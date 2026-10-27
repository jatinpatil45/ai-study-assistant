import crypto from "node:crypto";
import { z, ZodError } from "zod";
import { getEnv } from "./config/env";
import { detectFirebaseConfigStatus } from "./config/firebase";
import { AppError } from "./errors";
import { assertOwnership, FirebaseAdminTokenVerifier, type TokenVerifier } from "./middleware/auth";
import { GoogleGenAiClient, StudyAiService } from "./services/ai";
import { DefaultPdfExtractor, formatBytes, validatePdfUpload } from "./services/pdf";
import { buildStarterDocumentsForUser } from "./services/seed-docs";
import { FirestoreStudyRepository, type StudyRepository } from "./services/repository";
import { FirebaseStorageService, type StorageService } from "./services/storage";
import type {
  ClientQuizQuestion,
  DocumentRecord,
  DocumentSummary,
  GradedQuestionResult,
  PdfPageContent,
} from "./types";

const UploadMetadataSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  subject: z.string().trim().min(1).max(100).optional(),
});

const ChatRequestSchema = z.object({
  documentId: z.string().trim().min(1, "documentId is required"),
  question: z.string().trim().min(1, "question is required").max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "ai"]),
        text: z.string().trim().min(1).max(8000),
      }),
    )
    .max(20)
    .optional(),
});

const SummarizeRequestSchema = z.object({
  documentId: z.string().trim().min(1, "documentId is required"),
  style: z.enum(["summary", "chapter", "definitions", "revision"]).optional().default("summary"),
  pageRange: z
    .object({
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    })
    .refine((r) => r.end >= r.start, {
      message: "pageRange.end must be greater than or equal to pageRange.start",
    })
    .optional(),
});

const ExplainRequestSchema = z.object({
  documentId: z.string().trim().min(1, "documentId is required"),
  topic: z.string().trim().min(1, "topic is required").max(1000),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional().default("beginner"),
});

const QuizGenerateRequestSchema = z.object({
  documentId: z.string().trim().min(1, "documentId is required"),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().default("medium"),
  count: z.number().int().min(1).max(20).optional().default(5),
});

const QuizGradeRequestSchema = z.object({
  quizId: z.string().trim().min(1, "quizId is required"),
  answers: z.record(z.string(), z.number().int().min(0).max(3)),
});

const HistoryQuerySchema = z.object({
  type: z.enum(["chat", "note", "explanation", "quiz_attempt", "document"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

function toDocumentSummary(doc: DocumentRecord): DocumentSummary {
  return {
    id: doc.id,
    uid: doc.uid,
    title: doc.title,
    subject: doc.subject,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    sizeFormatted: doc.sizeFormatted,
    storagePath: doc.storagePath,
    pageCount: doc.pageCount,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function verifyRequestUid(request: Request, verifier: TokenVerifier): Promise<string> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    throw new AppError(401, "UNAUTHORIZED", "Missing Authorization header.");
  }
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer" || !parts[1]) {
    throw new AppError(
      401,
      "UNAUTHORIZED",
      "Malformed Authorization header. Expected 'Bearer <Firebase_ID_Token>'.",
    );
  }
  try {
    const user = await verifier.verifyIdToken(parts[1]);
    if (!user?.uid) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid authentication token.");
    }
    return user.uid;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "UNAUTHORIZED", "Invalid or expired Firebase ID token.");
  }
}

async function loadOwnedReadyDocument(
  repository: StudyRepository,
  documentId: string,
  uid: string,
): Promise<DocumentRecord> {
  const doc = await repository.getDocumentById(documentId);
  if (!doc) {
    throw new AppError(404, "NOT_FOUND", "Document not found.");
  }
  assertOwnership(doc.uid, uid);
  if (doc.status !== "ready" || !doc.pages || doc.pages.length === 0) {
    throw new AppError(
      422,
      "PDF_PROCESSING_ERROR",
      "Document has no extracted text available for AI processing.",
    );
  }
  return doc;
}

function filterPagesByRange(
  pages: PdfPageContent[],
  range?: { start: number; end: number },
): PdfPageContent[] {
  if (!range) return pages;
  const filtered = pages.filter((p) => p.pageNumber >= range.start && p.pageNumber <= range.end);
  if (filtered.length === 0) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `Requested page range (${range.start}–${range.end}) does not match any pages in this document.`,
    );
  }
  return filtered;
}

let cachedServices:
  | {
      verifier: TokenVerifier;
      repository: StudyRepository;
      storage: StorageService;
      pdfExtractor: DefaultPdfExtractor;
      aiService: StudyAiService;
    }
  | undefined;

function getWebServices(env: ReturnType<typeof getEnv>) {
  if (!cachedServices) {
    cachedServices = {
      verifier: new FirebaseAdminTokenVerifier(env),
      repository: new FirestoreStudyRepository(env),
      storage: new FirebaseStorageService(env),
      pdfExtractor: new DefaultPdfExtractor(),
      aiService: new StudyAiService(new GoogleGenAiClient(env)),
    };
  }
  return cachedServices;
}

export async function handleWebApiRequest(request: Request): Promise<Response> {
  const env = getEnv();
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    // GET /api/health
    if (pathname === "/api/health" && method === "GET") {
      const firebaseStatus = detectFirebaseConfigStatus(env);
      const aiConfigured = Boolean(env.geminiApiKey && env.geminiApiKey.trim().length > 0);
      return jsonResponse(200, {
        status: "ok",
        service: "studymate-ai-backend",
        timestamp: new Date().toISOString(),
        environment: env.nodeEnv,
        services: {
          firebase: {
            configured: firebaseStatus.configured,
            mode: firebaseStatus.mode,
          },
          ai: {
            configured: aiConfigured,
            model: env.geminiModel,
          },
        },
      });
    }

    const { verifier, repository, storage, pdfExtractor, aiService } = getWebServices(env);

    const uid = await verifyRequestUid(request, verifier);

    // GET /api/profile
    if (pathname === "/api/profile" && method === "GET") {
      const profile = repository.getUserProfile ? await repository.getUserProfile(uid) : null;
      return jsonResponse(200, { profile });
    }

    // POST /api/profile
    if (pathname === "/api/profile" && method === "POST") {
      const rawBody = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const existing = repository.getUserProfile ? await repository.getUserProfile(uid) : null;
      const now = new Date().toISOString();
      const displayName =
        typeof rawBody["displayName"] === "string" && rawBody["displayName"].trim()
          ? rawBody["displayName"].trim()
          : (existing?.displayName ?? "Student");
      const email =
        typeof rawBody["email"] === "string" && rawBody["email"].trim()
          ? rawBody["email"].trim()
          : (existing?.email ?? "");
      const college =
        typeof rawBody["college"] === "string"
          ? rawBody["college"].trim()
          : (existing?.college ?? "");
      const branch =
        typeof rawBody["branch"] === "string" ? rawBody["branch"].trim() : (existing?.branch ?? "");

      const record = {
        uid,
        email,
        displayName,
        college,
        branch,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (repository.upsertUserProfile) {
        await repository.upsertUserProfile(record);
      }
      return jsonResponse(200, { profile: record });
    }

    // GET /api/documents
    if (pathname === "/api/documents" && method === "GET") {
      const summaries = repository.listDocumentSummariesByUid
        ? (await repository.listDocumentSummariesByUid(uid)).filter((d) => d.uid === uid)
        : (await repository.listDocumentsByUid(uid))
            .filter((d) => d.uid === uid)
            .map((d) => toDocumentSummary(d));
      return jsonResponse(200, {
        documents: summaries,
      });
    }

    // POST /api/documents/seed
    if (pathname === "/api/documents/seed" && method === "POST") {
      const existing = repository.listDocumentSummariesByUid
        ? await repository.listDocumentSummariesByUid(uid)
        : (await repository.listDocumentsByUid(uid)).map((d) => toDocumentSummary(d));
      if (existing.length > 0) {
        return jsonResponse(200, {
          seeded: false,
          documents: existing,
        });
      }
      const starterDocs = buildStarterDocumentsForUser(uid);
      for (const doc of starterDocs) {
        await repository.createDocument(doc);
      }
      return jsonResponse(201, {
        seeded: true,
        documents: starterDocs.map((d) => toDocumentSummary(d)),
      });
    }

    // POST /api/documents
    if (pathname === "/api/documents" && method === "POST") {
      const formData = await request.formData();
      const fileEntry = formData.get("file");
      if (!fileEntry || typeof fileEntry === "string") {
        throw new AppError(400, "INVALID_FILE", "A PDF file is required in the 'file' field.");
      }

      const arrayBuf = await fileEntry.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      const maxUploadBytes = env.maxUploadMb * 1024 * 1024;

      validatePdfUpload(
        {
          originalname: fileEntry.name || "document.pdf",
          mimetype: fileEntry.type || "application/pdf",
          size: buffer.length,
          buffer,
        },
        maxUploadBytes,
      );

      const rawTitle = formData.get("title");
      const rawSubject = formData.get("subject");
      const parsedMeta = UploadMetadataSchema.parse({
        ...(typeof rawTitle === "string" && rawTitle.trim() ? { title: rawTitle } : {}),
        ...(typeof rawSubject === "string" && rawSubject.trim() ? { subject: rawSubject } : {}),
      });

      const extracted = await pdfExtractor.extractPages(buffer);
      const docId = crypto.randomUUID();
      const defaultTitle =
        (fileEntry.name || "Untitled").replace(/\.pdf$/i, "").trim() || "Untitled Document";
      const title = parsedMeta.title ?? defaultTitle;
      const subject = parsedMeta.subject ?? "General";
      const now = new Date().toISOString();

      const { storagePath } = await storage.uploadPdf({
        uid,
        documentId: docId,
        fileName: fileEntry.name || `${docId}.pdf`,
        buffer,
        mimeType: "application/pdf",
      });

      const docRecord: DocumentRecord = {
        id: docId,
        uid,
        title,
        subject,
        fileName: fileEntry.name || `${docId}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: buffer.length,
        sizeFormatted: formatBytes(buffer.length),
        storagePath,
        pageCount: extracted.pageCount,
        pages: extracted.pages,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      };

      await repository.createDocument(docRecord);
      await repository.createHistoryItem({
        id: crypto.randomUUID(),
        uid,
        type: "document",
        title: `Uploaded: ${title}`,
        documentId: docId,
        documentTitle: title,
        payload: {
          subject,
          pageCount: extracted.pageCount,
          sizeFormatted: docRecord.sizeFormatted,
        },
        createdAt: now,
      });

      return jsonResponse(201, { document: toDocumentSummary(docRecord) });
    }

    // GET / DELETE /api/documents/:id
    if (pathname.startsWith("/api/documents/")) {
      const docId = decodeURIComponent(pathname.slice("/api/documents/".length)).trim();
      if (!docId) {
        throw new AppError(400, "VALIDATION_ERROR", "Document ID is required.");
      }
      const doc = await repository.getDocumentById(docId);
      if (!doc) {
        throw new AppError(404, "NOT_FOUND", "Document not found.");
      }
      assertOwnership(doc.uid, uid);

      if (method === "GET") {
        return jsonResponse(200, { document: doc });
      }
      if (method === "DELETE") {
        await storage.deletePdf(doc.storagePath);
        await repository.deleteDocumentById(docId);
        return jsonResponse(200, { deleted: true, id: docId });
      }
    }

    // POST /api/ai/chat
    if (pathname === "/api/ai/chat" && method === "POST") {
      const rawBody = await request.json();
      const body = ChatRequestSchema.parse(rawBody);
      const doc = await loadOwnedReadyDocument(repository, body.documentId, uid);

      const aiResult = await aiService.chatWithDocument({
        documentTitle: doc.title,
        pages: doc.pages,
        question: body.question,
        history: body.history,
      });

      const now = new Date().toISOString();
      const historyId = crypto.randomUUID();

      await repository.createHistoryItem({
        id: historyId,
        uid,
        type: "chat",
        title: body.question.slice(0, 120),
        documentId: doc.id,
        documentTitle: doc.title,
        payload: {
          question: body.question,
          answer: aiResult.answer,
          supported: aiResult.supported,
          sources: aiResult.sources,
        },
        createdAt: now,
      });

      return jsonResponse(200, {
        id: historyId,
        documentId: doc.id,
        documentTitle: doc.title,
        question: body.question,
        answer: aiResult.answer,
        supported: aiResult.supported,
        sources: aiResult.sources,
        createdAt: now,
      });
    }

    // POST /api/ai/summarize
    if (pathname === "/api/ai/summarize" && method === "POST") {
      const rawBody = await request.json();
      const body = SummarizeRequestSchema.parse(rawBody);
      const doc = await loadOwnedReadyDocument(repository, body.documentId, uid);
      const targetPages = filterPagesByRange(doc.pages, body.pageRange);

      const summaryResult = await aiService.summarizeDocument({
        documentTitle: doc.title,
        pages: targetPages,
        style: body.style,
      });

      const now = new Date().toISOString();
      const historyId = crypto.randomUUID();

      await repository.createHistoryItem({
        id: historyId,
        uid,
        type: "note",
        title: summaryResult.title,
        documentId: doc.id,
        documentTitle: doc.title,
        payload: {
          style: body.style,
          summary: summaryResult.summary,
          sections: summaryResult.sections,
          sources: summaryResult.sources,
        },
        createdAt: now,
      });

      return jsonResponse(200, {
        id: historyId,
        documentId: doc.id,
        documentTitle: doc.title,
        style: body.style,
        title: summaryResult.title,
        summary: summaryResult.summary,
        sections: summaryResult.sections,
        sources: summaryResult.sources,
        createdAt: now,
      });
    }

    // POST /api/ai/explain
    if (pathname === "/api/ai/explain" && method === "POST") {
      const rawBody = await request.json();
      const body = ExplainRequestSchema.parse(rawBody);
      const doc = await loadOwnedReadyDocument(repository, body.documentId, uid);

      const explainResult = await aiService.explainTopic({
        documentTitle: doc.title,
        pages: doc.pages,
        topic: body.topic,
        level: body.level,
      });

      const now = new Date().toISOString();
      const historyId = crypto.randomUUID();

      await repository.createHistoryItem({
        id: historyId,
        uid,
        type: "explanation",
        title: `Explanation: ${body.topic.slice(0, 100)}`,
        documentId: doc.id,
        documentTitle: doc.title,
        payload: {
          topic: body.topic,
          level: body.level,
          explanation: explainResult.explanation,
          keyTakeaways: explainResult.keyTakeaways,
          supported: explainResult.supported,
          sources: explainResult.sources,
        },
        createdAt: now,
      });

      return jsonResponse(200, {
        id: historyId,
        documentId: doc.id,
        documentTitle: doc.title,
        topic: body.topic,
        level: body.level,
        explanation: explainResult.explanation,
        keyTakeaways: explainResult.keyTakeaways,
        supported: explainResult.supported,
        sources: explainResult.sources,
        createdAt: now,
      });
    }

    // POST /api/ai/quiz
    if (pathname === "/api/ai/quiz" && method === "POST") {
      const rawBody = await request.json();
      const body = QuizGenerateRequestSchema.parse(rawBody);
      const doc = await loadOwnedReadyDocument(repository, body.documentId, uid);

      const questions = await aiService.generateQuiz({
        documentTitle: doc.title,
        pages: doc.pages,
        difficulty: body.difficulty,
        count: body.count,
      });

      const now = new Date().toISOString();
      const quizId = crypto.randomUUID();

      await repository.saveQuiz({
        id: quizId,
        uid,
        documentId: doc.id,
        documentTitle: doc.title,
        difficulty: body.difficulty,
        questions,
        createdAt: now,
      });

      const clientQuestions: ClientQuizQuestion[] = questions.map((q) => ({
        id: q.id,
        question: q.question,
        options: q.options,
        source: q.source,
      }));

      return jsonResponse(201, {
        quizId,
        documentId: doc.id,
        documentTitle: doc.title,
        difficulty: body.difficulty,
        count: clientQuestions.length,
        questions: clientQuestions,
        createdAt: now,
      });
    }

    // POST /api/ai/quiz/grade
    if (pathname === "/api/ai/quiz/grade" && method === "POST") {
      const rawBody = await request.json();
      const body = QuizGradeRequestSchema.parse(rawBody);

      const storedQuiz = await repository.getQuizById(body.quizId);
      if (!storedQuiz) {
        throw new AppError(404, "NOT_FOUND", "Quiz not found.");
      }
      assertOwnership(storedQuiz.uid, uid);

      let score = 0;
      const results: GradedQuestionResult[] = storedQuiz.questions.map((q) => {
        const submitted = body.answers[q.id];
        const selectedIndex = typeof submitted === "number" ? submitted : null;
        const isCorrect = selectedIndex !== null && selectedIndex === q.correctIndex;
        if (isCorrect) score += 1;
        return {
          questionId: q.id,
          question: q.question,
          options: q.options,
          selectedIndex,
          correctIndex: q.correctIndex,
          isCorrect,
          explanation: q.explanation,
          source: q.source,
        };
      });

      const total = storedQuiz.questions.length;
      const percent = total > 0 ? Math.round((score / total) * 100) : 0;
      const now = new Date().toISOString();
      const attemptId = crypto.randomUUID();

      await repository.createHistoryItem({
        id: attemptId,
        uid,
        type: "quiz_attempt",
        title: `Quiz: ${storedQuiz.documentTitle} (${storedQuiz.difficulty})`,
        documentId: storedQuiz.documentId,
        documentTitle: storedQuiz.documentTitle,
        payload: {
          quizId: storedQuiz.id,
          difficulty: storedQuiz.difficulty,
          score,
          total,
          percent,
          results,
        },
        createdAt: now,
      });

      return jsonResponse(200, {
        attemptId,
        quizId: storedQuiz.id,
        documentId: storedQuiz.documentId,
        documentTitle: storedQuiz.documentTitle,
        difficulty: storedQuiz.difficulty,
        score,
        total,
        percent,
        results,
        createdAt: now,
      });
    }

    // GET /api/history
    if (pathname === "/api/history" && method === "GET") {
      const queryObj: Record<string, string> = {};
      const typeParam = url.searchParams.get("type");
      const limitParam = url.searchParams.get("limit");
      if (typeParam) queryObj["type"] = typeParam;
      if (limitParam) queryObj["limit"] = limitParam;

      const parsedQuery = HistoryQuerySchema.parse(queryObj);
      const items = await repository.listHistoryByUid(uid, {
        type: parsedQuery.type,
        limit: parsedQuery.limit,
      });
      return jsonResponse(200, {
        items: items.filter((item) => item.uid === uid),
      });
    }

    // GET / DELETE /api/history/:id
    if (pathname.startsWith("/api/history/")) {
      const id = decodeURIComponent(pathname.slice("/api/history/".length)).trim();
      if (!id) {
        throw new AppError(400, "VALIDATION_ERROR", "History item ID is required.");
      }
      const item = await repository.getHistoryItemById(id);
      if (!item) {
        throw new AppError(404, "NOT_FOUND", "History item not found.");
      }
      assertOwnership(item.uid, uid);

      if (method === "GET") {
        return jsonResponse(200, { item });
      }
      if (method === "DELETE") {
        await repository.deleteHistoryItemById(id);
        return jsonResponse(200, { deleted: true, id });
      }
    }

    throw new AppError(404, "NOT_FOUND", "Requested API endpoint does not exist.");
  } catch (err) {
    if (err instanceof AppError) {
      return jsonResponse(err.statusCode, {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    }
    if (err instanceof ZodError) {
      return jsonResponse(400, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request payload.",
          details: err.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    if (err instanceof SyntaxError) {
      return jsonResponse(400, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Malformed JSON in request body.",
        },
      });
    }
    console.error("[Web API Error]", err);
    return jsonResponse(500, {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected server error occurred.",
      },
    });
  }
}

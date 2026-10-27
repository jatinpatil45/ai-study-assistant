import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError } from "../errors";
import { assertOwnership, getAuthenticatedUid } from "../middleware/auth";
import { formatBytes, validatePdfUpload, type PdfExtractor } from "../services/pdf";
import { buildStarterDocumentsForUser } from "../services/seed-docs";
import type { StudyRepository } from "../services/repository";
import type { StorageService } from "../services/storage";
import type { DocumentRecord, DocumentSummary } from "../types";

const UploadMetadataSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  subject: z.string().trim().min(1).max(100).optional(),
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

export interface DocumentsRouterDeps {
  repository: StudyRepository;
  storage: StorageService;
  pdfExtractor: PdfExtractor;
  maxUploadBytes: number;
}

export function createDocumentsRouter(deps: DocumentsRouterDeps): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: deps.maxUploadBytes,
      files: 1,
    },
  });

  // GET /api/documents — list current user's documents
  router.get("/", async (req, res, next) => {
    try {
      const uid = getAuthenticatedUid(req);
      const summaries = deps.repository.listDocumentSummariesByUid
        ? (await deps.repository.listDocumentSummariesByUid(uid)).filter((d) => d.uid === uid)
        : (await deps.repository.listDocumentsByUid(uid))
            .filter((d) => d.uid === uid)
            .map((d) => toDocumentSummary(d));
      res.status(200).json({ documents: summaries });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/documents/seed — populate starter study documents for the authenticated user
  router.post("/seed", async (req, res, next) => {
    try {
      const uid = getAuthenticatedUid(req);
      const existing = deps.repository.listDocumentSummariesByUid
        ? await deps.repository.listDocumentSummariesByUid(uid)
        : (await deps.repository.listDocumentsByUid(uid)).map((d) => toDocumentSummary(d));
      if (existing.length > 0) {
        res.status(200).json({
          seeded: false,
          documents: existing,
        });
        return;
      }
      const starterDocs = buildStarterDocumentsForUser(uid);
      for (const doc of starterDocs) {
        await deps.repository.createDocument(doc);
      }
      res.status(201).json({
        seeded: true,
        documents: starterDocs.map((d) => toDocumentSummary(d)),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/documents/:id — get single document including extracted pages (owner only)
  router.get("/:id", async (req, res, next) => {
    try {
      const uid = getAuthenticatedUid(req);
      const docId = (req.params["id"] ?? "").trim();
      if (!docId) {
        throw new AppError(400, "VALIDATION_ERROR", "Document ID is required.");
      }
      const doc = await deps.repository.getDocumentById(docId);
      if (!doc) {
        throw new AppError(404, "NOT_FOUND", "Document not found.");
      }
      assertOwnership(doc.uid, uid);
      res.status(200).json({ document: doc });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/documents — validated PDF upload, extraction, storage, and metadata creation
  router.post("/", upload.single("file"), async (req, res, next) => {
    try {
      const uid = getAuthenticatedUid(req);
      const file = req.file;

      validatePdfUpload(file, deps.maxUploadBytes);
      if (!file) {
        throw new AppError(400, "INVALID_FILE", "A PDF file is required.");
      }

      const parsedMeta = UploadMetadataSchema.parse(req.body ?? {});
      const extracted = await deps.pdfExtractor.extractPages(file.buffer);

      if (!extracted.pages.length || extracted.pageCount <= 0) {
        throw new AppError(
          422,
          "PDF_PROCESSING_ERROR",
          "No readable pages could be extracted from the uploaded PDF.",
        );
      }

      const docId = crypto.randomUUID();
      const defaultTitle = file.originalname.replace(/\.pdf$/i, "").trim() || "Untitled Document";
      const title = parsedMeta.title ?? defaultTitle;
      const subject = parsedMeta.subject ?? "General";
      const now = new Date().toISOString();

      const { storagePath } = await deps.storage.uploadPdf({
        uid,
        documentId: docId,
        fileName: file.originalname,
        buffer: file.buffer,
        mimeType: "application/pdf",
      });

      const docRecord: DocumentRecord = {
        id: docId,
        uid,
        title,
        subject,
        fileName: file.originalname,
        mimeType: "application/pdf",
        sizeBytes: file.size,
        sizeFormatted: formatBytes(file.size),
        storagePath,
        pageCount: extracted.pageCount,
        pages: extracted.pages,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      };

      await deps.repository.createDocument(docRecord);

      await deps.repository.createHistoryItem({
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

      res.status(201).json({
        document: toDocumentSummary(docRecord),
      });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/documents/:id — enforce ownership and remove from Storage + Firestore
  router.delete("/:id", async (req, res, next) => {
    try {
      const uid = getAuthenticatedUid(req);
      const docId = (req.params["id"] ?? "").trim();
      if (!docId) {
        throw new AppError(400, "VALIDATION_ERROR", "Document ID is required.");
      }

      const doc = await deps.repository.getDocumentById(docId);
      if (!doc) {
        throw new AppError(404, "NOT_FOUND", "Document not found.");
      }

      assertOwnership(doc.uid, uid);

      await deps.storage.deletePdf(doc.storagePath);
      await deps.repository.deleteDocumentById(docId);

      res.status(200).json({
        deleted: true,
        id: docId,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

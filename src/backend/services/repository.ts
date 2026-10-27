import { getFirebaseServices } from "../config/firebase";
import type { ServerEnv } from "../config/env";
import type {
  DocumentRecord,
  DocumentSummary,
  HistoryItemType,
  HistoryRecord,
  StoredQuizRecord,
  UserProfileRecord,
} from "../types";

export interface ListHistoryOptions {
  type?: HistoryItemType | undefined;
  limit?: number | undefined;
}

export interface StudyRepository {
  // User Profile
  getUserProfile?(uid: string): Promise<UserProfileRecord | null>;
  upsertUserProfile?(profile: UserProfileRecord): Promise<UserProfileRecord>;

  // Documents
  createDocument(doc: DocumentRecord): Promise<DocumentRecord>;
  getDocumentById(id: string): Promise<DocumentRecord | null>;
  listDocumentsByUid(uid: string): Promise<DocumentRecord[]>;
  listDocumentSummariesByUid?(uid: string): Promise<DocumentSummary[]>;
  deleteDocumentById(id: string): Promise<void>;

  // Quizzes (server-side answer key storage)
  saveQuiz(quiz: StoredQuizRecord): Promise<StoredQuizRecord>;
  getQuizById(id: string): Promise<StoredQuizRecord | null>;

  // History (chats, notes, explanations, quiz_attempts, documents)
  createHistoryItem(item: HistoryRecord): Promise<HistoryRecord>;
  getHistoryItemById(id: string): Promise<HistoryRecord | null>;
  listHistoryByUid(uid: string, options?: ListHistoryOptions): Promise<HistoryRecord[]>;
  deleteHistoryItemById(id: string): Promise<void>;
}

const DOCUMENTS_COLLECTION = "documents";
const QUIZZES_COLLECTION = "quizzes";
const HISTORY_COLLECTION = "history";
const USERS_COLLECTION = "users";

const DOCUMENT_SUMMARY_FIELDS: readonly (keyof DocumentSummary)[] = [
  "id",
  "uid",
  "title",
  "subject",
  "fileName",
  "mimeType",
  "sizeBytes",
  "sizeFormatted",
  "storagePath",
  "pageCount",
  "status",
  "createdAt",
  "updatedAt",
];

export function toDocumentSummary(doc: DocumentRecord | DocumentSummary): DocumentSummary {
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

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

const READ_CACHE_TTL_MS = 45_000;
const DOC_DETAIL_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 250;

function getValidCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() < entry.expiresAtMs) {
    return entry.value;
  }
  map.delete(key);
  return undefined;
}

function setBoundedCache<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): void {
  if (!map.has(key) && map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, { value, expiresAtMs: Date.now() + ttlMs });
}

export class FirestoreStudyRepository implements StudyRepository {
  private readonly env?: ServerEnv | undefined;
  private readonly profileCache = new Map<string, CacheEntry<UserProfileRecord | null>>();
  private readonly docSummariesCache = new Map<string, CacheEntry<DocumentSummary[]>>();
  private readonly docByIdCache = new Map<string, CacheEntry<DocumentRecord>>();
  private readonly historyByUidCache = new Map<string, CacheEntry<HistoryRecord[]>>();
  private readonly historyByIdCache = new Map<string, CacheEntry<HistoryRecord>>();

  constructor(env?: ServerEnv) {
    this.env = env;
  }

  private get db() {
    return getFirebaseServices(this.env).firestore;
  }

  async getUserProfile(uid: string): Promise<UserProfileRecord | null> {
    const cached = getValidCache(this.profileCache, uid);
    if (cached !== undefined) return cached;

    const snap = await this.db.collection(USERS_COLLECTION).doc(uid).get();
    const profile = snap.exists ? (snap.data() as UserProfileRecord) : null;
    setBoundedCache(this.profileCache, uid, profile, READ_CACHE_TTL_MS);
    return profile;
  }

  async upsertUserProfile(profile: UserProfileRecord): Promise<UserProfileRecord> {
    await this.db.collection(USERS_COLLECTION).doc(profile.uid).set(profile, { merge: true });
    setBoundedCache(this.profileCache, profile.uid, profile, READ_CACHE_TTL_MS);
    return profile;
  }

  async createDocument(doc: DocumentRecord): Promise<DocumentRecord> {
    // Ensure pages payload stays safely within Cloud Firestore's 1 MB document limit
    const MAX_TOTAL_CHARS = 450_000;
    let usedChars = 0;
    const safePages: DocumentRecord["pages"] = [];
    for (const p of doc.pages) {
      if (usedChars >= MAX_TOTAL_CHARS) break;
      const remaining = MAX_TOTAL_CHARS - usedChars;
      const text = p.text.length > remaining ? p.text.slice(0, remaining) : p.text;
      usedChars += text.length;
      safePages.push({ pageNumber: p.pageNumber, text });
    }
    const safeDoc: DocumentRecord = {
      ...doc,
      pages: safePages,
    };
    await this.db.collection(DOCUMENTS_COLLECTION).doc(safeDoc.id).set(safeDoc);
    setBoundedCache(this.docByIdCache, safeDoc.id, safeDoc, DOC_DETAIL_CACHE_TTL_MS);

    const existingSummaries = getValidCache(this.docSummariesCache, safeDoc.uid);
    if (existingSummaries) {
      const summary = toDocumentSummary(safeDoc);
      const next = [summary, ...existingSummaries.filter((d) => d.id !== safeDoc.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      setBoundedCache(this.docSummariesCache, safeDoc.uid, next, READ_CACHE_TTL_MS);
    }

    return safeDoc;
  }

  async getDocumentById(id: string): Promise<DocumentRecord | null> {
    const cached = getValidCache(this.docByIdCache, id);
    if (cached !== undefined) return cached;

    const snap = await this.db.collection(DOCUMENTS_COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    const doc = snap.data() as DocumentRecord;
    setBoundedCache(this.docByIdCache, id, doc, DOC_DETAIL_CACHE_TTL_MS);
    return doc;
  }

  async listDocumentsByUid(uid: string): Promise<DocumentRecord[]> {
    const snap = await this.db.collection(DOCUMENTS_COLLECTION).where("uid", "==", uid).get();
    const docs = snap.docs.map((d) => d.data() as DocumentRecord);
    return docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listDocumentSummariesByUid(uid: string): Promise<DocumentSummary[]> {
    const cached = getValidCache(this.docSummariesCache, uid);
    if (cached !== undefined) return cached;

    const baseQuery = this.db.collection(DOCUMENTS_COLLECTION).where("uid", "==", uid);
    // Project only lightweight metadata fields so Firestore never reads or transfers
    // up to 450 KB per document of extracted PDF page text on tab loads.
    const projectedQuery =
      typeof baseQuery.select === "function"
        ? baseQuery.select(...DOCUMENT_SUMMARY_FIELDS)
        : baseQuery;
    const snap = await projectedQuery.get();
    const summaries = snap.docs
      .map((d) => toDocumentSummary(d.data() as DocumentSummary))
      .filter((d) => d.uid === uid)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    setBoundedCache(this.docSummariesCache, uid, summaries, READ_CACHE_TTL_MS);
    return summaries;
  }

  async deleteDocumentById(id: string): Promise<void> {
    await this.db.collection(DOCUMENTS_COLLECTION).doc(id).delete();
    this.docByIdCache.delete(id);
    for (const [uid, entry] of this.docSummariesCache.entries()) {
      const filtered = entry.value.filter((d) => d.id !== id);
      if (filtered.length !== entry.value.length) {
        this.docSummariesCache.set(uid, {
          value: filtered,
          expiresAtMs: entry.expiresAtMs,
        });
      }
    }
  }

  async saveQuiz(quiz: StoredQuizRecord): Promise<StoredQuizRecord> {
    await this.db.collection(QUIZZES_COLLECTION).doc(quiz.id).set(quiz);
    return quiz;
  }

  async getQuizById(id: string): Promise<StoredQuizRecord | null> {
    const snap = await this.db.collection(QUIZZES_COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    return snap.data() as StoredQuizRecord;
  }

  async createHistoryItem(item: HistoryRecord): Promise<HistoryRecord> {
    await this.db.collection(HISTORY_COLLECTION).doc(item.id).set(item);
    setBoundedCache(this.historyByIdCache, item.id, item, READ_CACHE_TTL_MS);

    const existingList = getValidCache(this.historyByUidCache, item.uid);
    if (existingList) {
      const next = [item, ...existingList.filter((i) => i.id !== item.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      setBoundedCache(this.historyByUidCache, item.uid, next, READ_CACHE_TTL_MS);
    }

    return item;
  }

  async getHistoryItemById(id: string): Promise<HistoryRecord | null> {
    const cached = getValidCache(this.historyByIdCache, id);
    if (cached !== undefined) return cached;

    const snap = await this.db.collection(HISTORY_COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    const item = snap.data() as HistoryRecord;
    setBoundedCache(this.historyByIdCache, id, item, READ_CACHE_TTL_MS);
    return item;
  }

  async listHistoryByUid(uid: string, options?: ListHistoryOptions): Promise<HistoryRecord[]> {
    let allItems = getValidCache(this.historyByUidCache, uid);
    if (allItems === undefined) {
      const snap = await this.db.collection(HISTORY_COLLECTION).where("uid", "==", uid).get();
      allItems = snap.docs
        .map((d) => d.data() as HistoryRecord)
        .filter((i) => i.uid === uid)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      setBoundedCache(this.historyByUidCache, uid, allItems, READ_CACHE_TTL_MS);
      for (const item of allItems) {
        setBoundedCache(this.historyByIdCache, item.id, item, READ_CACHE_TTL_MS);
      }
    }

    const filtered = options?.type ? allItems.filter((i) => i.type === options.type) : allItems;
    const limit = options?.limit ?? 50;
    return filtered.slice(0, limit);
  }

  async deleteHistoryItemById(id: string): Promise<void> {
    await this.db.collection(HISTORY_COLLECTION).doc(id).delete();
    this.historyByIdCache.delete(id);
    for (const [uid, entry] of this.historyByUidCache.entries()) {
      const filtered = entry.value.filter((i) => i.id !== id);
      if (filtered.length !== entry.value.length) {
        this.historyByUidCache.set(uid, {
          value: filtered,
          expiresAtMs: entry.expiresAtMs,
        });
      }
    }
  }
}

export class InMemoryStudyRepository implements StudyRepository {
  public readonly documents = new Map<string, DocumentRecord>();
  public readonly quizzes = new Map<string, StoredQuizRecord>();
  public readonly history = new Map<string, HistoryRecord>();

  async createDocument(doc: DocumentRecord): Promise<DocumentRecord> {
    this.documents.set(doc.id, structuredClone(doc));
    return structuredClone(doc);
  }

  async getDocumentById(id: string): Promise<DocumentRecord | null> {
    const doc = this.documents.get(id);
    return doc ? structuredClone(doc) : null;
  }

  async listDocumentsByUid(uid: string): Promise<DocumentRecord[]> {
    const list: DocumentRecord[] = [];
    for (const doc of this.documents.values()) {
      if (doc.uid === uid) {
        list.push(structuredClone(doc));
      }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listDocumentSummariesByUid(uid: string): Promise<DocumentSummary[]> {
    const docs = await this.listDocumentsByUid(uid);
    return docs.map((d) => toDocumentSummary(d));
  }

  async deleteDocumentById(id: string): Promise<void> {
    this.documents.delete(id);
  }

  async saveQuiz(quiz: StoredQuizRecord): Promise<StoredQuizRecord> {
    this.quizzes.set(quiz.id, structuredClone(quiz));
    return structuredClone(quiz);
  }

  async getQuizById(id: string): Promise<StoredQuizRecord | null> {
    const quiz = this.quizzes.get(id);
    return quiz ? structuredClone(quiz) : null;
  }

  async createHistoryItem(item: HistoryRecord): Promise<HistoryRecord> {
    this.history.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  async getHistoryItemById(id: string): Promise<HistoryRecord | null> {
    const item = this.history.get(id);
    return item ? structuredClone(item) : null;
  }

  async listHistoryByUid(uid: string, options?: ListHistoryOptions): Promise<HistoryRecord[]> {
    let items: HistoryRecord[] = [];
    for (const item of this.history.values()) {
      if (item.uid === uid) {
        items.push(structuredClone(item));
      }
    }
    if (options?.type) {
      items = items.filter((i) => i.type === options.type);
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = options?.limit ?? 50;
    return items.slice(0, limit);
  }

  async deleteHistoryItemById(id: string): Promise<void> {
    this.history.delete(id);
  }
}

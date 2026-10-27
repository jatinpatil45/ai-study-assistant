import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { apiRequest, useAuth } from "./firebase-client";
import type { StudyDoc } from "./sample-data";

export interface ApiDocumentSummary {
  id: string;
  uid: string;
  title: string;
  subject: string;
  fileName: string;
  mimeType: "application/pdf";
  sizeBytes: number;
  sizeFormatted: string;
  storagePath: string;
  pageCount: number;
  status: "ready" | "processing" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface ApiDocumentDetail extends ApiDocumentSummary {
  pages: { pageNumber: number; text: string }[];
}

export type ApiDocumentItem = ApiDocumentDetail;
export type StudyDocView = StudyDoc;

export interface ApiHistoryItem {
  id: string;
  uid: string;
  type: "chat" | "note" | "explanation" | "quiz_attempt" | "document";
  title: string;
  documentId?: string;
  documentTitle?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  preview?: string;
  score?: number;
  total?: number;
  percent?: number;
  difficulty?: string;
  noteType?: string;
}

export function formatAiText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
          ? (Object.values(parsed as Record<string, unknown>).find(Array.isArray) ?? [parsed])
          : [];
      if (Array.isArray(items) && items.length > 0) {
        const lines = items
          .map((item, idx) => {
            if (typeof item === "string") return `${idx + 1}. ${item.trim()}`;
            if (item && typeof item === "object") {
              const obj = item as Record<string, unknown>;
              const mainText =
                obj["question"] ??
                obj["text"] ??
                obj["point"] ??
                obj["definition"] ??
                obj["concept"] ??
                obj["title"] ??
                Object.values(obj).find((v) => typeof v === "string");
              const extraText = obj["answer"] ?? obj["explanation"] ?? obj["description"];
              if (typeof mainText === "string") {
                return typeof extraText === "string" && extraText.trim()
                  ? `${idx + 1}. ${mainText.trim()}\n${extraText.trim()}`
                  : `${idx + 1}. ${mainText.trim()}`;
              }
            }
            return "";
          })
          .filter(Boolean);
        if (lines.length > 0) {
          return lines.join("\n\n");
        }
      }
    } catch {
      // Fall through to text formatting
    }
  }

  return trimmed
    .replace(/([.?!:])\s+(\d+\.\s+[A-Z])/g, "$1\n\n$2")
    .replace(/([.?!:])\s+([•\-*]\s+[A-Z])/g, "$1\n$2");
}

export function enrichHistoryItem(item: ApiHistoryItem): ApiHistoryItem {
  const p = item.payload ?? {};
  const answer = typeof p["answer"] === "string" ? formatAiText(p["answer"]) : undefined;
  const summary = typeof p["summary"] === "string" ? formatAiText(p["summary"]) : undefined;
  const explanation =
    typeof p["explanation"] === "string" ? formatAiText(p["explanation"]) : undefined;
  const previewText = answer ?? summary ?? explanation ?? item.title;
  const score = typeof p["score"] === "number" ? p["score"] : item.score;
  const total = typeof p["total"] === "number" ? p["total"] : item.total;
  const percent = typeof p["percent"] === "number" ? p["percent"] : item.percent;
  const difficulty = typeof p["difficulty"] === "string" ? p["difficulty"] : item.difficulty;
  const noteType = typeof p["style"] === "string" ? p["style"] : item.noteType;

  return {
    ...item,
    preview: previewText.slice(0, 120),
    ...(score !== undefined ? { score } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(percent !== undefined ? { percent } : {}),
    ...(difficulty !== undefined ? { difficulty } : {}),
    ...(noteType !== undefined ? { noteType } : {}),
  };
}

interface PersistedCachePayload<T> {
  updatedAt: number;
  data: T;
}

const STUDY_CACHE_STALE_MS = 2 * 60 * 1000;
const DOC_DETAIL_STALE_MS = 10 * 60 * 1000;

function docsStorageKey(uid: string): string {
  return `studymate:v1:${uid}:docs`;
}

function historyStorageKey(uid: string): string {
  return `studymate:v1:${uid}:history`;
}

function readLocalCache<T>(key: string): PersistedCachePayload<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedCachePayload<T>>;
    if (!parsed || typeof parsed.updatedAt !== "number" || !Array.isArray(parsed.data)) {
      return null;
    }
    return { updatedAt: parsed.updatedAt, data: parsed.data };
  } catch {
    return null;
  }
}

function writeLocalCache<T>(key: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedCachePayload<T> = {
      updatedAt: Date.now(),
      data,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore storage quota errors
  }
}

export const studyKeys = {
  documents: (uid: string) => ["study-documents", uid] as const,
  documentDetail: (uid: string, docId: string) => ["study-document-detail", uid, docId] as const,
  history: (uid: string) => ["study-history", uid] as const,
};

export async function fetchStudyDocumentSummaries(uid: string): Promise<ApiDocumentSummary[]> {
  const res = await apiRequest<{ documents: ApiDocumentSummary[] }>("/api/documents");
  const list = res.documents ?? [];
  if (uid) {
    writeLocalCache(docsStorageKey(uid), list);
  }
  return list;
}

export async function fetchAllStudyHistory(uid: string): Promise<ApiHistoryItem[]> {
  const res = await apiRequest<{ items?: ApiHistoryItem[]; history?: ApiHistoryItem[] }>(
    "/api/history?limit=100",
  );
  const raw = res.items ?? res.history ?? [];
  const enriched = raw.map(enrichHistoryItem);
  if (uid) {
    writeLocalCache(historyStorageKey(uid), enriched);
  }
  return enriched;
}

export async function fetchHistoryList(type?: string): Promise<ApiHistoryItem[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : "?limit=100";
  const res = await apiRequest<{ items?: ApiHistoryItem[]; history?: ApiHistoryItem[] }>(
    `/api/history${qs}`,
  );
  const raw = res.items ?? res.history ?? [];
  return raw.map(enrichHistoryItem);
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return "Just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function mapApiDocToStudyDoc(doc: ApiDocumentSummary): StudyDoc {
  return {
    id: doc.id,
    title: doc.title,
    subject: doc.subject,
    pages: doc.pageCount,
    size: doc.sizeFormatted,
    uploaded: formatRelativeTime(doc.createdAt),
    status: doc.status,
  };
}

export function useStudyDocuments() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const uid = user?.uid ?? "";

  const persisted = useMemo(
    () => (uid ? readLocalCache<ApiDocumentSummary[]>(docsStorageKey(uid)) : null),
    [uid],
  );

  const query = useQuery({
    queryKey: studyKeys.documents(uid),
    queryFn: () => fetchStudyDocumentSummaries(uid),
    enabled: Boolean(uid),
    staleTime: STUDY_CACHE_STALE_MS,
    ...(persisted
      ? { initialData: persisted.data, initialDataUpdatedAt: persisted.updatedAt }
      : {}),
  });

  const docs = useMemo(() => (query.data ?? []).map(mapApiDocToStudyDoc), [query.data]);

  const setDocs: Dispatch<SetStateAction<StudyDoc[]>> = useCallback(
    (updater) => {
      if (!uid) return;
      queryClient.setQueryData<ApiDocumentSummary[]>(studyKeys.documents(uid), (prev = []) => {
        const currentStudyDocs = prev.map(mapApiDocToStudyDoc);
        const nextStudyDocs = typeof updater === "function" ? updater(currentStudyDocs) : updater;
        const byId = new Map(prev.map((d) => [d.id, d]));
        const nextSummaries: ApiDocumentSummary[] = nextStudyDocs
          .map((sd) => {
            const existing = byId.get(sd.id);
            if (!existing) return null;
            return {
              ...existing,
              title: sd.title,
              subject: sd.subject,
              pageCount: sd.pages,
              sizeFormatted: sd.size,
              status: sd.status,
            };
          })
          .filter((x): x is ApiDocumentSummary => x !== null);
        writeLocalCache(docsStorageKey(uid), nextSummaries);
        return nextSummaries;
      });
    },
    [queryClient, uid],
  );

  const upsertDocument = useCallback(
    (doc: ApiDocumentSummary) => {
      if (!uid) return;
      queryClient.setQueryData<ApiDocumentSummary[]>(studyKeys.documents(uid), (prev = []) => {
        const next = [doc, ...prev.filter((d) => d.id !== doc.id)];
        writeLocalCache(docsStorageKey(uid), next);
        return next;
      });
    },
    [queryClient, uid],
  );

  const removeDocument = useCallback(
    (docId: string): (() => void) => {
      if (!uid) return () => undefined;
      const previous = queryClient.getQueryData<ApiDocumentSummary[]>(studyKeys.documents(uid));
      queryClient.setQueryData<ApiDocumentSummary[]>(studyKeys.documents(uid), (prev = []) => {
        const next = prev.filter((d) => d.id !== docId);
        writeLocalCache(docsStorageKey(uid), next);
        return next;
      });
      return () => {
        if (previous) {
          queryClient.setQueryData(studyKeys.documents(uid), previous);
          writeLocalCache(docsStorageKey(uid), previous);
        }
      };
    },
    [queryClient, uid],
  );

  const refresh = useCallback(async () => {
    if (!uid) return;
    await queryClient.invalidateQueries({ queryKey: studyKeys.documents(uid) });
  }, [queryClient, uid]);

  const loading = Boolean(uid) && query.isPending && !query.data;

  return { docs, setDocs, loading, refresh, upsertDocument, removeDocument };
}

export function useStudyHistory(type?: ApiHistoryItem["type"]) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const uid = user?.uid ?? "";

  const persisted = useMemo(
    () => (uid ? readLocalCache<ApiHistoryItem[]>(historyStorageKey(uid)) : null),
    [uid],
  );

  const query = useQuery({
    queryKey: studyKeys.history(uid),
    queryFn: () => fetchAllStudyHistory(uid),
    enabled: Boolean(uid),
    staleTime: STUDY_CACHE_STALE_MS,
    ...(persisted
      ? { initialData: persisted.data, initialDataUpdatedAt: persisted.updatedAt }
      : {}),
  });

  const allItems = useMemo(() => query.data ?? [], [query.data]);
  const items = useMemo(
    () => (type ? allItems.filter((item) => item.type === type) : allItems),
    [allItems, type],
  );

  const prependHistoryItem = useCallback(
    (rawItem: ApiHistoryItem) => {
      if (!uid) return;
      const enriched = enrichHistoryItem(rawItem);
      queryClient.setQueryData<ApiHistoryItem[]>(studyKeys.history(uid), (prev = []) => {
        const next = [enriched, ...prev.filter((i) => i.id !== enriched.id)].slice(0, 100);
        writeLocalCache(historyStorageKey(uid), next);
        return next;
      });
    },
    [queryClient, uid],
  );

  const removeHistoryItem = useCallback(
    (id: string): (() => void) => {
      if (!uid) return () => undefined;
      const previous = queryClient.getQueryData<ApiHistoryItem[]>(studyKeys.history(uid));
      queryClient.setQueryData<ApiHistoryItem[]>(studyKeys.history(uid), (prev = []) => {
        const next = prev.filter((i) => i.id !== id);
        writeLocalCache(historyStorageKey(uid), next);
        return next;
      });
      return () => {
        if (previous) {
          queryClient.setQueryData(studyKeys.history(uid), previous);
          writeLocalCache(historyStorageKey(uid), previous);
        }
      };
    },
    [queryClient, uid],
  );

  const refresh = useCallback(async () => {
    if (!uid) return;
    await queryClient.invalidateQueries({ queryKey: studyKeys.history(uid) });
  }, [queryClient, uid]);

  const loading = Boolean(uid) && query.isPending && !query.data;

  return {
    items,
    allItems,
    loading,
    refresh,
    prependHistoryItem,
    removeHistoryItem,
  };
}

export function useDocumentPages() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const uid = user?.uid ?? "";

  const fetchDocumentPages = useCallback(
    async (docId: string): Promise<{ pageNumber: number; text: string }[]> => {
      if (!uid || !docId) return [];
      const doc = await queryClient.fetchQuery({
        queryKey: studyKeys.documentDetail(uid, docId),
        queryFn: async () => {
          const res = await apiRequest<{ document: ApiDocumentItem }>(`/api/documents/${docId}`);
          return res.document;
        },
        staleTime: DOC_DETAIL_STALE_MS,
      });
      return doc.pages ?? [];
    },
    [queryClient, uid],
  );

  const prefetchDocumentPages = useCallback(
    (docId: string) => {
      if (!uid || !docId) return;
      void queryClient.prefetchQuery({
        queryKey: studyKeys.documentDetail(uid, docId),
        queryFn: async () => {
          const res = await apiRequest<{ document: ApiDocumentItem }>(`/api/documents/${docId}`);
          return res.document;
        },
        staleTime: DOC_DETAIL_STALE_MS,
      });
    },
    [queryClient, uid],
  );

  return { fetchDocumentPages, prefetchDocumentPages };
}

export function WorkspaceDataSync() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const uid = user?.uid ?? "";

  useEffect(() => {
    if (!uid) return;

    // Seed QueryClient immediately from localStorage if empty, then prefetch stale/missing data
    // in parallel so every tab (Dashboard, Tutor, Library, Notes, Quiz, History) opens in 0ms.
    const cachedDocs = readLocalCache<ApiDocumentSummary[]>(docsStorageKey(uid));
    if (cachedDocs && !queryClient.getQueryData(studyKeys.documents(uid))) {
      queryClient.setQueryData(studyKeys.documents(uid), cachedDocs.data, {
        updatedAt: cachedDocs.updatedAt,
      });
    }

    const cachedHistory = readLocalCache<ApiHistoryItem[]>(historyStorageKey(uid));
    if (cachedHistory && !queryClient.getQueryData(studyKeys.history(uid))) {
      queryClient.setQueryData(studyKeys.history(uid), cachedHistory.data, {
        updatedAt: cachedHistory.updatedAt,
      });
    }

    void queryClient.prefetchQuery({
      queryKey: studyKeys.documents(uid),
      queryFn: () => fetchStudyDocumentSummaries(uid),
      staleTime: STUDY_CACHE_STALE_MS,
    });

    void queryClient.prefetchQuery({
      queryKey: studyKeys.history(uid),
      queryFn: () => fetchAllStudyHistory(uid),
      staleTime: STUDY_CACHE_STALE_MS,
    });
  }, [queryClient, uid]);

  useEffect(() => {
    if (!uid || typeof window === "undefined") return;

    const docsKey = docsStorageKey(uid);
    const histKey = historyStorageKey(uid);

    const onStorage = (event: StorageEvent) => {
      if (event.key === docsKey) {
        const next = readLocalCache<ApiDocumentSummary[]>(docsKey);
        if (next) {
          queryClient.setQueryData(studyKeys.documents(uid), next.data, {
            updatedAt: next.updatedAt,
          });
        }
      } else if (event.key === histKey) {
        const next = readLocalCache<ApiHistoryItem[]>(histKey);
        if (next) {
          queryClient.setQueryData(studyKeys.history(uid), next.data, {
            updatedAt: next.updatedAt,
          });
        }
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [queryClient, uid]);

  return null;
}

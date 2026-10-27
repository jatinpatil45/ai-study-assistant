import { describe, expect, it, vi, beforeEach } from "vitest";
import * as firebaseConfig from "@/backend/config/firebase";
import { clearVerifiedTokenCache, FirebaseAdminTokenVerifier } from "@/backend/middleware/auth";
import { FirestoreStudyRepository } from "@/backend/services/repository";
import type { DocumentRecord, HistoryRecord } from "@/backend/types";

describe("Tab Load Performance Optimizations", () => {
  beforeEach(() => {
    clearVerifiedTokenCache();
    vi.restoreAllMocks();
  });

  it("verifies Firebase ID tokens locally (without checkRevoked RPC) and caches verified tokens", async () => {
    const verifyIdTokenSpy = vi.fn(async () => ({
      uid: "uid-fast",
      email: "fast@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));

    vi.spyOn(firebaseConfig, "getFirebaseServices").mockReturnValue({
      auth: {
        verifyIdToken: verifyIdTokenSpy,
      } as unknown as firebaseConfig.FirebaseServices["auth"],
      firestore: {} as firebaseConfig.FirebaseServices["firestore"],
      storage: {} as firebaseConfig.FirebaseServices["storage"],
    });

    const verifier = new FirebaseAdminTokenVerifier();

    const first = await verifier.verifyIdToken("valid-jwt-token");
    const second = await verifier.verifyIdToken("valid-jwt-token");
    const third = await verifier.verifyIdToken("valid-jwt-token");

    expect(first).toEqual({ uid: "uid-fast", email: "fast@example.com" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // Must only verify once and must NOT pass checkRevoked=true (which triggers a remote Google RPC)
    expect(verifyIdTokenSpy).toHaveBeenCalledTimes(1);
    expect(verifyIdTokenSpy).toHaveBeenCalledWith("valid-jwt-token");
  });

  it("projects lightweight summary fields without PDF pages and keeps per-user caches coherent on writes", async () => {
    const storedDocs = new Map<string, DocumentRecord>();
    const storedHistory = new Map<string, HistoryRecord>();
    let docListReads = 0;
    let historyListReads = 0;
    let capturedProjectedFields: string[] = [];

    const fakeFirestore = {
      collection(name: string) {
        if (name === "documents") {
          return {
            doc(id: string) {
              return {
                async set(data: DocumentRecord) {
                  storedDocs.set(id, structuredClone(data));
                },
                async get() {
                  const found = storedDocs.get(id);
                  return { exists: Boolean(found), data: () => found };
                },
                async delete() {
                  storedDocs.delete(id);
                },
              };
            },
            where(_field: string, _op: string, uid: string) {
              return {
                select(...fields: string[]) {
                  capturedProjectedFields = fields;
                  return {
                    async get() {
                      docListReads += 1;
                      const matching = [...storedDocs.values()].filter((d) => d.uid === uid);
                      return {
                        docs: matching.map((d) => ({
                          data: () => {
                            const projected: Record<string, unknown> = {};
                            for (const f of fields) {
                              projected[f] = d[f as keyof DocumentRecord];
                            }
                            return projected;
                          },
                        })),
                      };
                    },
                  };
                },
                async get() {
                  docListReads += 1;
                  const matching = [...storedDocs.values()].filter((d) => d.uid === uid);
                  return { docs: matching.map((d) => ({ data: () => d })) };
                },
              };
            },
          };
        }

        if (name === "history") {
          return {
            doc(id: string) {
              return {
                async set(data: HistoryRecord) {
                  storedHistory.set(id, structuredClone(data));
                },
                async get() {
                  const found = storedHistory.get(id);
                  return { exists: Boolean(found), data: () => found };
                },
                async delete() {
                  storedHistory.delete(id);
                },
              };
            },
            where(_field: string, _op: string, uid: string) {
              return {
                async get() {
                  historyListReads += 1;
                  const matching = [...storedHistory.values()].filter((h) => h.uid === uid);
                  return { docs: matching.map((h) => ({ data: () => h })) };
                },
              };
            },
          };
        }

        throw new Error(`Unexpected collection ${name}`);
      },
    };

    vi.spyOn(firebaseConfig, "getFirebaseServices").mockReturnValue({
      auth: {} as firebaseConfig.FirebaseServices["auth"],
      firestore: fakeFirestore as unknown as firebaseConfig.FirebaseServices["firestore"],
      storage: {} as firebaseConfig.FirebaseServices["storage"],
    });

    const repo = new FirestoreStudyRepository();

    await repo.createDocument({
      id: "doc-1",
      uid: "uid-alice",
      title: "Algorithms Textbook",
      subject: "CS",
      fileName: "algo.pdf",
      mimeType: "application/pdf",
      sizeBytes: 204800,
      sizeFormatted: "200.0 KB",
      storagePath: "users/uid-alice/documents/doc-1/algo.pdf",
      pageCount: 100,
      pages: [{ pageNumber: 1, text: "Large extracted page text..." }],
      status: "ready",
      createdAt: "2026-10-27T10:00:00.000Z",
      updatedAt: "2026-10-27T10:00:00.000Z",
    });

    // First tab load fetches projected summaries (excluding heavy `pages` field)
    const firstDocs = await repo.listDocumentSummariesByUid("uid-alice");
    expect(firstDocs).toHaveLength(1);
    expect(capturedProjectedFields).toContain("title");
    expect(capturedProjectedFields).not.toContain("pages");
    expect((firstDocs[0] as unknown as Record<string, unknown>)["pages"]).toBeUndefined();
    expect(docListReads).toBe(1);

    // Subsequent tab switches read warm cache with zero extra Firestore queries
    const secondDocs = await repo.listDocumentSummariesByUid("uid-alice");
    expect(secondDocs).toHaveLength(1);
    expect(docListReads).toBe(1);

    // Uploading a second document updates warm cache coherently without extra list reads
    await repo.createDocument({
      id: "doc-2",
      uid: "uid-alice",
      title: "Networks Notes",
      subject: "CN",
      fileName: "cn.pdf",
      mimeType: "application/pdf",
      sizeBytes: 102400,
      sizeFormatted: "100.0 KB",
      storagePath: "users/uid-alice/documents/doc-2/cn.pdf",
      pageCount: 25,
      pages: [{ pageNumber: 1, text: "TCP/IP stack..." }],
      status: "ready",
      createdAt: "2026-10-27T11:00:00.000Z",
      updatedAt: "2026-10-27T11:00:00.000Z",
    });

    const afterUpload = await repo.listDocumentSummariesByUid("uid-alice");
    expect(afterUpload.map((d) => d.id)).toEqual(["doc-2", "doc-1"]);
    expect(docListReads).toBe(1);

    // Deleting a document updates warm cache immediately
    await repo.deleteDocumentById("doc-1");
    const afterDelete = await repo.listDocumentSummariesByUid("uid-alice");
    expect(afterDelete.map((d) => d.id)).toEqual(["doc-2"]);
    expect(docListReads).toBe(1);

    // History list also warms across all tabs & filters in memory
    await repo.createHistoryItem({
      id: "h-1",
      uid: "uid-alice",
      type: "chat",
      title: "Explain Dijkstra",
      documentId: "doc-2",
      documentTitle: "Networks Notes",
      payload: { question: "Explain Dijkstra", answer: "Shortest path algorithm" },
      createdAt: "2026-10-27T12:00:00.000Z",
    });

    const allHistory = await repo.listHistoryByUid("uid-alice");
    expect(allHistory).toHaveLength(1);
    expect(historyListReads).toBe(1);

    const chatHistory = await repo.listHistoryByUid("uid-alice", { type: "chat" });
    expect(chatHistory).toHaveLength(1);
    expect(historyListReads).toBe(1);
  });
});

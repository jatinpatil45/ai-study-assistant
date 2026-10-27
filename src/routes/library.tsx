import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  FileText,
  Search,
  UploadCloud,
  LayoutGrid,
  List,
  Eye,
  Trash2,
  RotateCw,
  AlertCircle,
  FolderOpen,
} from "lucide-react";
import { AppShell, DemoNote, EmptyState, StatusBadge } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, useAuth } from "@/lib/firebase-client";
import {
  useDocumentPages,
  useStudyDocuments,
  useStudyHistory,
  type ApiDocumentSummary,
  type StudyDocView,
} from "@/lib/study-api";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "My Library — StudyMate AI" },
      { name: "description", content: "Upload and manage your study PDFs." },
      { property: "og:title", content: "My Library — StudyMate AI" },
      { property: "og:description", content: "Your uploaded textbooks and lecture notes." },
    ],
  }),
  component: LibraryPage,
});

function LibraryPage() {
  const { user } = useAuth();
  const { docs, loading, upsertDocument, removeDocument } = useStudyDocuments();
  const { prependHistoryItem } = useStudyHistory();
  const { fetchDocumentPages, prefetchDocumentPages } = useDocumentPages();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [drag, setDrag] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const [preview, setPreview] = useState<StudyDocView | null>(null);
  const [previewPages, setPreviewPages] = useState<{ pageNumber: number; text: string }[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const openPreview = async (doc: StudyDocView) => {
    setPreview(doc);
    setPreviewPages([]);
    setPreviewLoading(true);
    try {
      const pages = await fetchDocumentPages(doc.id);
      setPreviewPages(pages);
    } catch {
      setPreviewPages([]);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleUploadFiles = (files: FileList | null) => {
    if (!files?.length) return;
    Array.from(files).forEach((f) => {
      if (!f.name.toLowerCase().endsWith(".pdf")) {
        toast.error(`${f.name} isn't a PDF`, { description: "Only PDF files are supported." });
        return;
      }
      setUploads((u) => [...u, { name: f.name, progress: 25 }]);
      const fd = new FormData();
      fd.append("file", f);
      fd.append("title", f.name.replace(/\.pdf$/i, ""));
      fd.append("subject", "Uploaded PDF");

      void (async () => {
        try {
          setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, progress: 65 } : x)));
          const res = await apiRequest<{ document: ApiDocumentSummary }>("/api/documents", {
            method: "POST",
            body: fd,
          });
          setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, progress: 100 } : x)));
          upsertDocument(res.document);
          prependHistoryItem({
            id: `upload-${res.document.id}`,
            uid: user?.uid ?? res.document.uid,
            type: "document",
            title: `Uploaded: ${res.document.title}`,
            documentId: res.document.id,
            documentTitle: res.document.title,
            payload: {
              subject: res.document.subject,
              pageCount: res.document.pageCount,
              sizeFormatted: res.document.sizeFormatted,
            },
            createdAt: res.document.createdAt,
          });
          toast.success("PDF uploaded & indexed", {
            description: `${res.document.title} (${res.document.pageCount} pages ready for AI study).`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Could not process PDF file.";
          toast.error(`Upload failed for ${f.name}`, { description: msg });
        } finally {
          setUploads((u) => u.filter((x) => x.name !== f.name));
        }
      })();
    });
  };

  const handleDelete = async (doc: StudyDocView) => {
    const rollback = removeDocument(doc.id);
    try {
      await apiRequest(`/api/documents/${doc.id}`, { method: "DELETE" });
      toast.success("Document deleted", {
        description: `${doc.title} was removed from your library.`,
      });
    } catch (err) {
      rollback();
      toast.error("Could not delete document", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    }
  };

  const filtered = docs.filter(
    (d) =>
      (status === "all" || d.status === status) && d.title.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <AppShell
      title="My Library"
      actions={
        <Button size="sm" onClick={() => fileRef.current?.click()}>
          <UploadCloud className="mr-1.5 h-4 w-4" />
          Upload PDF
        </Button>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        multiple
        hidden
        onChange={(e) => handleUploadFiles(e.target.files)}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          handleUploadFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          drag ? "border-primary bg-primary-soft" : "bg-card"
        }`}
      >
        <span className="grid h-12 w-12 place-items-center rounded-full bg-primary-soft text-primary">
          <UploadCloud className="h-6 w-6" />
        </span>
        <p className="mt-3 font-semibold">{drag ? "Drop to upload" : "Drag & drop PDFs here"}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Textbooks, lecture slides or notes · up to 20 MB each
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => fileRef.current?.click()}
        >
          Browse files
        </Button>
      </div>

      {uploads.length > 0 && (
        <div className="mt-4 space-y-2">
          {uploads.map((u) => (
            <div key={u.name} className="rounded-lg border bg-card p-3">
              <div className="mb-2 flex justify-between text-sm">
                <span className="truncate font-medium">{u.name}</span>
                <span className="text-muted-foreground">{u.progress}%</span>
              </div>
              <Progress value={u.progress} className="h-1.5" />
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your library"
            className="bg-card pl-9"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="bg-card sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ready">Ready</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex rounded-lg border bg-card p-0.5">
          <Button
            variant={view === "grid" ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            aria-label="Grid view"
            onClick={() => setView("grid")}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            aria-label="List view"
            onClick={() => setView("list")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-4">
        {loading && docs.length === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex flex-col rounded-xl border bg-card p-4 shadow-card">
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <Skeleton className="mt-3 h-4 w-3/4" />
                <Skeleton className="mt-2 h-3 w-1/2" />
                <div className="mt-4 flex gap-2 border-t pt-3">
                  <Skeleton className="h-8 flex-1 rounded-md" />
                  <Skeleton className="h-8 w-8 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="No documents found"
            description={
              q
                ? `Nothing matches "${q}". Try a different search or filter.`
                : "Upload your first PDF to start studying with AI."
            }
            action={
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                Upload PDF
              </Button>
            }
          />
        ) : view === "grid" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((d) => (
              <div key={d.id} className="flex flex-col rounded-xl border bg-card p-4 shadow-card">
                <div className="flex items-start justify-between gap-2">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary-soft text-primary">
                    <FileText className="h-5 w-5" />
                  </span>
                  <StatusBadge status={d.status} progress={d.progress} />
                </div>
                <p className="mt-3 line-clamp-2 text-sm font-semibold">{d.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.subject} · {d.pages || "—"} pages · {d.size}
                </p>
                {d.status === "processing" && <Progress value={d.progress} className="mt-3 h-1" />}
                {d.status === "failed" && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Couldn't read text from this scan.
                  </p>
                )}
                <div className="mt-4 flex gap-2 border-t pt-3">
                  {d.status === "failed" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => fileRef.current?.click()}
                    >
                      <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                      Re-upload
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      disabled={d.status !== "ready"}
                      onMouseEnter={() => {
                        if (d.status === "ready") prefetchDocumentPages(d.id);
                      }}
                      onClick={() => void openPreview(d)}
                    >
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                      Preview
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Delete document"
                    onClick={() => void handleDelete(d)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">Subject</th>
                  <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Uploaded</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((d) => (
                  <tr key={d.id} className="hover:bg-muted/40">
                    <td className="max-w-[240px] truncate px-4 py-3 font-medium">{d.title}</td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {d.subject}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                      {d.uploaded}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={d.status} progress={d.progress} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={d.status !== "ready"}
                        onMouseEnter={() => {
                          if (d.status === "ready") prefetchDocumentPages(d.id);
                        }}
                        onClick={() => void openPreview(d)}
                      >
                        Preview
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Sheet open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{preview?.title}</SheetTitle>
            <SheetDescription>
              {preview?.subject} · {preview?.pages} pages
            </SheetDescription>
          </SheetHeader>
          {previewLoading ? (
            <div className="mt-4 space-y-3 rounded-lg border bg-muted/40 p-6">
              <p className="text-xs font-medium text-muted-foreground">Loading extracted pages…</p>
              <Skeleton className="h-5 w-2/3" />
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-3" style={{ width: `${70 + ((i * 13) % 30)}%` }} />
              ))}
            </div>
          ) : previewPages.length > 0 ? (
            <div className="mt-4 space-y-3">
              {previewPages.map((p) => (
                <div key={p.pageNumber} className="rounded-lg border bg-muted/40 p-4">
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
                    Page {p.pageNumber}
                  </p>
                  <p className="whitespace-pre-line text-xs leading-relaxed text-foreground/90">
                    {p.text}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-lg border bg-muted/40 p-6 text-xs text-muted-foreground">
              Extracted text preview is ready for AI Tutor, Notes, and Quizzes.
            </div>
          )}
        </SheetContent>
      </Sheet>
      <DemoNote />
    </AppShell>
  );
}

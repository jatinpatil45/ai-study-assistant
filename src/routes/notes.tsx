import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Download, NotebookPen, Sparkles, AlertTriangle } from "lucide-react";
import { AppShell, DemoNote, EmptyState, SectionCard } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, useAuth } from "@/lib/firebase-client";
import { useStudyDocuments, useStudyHistory } from "@/lib/study-api";

export const Route = createFileRoute("/notes")({
  head: () => ({
    meta: [
      { title: "AI Notes — StudyMate AI" },
      {
        name: "description",
        content:
          "Generate summaries, chapter notes, definitions and revision sheets from your PDFs.",
      },
      { property: "og:title", content: "AI Notes — StudyMate AI" },
      { property: "og:description", content: "Turn textbooks into revision-ready notes." },
    ],
  }),
  component: Notes,
});

const types = [
  { id: "summary", label: "Summary", desc: "Concise overview" },
  { id: "chapter", label: "Chapter-wise notes", desc: "Structured by chapter" },
  { id: "definitions", label: "Key definitions", desc: "Terms & meanings" },
  { id: "simple", label: "Simple explanation", desc: "Beginner friendly" },
  { id: "revision", label: "Revision notes", desc: "Last-minute bullets" },
] as const;

type NoteOutput = {
  title: string;
  sections: { heading: string; bullets: string[] }[];
  sourceRange: string;
};

const sample: NoteOutput = {
  title: "CPU Scheduling — Summary",
  sections: [
    {
      heading: "Overview",
      bullets: [
        "CPU scheduling decides which ready process runs next to maximise CPU utilisation and minimise waiting time.",
      ],
    },
    {
      heading: "Key algorithms",
      bullets: [
        "FCFS — simple, non-preemptive, can cause convoy effect.",
        "SJF — optimal average waiting time, risk of starvation.",
        "Priority — may starve low priority; solved with aging.",
        "Round Robin — time quantum based, good response time.",
      ],
    },
    {
      heading: "Criteria",
      bullets: ["CPU utilisation, throughput, turnaround time, waiting time, response time."],
    },
  ],
  sourceRange: "Operating Systems — Galvin, pp. 1–4",
};

function Notes() {
  const { user } = useAuth();
  const { docs } = useStudyDocuments();
  const { prependHistoryItem } = useStudyHistory();
  const [doc, setDoc] = useState("");
  const [type, setType] = useState<(typeof types)[number]["id"]>("summary");
  const [topic, setTopic] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [note, setNote] = useState<NoteOutput>(sample);

  useEffect(() => {
    if (!doc && docs[0]) {
      setDoc(docs[0].id);
    }
  }, [doc, docs]);

  const generate = async () => {
    const selectedDoc = docs.find((d) => d.id === doc) ?? docs[0];
    if (!selectedDoc) {
      toast.error("Please upload or select a document first.");
      return;
    }
    if (selectedDoc.status === "failed") {
      setErrorMessage(
        "This document failed processing, so there's no text to work with. Re-upload a clearer PDF from My Library.",
      );
      setState("error");
      return;
    }

    setState("loading");
    setErrorMessage("");
    try {
      if (type === "simple") {
        const targetTopic = topic.trim() || selectedDoc.title;
        const res = await apiRequest<{
          id?: string;
          topic: string;
          explanation: string;
          keyTakeaways: string[];
          sources: string[];
          createdAt?: string;
        }>("/api/ai/explain", {
          method: "POST",
          body: {
            documentId: selectedDoc.id,
            topic: targetTopic,
            level: "beginner",
          },
        });
        setNote({
          title: `${res.topic} — Simple Explanation`,
          sections: [
            { heading: "Simple Explanation", bullets: [res.explanation] },
            { heading: "Key Takeaways", bullets: res.keyTakeaways },
          ],
          sourceRange: res.sources.length > 0 ? res.sources.join(" · ") : selectedDoc.title,
        });
        if (res.id) {
          prependHistoryItem({
            id: res.id,
            uid: user?.uid ?? "",
            type: "explanation",
            title: `Explanation: ${res.topic.slice(0, 100)}`,
            documentId: selectedDoc.id,
            documentTitle: selectedDoc.title,
            payload: {
              topic: res.topic,
              level: "beginner",
              explanation: res.explanation,
              keyTakeaways: res.keyTakeaways,
              sources: res.sources,
            },
            createdAt: res.createdAt ?? new Date().toISOString(),
          });
        }
      } else {
        const res = await apiRequest<{
          id?: string;
          title: string;
          summary: string;
          sections: { heading: string; bullets: string[] }[];
          sources: string[];
          createdAt?: string;
        }>("/api/ai/summarize", {
          method: "POST",
          body: {
            documentId: selectedDoc.id,
            style: type,
          },
        });
        setNote({
          title: res.title,
          sections: [{ heading: "Executive Summary", bullets: [res.summary] }, ...res.sections],
          sourceRange: res.sources.length > 0 ? res.sources.join(" · ") : selectedDoc.title,
        });
        if (res.id) {
          prependHistoryItem({
            id: res.id,
            uid: user?.uid ?? "",
            type: "note",
            title: res.title,
            documentId: selectedDoc.id,
            documentTitle: selectedDoc.title,
            payload: {
              style: type,
              summary: res.summary,
              sections: res.sections,
              sources: res.sources,
            },
            createdAt: res.createdAt ?? new Date().toISOString(),
          });
        }
      }
      setState("done");
      toast.success("Notes generated & saved to Study History");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not generate notes right now.";
      setErrorMessage(msg);
      setState("error");
      toast.error("Failed to generate notes", { description: msg });
    }
  };

  const formatMarkdown = () => {
    const lines = [`# ${note.title}`, ""];
    for (const s of note.sections) {
      lines.push(`## ${s.heading}`);
      for (const b of s.bullets) {
        lines.push(`- ${b}`);
      }
      lines.push("");
    }
    lines.push(`_Source: ${note.sourceRange}_`);
    return lines.join("\n");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatMarkdown());
      toast.success("Copied notes to clipboard");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  const handleDownload = () => {
    const md = formatMarkdown();
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${note.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Downloaded Markdown notes");
  };

  return (
    <AppShell title="AI Notes">
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <SectionCard title="Generate notes" description="Pick a document and note style">
          <label className="text-xs font-medium text-muted-foreground">Document</label>
          <Select value={doc || (docs[0]?.id ?? "")} onValueChange={setDoc}>
            <SelectTrigger className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {docs.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-4 text-xs font-medium text-muted-foreground">Note type</p>
          <div className="mt-1.5 space-y-1.5">
            {types.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setType(t.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                  type === t.id ? "border-primary bg-primary-soft" : "hover:bg-muted"
                }`}
              >
                <p className={`text-sm font-medium ${type === t.id ? "text-primary" : ""}`}>
                  {t.label}
                </p>
                <p className="text-xs text-muted-foreground">{t.desc}</p>
              </button>
            ))}
          </div>
          {type === "simple" && (
            <div className="mt-3">
              <label className="text-xs font-medium text-muted-foreground">
                Specific concept or topic (optional)
              </label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Deadlock prevention, BCNF, TCP 3-way handshake"
                className="mt-1.5"
              />
            </div>
          )}
          <Button
            className="mt-4 w-full"
            onClick={() => void generate()}
            disabled={state === "loading"}
          >
            <Sparkles className="mr-1.5 h-4 w-4" />
            {state === "loading" ? "Generating with Gemini…" : "Generate notes"}
          </Button>
        </SectionCard>

        <div>
          {state === "idle" && (
            <EmptyState
              icon={NotebookPen}
              title="No notes yet"
              description="Choose a document and a note type, then generate."
            />
          )}
          {state === "loading" && (
            <SectionCard>
              <Skeleton className="h-6 w-1/2" />
              <div className="mt-6 space-y-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-4" style={{ width: `${60 + ((i * 17) % 40)}%` }} />
                ))}
              </div>
            </SectionCard>
          )}
          {state === "error" && (
            <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
              <div>
                <p className="font-semibold">Couldn't generate notes</p>
                <p className="mt-1 text-sm text-muted-foreground">{errorMessage}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => {
                    const ready = docs.find((d) => d.status === "ready");
                    if (ready) setDoc(ready.id);
                    setState("done");
                  }}
                >
                  Choose another document
                </Button>
              </div>
            </div>
          )}
          {state === "done" && (
            <SectionCard
              title={note.title}
              description={`${types.find((t) => t.id === type)?.label ?? "Notes"}`}
              action={
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Copy notes"
                    onClick={() => void handleCopy()}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Download notes"
                    onClick={handleDownload}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              }
            >
              <div className="space-y-5">
                {note.sections.map((s) => (
                  <div key={s.heading}>
                    <h3 className="text-sm font-semibold text-primary">{s.heading}</h3>
                    <ul className="mt-2 space-y-1.5 text-sm leading-relaxed">
                      {s.bullets.map((b) => (
                        <li key={b} className="flex gap-2">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  Source: {note.sourceRange}
                </p>
              </div>
            </SectionCard>
          )}
        </div>
      </div>
      <DemoNote />
    </AppShell>
  );
}

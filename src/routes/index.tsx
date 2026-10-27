import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  FileText,
  MessageSquareText,
  NotebookPen,
  ListChecks,
  Search,
  Upload,
  ArrowRight,
  FolderOpen,
  Target,
} from "lucide-react";
import { AppShell, EmptyState, SectionCard, StatusBadge } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/firebase-client";
import { formatRelativeTime, useStudyDocuments, useStudyHistory } from "@/lib/study-api";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard — StudyMate AI" },
      {
        name: "description",
        content:
          "Your study overview: recent documents, AI conversations, activity and quiz performance.",
      },
      { property: "og:title", content: "Dashboard — StudyMate AI" },
      { property: "og:description", content: "Your personal AI study assistant dashboard." },
    ],
  }),
  component: Dashboard,
});

const quick = [
  {
    title: "Ask AI Tutor",
    desc: "Get explanations from your PDFs",
    icon: MessageSquareText,
    to: "/tutor",
  },
  { title: "Generate Notes", desc: "Summaries & revision sheets", icon: NotebookPen, to: "/notes" },
  { title: "Practice Quiz", desc: "Test yourself with MCQs", icon: ListChecks, to: "/quiz" },
  { title: "Upload PDF", desc: "Add notes or textbooks", icon: Upload, to: "/library" },
] as const;

function Dashboard() {
  const { displayName } = useAuth();
  const { docs, loading: docsLoading } = useStudyDocuments();
  const { items: historyItems, loading: historyLoading } = useStudyHistory();
  const [search, setSearch] = useState("");

  const firstName = displayName.split(" ")[0] || "Student";
  const filteredDocs = search.trim()
    ? docs.filter(
        (d) =>
          d.title.toLowerCase().includes(search.toLowerCase()) ||
          d.subject.toLowerCase().includes(search.toLowerCase()),
      )
    : docs;

  const recentChats = historyItems.filter((i) => i.type === "chat").slice(0, 3);
  const quizAttempts = historyItems.filter((i) => i.type === "quiz_attempt");
  const avgQuizScore =
    quizAttempts.length > 0
      ? `${Math.round(
          quizAttempts.reduce(
            (acc, a) =>
              acc + (a.percent ?? (a.total ? Math.round(((a.score ?? 0) / a.total) * 100) : 0)),
            0,
          ) / quizAttempts.length,
        )}%`
      : "—";

  const quizChartData = [...quizAttempts].reverse().map((a, idx) => ({
    attempt: `Q${idx + 1}`,
    score: a.percent ?? (a.total ? Math.round(((a.score ?? 0) / a.total) * 100) : 0),
  }));

  return (
    <AppShell
      title="Dashboard"
      actions={
        <Button asChild size="sm" className="hidden sm:inline-flex">
          <Link to="/library">
            <Upload className="mr-1.5 h-4 w-4" />
            Upload document
          </Link>
        </Button>
      }
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Personal AI Study Workspace</p>
          <h2 className="mt-1 text-2xl font-bold">Welcome, {firstName}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {docs.length === 0
              ? "Your workspace is fresh and ready. Upload your first PDF textbook or notes to start studying."
              : `You have ${docs.length} study document${docs.length === 1 ? "" : "s"} indexed and ready for AI Q&A, notes, and quizzes.`}
          </p>
        </div>
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your documents…"
            className="bg-card pl-9"
          />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {quick.map((q) => (
          <Link
            key={q.title}
            to={q.to}
            className="group rounded-xl border bg-card p-4 shadow-card transition hover:border-primary/40"
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary-soft text-primary">
              <q.icon className="h-4.5 w-4.5" />
            </span>
            <p className="mt-3 text-sm font-semibold">{q.title}</p>
            <p className="text-xs text-muted-foreground">{q.desc}</p>
          </Link>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {[
          { i: FileText, l: "Uploaded PDFs", v: String(docs.length) },
          {
            i: MessageSquareText,
            l: "AI Tutor chats",
            v: String(historyItems.filter((i) => i.type === "chat").length),
          },
          { i: Target, l: "Avg. quiz score", v: avgQuizScore },
        ].map((s) => (
          <div
            key={s.l}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card"
          >
            <s.i className="hidden h-5 w-5 text-primary sm:block" />
            <div>
              <p className="font-display text-xl font-bold">{s.v}</p>
              <p className="text-xs text-muted-foreground">{s.l}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Recent documents"
          className="lg:col-span-2"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/library">
                View all
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          }
        >
          {docsLoading ? (
            <div className="space-y-3 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredDocs.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="No documents uploaded yet"
              description="Upload a PDF textbook or lecture notes to unlock AI Tutor Q&A, summaries, and practice quizzes."
              action={
                <Button asChild size="sm">
                  <Link to="/library">Upload your first PDF</Link>
                </Button>
              }
            />
          ) : (
            <ul className="divide-y">
              {filteredDocs.slice(0, 4).map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <FileText className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.subject} · {d.pages} pages · {d.uploaded}
                    </p>
                  </div>
                  <StatusBadge status={d.status} progress={d.progress} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard
          title="Recent AI conversations"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link to="/tutor">Open</Link>
            </Button>
          }
        >
          {historyLoading ? (
            <div className="space-y-3 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          ) : recentChats.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm font-medium">No conversations yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Ask questions about your PDFs in AI Tutor and they will appear here.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {recentChats.map((c) => (
                <li key={c.id}>
                  <Link to="/tutor" className="-m-2 block rounded-lg p-2 hover:bg-muted">
                    <p className="truncate text-sm font-medium">{c.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{c.preview}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {formatRelativeTime(c.createdAt)} · {c.documentTitle}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        {quizChartData.length > 0 && (
          <SectionCard
            title="Quiz performance"
            description="Score % over your attempts"
            className="lg:col-span-3"
          >
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={quizChartData}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis
                    dataKey="attempt"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    stroke="var(--muted-foreground)"
                  />
                  <YAxis
                    domain={[0, 100]}
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={30}
                    stroke="var(--muted-foreground)"
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="score"
                    stroke="var(--chart-1)"
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </SectionCard>
        )}
      </div>
    </AppShell>
  );
}

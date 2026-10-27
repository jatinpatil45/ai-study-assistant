import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FileText, MessageSquareText, NotebookPen, Trash2 } from "lucide-react";
import { AppShell, SectionCard, StatusBadge } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest } from "@/lib/firebase-client";
import { formatRelativeTime, useStudyDocuments, useStudyHistory } from "@/lib/study-api";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Study History — StudyMate AI" },
      {
        name: "description",
        content: "Review past chats, notes, uploads, quiz attempts and progress.",
      },
      { property: "og:title", content: "Study History — StudyMate AI" },
      { property: "og:description", content: "Track your study progress over time." },
    ],
  }),
  component: History,
});

function Row({
  icon: Icon,
  title,
  meta,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  meta: string;
  right?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      {right}
    </li>
  );
}

function History() {
  const { docs } = useStudyDocuments();
  const { items, removeHistoryItem } = useStudyHistory();

  const handleDelete = async (id: string) => {
    const rollback = removeHistoryItem(id);
    try {
      await apiRequest(`/api/history/${id}`, { method: "DELETE" });
      toast.success("History entry removed");
    } catch {
      rollback();
      toast.error("Could not delete history entry");
    }
  };

  const liveChats = items.filter((i) => i.type === "chat");
  const liveNotes = items.filter((i) => i.type === "note" || i.type === "explanation");
  const liveAttempts = items.filter((i) => i.type === "quiz_attempt");

  const chartData = [...liveAttempts].reverse().map((a, idx) => ({
    attempt: `Q${idx + 1}`,
    score: a.percent ?? (a.total ? Math.round(((a.score ?? 0) / a.total) * 100) : 0),
  }));

  const stats = [
    [String(liveChats.length), "AI chats"],
    [String(liveNotes.length), "Notes generated"],
    [String(docs.length), "Documents"],
    [String(liveAttempts.length), "Quizzes taken"],
  ] as const;

  return (
    <AppShell title="Study History">
      <div className="grid gap-4 md:grid-cols-4">
        {stats.map(([v, l]) => (
          <div key={l} className="rounded-xl border bg-card p-4 shadow-card">
            <p className="font-display text-2xl font-bold">{v}</p>
            <p className="text-xs text-muted-foreground">{l}</p>
          </div>
        ))}
      </div>
      {chartData.length > 0 && (
        <SectionCard
          title="Quiz score progress"
          description="Performance across your attempts"
          className="mt-4"
        >
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="attempt"
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                  stroke="var(--muted-foreground)"
                />
                <YAxis
                  domain={[0, 100]}
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
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
                <Area
                  type="monotone"
                  dataKey="score"
                  stroke="var(--chart-1)"
                  strokeWidth={2.5}
                  fill="url(#g)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      )}
      <Tabs defaultValue="quizzes" className="mt-4">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="quizzes">Quiz attempts</TabsTrigger>
          <TabsTrigger value="chats">Chats</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="docs">Uploads</TabsTrigger>
        </TabsList>
        <TabsContent value="quizzes">
          {liveAttempts.length === 0 ? (
            <SectionCard>
              <p className="py-6 text-center text-sm text-muted-foreground">
                No quiz attempts yet. Take a practice quiz from your uploaded PDFs to track your
                scores here.
              </p>
            </SectionCard>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Topic</th>
                    <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Difficulty</th>
                    <th className="px-4 py-2.5 font-medium">Score</th>
                    <th className="px-4 py-2.5 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {liveAttempts.map((a) => {
                    const score = a.score ?? 0;
                    const total = a.total ?? 5;
                    const pct = a.percent ?? Math.round((score / total) * 100);
                    return (
                      <tr key={a.id}>
                        <td className="px-4 py-3">
                          <p className="font-medium">{a.title}</p>
                          <p className="text-xs text-muted-foreground">{a.documentTitle}</p>
                        </td>
                        <td className="hidden px-4 py-3 capitalize sm:table-cell">
                          {a.difficulty ?? "medium"}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`font-semibold ${
                              pct >= 75
                                ? "text-success"
                                : pct >= 60
                                  ? "text-warning"
                                  : "text-destructive"
                            }`}
                          >
                            {score}/{total} ({pct}%)
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatRelativeTime(a.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="chats">
          <SectionCard>
            {liveChats.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No AI Tutor conversations yet.
              </p>
            ) : (
              <ul className="divide-y">
                {liveChats.map((c) => (
                  <Row
                    key={c.id}
                    icon={MessageSquareText}
                    title={c.title}
                    meta={`${c.documentTitle} · ${formatRelativeTime(c.createdAt)}`}
                    right={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => void handleDelete(c.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                  />
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>
        <TabsContent value="notes">
          <SectionCard>
            {liveNotes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No AI notes generated yet.
              </p>
            ) : (
              <ul className="divide-y">
                {liveNotes.map((n) => (
                  <Row
                    key={n.id}
                    icon={NotebookPen}
                    title={n.title}
                    meta={`${n.noteType ?? "Notes"} · ${formatRelativeTime(n.createdAt)}`}
                    right={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => void handleDelete(n.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                  />
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>
        <TabsContent value="docs">
          <SectionCard>
            {docs.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No PDF documents uploaded yet.
              </p>
            ) : (
              <ul className="divide-y">
                {docs.map((d) => (
                  <Row
                    key={d.id}
                    icon={FileText}
                    title={d.title}
                    meta={`${d.subject} · ${d.uploaded}`}
                    right={<StatusBadge status={d.status} />}
                  />
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}

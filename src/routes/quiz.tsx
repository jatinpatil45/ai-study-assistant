import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, XCircle, RotateCcw, Play, Trophy } from "lucide-react";
import { AppShell, DemoNote, SectionCard } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { apiRequest, useAuth } from "@/lib/firebase-client";
import { useStudyDocuments, useStudyHistory } from "@/lib/study-api";

export const Route = createFileRoute("/quiz")({
  head: () => ({
    meta: [
      { title: "Practice Quiz — StudyMate AI" },
      {
        name: "description",
        content: "Practice MCQs generated from your study material with explanations.",
      },
      { property: "og:title", content: "Practice Quiz — StudyMate AI" },
      { property: "og:description", content: "Test yourself and review explanations." },
    ],
  }),
  component: Quiz,
});

type PublicQuizQuestion = {
  id: string;
  question: string;
  options: [string, string, string, string];
  source: string;
};

type GradedItem = {
  questionId: string;
  question: string;
  options: [string, string, string, string];
  selectedIndex: number | null;
  correctIndex: number;
  isCorrect: boolean;
  explanation: string;
  source: string;
};

type GradeResponse = {
  attemptId?: string;
  quizId: string;
  documentId?: string;
  documentTitle?: string;
  difficulty?: string;
  score: number;
  total: number;
  percent: number;
  results: GradedItem[];
  createdAt?: string;
};

function Quiz() {
  const { user } = useAuth();
  const { docs } = useStudyDocuments();
  const { prependHistoryItem } = useStudyHistory();
  const readyDocs = docs.filter((d) => d.status === "ready");
  const [selectedDocId, setSelectedDocId] = useState("");
  const [stage, setStage] = useState<"setup" | "taking" | "result">("setup");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [count, setCount] = useState([5]);
  const [quizId, setQuizId] = useState<string>("");
  const [questions, setQuestions] = useState<PublicQuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [gradeResult, setGradeResult] = useState<GradeResponse | null>(null);

  useEffect(() => {
    if (!selectedDocId && readyDocs[0]) {
      setSelectedDocId(readyDocs[0].id);
    }
  }, [selectedDocId, readyDocs]);

  const handleStartQuiz = async () => {
    const docId = selectedDocId || readyDocs[0]?.id;
    if (!docId) {
      toast.error("Please upload or select a ready document first.");
      return;
    }
    setBusy(true);
    try {
      const requestedCount = Math.min(Math.max(count[0] ?? 5, 1), 15);
      const res = await apiRequest<{
        quizId: string;
        documentTitle: string;
        questions: PublicQuizQuestion[];
      }>("/api/ai/quiz", {
        method: "POST",
        body: {
          documentId: docId,
          count: requestedCount,
          difficulty,
        },
      });
      setQuizId(res.quizId);
      setQuestions(res.questions);
      setAnswers({});
      setCurrent(0);
      setGradeResult(null);
      setStage("taking");
      toast.success("Quiz generated!", { description: `${res.questions.length} questions ready.` });
    } catch (err) {
      toast.error("Failed to generate quiz", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitQuiz = async () => {
    const missing = questions.length - Object.keys(answers).length;
    if (missing > 0) {
      toast.warning(`${missing} unanswered — counted as wrong`);
    }
    setBusy(true);
    try {
      const res = await apiRequest<GradeResponse>("/api/ai/quiz/grade", {
        method: "POST",
        body: {
          quizId,
          answers,
        },
      });
      setGradeResult(res);
      setStage("result");
      const activeDocTitle =
        res.documentTitle ??
        readyDocs.find((d) => d.id === (res.documentId ?? selectedDocId))?.title ??
        "Document";
      const usedDifficulty = res.difficulty ?? difficulty;
      prependHistoryItem({
        id: res.attemptId ?? `attempt-${res.quizId}-${Date.now()}`,
        uid: user?.uid ?? "",
        type: "quiz_attempt",
        title: `Quiz: ${activeDocTitle} (${usedDifficulty})`,
        ...(res.documentId
          ? { documentId: res.documentId }
          : selectedDocId
            ? { documentId: selectedDocId }
            : {}),
        documentTitle: activeDocTitle,
        payload: {
          quizId: res.quizId,
          difficulty: usedDifficulty,
          score: res.score,
          total: res.total,
          percent: res.percent,
          results: res.results,
        },
        createdAt: res.createdAt ?? new Date().toISOString(),
      });
      toast.success(`Quiz graded: ${res.percent}%`);
    } catch (err) {
      toast.error("Could not grade quiz", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (stage === "setup")
    return (
      <AppShell title="Practice Quiz">
        <div className="mx-auto max-w-xl">
          <SectionCard
            title="Configure your quiz"
            description="Questions are generated from the selected document"
          >
            <div className="space-y-5">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Topic / document
                </label>
                <Select
                  value={selectedDocId || (readyDocs[0]?.id ?? "")}
                  onValueChange={setSelectedDocId}
                >
                  <SelectTrigger className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {readyDocs.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Difficulty</p>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {(["easy", "medium", "hard"] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDifficulty(d)}
                      className={`rounded-lg border py-2 text-sm font-medium capitalize ${
                        difficulty === d
                          ? "border-primary bg-primary-soft text-primary"
                          : "hover:bg-muted"
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs font-medium text-muted-foreground">
                  <span>Number of questions</span>
                  <span className="text-foreground">{count[0]}</span>
                </div>
                <Slider
                  value={count}
                  onValueChange={setCount}
                  min={3}
                  max={15}
                  step={1}
                  className="mt-3"
                />
              </div>
              <Button className="w-full" disabled={busy} onClick={() => void handleStartQuiz()}>
                <Play className="mr-1.5 h-4 w-4" />
                {busy ? "Generating quiz with Gemini…" : "Start quiz"}
              </Button>
            </div>
          </SectionCard>
        </div>
      </AppShell>
    );

  const q = questions[current];

  if (stage === "taking" && q)
    return (
      <AppShell title="Practice Quiz">
        <div className="mx-auto max-w-2xl">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="font-medium">
              Question {current + 1} of {questions.length}
            </span>
            <span className="text-muted-foreground">{Object.keys(answers).length} answered</span>
          </div>
          <Progress value={((current + 1) / questions.length) * 100} className="mb-4 h-1.5" />
          <SectionCard>
            <p className="text-base font-semibold leading-snug">{q.question}</p>
            <div className="mt-5 space-y-2">
              {q.options.map((o, i) => (
                <button
                  key={`${q.id}-${i}`}
                  type="button"
                  onClick={() => setAnswers((a) => ({ ...a, [q.id]: i }))}
                  className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition ${
                    answers[q.id] === i ? "border-primary bg-primary-soft" : "hover:bg-muted"
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold ${
                      answers[q.id] === i ? "border-primary bg-primary text-primary-foreground" : ""
                    }`}
                  >
                    {String.fromCharCode(65 + i)}
                  </span>
                  {o}
                </button>
              ))}
            </div>
            <div className="mt-6 flex justify-between gap-2">
              <Button
                variant="outline"
                disabled={current === 0 || busy}
                onClick={() => setCurrent((c) => c - 1)}
              >
                Previous
              </Button>
              {current < questions.length - 1 ? (
                <Button onClick={() => setCurrent((c) => c + 1)}>Next</Button>
              ) : (
                <Button disabled={busy} onClick={() => void handleSubmitQuiz()}>
                  {busy ? "Grading on server…" : "Submit quiz"}
                </Button>
              )}
            </div>
          </SectionCard>
        </div>
      </AppShell>
    );

  return (
    <AppShell title="Quiz Review">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex flex-col items-center rounded-xl border bg-card p-6 text-center shadow-card">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-primary-soft text-primary">
            <Trophy className="h-7 w-7" />
          </span>
          <p className="mt-3 font-display text-3xl font-bold">{gradeResult?.percent ?? 0}%</p>
          <p className="text-sm text-muted-foreground">
            {gradeResult?.score ?? 0} of {gradeResult?.total ?? questions.length} correct ·{" "}
            {difficulty} difficulty
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" onClick={() => setStage("setup")}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              New quiz
            </Button>
            <Button
              onClick={() => {
                setAnswers({});
                setCurrent(0);
                setStage("taking");
              }}
            >
              Retry
            </Button>
          </div>
        </div>
        {(gradeResult?.results ?? []).map((item, idx) => (
          <SectionCard key={item.questionId}>
            <div className="flex gap-3">
              {item.isCorrect ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0 text-destructive" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {idx + 1}. {item.question}
                </p>
                <p className="mt-2 text-sm">
                  Correct:{" "}
                  <span className="font-medium text-success">
                    {item.options[item.correctIndex]}
                  </span>
                </p>
                {!item.isCorrect && (
                  <p className="text-sm">
                    Your answer:{" "}
                    <span className="font-medium text-destructive">
                      {item.selectedIndex !== null
                        ? item.options[item.selectedIndex]
                        : "Not answered"}
                    </span>
                  </p>
                )}
                <p className="mt-2 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                  {item.explanation}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">Source: {item.source}</p>
              </div>
            </div>
          </SectionCard>
        ))}
        <DemoNote />
      </div>
    </AppShell>
  );
}

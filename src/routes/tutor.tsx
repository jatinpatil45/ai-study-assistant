import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  Send,
  Sparkles,
  BookOpen,
  FileText,
  Paperclip,
  MessageSquareText,
} from "lucide-react";
import { AppShell, EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { apiRequest, useAuth } from "@/lib/firebase-client";
import {
  formatAiText,
  formatRelativeTime,
  useStudyDocuments,
  useStudyHistory,
  type ApiHistoryItem,
} from "@/lib/study-api";

export const Route = createFileRoute("/tutor")({
  head: () => ({
    meta: [
      { title: "AI Tutor — StudyMate AI" },
      {
        name: "description",
        content: "Chat with an AI tutor about your uploaded study documents.",
      },
      { property: "og:title", content: "AI Tutor — StudyMate AI" },
      {
        property: "og:description",
        content: "Ask questions and get explanations with page references.",
      },
    ],
  }),
  component: Tutor,
});

type Msg = { role: "user" | "ai"; text: string; sources?: string[]; pending?: boolean };

const suggestions = [
  "Summarize the key concepts in this document",
  "Give me 3 exam questions from this material",
  "Explain the main definitions in simple terms",
  "What are the most important formulas or rules here?",
];

function renderInlineFormatting(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function FormattedAiMessage({ text }: { text: string }) {
  const normalized = formatAiText(text);
  const lines = normalized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return <p className="text-sm leading-relaxed">{text}</p>;
  }

  return (
    <div className="space-y-2.5 text-sm leading-relaxed">
      {lines.map((line, idx) => {
        const numberedMatch = /^(\d+)[.)]\s+(.*)$/.exec(line);
        if (numberedMatch) {
          return (
            <div key={idx} className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold text-primary">
                {numberedMatch[1]}
              </span>
              <p className="flex-1">{renderInlineFormatting(numberedMatch[2] ?? "")}</p>
            </div>
          );
        }

        const bulletMatch = /^[•\-*]\s+(.*)$/.exec(line);
        if (bulletMatch) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-1">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <p className="flex-1">{renderInlineFormatting(bulletMatch[1] ?? "")}</p>
            </div>
          );
        }

        const headingMatch = /^#{1,3}\s+(.*)$/.exec(line);
        if (headingMatch) {
          return (
            <p key={idx} className="pt-1 font-semibold text-foreground">
              {renderInlineFormatting(headingMatch[1] ?? "")}
            </p>
          );
        }

        return <p key={idx}>{renderInlineFormatting(line)}</p>;
      })}
    </div>
  );
}

function ConversationList({
  items,
  activeId,
  onSelect,
  onNewChat,
}: {
  items: ApiHistoryItem[];
  activeId: string | null;
  onSelect: (item: ApiHistoryItem) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <Button className="m-3" onClick={onNewChat}>
        <Plus className="mr-1.5 h-4 w-4" />
        New chat
      </Button>
      <p className="px-4 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Recent
      </p>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2">
        {items.length === 0 ? (
          <li className="px-3 py-4 text-xs text-muted-foreground">
            No conversations yet. Ask a question to start your first AI Tutor session.
          </li>
        ) : (
          items.map((c) => {
            const isActive = activeId === c.id;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c)}
                  className={`w-full rounded-lg px-3 py-2 text-left ${isActive ? "bg-primary-soft" : "hover:bg-muted"}`}
                >
                  <p className={`truncate text-sm font-medium ${isActive ? "text-primary" : ""}`}>
                    {c.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatRelativeTime(c.createdAt)} · {c.documentTitle}
                  </p>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function Tutor() {
  const { user } = useAuth();
  const { docs } = useStudyDocuments();
  const { items: chatHistory, prependHistoryItem } = useStudyHistory("chat");
  const readyDocs = docs.filter((d) => d.status === "ready");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [ctx, setCtx] = useState<string>("");
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!ctx && readyDocs[0]) {
      setCtx(readyDocs[0].id);
    }
  }, [ctx, readyDocs]);

  const targetDocId = ctx && ctx !== "all" ? ctx : (readyDocs[0]?.id ?? "");

  const selectedDocTitle =
    readyDocs.find((d) => d.id === ctx)?.title ?? readyDocs[0]?.title ?? "No document uploaded";

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    if (!targetDocId) {
      toast.error("Please upload a PDF document in My Library first.");
      return;
    }

    const priorTurns = messages
      .filter((m) => !m.pending && m.text.trim().length > 0)
      .slice(-6)
      .map((m) => ({
        role: m.role,
        text: m.text,
      }));

    setMessages((m) => [
      ...m,
      { role: "user", text: trimmed },
      { role: "ai", text: "", pending: true },
    ]);
    setInput("");
    setSending(true);

    try {
      const res = await apiRequest<{
        id: string;
        documentId?: string;
        documentTitle?: string;
        answer: string;
        sources: string[];
        supported: boolean;
        createdAt?: string;
      }>("/api/ai/chat", {
        method: "POST",
        body: {
          documentId: targetDocId,
          question: trimmed,
          history: priorTurns,
        },
      });

      const sourceLabels = res.sources ?? [];

      setMessages((m) => [
        ...m.slice(0, -1),
        {
          role: "ai",
          text: res.answer,
          ...(sourceLabels.length > 0 ? { sources: sourceLabels } : {}),
        },
      ]);
      setActiveChatId(res.id);
      prependHistoryItem({
        id: res.id,
        uid: user?.uid ?? "",
        type: "chat",
        title: trimmed.slice(0, 120),
        documentId: res.documentId ?? targetDocId,
        documentTitle: res.documentTitle ?? selectedDocTitle,
        payload: {
          question: trimmed,
          answer: res.answer,
          supported: res.supported,
          sources: sourceLabels,
        },
        createdAt: res.createdAt ?? new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not get an answer from the AI tutor.";
      toast.error("AI Tutor error", { description: msg });
      setMessages((m) => [
        ...m.slice(0, -1),
        {
          role: "ai",
          text: `Sorry, I couldn't process that question right now: ${msg}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleSelectHistory = async (item: ApiHistoryItem) => {
    setActiveChatId(item.id);
    if (item.documentId) setCtx(item.documentId);

    const localPayload = item.payload ?? {};
    const localQuestion =
      typeof localPayload["question"] === "string" ? localPayload["question"] : item.title;
    const localAnswer = typeof localPayload["answer"] === "string" ? localPayload["answer"] : "";
    const localRawSources = Array.isArray(localPayload["sources"]) ? localPayload["sources"] : [];
    const localLabels = localRawSources.filter((s): s is string => typeof s === "string");

    if (localQuestion && localAnswer) {
      setMessages([
        { role: "user", text: localQuestion },
        {
          role: "ai",
          text: localAnswer,
          ...(localLabels.length > 0 ? { sources: localLabels } : {}),
        },
      ]);
      return;
    }

    try {
      const res = await apiRequest<{ item?: ApiHistoryItem }>(`/api/history/${item.id}`);
      const p = res.item?.payload ?? localPayload;
      const question = typeof p["question"] === "string" ? p["question"] : item.title;
      const answer = typeof p["answer"] === "string" ? p["answer"] : "";
      const rawSources = Array.isArray(p["sources"]) ? p["sources"] : [];
      const labels = rawSources.filter((s): s is string => typeof s === "string");
      if (question && answer) {
        setMessages([
          { role: "user", text: question },
          { role: "ai", text: answer, ...(labels.length > 0 ? { sources: labels } : {}) },
        ]);
      }
    } catch {
      toast.error("Could not load saved conversation");
    }
  };

  const handleNewChat = () => {
    setActiveChatId(null);
    setMessages([]);
  };

  return (
    <AppShell
      title="AI Tutor"
      actions={
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="lg:hidden">
              Chats
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <ConversationList
              items={chatHistory}
              activeId={activeChatId}
              onSelect={(item) => void handleSelectHistory(item)}
              onNewChat={handleNewChat}
            />
          </SheetContent>
        </Sheet>
      }
    >
      <div className="grid h-[calc(100vh-7.5rem)] overflow-hidden rounded-xl border bg-card shadow-card lg:grid-cols-[260px_1fr]">
        <aside className="hidden border-r lg:block">
          <ConversationList
            items={chatHistory}
            activeId={activeChatId}
            onSelect={(item) => void handleSelectHistory(item)}
            onNewChat={handleNewChat}
          />
        </aside>
        <div className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Context:</span>
            {readyDocs.length > 0 ? (
              <Select value={ctx || (readyDocs[0]?.id ?? "")} onValueChange={setCtx}>
                <SelectTrigger className="h-8 w-auto max-w-[300px] text-sm">
                  <SelectValue>{selectedDocTitle}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {readyDocs.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Link to="/library" className="text-xs font-medium text-primary hover:underline">
                Upload a PDF in My Library to start chatting
              </Link>
            )}
          </div>
          <div className="flex-1 space-y-5 overflow-y-auto p-4 md:p-6">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={MessageSquareText}
                  title={
                    readyDocs.length === 0
                      ? "Upload a PDF to start chatting"
                      : "Ask your AI Tutor anything"
                  }
                  description={
                    readyDocs.length === 0
                      ? "Upload your textbook or lecture notes in My Library, then ask questions here to get grounded answers with page citations."
                      : `Selected document: ${selectedDocTitle}. Ask a question below or pick a suggestion to begin.`
                  }
                  action={
                    readyDocs.length === 0 ? (
                      <Button asChild size="sm">
                        <Link to="/library">Upload PDF</Link>
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              messages.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={i}
                    className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground md:max-w-[70%]"
                  >
                    {m.text}
                  </div>
                ) : (
                  <div key={i} className="flex max-w-[92%] gap-3 md:max-w-[80%]">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-primary-foreground">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      {m.pending ? (
                        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {[0, 150, 300].map((d) => (
                              <span
                                key={d}
                                className="h-2 w-2 animate-bounce rounded-full bg-primary/60"
                                style={{ animationDelay: `${d}ms` }}
                              />
                            ))}
                            <span className="ml-2 text-xs text-muted-foreground">
                              Analyzing document pages with Gemini AI…
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
                          <FormattedAiMessage text={m.text} />
                        </div>
                      )}
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {m.sources.map((s) => (
                            <span
                              key={s}
                              className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              <FileText className="h-3 w-3" />
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )
            )}
          </div>
          <div className="border-t p-3 md:p-4">
            {readyDocs.length > 0 && (
              <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={sending}
                    onClick={() => void send(s)}
                    className="shrink-0 rounded-full border px-3 py-1 text-xs hover:border-primary/40 hover:bg-primary-soft disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/30"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Upload or switch document"
                onClick={() => void navigate({ to: "/library" })}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                rows={1}
                placeholder={
                  readyDocs.length > 0
                    ? "Ask about your document…"
                    : "Upload a PDF in My Library first…"
                }
                disabled={readyDocs.length === 0}
                className="min-h-9 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <Button
                type="submit"
                size="icon"
                aria-label="Send"
                disabled={!input.trim() || sending || readyDocs.length === 0}
              >
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

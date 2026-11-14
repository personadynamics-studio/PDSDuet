import { useState } from "react";
import { useConversationSession } from "./active-bot";
import { NOT_SHOWN } from "@openbot/shared/component-markers";
import { ToolLine } from "@/components/channels/tool-line";
import { galleryComponent, RENDERABLE_NAMES } from "./gallery-registry";
import { readReplies, ReplyChips } from "./reply-chips-tool";
import { readPage, ConversationPageCard } from "./page-card-tool";
import { BriefToolView } from "./morning-brief-tool";
import { readSignInOutcome, SignInCard } from "./sign-in-tool";

const CARDS = new Set(["suggest_replies", "make_page", "morning_brief", "computer_request_sign_in", "message_bot", "ask_person"]);
export function drawsTool(name: string): boolean { return CARDS.has(name) || RENDERABLE_NAMES.has(name); }
export function ToolCard({ id, name, args: raw, result }: { id: string; name: string; args: string; result?: string }) {
  const session = useConversationSession();
  const waiting = session?.activeRun?.waiting?.find((item) => item.toolCallId === id);
  const answer = waiting?.answerable ? session?.answer : undefined;
  let args: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>; } catch {}
  const running = result === undefined;
  if (name === "suggest_replies") { const replies = readReplies(args, result); return replies ? <ReplyChips replies={replies} toolCallId={id} /> : null; }
  if (name === "make_page") { const page = readPage(result); return page ? <ConversationPageCard page={page} /> : running ? <ToolLine label="正在建立頁面" running /> : null; }
  if (name === "morning_brief") return <BriefToolView result={result} running={running} />;
  if (name === "computer_request_sign_in") return <SignInCard site={typeof args.site === "string" ? args.site : ""} toolCallId={id} running={running} outcome={readSignInOutcome(result)} />;
  if (name === "ask_person") return typeof args.question === "string" ? <QuestionCard question={args.question} result={result} answer={answer ? (value) => answer(id, value) : undefined} /> : <ToolLine label="正在準備問題" running />;
  if (name === "message_bot") return <ToolLine label={running ? "正在聯絡另一位機械人" : "已交給另一位機械人"} detail={typeof args.task === "string" ? args.task : undefined} running={running} />;
  const gallery = galleryComponent(name);
  if (!gallery || result?.startsWith(NOT_SHOWN)) return null;
  const parsed = gallery.parameters.safeParse(args);
  if (!parsed.success) return null;
  const Component = gallery.Component;
  if (gallery.kind === "decision") return <Component args={parsed.data} status={running ? "executing" : "complete"} result={result} respond={running && answer ? (value: unknown) => answer(id, value) : undefined} />;
  return <Component {...parsed.data as Record<string, unknown>} />;
}

function QuestionCard({ question, result, answer }: { question: string; result?: string; answer?(value: string): Promise<void> }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return <form className="grid gap-3 rounded-lg border p-4" onSubmit={async (event) => {
    event.preventDefault();
    if (!answer || !value.trim() || sending) return;
    setSending(true); setProblem(null);
    try { await answer(value.trim()); }
    catch (failure) { setProblem(failure instanceof Error ? failure.message : "未能傳送回覆。"); }
    finally { setSending(false); }
  }}><p>{question}</p>{result === undefined ? <><input aria-label="你的回覆" className="min-h-11 rounded-lg border bg-background px-3" value={value} onChange={(event) => setValue(event.target.value)} disabled={sending} /><button type="submit" className="min-h-11 rounded-lg bg-primary px-4 text-primary-foreground disabled:opacity-50" disabled={!answer || !value.trim() || sending}>{sending ? "正在傳送…" : "回覆"}</button></> : <p className="whitespace-pre-wrap text-muted-foreground">{result}</p>}{problem ? <p role="alert" className="text-destructive">{problem}</p> : null}</form>;
}

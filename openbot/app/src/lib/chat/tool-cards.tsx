import { createContext, useContext, type ReactNode } from "react";
import { NOT_SHOWN } from "@openbot/shared/component-markers";
import { ToolLine } from "@/components/channels/tool-line";
import { galleryComponent, RENDERABLE_NAMES } from "./gallery-registry";
import { readReplies, ReplyChips } from "./reply-chips-tool";
import { readPage, ConversationPageCard } from "./page-card-tool";
import { readOffer, OfferedTaskCard } from "./offer-task-tool";
import { TaskToolView } from "./task-card-tool";
import { BriefToolView } from "./morning-brief-tool";
import { readSignInOutcome, SignInCard } from "./sign-in-tool";

const Responses = createContext<((id: string, value: unknown) => Promise<void>) | null>(null);
export function ToolResponses({ answer, children }: { answer(id: string, value: unknown): Promise<void>; children: ReactNode }) {
  return <Responses.Provider value={answer}>{children}</Responses.Provider>;
}
const CARDS = new Set(["suggest_replies", "make_page", "start_task", "offer_task", "morning_brief", "computer_request_sign_in", "message_bot", "ask_person"]);
export function drawsTool(name: string): boolean { return CARDS.has(name) || RENDERABLE_NAMES.has(name); }
export function ToolCard({ id, name, args: raw, result }: { id: string; name: string; args: string; result?: string }) {
  const answer = useContext(Responses);
  let args: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>; } catch {}
  const running = result === undefined;
  if (name === "suggest_replies") { const replies = readReplies(args, result); return replies ? <ReplyChips replies={replies} toolCallId={id} /> : null; }
  if (name === "make_page") { const page = readPage(result); return page ? <ConversationPageCard page={page} /> : running ? <ToolLine label="正在建立頁面" running /> : null; }
  if (name === "start_task") return <TaskToolView result={result} running={running} />;
  if (name === "offer_task") { const offered = readOffer(result); return offered ? <OfferedTaskCard offered={offered} /> : null; }
  if (name === "morning_brief") return <BriefToolView result={result} running={running} />;
  if (name === "computer_request_sign_in") return <SignInCard site={typeof args.site === "string" ? args.site : ""} toolCallId={id} running={running} outcome={readSignInOutcome(result)} />;
  if (name === "message_bot" || name === "ask_person") return <ToolLine label={name === "message_bot" ? "已交給另一位代理" : "等待你的決定"} detail={typeof args.question === "string" ? args.question : typeof args.task === "string" ? args.task : undefined} running={running} />;
  const gallery = galleryComponent(name);
  if (!gallery || result?.startsWith(NOT_SHOWN)) return null;
  const parsed = gallery.parameters.safeParse(args);
  if (!parsed.success) return null;
  const Component = gallery.Component;
  if (gallery.kind === "decision") return <Component args={parsed.data} status={running ? "executing" : "complete"} result={result} respond={running && answer ? (value: unknown) => answer(id, value) : undefined} />;
  return <Component {...parsed.data as Record<string, unknown>} />;
}

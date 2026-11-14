import type { Message } from "@ag-ui/core";
import { type ReactNode, useMemo } from "react";
import { text } from "prompt-area/helpers";
import { Composer, type AgentOption, type ComposerDraft } from "./composer";
import { toDraft } from "./composer/draft";
import { ChatTranscript } from "./chat-transcript";
import { ConversationSendContext, latestTurnToolCalls } from "./conversation-send";
import { PageSheetHost } from "@/components/duet/page-sheet";
import { useConversationSession } from "@/lib/chat/active-bot";
import { ToolCard } from "@/lib/chat/tool-cards";

export function ConversationView({
  messages, busy = false, pending = false, restoring = false, disabled = false,
  onSubmit, onStop, stoppable, agents = [], channelId, notice, stopped,
  inShell = false, placeholder, lead, autoFocus = false, speakerNames,
}: {
  messages: readonly Message[]; busy?: boolean; pending?: boolean; restoring?: boolean; disabled?: boolean;
  onSubmit(draft: ComposerDraft): void | Promise<void>; onStop?(): void; stoppable?: boolean;
  agents?: readonly AgentOption[]; channelId?: string;
  notice?: ReactNode; stopped?: string; inShell?: boolean; placeholder?: string; lead?: ReactNode;
  autoFocus?: boolean;
  speakerNames?: ReadonlyMap<string, string>;
}) {
  const session = useConversationSession();
  const latest = useMemo(() => new Set(latestTurnToolCalls(messages)), [messages]);
  const visibleCalls = useMemo(() => new Set(messages.flatMap(message =>
    message.role === "assistant" ? (message.toolCalls ?? []).map(call => call.id) : [],
  )), [messages]);
  // The published session can lag one render while switching conversations.
  const questions = !disabled && !restoring && session?.messages === messages && session.activeRun?.status === "waiting"
    ? (session.activeRun.waiting ?? []).flatMap(waiting => {
      const question = waiting.metadata?.message;
      return waiting.answerable && waiting.metadata?.kind === "person_question" && typeof question === "string" && !visibleCalls.has(waiting.toolCallId)
        ? [{ id: waiting.toolCallId, question }] : [];
    }) : [];
  const send = useMemo(() => ({
    send: (words: string) => {
      if (disabled || busy || pending) return false;
      void Promise.resolve(onSubmit(toDraft([text(words)]))).catch(() => {});
      return true;
    },
    isLatestTurn: (id: string) => latest.has(id),
  }), [disabled, busy, pending, onSubmit, latest]);
  return (
    <ConversationSendContext.Provider value={send}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <ChatTranscript messages={messages} busy={busy} restoring={restoring} stopped={stopped} lead={lead} speakerNames={speakerNames} contentClassName={inShell ? "gap-4 px-4 pt-[100px] pb-6" : undefined} />
        </div>
        <div className="shrink-0 border-t bg-background px-4 py-3">
          {notice}
          {questions.length > 0 ? <div className="space-y-3 pb-3">{questions.map(question =>
            <ToolCard key={question.id} id={question.id} name="ask_person" args={JSON.stringify({ question: question.question })} />,
          )}</div> : null}
          <Composer agents={agents} channelId={channelId} autoFocus={autoFocus} className="w-full" compact disabled={disabled || restoring} pending={busy || pending} stoppable={stoppable ?? busy} onStop={onStop} onSubmit={onSubmit} placeholder={placeholder} />
        </div>
        <PageSheetHost />
      </div>
    </ConversationSendContext.Provider>
  );
}


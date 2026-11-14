import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, type ReactNode } from "react";
import { attachmentModality } from "./chat-messages";
import { type ComposerDraft } from "./composer";
import { ConversationView } from "./conversation-view";
import { takeFirstMessage } from "./transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { attachmentUrl } from "@/lib/channels/attachments";
import type { AgentChannel } from "@/lib/channels/queries";
import { useActiveConversation } from "@/lib/chat/active-bot";
import type { Attachment } from "@/lib/chat/attachments";
import { ConversationProvider } from "@/lib/chat/conversation";
import { useThread } from "@/lib/chat/use-thread";
import { newId } from "@/lib/new-id";

function uploadedAttachment(attachment: Attachment) {
  const metadata = attachment.source.metadata as { attachmentId?: unknown; filename?: unknown } | undefined;
  if (attachment.status !== "uploaded" || typeof metadata?.attachmentId !== "string") throw new Error("附件仍未完成上載，請稍後傳送。");
  return { attachmentId: metadata.attachmentId, filename: typeof metadata.filename === "string" ? metadata.filename : attachment.filename };
}
export function toMessageContent(text: string, attachments: readonly Attachment[]) {
  if (!attachments.length) return text;
  const files = attachments.map((attachment) => {
    const { attachmentId, filename } = uploadedAttachment(attachment);
    return { type: attachmentModality(attachment.type, attachment.source.mimeType), source: { type: "url" as const, value: attachmentUrl(attachmentId) }, metadata: { attachmentId, filename } };
  });
  return text ? [{ type: "text" as const, text }, ...files] : files;
}
type ChannelChatProps = { channel: AgentChannel; runtimeAgentId: string; inShell?: boolean; lead?: ReactNode; };
export function ChannelChat(props: ChannelChatProps) {
  return <ChannelChatSession key={props.channel.threadId + ":" + props.runtimeAgentId} {...props} />;
}
function ChannelChatSession({ channel, runtimeAgentId, inShell, lead }: ChannelChatProps) {
  const thread = useThread(channel.threadId, runtimeAgentId);
  useActiveConversation({ threadId: channel.threadId, botId: runtimeAgentId, messages: thread.messages, activeRun: thread.activeRun, answer: thread.answer });
  const agents = useQuery(agentListQueryOptions());
  const name = agents.data?.find((bot) => bot.id === runtimeAgentId)?.name ?? channel.name;
  const send = useCallback(async (draft: ComposerDraft) => {
    const message: Message = { id: newId(), role: "user", content: toMessageContent(draft.text.trim(), draft.attachments) };
    await thread.submit([message]);
  }, [thread.submit]);
  useEffect(() => {
    if (thread.restoring || thread.busy) return;
    const first = takeFirstMessage(channel.id);
    if (!first || thread.messages.some((message) => message.role === "user")) return;
    void thread.submit([{ id: newId(), role: "user", content: first }]).catch(() => {});
  }, [channel.id, thread.restoring, thread.busy, thread.messages, thread.submit]);
  return (
      <ConversationProvider ask={(words) => { void thread.submit([{ id: newId(), role: "user", content: words }]).catch(() => {}); }}>
        <ConversationView messages={thread.messages} busy={thread.busy} restoring={thread.restoring} disabled={!channel.active} stoppable={Boolean(thread.activeRun)} onStop={() => { void thread.stop(); }} onSubmit={send} channelId={channel.id} inShell={inShell} lead={lead} placeholder={"傳送訊息給 " + name} stopped={thread.error ?? undefined} notice={thread.reconnecting ? <p role="status">正在重新連線並取回對話進度…</p> : !channel.active ? <p role="status">這段對話已無法接收新訊息。</p> : null} />
      </ConversationProvider>
  );
}


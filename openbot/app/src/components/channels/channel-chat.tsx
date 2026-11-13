import type { Message } from "@ag-ui/core";
import type { TaskReplyContext } from "@openbot/shared/task-reply";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { attachmentModality } from "./chat-messages";
import { type ComposerDraft } from "./composer";
import { ConversationView } from "./conversation-view";
import { takeFirstMessage } from "./transcript-messages";
import { VoiceCallWidget } from "./voice-call-widget";
import { Topic } from "@/components/duet/kit";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { attachmentUrl } from "@/lib/channels/attachments";
import type { AgentChannel } from "@/lib/channels/queries";
import { useActiveBot } from "@/lib/chat/active-bot";
import type { Attachment } from "@/lib/chat/attachments";
import { ConversationProvider } from "@/lib/chat/conversation";
import { ToolResponses } from "@/lib/chat/tool-cards";
import { useThread } from "@/lib/chat/use-thread";
import { client } from "@/lib/client";
import { newId } from "@/lib/new-id";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { voiceContext } from "@/lib/voice/agent-bridge";
import { useVoiceArchive, withVoiceChats } from "@/lib/voice/archive";
import { useVoiceCall } from "@/lib/voice/use-voice-call";

function uploadedAttachment(attachment: Attachment) {
  const metadata = attachment.source.metadata as { attachmentId?: unknown; filename?: unknown } | undefined;
  if (attachment.status !== "uploaded" || typeof metadata?.attachmentId !== "string") throw new Error("附件仍未完成上載，請稍後傳送。");
  return { attachmentId: metadata.attachmentId, filename: typeof metadata.filename === "string" ? metadata.filename : attachment.filename };
}
export function toMessageContent(text: string, attachments: readonly Attachment[]) {
  if (attachments.length === 0) return text;
  const files = attachments.map((attachment) => {
    const { attachmentId, filename } = uploadedAttachment(attachment);
    return { type: attachmentModality(attachment.type, attachment.source.mimeType), source: { type: "url" as const, value: attachmentUrl(attachmentId) }, metadata: { attachmentId, filename } };
  });
  return text ? [{ type: "text" as const, text }, ...files] : files;
}

type ChannelChatProps = {
  channel: AgentChannel;
  runtimeAgentId: string;
  inShell?: boolean;
  topic?: string | null;
  task?: { busy: boolean; durable?: boolean; queued?: { messageId: string; text: string }[]; send?: (input: { text: string; messageId: string } & TaskReplyContext) => Promise<void> };
  lead?: ReactNode;
  folded?: boolean;
  onSubmitted?: () => void;
};
export function ChannelChat(props: ChannelChatProps) {
  return <ChannelChatSession key={`${props.channel.id}:${props.channel.threadId}:${props.runtimeAgentId}`} {...props} />;
}
function ChannelChatSession({ channel, runtimeAgentId, inShell = false, topic, task, lead, folded = false, onSubmitted }: ChannelChatProps) {
  useActiveBot(runtimeAgentId);
  const thread = useThread(channel.threadId, runtimeAgentId);
  const agents = useQuery(agentListQueryOptions());
  const inbox = useQuery(approvalInboxOptions());
  const skillCommands = useSkillCommands(runtimeAgentId);
  const archive = useVoiceArchive(channel.id);
  const [taskPreviews, setTaskPreviews] = useState<Message[]>([]);
  const seed = useRef<string | null>(null);
  const botName = agents.data?.find((bot) => bot.id === runtimeAgentId)?.name ?? channel.name;
  const busy = thread.busy || task?.busy === true;

  const send = useCallback(async (text: string, attachments: Attachment[] = [], commands: string[] = []) => {
    const context = commands.flatMap((id) => {
      const instruction = skillCommands.find((command) => command.id === id)?.prompt;
      return instruction ? [{ description: `Granted skill: ${id}`, value: instruction }] : [];
    });
    const message: Message = { id: newId(), role: "user", content: toMessageContent(text.trim(), attachments) };
    const runId = await thread.submit([message], context);
    void client(`/api/channels/${encodeURIComponent(channel.id)}/activity`, { method: "POST", body: { text: text.trim() || "已傳送附件", agentId: null, at: new Date().toISOString() } }).catch(() => {});
    return runId;
  }, [thread.submit, skillCommands, channel.id]);

  useEffect(() => {
    if (thread.restoring || thread.busy) return;
    const first = seed.current ?? takeFirstMessage(channel.id);
    if (!first) return;
    seed.current = null;
    if (thread.messages.some((message) => message.role === "user")) return;
    void send(first).catch(() => {});
  }, [thread.restoring, thread.busy, thread.messages, send]);

  const call = useVoiceCall({
    channelId: channel.id,
    disabled: !channel.active,
    context: () => voiceContext(thread.messagesRef.current),
    anchorMessageId: () => thread.messagesRef.current.at(-1)?.id ?? null,
    askAgent: async (request, signal) => {
      if (busy) throw new Error("代理仍在處理工作，請稍後再問。");
      const id = newId();
      const runId = await thread.submit([{ id, role: "user", content: request }]);
      for (;;) {
        signal.throwIfAborted();
        const response = await client(`/api/threads/${encodeURIComponent(channel.threadId)}/messages?agentId=${encodeURIComponent(runtimeAgentId)}`, { signal, fallback: "無法取得代理回覆。" });
        const snapshot = await response.json() as { messages: Message[]; activeRun?: { id: string; status: string } };
        if (snapshot.activeRun?.id !== runId || snapshot.activeRun.status === "waiting") {
          const start = snapshot.messages.findIndex((message) => message.id === id);
          return snapshot.messages.slice(start + 1).filter((message) => message.role === "assistant" && typeof message.content === "string").map((message) => message.content).join("\n") || "代理已接收工作，請在對話中查看進度或完成待確認事項。";
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    },
  });
  const submit = async (draft: ComposerDraft) => {
    onSubmitted?.();
    if (!task?.send) { await send(draft.text, draft.attachments, draft.commandIds); return; }
    const messageId = newId();
    if (!task.durable) setTaskPreviews((rows) => [...rows, { id: messageId, role: "user", content: draft.text }]);
    try {
      await task.send({ text: draft.text, messageId, ...(draft.attachments.length ? { attachmentIds: draft.attachments.map((attachment) => uploadedAttachment(attachment).attachmentId) } : {}), ...(draft.commandIds.length ? { skillIds: draft.commandIds } : {}) });
    } catch (error) { setTaskPreviews((rows) => rows.filter((row) => row.id !== messageId)); throw error; }
  };
  const messages = withVoiceChats([...thread.messages, ...taskPreviews.filter((preview) => !thread.messages.some((message) => message.id === preview.id))], archive.entries);
  return (
    <ToolResponses answer={thread.answer}>
      <ConversationProvider ask={(text) => { void send(text).catch(() => {}); }}>
        <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
          <VoiceCallWidget call={call} agentId={runtimeAgentId} name={botName} avatarSeed={agents.data?.find((bot) => bot.id === runtimeAgentId)?.avatarSeed ?? runtimeAgentId} taskRunning={busy} />
          <ConversationView messages={messages} busy={busy} pending={busy} restoring={thread.restoring} disabled={!channel.active} stoppable={Boolean(thread.activeRun)} onStop={() => { void thread.stop(); }} onSubmit={submit} queueWhileBusy={!task?.send} channelId={task?.send && !task.durable ? undefined : channel.id} serverQueued={task?.queued} commands={task?.send && !task.durable ? undefined : skillCommands} approvals={inbox.data?.requests} inShell={inShell} folded={folded} lead={lead ?? (topic ? <Topic>{topic}</Topic> : null)} placeholder={`傳送訊息給 ${botName}`} stopped={thread.error ?? undefined} voiceCall={call.available ? { active: call.active, supported: call.supported, onStart: call.open } : undefined} notice={<>{!channel.active ? <p role="status">這段對話已無法接收新訊息。</p> : null}{thread.reconnecting ? <p role="status" className="text-sm text-muted-foreground">正在重新連線並取回對話進度…</p> : null}{archive.error ? <p role="alert" className="text-sm text-destructive">無法載入語音對話。</p> : null}</>} />
        </div>
      </ConversationProvider>
    </ToolResponses>
  );
}

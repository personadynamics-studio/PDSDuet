import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { groupQueryOptions, sendGroupMessageMutationOptions, type GroupConversation } from "@/lib/groups";
import { useThread } from "@/lib/chat/use-thread";
import { useActiveConversation } from "@/lib/chat/active-bot";
import { ConversationProvider } from "@/lib/chat/conversation";
import { newId } from "@/lib/new-id";
import { ConversationView } from "./conversation-view";
import { toAgentOptions } from "./composer";
import { takeFirstMessage } from "./transcript-messages";
import { Button } from "@/components/ui/button";

export function GroupChat({ channelId }: { channelId: string }) {
  const group = useQuery(groupQueryOptions(channelId));
  if (group.isPending) return <p role="status" className="p-6">正在載入群聊…</p>;
  if (!group.data) return <p role="alert" className="p-6 text-destructive">{group.error?.message ?? "無法載入群聊。"}</p>;
  return <GroupSession key={group.data.threadId} channelId={channelId} group={group.data} />;
}
function GroupSession({ channelId, group }: { channelId: string; group: GroupConversation }) {
  const queryClient = useQueryClient();
  const thread = useThread(group.threadId);
  useActiveConversation({ threadId: group.threadId, messages: thread.messages, activeRun: thread.activeRun, answer: thread.answer });
  const roster = useQuery(agentListQueryOptions());
  const send = useMutation(sendGroupMessageMutationOptions(queryClient, channelId));
  const [firstFailed, setFirstFailed] = useState<{ id: string; text: string } | null>(null);
  const sendFirst = useCallback(async (message: { id: string; text: string }) => {
    try { await send.mutateAsync({ ...message, agentId: null }); setFirstFailed(null); await thread.refresh(); }
    catch { setFirstFailed(message); }
  }, [send.mutateAsync, thread.refresh]);
  useEffect(() => {
    if (thread.restoring || thread.busy) return;
    const text = takeFirstMessage(channelId);
    if (text && !thread.messages.some((message) => message.role === "user")) void sendFirst({ id: newId(), text });
  }, [channelId, thread.restoring, thread.busy, thread.messages, sendFirst]);
  const names = new Map([...(roster.data ?? []), ...group.bots].map((bot) => [bot.id, bot.name]));
  for (const person of group.people) names.set(person.userId, person.name || person.email);
  return (
      <ConversationProvider ask={(words) => { void send.mutateAsync({ id: newId(), text: words, agentId: null }).then(() => thread.refresh()).catch(() => {}); }}>
        <ConversationView
          messages={thread.messages}
          speakerNames={names}
          busy={thread.busy || send.isPending}
          restoring={thread.restoring}
          agents={toAgentOptions(group.bots)}
          commands={[]}
          stoppable={Boolean(thread.activeRun)}
          onStop={() => { void thread.stop(); }}
          stopped={thread.error ?? undefined}
          lead={<p className="text-sm text-muted-foreground">{group.bots.map((bot) => names.get(bot.id) ?? bot.id).join("、")}</p>}
          notice={send.error ? <div role="alert" className="text-destructive">{send.error.message}{firstFailed ? <Button variant="link" disabled={send.isPending} onClick={() => { void sendFirst(firstFailed); }}>重送首句</Button> : null}</div> : thread.reconnecting ? <p role="status">正在重新連線並取回群聊進度…</p> : null}
          onSubmit={async (draft) => {
            setFirstFailed(null);
            await send.mutateAsync({ id: newId(), text: draft.text, agentId: draft.agentId });
            await thread.refresh();
          }}
        />
      </ConversationProvider>
  );
}


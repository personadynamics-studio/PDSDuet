import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { BotSelector } from "@/components/agents/bot-selector";
import { ChannelChat } from "@/components/channels/channel-chat";
import { Button } from "@/components/ui/button";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import type { AgentChannel } from "@/lib/channels/queries";
import { client } from "@/lib/client";

export function ChatScreen() {
  const { bot, loading, error } = useSelectedBot();
  if (bot) return <SelectedChat key={bot.id} botId={bot.id} />;
  return <div className="flex min-h-0 flex-1 flex-col"><div className="mx-4 mt-24"><BotSelector /></div><ScreenNotice alert={Boolean(error)}>{loading ? "正在載入機械人…" : error ? "無法載入機械人。" : "選擇機械人後便可開始對話。"}</ScreenNotice></div>;
}
function SelectedChat({ botId }: { botId: string }) {
  const { userId } = useSelectedBot();
  const conversation = useQuery({
    queryKey: ["channels", "direct", userId, botId],
    queryFn: ({ signal }) => client<AgentChannel>("/api/channels/direct", "channel", { method: "POST", body: { agentId: botId }, signal, fallback: "無法開啟對話。" }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (conversation.isPending) return <ScreenNotice>正在載入對話…</ScreenNotice>;
  if (!conversation.data) return <ScreenNotice alert>{conversation.error?.message}<Button variant="link" onClick={() => { void conversation.refetch(); }}>重試</Button></ScreenNotice>;
  return <OpenChat channel={conversation.data} botId={botId} />;
}
function OpenChat({ channel, botId }: { channel: AgentChannel; botId: string }) {
  useMarkOpenChannelRead(channel.id);
  return <ChannelChat channel={channel} runtimeAgentId={botId} inShell lead={<BotSelector />} />;
}
export function ScreenNotice({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return <div className="flex flex-1 items-center justify-center px-6 py-12 text-center"><div className={alert ? "text-destructive" : "text-muted-foreground"} role={alert ? "alert" : "status"}>{children}</div></div>;
}


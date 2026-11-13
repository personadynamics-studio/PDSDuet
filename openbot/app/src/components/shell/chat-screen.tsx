import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { BotSelector } from "@/components/agents/bot-selector";
import { ChannelChat } from "@/components/channels/channel-chat";
import { Button } from "@/components/ui/button";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { ONGOING_SEARCH_LIMIT, ongoingChannel } from "@/lib/channels/ongoing";
import { type AgentChannel, channelListQueryOptions } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";

/** Selecting a Bot opens its conversation; no model work starts until the person sends. */
export function ChatScreen() {
  const { bot, loading, error } = useSelectedBot();
  if (!loading && !error && bot) return <SelectedChat key={bot.id} botId={bot.id} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative z-10 mx-4 mb-2 mt-24"><BotSelector /></div>
      {loading ? <ScreenNotice>正在載入機械人…</ScreenNotice> : error ? (
        <ScreenNotice alert>無法載入你的機械人，請重新整理頁面。</ScreenNotice>
      ) : (
        <ScreenNotice>選擇機械人後便可開始對話。</ScreenNotice>
      )}
    </div>
  );
}

function SelectedChat({ botId }: { botId: string }) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [started, setStarted] = useState<AgentChannel | null>(null);
  const channel = started ?? ongoingChannel(channels.data, botId);
  const searching = !channel && channels.hasNextPage && !channels.isFetchNextPageError && (channels.data?.length ?? 0) < ONGOING_SEARCH_LIMIT;
  useEffect(() => {
    if (searching && !channels.isFetching) void channels.fetchNextPage({ cancelRefetch: false });
  }, [searching, channels.isFetching, channels.fetchNextPage]);
  if (channels.isPending || searching) return <ScreenNotice>正在載入對話…</ScreenNotice>;
  if (channels.error && !channels.data) return <ScreenNotice alert>無法載入對話，請重新整理頁面。</ScreenNotice>;
  if (channel) return <OpenChat channel={channel} botId={botId} />;
  return <CreateConversation botId={botId} onStarted={setStarted} />;
}

function CreateConversation({ botId, onStarted }: { botId: string; onStarted: (channel: AgentChannel) => void }) {
  const { mutateAsync, error } = useMutation(createChannelMutationOptions(queryClient));
  const begun = useRef(false);
  const start = useCallback(() => mutateAsync([botId]).then(onStarted), [mutateAsync, botId, onStarted]);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    void start().catch(() => {});
  }, [start]);
  return <ScreenNotice>{error ? <>{error.message}<Button variant="link" onClick={() => { void start().catch(() => {}); }}>重試</Button></> : "正在準備對話…"}</ScreenNotice>;
}

function OpenChat({ channel, botId }: { channel: AgentChannel; botId: string }) {
  useMarkOpenChannelRead(channel.id);
  return <ChannelChat channel={channel} runtimeAgentId={botId} inShell lead={<BotSelector />} />;
}

export function ScreenNotice({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return <div className="flex flex-1 items-center justify-center px-6 py-12 text-center"><p className={alert ? "text-destructive" : "text-muted-foreground"} role={alert ? "alert" : "status"}>{children}</p></div>;
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChannelChat } from "@/components/channels/channel-chat";
import { GroupChat } from "@/components/channels/group-chat";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";

export function ChannelScreen({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQueryOptions(channelId));
  useMarkOpenChannelRead(channelId);
  if (channel.isPending) return <p role="status" className="p-6">正在載入對話…</p>;
  const agentId = channel.data?.agentIds[0];
  if (!channel.data || !agentId) return <p role="alert" className="p-6 text-destructive">{channel.error?.message ?? "無法載入這段對話。"}</p>;
  if (channel.data.agentIds.length > 1) return <GroupChat channelId={channelId} />;
  return <ChannelChat channel={channel.data} runtimeAgentId={agentId} lead={<div className="flex items-center justify-between gap-3"><h1>{channel.data.name}</h1><Link className="text-sm underline" to="/bots/$agentId" params={{ agentId }}>機械人設定</Link></div>} />;
}

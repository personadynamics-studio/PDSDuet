import { useQuery } from "@tanstack/react-query";
import { useSelectedBot } from "@/lib/agents/selected-bot";
import { type DuetChannel, duetChannelListQueryOptions } from "./queries";

/** The person's channels, for the Bot the tabs are about. Disabled until that Bot is known. */
export function useDuetChannels() {
  const { bot, agents } = useSelectedBot();
  const list = useQuery({
    ...duetChannelListQueryOptions(bot?.id ?? ""),
    enabled: Boolean(bot),
  });
  return { bot, agents, list };
}

/**
 * The channel a task or a card was asked for in, to draw its tag, or null: Everything, a channel
 * since deleted, or a list not read yet.
 */
export function useChannelOf(
  channelId: string | null | undefined,
): DuetChannel | null {
  const { list } = useDuetChannels();
  if (!channelId) return null;
  return (
    list.data?.channels.find((channel) => channel.id === channelId) ?? null
  );
}

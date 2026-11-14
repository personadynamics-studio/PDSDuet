import {
  type InfiniteData,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type AgentChannel, type ChannelPage, channelKeys } from "./queries";

/**
 * Start a new channel with one or more coworkers.
 *
 * Deliberately not idempotent: every call creates a channel with its own thread.
 */
export function createChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentIds: string[]): Promise<AgentChannel> => {
      const response = await client("/api/channels", {
        method: "POST",
        body: { agentIds },
        fallback: "Couldn't start a conversation.",
      });
      return ((await response.json()) as { channel: AgentChannel }).channel;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/** Pin or unpin a channel for this member. A marker, not a reorder, so no optimistic sort. */
export function setChannelPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { channelId: string; pinned: boolean }) => {
      await client(`/api/channels/${variables.channelId}/pin`, {
        method: "PUT",
        body: { pinned: variables.pinned },
        fallback: "Couldn't pin this conversation.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

/**
 * Stamp a channel read for this member, patching the cache before the wire answers.
 *
 * Patched in onMutate rather than refetched on success: the dot must clear the instant the channel
 * opens, not a round-trip later. No rollback on failure and no roster invalidation — a mark-read
 * that did not land is a dot that returns on the next refetch, which is the truth reasserting
 * itself, and a roster refetch here would race the socket's own patches for nothing. The Bots
 * badge counts unread on the server, so once the mark lands its count is asked for again rather
 * than left lit until its next poll.
 */
export function markChannelReadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`/api/channels/${channelId}/read`, {
        method: "PUT",
        fallback: "Couldn't mark this conversation as read.",
      });
    },
    onMutate: (channelId) => {
      const now = new Date().toISOString();
      queryClient.setQueryData(
        channelKeys.list(),
        (data: InfiniteData<ChannelPage> | undefined) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              channels: page.channels.map((row) =>
                row.id === channelId
                  ? {
                      ...row,
                      /*
                       * The later of now and the row's own lastMessageAt: lastMessageAt comes from
                       * another clock, and a marker stamped "now" by a clock running behind it
                       * would leave the row still reading as unseen — and the dot still lit.
                       */
                      lastReadAt:
                        row.lastMessageAt && row.lastMessageAt > now
                          ? row.lastMessageAt
                          : now,
                    }
                  : row,
              ),
            })),
          },
      );
    },
  });
}

/** Soft-delete a channel for everyone in it. The server keeps the transcript; the roster forgets. */
export function deleteChannelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (channelId: string) => {
      await client(`/api/channels/${channelId}`, {
        method: "DELETE",
        fallback: "Couldn't delete this conversation.",
      });
    },
    // The roster only. The open channel's detail query would refetch into the fresh 404 and
    // flash an error before the navigate-home lands; left alone, it keeps its cache and the
    // navigation happens with nothing to complain about.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.list() }),
  });
}

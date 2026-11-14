import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { createGroupMutationOptions } from "@/lib/groups";
import { createChannelMutationOptions } from "./mutations";
import { channelKeys, type AgentChannel } from "./queries";

/** Open the chosen conversation before its first run so its live progress and questions are visible. */
export function useStartChannel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const createGroup = useMutation(createGroupMutationOptions(queryClient));
  const open = async (channel: AgentChannel, text: string, group: boolean) => {
    queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    stashFirstMessage(channel.id, text);
    await navigate({ to: group ? "/group/$channelId" : "/channel/$channelId", params: { channelId: channel.id }, replace: true });
  };
  return {
    pending: createChannel.isPending || createGroup.isPending,
    startChosen: async (agentId: string, text: string) => open(await createChannel.mutateAsync([agentId]), text, false),
    startGroup: async (agentIds: string[], text: string) => open(await createGroup.mutateAsync(agentIds), text, true),
  };
}

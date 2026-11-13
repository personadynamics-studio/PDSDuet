import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelControl, readControl, releaseControl, takeControl } from "./control";

type Action = "take" | "release" | "cancel";

export function useComputerControl(computerId: string, enabled = true) {
  const queryClient = useQueryClient();
  const queryKey = ["computer-control", computerId];
  const query = useQuery({ queryKey, queryFn: () => readControl(computerId), enabled: enabled && Boolean(computerId), refetchInterval: 1000 });
  const change = useMutation({
    mutationFn: (action: Action) => {
      const requestId = query.data?.request?.id;
      return action === "take" ? takeControl(computerId, requestId)
        : action === "release" ? releaseControl(computerId, requestId)
        : cancelControl(computerId, requestId);
    },
    onSuccess: (control) => queryClient.setQueryData(queryKey, control),
  });
  return {
    control: query.data ?? null,
    busy: change.isPending,
    problem: change.error?.message ?? query.error?.message ?? null,
    refresh: async () => { await query.refetch(); },
    change: async (action: Action) => (await change.mutateAsync(action)) !== null,
  };
}

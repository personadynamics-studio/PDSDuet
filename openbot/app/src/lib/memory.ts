import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
export type MemoryRecord = {
  id: string;
  content: string;
  provenance: string;
  sourceId: string | null;
  enabled: boolean;
  reviewState: "unreviewed" | "confirmed" | "edited";
  formedBy: "person" | "import" | "bot";
  formedByAgentId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  observedAt: string | null;
  updatedAt: string;
};
export const memoryKeys = {
  all: ["memory"] as const,
};
export const memoriesQueryOptions = (search = "") =>
  queryOptions({
    queryKey: [...memoryKeys.all, "list", search],
    queryFn: (): Promise<MemoryRecord[]> =>
      client(`/api/memory?search=${encodeURIComponent(search)}`, "memories", { fallback: "Could not load memory" }),
  });
export const createMemory = (content: string) =>
  client("/api/memory", {
    method: "POST",
    body: { content },
    fallback: "Could not remember this fact",
  });
export const updateMemory = (
  id: string,
  input: { content?: string; enabled?: boolean; reviewState?: "confirmed" },
) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "Could not update memory",
  });
export const deleteMemory = (id: string) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not forget this memory",
  });
const settleMemory = (queryClient: QueryClient) => () => {
  void queryClient.invalidateQueries({ queryKey: memoryKeys.all });
};

export const createMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createMemory,
    onSettled: settleMemory(queryClient),
  });
export const updateMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { content?: string; enabled?: boolean; reviewState?: "confirmed" };
    }) => updateMemory(id, input),
    onSettled: settleMemory(queryClient),
  });
export const deleteMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: deleteMemory,
    onSettled: settleMemory(queryClient),
  });


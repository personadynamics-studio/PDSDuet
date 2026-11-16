import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type AgentVisibility = "public" | "private";

/**
 * A coworker as the browser sees it.
 *
 * The server provides the coworker's configuration and roster metadata.
 */
export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether the stored agent runs through the server's Native factory. */
  builtIn: boolean;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  hidden: boolean;
  /** Whether the signed-in person pinned it to the top of their Bots list. Nobody else's. */
  pinned: boolean;
  /** A Team Bot an administrator assigned to this person; their Bots list always pins it. */
  assignedToMe?: boolean;
  systemOwned: boolean;
  /**
   * Whether the signed-in person created this coworker.
   *
   */
  mine: boolean;
  canManage: boolean;
  canControlComputer: boolean;
};

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
  botRouteDetail: (agentId: string) =>
    ["agents", "bot-route-detail", agentId] as const,
  capabilities: () => ["agents", "capabilities"] as const,
};

/** What kinds of coworker this deployment can create. */
export type AgentCapabilities = {
  /** Whether the server provides its Native factory for creating Bots without an endpoint. */
  builtInAvailable: boolean;
};

export function agentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: agentKeys.capabilities(),
    queryFn: (): Promise<AgentCapabilities> =>
      client("/api/agents/capabilities", "capabilities", {
        fallback: "Could not load what this deployment supports",
      }),
    // Deployment configuration, not data: it cannot change without the server restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: (): Promise<AgentProfile[]> =>
      client(`/api/agents${hidden ? "?hidden=true" : ""}`, "agents", {
        fallback: "Couldn't load your Bots.",
      }),
  });
}

/** Package-defined IDs remain one path segment without changing their stored or cache identity. */
export function agentApiPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}`;
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: (): Promise<AgentProfile> =>
      client(agentApiPath(agentId), "agent", {
        fallback: "Couldn't load this Bot.",
      }),
  });
}


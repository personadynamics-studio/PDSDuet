import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { type RegisteredAgent, registeredAgentFromRow } from "./build";
import type { CredentialSecretReader } from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
} from "../db/schema";
import { agentAuthHeaders, authFromConfiguration } from "./auth-header";
import type { AgentActor } from "./profile-types";

/** Load active agents and the deleted agents present in the caller's history. */
export function createRuntimeAgentLoader(
  database: Database,
  /** Resolves a customer agent's key at load time. Absent means no agent can carry one. */
  vault?: { reader: CredentialSecretReader; encryptionKey: string },
) {
  return async (actor: AgentActor, selectedBotId?: string): Promise<RegisteredAgent[]> => {
    const [active, tombstones] = await Promise.all([
      selectActiveAgents(database, selectedBotId),
      selectTombstoneAgents(database, actor, selectedBotId),
    ]);

    // A row whose configuration cannot be understood is skipped rather than mounted as a broken
    // agent. Tombstones are appended after, and never overwrite a live agent of the same id.
    const registered = new Map<string, RegisteredAgent>();
    for (const row of active) {
      const agent = registeredAgentFromRow(row);
      if (!agent) continue;
      const isRemoteAgent =
        agent.type === "remote_ag_ui" || agent.type === "remote_mastra";
      // The key is resolved per load, rather than being cached on the row: revoking a
      // credential then takes effect on the next run rather than on the next restart.
      if (isRemoteAgent && vault) {
        const headers = await agentAuthHeaders({
          reader: vault.reader,
          encryptionKey: vault.encryptionKey,
          auth: authFromConfiguration(row.configuration),
        });
        if (headers) agent.headers = headers;
      }
      registered.set(agent.id, agent);
    }
    for (const row of tombstones) {
      if (registered.has(row.id)) continue;
      registered.set(row.id, {
        id: row.id,
        name: row.name,
        type: "unavailable",
        reason: `${row.name} has been deleted and can no longer run. Its conversations remain readable.`,
      });
    }

    return [...registered.values()];
  };
}

function selectActiveAgents(database: Database, selectedBotId?: string) {
  return database
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      configuration: agents.configuration,
      title: agentProfiles.title,
      roleDescription: agentProfiles.roleDescription,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(and(isNull(agentProfiles.deletedAt), selectedBotId === undefined ? undefined : eq(agents.id, selectedBotId)));
}


function selectTombstoneAgents(database: Database, actor: AgentActor, selectedBotId?: string) {
  return database
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .innerJoin(channelAgents, eq(channelAgents.agentId, agents.id))
    .innerJoin(
      channels,
      and(eq(channels.id, channelAgents.channelId), isNull(channels.deletedAt)),
    )
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channelAgents.channelId),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .where(and(isNotNull(agentProfiles.deletedAt), selectedBotId === undefined ? undefined : eq(agents.id, selectedBotId)));
}

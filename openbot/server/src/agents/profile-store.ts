import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  deploymentPackages,
} from "../db/schema";
import {
  authFromConfiguration,
  retireReplacedKey,
  storeAgentAuth,
} from "./auth-header";
import { assignedToActor } from "../team-bots/access";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Pick<Database, "select"> | Pick<Transaction, "select">;

/** Something that can read profiles: the pool, or a caller's open transaction. */
export type ProfileReadExecutor = DatabaseExecutor;

export type AgentProfileStore = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  getWithin(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    id: string,
  ): Promise<AgentProfile | null>;
  create(actor: AgentActor, input: CreateAgentInput): Promise<AgentProfile>;
  update(
    actor: AgentActor,
    id: string,
    input: CreateAgentInput,
  ): Promise<AgentProfile>;
  duplicate(actor: AgentActor, id: string): Promise<AgentProfile>;
  setHidden(actor: AgentActor, id: string, hidden: boolean): Promise<void>;
  setPinned(actor: AgentActor, id: string, pinned: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
};

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} was not found.`);
    this.name = "AgentNotFoundError";
  }
}



export class AgentDefinitionError extends Error {
  constructor(message: string) { super(message); this.name = "AgentDefinitionError"; }
}

const joinedProjection = {
  id: agents.id,
  type: agents.type,
  name: agents.name,
  title: agentProfiles.title,
  roleDescription: agentProfiles.roleDescription,
  avatarSeed: agentProfiles.avatarSeed,
  visibility: agentProfiles.visibility,
  ownerUserId: agentProfiles.ownerUserId,
  packageId: deploymentPackages.id,
  hiddenAt: agentPreferences.hiddenAt,
  pinnedAt: agentPreferences.pinnedAt,
  deletedAt: agentProfiles.deletedAt,
  configuration: agents.configuration,
};

function joinedProfiles(executor: DatabaseExecutor, actor: AgentActor) {
  return executor
    .select({
      ...joinedProjection,
      // A Team Bot an administrator put in this person's sidebar.
      assignedToMe: sql<boolean>`${assignedToActor(actor.id, agents.id)}`,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .leftJoin(
      agentPreferences,
      and(
        eq(agentPreferences.agentId, agents.id),
        eq(agentPreferences.userId, actor.id),
      ),
    )
    .leftJoin(deploymentPackages, eq(deploymentPackages.id, agents.packageId));
}

function mapProfile(
  row: Awaited<
    ReturnType<ReturnType<typeof joinedProfiles>["execute"]>
  >[number],
): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
    avatarSeed: row.avatarSeed,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    systemOwned: row.packageId !== null,
    hidden: row.hiddenAt !== null,
    pinned: row.pinnedAt !== null,
    assignedToMe: Boolean(row.assignedToMe),
    deletedAt: row.deletedAt,
    endpoint: endpointOf(row.configuration),
    // Whether a key is set, never which. The form needs to show "a key is set" so a person does not
    // wipe one by saving an unrelated edit; showing the value would put a secret in a screenshot.
    hasAuth: authFromConfiguration(row.configuration) !== null,
    builtIn: row.type === "built_in",
  };
}

/**
 * The AG-UI address this coworker runs on, read back out of its stored configuration.
 *
 * Needed so an edit does not destroy it. The edit form is the same form as create, so without the
 * current endpoint to fill it with, saving a change of title would submit an empty endpoint and
 * convert an external agent back into the built-in one. That failure is silent and total: the Bot
 * keeps working, so nothing looks broken, and it is simply no longer their agent.
 */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

/** Which agent on a Mastra server this Bot means, when the row names one. */
function remoteAgentIdOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const named = (configuration as { remoteAgentId?: unknown }).remoteAgentId;
  return typeof named === "string" && named.length > 0 ? named : null;
}

/**
 * The instruction a Bot in the box runs on, read back out of its stored configuration.
 *
 * The mirror of {@link endpointOf}, and needed for the same reason: a copy has to be made of what
 * the original actually was. Check that the prompt has words while preserving its exact stored
 * contents for a duplicate, including the original role's formatting.
 */
function systemPromptOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const prompt = (configuration as { systemPrompt?: unknown }).systemPrompt;
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? prompt : null;
}

/** What a coworker is, and what it runs on: the two `agents` columns a copy has to reproduce. */
export type AgentRun = {
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: Record<string, unknown>;
};

/** Copy the original runtime identity and role; credentials belong to the original Bot. */
export function runForDuplicate(source: {
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: unknown;
}): AgentRun | null {
  if (source.type === "built_in") {
    const systemPrompt = systemPromptOf(source.configuration);
    return systemPrompt ? { type: source.type, configuration: { systemPrompt } } : null;
  }
  const endpoint = endpointOf(source.configuration);
  if (!endpoint?.trim()) return null;
  const remoteAgentId = remoteAgentIdOf(source.configuration);
  return { type: source.type, configuration: { endpoint, ...(remoteAgentId ? { remoteAgentId } : {}) } };
}
async function findProfile(
  executor: DatabaseExecutor,
  actor: AgentActor,
  id: string,
): Promise<AgentProfile | null> {
  const [row] = await joinedProfiles(executor, actor).where(
    and(
      eq(agents.id, id),
      isNull(agentProfiles.deletedAt),
    ),
  );
  return row ? mapProfile(row) : null;
}

function newAgentId() {
  return `agent_${crypto.randomUUID()}`;
}

export function createAgentProfileStore(
  database: Database,
  /**
   * Where a customer agent's key is kept. Optional so a deployment without a vault still runs; an
   * agent with a key then simply cannot be created, which is better than storing it in the clear.
   */
  vault?: { store: CredentialStore; encryptionKey: string },
): AgentProfileStore {
  return {
    async list(actor, hidden = false) {
      const rows = await joinedProfiles(database, actor).where(
        and(
          isNull(agentProfiles.deletedAt),
          hidden
            ? isNotNull(agentPreferences.hiddenAt)
            : isNull(agentPreferences.hiddenAt),
        ),
      );
      return rows.map(mapProfile);
    },

    get(actor, id) {
      return findProfile(database, actor, id);
    },

    async getWithin(executor, actor, id) {
      return findProfile(executor, actor, id);
    },

    create(actor, input) {
      return database.transaction(async (transaction) => {
        const id = newAgentId();
        const endpoint = input.endpoint?.trim();
        const roleDescription = input.roleDescription.trim();
        if (!endpoint && !roleDescription) throw new AgentDefinitionError("A Native Bot needs a role description, or provide a remote endpoint.");
        if (!endpoint && input.auth) throw new AgentDefinitionError("A Native Bot does not use a remote endpoint credential.");
        if (input.auth && !vault) throw new AgentDefinitionError("Remote endpoint credentials cannot be saved without the credential vault.");
        if (endpoint) {
          await transaction.insert(agents).values({
            id,
            name: input.name,
            type: "remote_ag_ui",
            // The key, if there is one, goes to the vault and only its reference is stored here. See
            // auth-header.ts for why a bearer token must not sit next to the endpoint.
            configuration: {
              endpoint,
              ...(input.auth && vault
                ? {
                    auth: await storeAgentAuth({
                      store: vault.store,
                      encryptionKey: vault.encryptionKey,
                      agentId: id,
                      header: input.auth.header,
                      value: input.auth.value,
                      executor: transaction,
                    }),
                  }
                : {}),
            },
          });
        } else {
          await transaction.insert(agents).values({
            id,
            name: input.name,
            type: "built_in",
            configuration: { systemPrompt: roleDescription },
          });
        }
        await transaction.insert(agentProfiles).values({
          agentId: id,
          ownerUserId: actor.id,
          title: input.title,
          roleDescription,
          avatarSeed: id,
          visibility: input.visibility,
        });

        const profile = await findProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        return profile;
      });
    },

    update(actor, id, input) {
      return database.transaction(
        async (transaction) => {
          const profile = await findProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);

          const updatedAt = new Date();
          /**
           * The endpoint and the key change here too, not only at creation.
           *
           * The form sends both and the route validates both, so an edit that dropped them looked
           * like it had worked: the screen reported success and the Bot kept answering at the old
           * address, which is the worst way to move an endpoint. A key is replaced only when one is
           * supplied, because the form cannot show what is stored and sending nothing means "leave
           * it alone" rather than "remove it".
           */
          const [row] = await transaction
            .select({ configuration: agents.configuration, type: agents.type })
            .from(agents)
            .where(eq(agents.id, id))
            .limit(1);
          if (!row) throw new AgentNotFoundError(id);
          const previous = row.configuration as Record<string, unknown>;
          const roleDescription = input.roleDescription.trim();
          const endpoint = input.endpoint === undefined ? endpointOf(previous) : input.endpoint.trim();
          let configuration: Record<string, unknown>;
          if (row.type === "built_in") {
            if (!roleDescription) throw new AgentDefinitionError("A Native Bot's role description cannot be empty.");
            if (input.endpoint?.trim() || input.auth) throw new AgentDefinitionError("A Native Bot does not use a remote endpoint or its credential.");
            const changed = roleDescription !== profile.roleDescription.trim();
            if (!changed && !systemPromptOf(previous)) throw new AgentDefinitionError("This Native Bot has no role instruction. Supply its role before saving.");
            configuration = { ...previous, ...(changed ? { systemPrompt: roleDescription } : {}) };
          } else {
            if (!endpoint?.trim()) throw new AgentDefinitionError("A remote Bot needs its own endpoint.");
            if (input.auth && !vault) throw new AgentDefinitionError("Remote endpoint credentials cannot be saved without the credential vault.");
            configuration = {
              ...previous, endpoint,
              ...(input.auth && vault ? { auth: await storeAgentAuth({
                store: vault.store, encryptionKey: vault.encryptionKey, agentId: id,
                header: input.auth.header, value: input.auth.value,
                previousCredentialId: authFromConfiguration(previous)?.credentialId,
                executor: transaction,
              }) } : {}),
            };
          }
          /*
           * The key this one replaces is already retired, by the rotation above.
           *
           * `storeAgentAuth` locks the previous credential, revokes it and inserts the replacement
           * inside this transaction, so there is nothing left here to retire. A second revoke from
           * outside the transaction would wait on the row lock this transaction is holding and never
           * be released, because the transaction cannot commit until the call it is awaiting
           * returns: editing a Bot's key would hang until the statement timed out, and the timeout
           * would then be reported as a key that is still live.
           */
          await transaction
            .update(agents)
            .set({ name: input.name, configuration, updatedAt })
            .where(eq(agents.id, id));
          await transaction
            .update(agentProfiles)
            .set({
              title: input.title,
              roleDescription,
              visibility: input.visibility,
              updatedAt,
            })
            .where(eq(agentProfiles.agentId, id));

          const updated = await findProfile(transaction, actor, id);
          if (!updated) throw new AgentNotFoundError(id);
          return updated;
        },
        { isolationLevel: "read committed" },
      );
    },

    duplicate(actor, id) {
      return database.transaction(async (transaction) => {
        const source = await findProfile(transaction, actor, id);
        if (!source) throw new AgentNotFoundError(id);

        /*
         * The stored row, because a profile does not carry what a copy has to reproduce.
         *
         * `AgentProfile` projects `endpoint` out of the configuration and nothing else, which is all
         * an edit form needs and half of what this needs: a `built_in` coworker has no endpoint and
         * a prompt instead. Read here rather than widened into the profile, so the DTO every surface
         * gets does not start carrying a Bot's instructions. Inside the transaction, and after the
         * access check, so this cannot read a row the caller may not see.
         */
        const [stored] = await transaction
          .select({ type: agents.type, configuration: agents.configuration })
          .from(agents)
          .where(eq(agents.id, id))
          .limit(1);
        if (!stored) throw new AgentNotFoundError(id);

        // `auth` is a vault reference and is deliberately not carried: see `runForDuplicate`.
        const run = runForDuplicate(stored);
        if (!run) throw new AgentDefinitionError("This Bot is missing its role instruction or remote endpoint and cannot be duplicated.");
        const duplicateId = newAgentId();
        await transaction.insert(agents).values({
          id: duplicateId,
          name: source.name,
          type: run.type,
          configuration: run.configuration,
        });
        await transaction.insert(agentProfiles).values({
          agentId: duplicateId,
          ownerUserId: actor.id,
          title: source.title,
          roleDescription: source.roleDescription,
          avatarSeed: source.avatarSeed,
          visibility: "private",
        });

        const duplicate = await findProfile(
          transaction,
          actor,
          duplicateId,
        );
        if (!duplicate) throw new AgentNotFoundError(duplicateId);
        return duplicate;
      });
    },

    setHidden(actor, id, hidden) {
      return database.transaction(async (transaction) => {
        const profile = await findProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            hiddenAt: hidden ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { hiddenAt: hidden ? new Date() : null },
          });
      });
    },

    /*
     * The same row as hiding, one column over, and the upsert sets only its own column: pinning a
     * hidden coworker keeps it hidden, and it comes back pinned when it is unhidden. Two people, or
     * two tabs, pinning at once meet on the (user, agent) primary key, so the second write updates
     * the row the first one made instead of failing.
     */
    setPinned(actor, id, pinned) {
      return database.transaction(async (transaction) => {
        const profile = await findProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);

        await transaction
          .insert(agentPreferences)
          .values({
            userId: actor.id,
            agentId: id,
            pinnedAt: pinned ? new Date() : null,
          })
          .onConflictDoUpdate({
            target: [agentPreferences.userId, agentPreferences.agentId],
            set: { pinnedAt: pinned ? new Date() : null },
          });
      });
    },

    softDelete(actor, id) {
      return database.transaction(
        async (transaction) => {
          const profile = await findProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);

          const deletedAt = new Date();
          await transaction
            .update(agentProfiles)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(eq(agentProfiles.agentId, id));

          /*
           * And its key stops working.
           *
           * A deleted Bot left its credential in the vault, decryptable and still valid, with
           * nothing listing it and no screen able to reach it: deleting the Bot was the last chance
           * anybody had to retire it. The profile is a soft delete, deliberately, but the key is not
           * something to keep pending an undelete that would ask for a new one anyway.
           */
          if (vault) {
            const [row] = await transaction
              .select({ configuration: agents.configuration })
              .from(agents)
              .where(eq(agents.id, id))
              .limit(1);
            await retireReplacedKey(
              vault.store,
              (row?.configuration ?? {}) as Record<string, unknown>,
              {},
              // In this transaction, so the key is retired exactly when the deletion is. On its own
              // connection the revoke would commit even where the delete rolled back, leaving a Bot
              // that still exists and can no longer reach its endpoint.
              transaction,
            );
          }
        },
        { isolationLevel: "read committed" },
      );
    },

  };
}

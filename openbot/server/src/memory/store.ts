import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { memorySources, personalMemories } from "../db/schema/memory";
import { lockDefaults, recordOptOut, sourceServerId } from "./defaults";
import {
  type ImportedMemory,
  MemoryNotFoundError,
  type MemoryRecord,
  parseMemoryInput,
  parseMemoryPatch,
  parseMemorySourceInput,
} from "./types";

/** Personal memory stored in this deployment's PostgreSQL database. */
export function createMemoryStore(database: Database) {
  const getSource = async (ownerUserId: string, id: string) => {
    const [row] = await database
      .select()
      .from(memorySources)
      .where(
        and(
          eq(memorySources.id, id),
          eq(memorySources.ownerUserId, ownerUserId),
        ),
      );
    if (!row) throw new MemoryNotFoundError();
    return row;
  };

  /**
   * The rows a Bot may recall, every filter in the query. Bot-formed memories go only to the Bot that
   * formed them, and only while it still holds their source app; imported ones only through a source
   * this Bot may use; the person's own to every Bot of theirs.
   */
  function eligibleRows(
    ownerUserId: string,
    eligibleSourceIds: string[],
    formed: { botId: string; heldServerIds: ReadonlySet<string> } | undefined,
    narrow: { term?: string },
  ) {
    const held = [...(formed?.heldServerIds ?? [])];
    const formedByThisBot = formed
      ? and(
          eq(personalMemories.formedBy, "bot"),
          eq(personalMemories.formedByAgentId, formed.botId),
          or(
            isNull(personalMemories.sourceRef),
            held.length > 0
              ? inArray(
                  sql<string>`split_part(${personalMemories.sourceRef}, '/', 1)`,
                  held,
                )
              : sql`false`,
          ),
        )
      : undefined;
    const personOrSource = and(
      sql`${personalMemories.formedBy} <> 'bot'`,
      or(
        isNull(personalMemories.sourceId),
        eligibleSourceIds.length > 0
          ? inArray(personalMemories.sourceId, eligibleSourceIds)
          : sql`false`,
      ),
    );
    return database
      .select()
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, ownerUserId),
          eq(personalMemories.enabled, true),
          isNull(personalMemories.deletedAt),
          formedByThisBot
            ? or(formedByThisBot, personOrSource)
            : personOrSource,
          narrow.term
            ? sql`strpos(lower(${personalMemories.content}), lower(${narrow.term})) > 0`
            : undefined,
        ),
      )
      .orderBy(desc(personalMemories.updatedAt))
      .limit(40);
  }

  return {
    async list(ownerUserId: string): Promise<MemoryRecord[]> {
      const rows = await database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .orderBy(desc(personalMemories.updatedAt))
        .limit(500);
      return rows;
    },
    async create(ownerUserId: string, input: unknown) {
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parseMemoryInput(input),
          reviewState: "confirmed",
        })
        .returning();
      if (!row) throw new Error("Memory insert returned no row.");
      return row;
    },
    async update(
      ownerUserId: string,
      id: string,
      input: unknown,
    ): Promise<MemoryRecord> {
      const patch = parseMemoryPatch(input);
      const [row] = await database
        .update(personalMemories)
        .set({
          ...patch,
          ...(patch.content ? { reviewState: "edited" as const } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalMemories.id, id),
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .returning();
      if (!row) throw new MemoryNotFoundError();
      return row;
    },
    async remove(ownerUserId: string, id: string) {
      // Imported tombstones prevent the next sync from resurrecting a fact the person deleted.
      const [row] = await database
        .update(personalMemories)
        .set({
          deletedAt: new Date(),
          enabled: false,
          content: "",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalMemories.id, id),
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .returning({ id: personalMemories.id });
      if (!row) throw new MemoryNotFoundError();
    },
    async sources(ownerUserId: string) {
      return database
        .select()
        .from(memorySources)
        .where(eq(memorySources.ownerUserId, ownerUserId))
        .orderBy(desc(memorySources.createdAt));
    },
    getSource,
    async createSource(ownerUserId: string, input: unknown) {
      const [row] = await database
        .insert(memorySources)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parseMemorySourceInput(input),
        })
        .returning();
      if (!row) throw new Error("Memory source insert returned no row.");
      return row;
    },
    async setSourceEnabled(ownerUserId: string, id: string, enabled: boolean) {
      const [row] = await database
        .update(memorySources)
        .set({ enabled, nextSyncAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      if (!row) throw new MemoryNotFoundError();
      return row;
    },
    async removeSource(ownerUserId: string, id: string) {
      const [source] = await database
        .select({ agentId: memorySources.agentId })
        .from(memorySources)
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .limit(1);
      if (!source) throw new MemoryNotFoundError();
      // Removing a source is turning that app down for this Bot: OpenBot never adds it back.
      await database.transaction(async (transaction) => {
        await lockDefaults(transaction, ownerUserId, source.agentId);
        const [row] = await transaction
          .delete(memorySources)
          .where(
            and(
              eq(memorySources.id, id),
              eq(memorySources.ownerUserId, ownerUserId),
            ),
          )
          .returning({ toolRef: memorySources.toolRef });
        if (!row) throw new MemoryNotFoundError();
        await recordOptOut(transaction, {
          ownerUserId,
          agentId: source.agentId,
          feature: "memory_source",
          scope: sourceServerId(row.toolRef),
        });
      });
    },
    async dueSources(limit = 5) {
      return database
        .select()
        .from(memorySources)
        .where(
          and(
            eq(memorySources.enabled, true),
            lte(memorySources.nextSyncAt, new Date()),
          ),
        )
        .limit(Math.min(limit, 10));
    },
    async claimSync(ownerUserId: string, id: string) {
      const now = new Date();
      const [row] = await database
        .update(memorySources)
        .set({
          syncStatus: "running",
          nextSyncAt: new Date(now.getTime() + 120_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
            eq(memorySources.enabled, true),
            or(
              sql`${memorySources.syncStatus} <> 'running'`,
              lte(memorySources.nextSyncAt, now),
            ),
          ),
        )
        .returning();
      return row ?? null;
    },
    async failSync(ownerUserId: string, id: string, error: string) {
      await database
        .update(memorySources)
        .set({
          syncStatus: "error",
          syncError: error.slice(0, 500),
          nextSyncAt: new Date(Date.now() + 900_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        );
    },
    async completeSync(
      ownerUserId: string,
      sourceId: string,
      records: ImportedMemory[],
    ) {
      await database.transaction(async (transaction) => {
        const [source] = await transaction
          .select()
          .from(memorySources)
          .where(
            and(
              eq(memorySources.id, sourceId),
              eq(memorySources.ownerUserId, ownerUserId),
              eq(memorySources.enabled, true),
            ),
          )
          .for("update");
        if (!source) throw new MemoryNotFoundError();
        for (const record of records) {
          await transaction
            .insert(personalMemories)
            .values({
              id: randomUUID(),
              ownerUserId,
              sourceId,
              externalId: record.externalId,
              importDigest: record.digest,
              content: record.content,
              provenance: `${source.title}: ${record.provenance}`,
              formedBy: "import",
              sourceApp: source.title,
              sourceRef: source.toolRef,
              observedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [personalMemories.sourceId, personalMemories.externalId],
              set: {
                content: sql`CASE WHEN ${personalMemories.reviewState} = 'edited' OR ${personalMemories.deletedAt} IS NOT NULL THEN ${personalMemories.content} ELSE ${record.content} END`,
                provenance: `${source.title}: ${record.provenance}`,
                importDigest: record.digest,
                updatedAt: new Date(),
              },
              setWhere: sql`${personalMemories.importDigest} IS DISTINCT FROM ${record.digest}`,
            });
        }
        await transaction
          .update(memorySources)
          .set({
            syncStatus: "succeeded",
            syncError: null,
            lastSyncAt: new Date(),
            nextSyncAt: new Date(Date.now() + 900_000),
            updatedAt: new Date(),
          })
          .where(eq(memorySources.id, sourceId));
      });
    },
    async retrieve(
      ownerUserId: string,
      eligibleSourceIds: string[],
      search = "",
      /**
       * The Bot asking and the app servers it currently holds. Bot-formed memories are returned
       * only to the Bot that formed them, and only while it still holds their source app; without
       * this argument none are returned.
       */
      formed?: { botId: string; heldServerIds: ReadonlySet<string> },
    ): Promise<MemoryRecord[]> {
      const term = search.trim();
      return eligibleRows(ownerUserId, eligibleSourceIds, formed, { term });
    },
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;

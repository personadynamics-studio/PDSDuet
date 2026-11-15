import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { personalMemories } from "../db/schema/memory";
import {
  type MemoryInput,
  MemoryNotFoundError,
  type MemoryPatch,
  type MemoryRecord,
} from "./types";

/** Personal memory stored in this deployment's PostgreSQL database. */
export function createMemoryStore(database: Database) {
  return {
    async list(ownerUserId: string, search = ""): Promise<MemoryRecord[]> {
      const rows = await database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
            search.trim()
              ? sql`strpos(lower(${personalMemories.content}), lower(${search.trim()})) > 0`
              : undefined,
          ),
        )
        .orderBy(desc(personalMemories.updatedAt))
        .limit(500);
      return rows;
    },
    async create(ownerUserId: string, input: MemoryInput) {
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...input,
          reviewState: "confirmed",
        })
        .returning();
      if (!row) throw new Error("Memory insert returned no row.");
      return row;
    },
    async update(
      ownerUserId: string,
      id: string,
      patch: MemoryPatch,
    ): Promise<MemoryRecord> {
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
      const [row] = await database
        .delete(personalMemories)
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
    async retrieve(ownerUserId: string, search = ""): Promise<MemoryRecord[]> {
      const term = search.trim();
      return database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.formedBy, "person"),
            isNull(personalMemories.sourceId),
            eq(personalMemories.enabled, true),
            isNull(personalMemories.deletedAt),
            term
              ? sql`strpos(lower(${personalMemories.content}), lower(${term})) > 0`
              : undefined,
          ),
        )
        .orderBy(desc(personalMemories.updatedAt))
        .limit(40);
    },
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;

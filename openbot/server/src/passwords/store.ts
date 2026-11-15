import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { savedLogins, signInRequests } from "../db/schema/passwords";
import type {
  PasswordStore,
  SignInRequestRecord,
} from "./types";

function requestRow(
  row: typeof signInRequests.$inferSelect,
): SignInRequestRecord {
  return {
    ...row,
  };
}

/** The Postgres store. Every read and write is scoped by the owner, so a request id alone is nothing. */
export function createPasswordStore(database: Database): PasswordStore {
  return {
    async createRequest(input) {
      const [row] = await database
        .insert(signInRequests)
        .values({
          ...input,
          status: "pending",
        })
        .returning();
      if (!row) throw new Error("The sign-in request was not recorded.");
      return requestRow(row);
    },
    async request(ownerUserId, id) {
      const [row] = await database
        .select()
        .from(signInRequests)
        .where(
          and(
            eq(signInRequests.ownerUserId, ownerUserId),
            eq(signInRequests.id, id),
          ),
        )
        .limit(1);
      return row ? requestRow(row) : null;
    },
    async pendingRequests(ownerUserId) {
      const rows = await database
        .select()
        .from(signInRequests)
        .where(
          and(
            eq(signInRequests.ownerUserId, ownerUserId),
            inArray(signInRequests.status, [
              "pending",
              "code_required",
              "taken_over",
            ]),
            sql`${signInRequests.expiresAt} > now()`,
          ),
        )
        .orderBy(desc(signInRequests.createdAt))
        .limit(50);
      return rows.map(requestRow);
    },
    async transition(ownerUserId, id, from, to) {
      const [row] = await database
        .update(signInRequests)
        .set(to)
        .where(
          and(
            eq(signInRequests.ownerUserId, ownerUserId),
            eq(signInRequests.id, id),
            inArray(signInRequests.status, [...from]),
          ),
        )
        .returning();
      return row ? requestRow(row) : null;
    },
    async logins(ownerUserId, origin) {
      return database
        .select()
        .from(savedLogins)
        .where(
          and(
            eq(savedLogins.ownerUserId, ownerUserId),
            ...(origin ? [eq(savedLogins.origin, origin)] : []),
          ),
        )
        .orderBy(asc(savedLogins.origin), asc(savedLogins.username));
    },
    async login(ownerUserId, id) {
      const [row] = await database
        .select()
        .from(savedLogins)
        .where(
          and(eq(savedLogins.ownerUserId, ownerUserId), eq(savedLogins.id, id)),
        )
        .limit(1);
      return row ?? null;
    },
    async saveLogin(input) {
      const now = new Date();
      const [row] = await database
        .insert(savedLogins)
        .values({ id: randomUUID(), ...input })
        .onConflictDoUpdate({
          target: [
            savedLogins.ownerUserId,
            savedLogins.origin,
            savedLogins.username,
          ],
          set: { encryptedPassword: input.encryptedPassword, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error("The login was not saved.");
      return row;
    },
    async touchLogin(ownerUserId, id) {
      await database
        .update(savedLogins)
        .set({ lastUsedAt: new Date() })
        .where(
          and(eq(savedLogins.ownerUserId, ownerUserId), eq(savedLogins.id, id)),
        );
    },
    async deleteLogin(ownerUserId, id) {
      const rows = await database
        .delete(savedLogins)
        .where(
          and(eq(savedLogins.ownerUserId, ownerUserId), eq(savedLogins.id, id)),
        )
        .returning({ id: savedLogins.id });
      return rows.length > 0;
    },
  };
}

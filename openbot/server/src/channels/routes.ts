import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { parsePageLimit } from "../paging";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  threadChannelMappings,
} from "../db/schema";
import type { ChannelActivityEvent, ChannelEventHub } from "./events";
import {
  announceChannelActivity,
} from "./notifications";
import { upgradeWebSocket } from "./socket";

export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  /**
   * When something was last said here, or null for a conversation nobody has used.
   *
   * On the channel itself rather than only on the roster summary, because the conversation screen
   * needs it: a thread the history store does not know about is an empty NEW conversation when this
   * is null and a conversation whose history is unreachable when it is set, and those are different
   * things to put on the screen. See the note in `channel-chat.tsx`.
   */
  lastMessageAt: Date | null;
};

/** A channel plus the last thing said in it, which is what a roster renders. */
export type ChannelSummary = AgentChannel & {
  /** Whether the canonical root execution is running or waiting. */
  busy: boolean;
  /** A few words about the conversation, or null. Readers fall back to the channel's name. */
  summary: string | null;
  lastMessage: string | null;
  lastMessageAgentId: string | null;
  createdAt: Date;
  /** Whether the caller pinned this channel. A pin is per-member, so this is the caller's, only. */
  pinned: boolean;
  /** When the caller last had this channel open, or null for never. The caller's, only. */
  lastReadAt: Date | null;
};

/** A channel has one conversation, shared by every member. */
const CANONICAL_THREAD = sql<string>`(select thread_id from thread_channel_mappings where channel_id = ${channels.id} order by created_at,user_id limit 1)`;

/** One page of somebody's channels, newest activity first. */
export type ChannelPage = {
  channels: ChannelSummary[];
  /** Where the next page starts, or null at the end. */
  nextCursor: string | null;
};

export type ChannelQuery = { cursor?: string; limit?: number };

/**
 * How many channels one page holds.
 *
 * The sidebar asked for all of them on every render, one row per channel-agent pair, and nothing
 * removes a channel: somebody who talks to their Bot daily accumulates thousands, so a query that is
 * instant in a demo returns thousands of rows on every page load for every employee, and grows
 * monotonically. A page is what a sidebar can show anyway.
 */
const DEFAULT_CHANNEL_PAGE = 50;

/** The most a caller may ask for, so the endpoint cannot be talked back into reading everything. */
const MAX_CHANNEL_PAGE = 200;

/**
 * Where a page stopped: every part of the sort, in sort order.
 *
 * `pinned` leads, because the ordering does: a keyset cursor has to name the whole sort key or the
 * next page is selected by a different rule than the page it follows, which serves some channels
 * twice and others never. `recency` and `id` are both here for the same reason — two channels can
 * share a timestamp.
 */
type ChannelCursor = { pinned: boolean; recency: string; id: string };

/** The shape the encoder writes: UTC, to the millisecond (older cursors) or the microsecond. */
const CURSOR_RECENCY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function encodeChannelCursor(cursor: ChannelCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A malformed cursor reads as the first page, which is the honest answer to a stale link.
 *
 * A cursor minted before `pinned` existed is malformed by this definition, and deliberately: it
 * describes a position in an ordering this query no longer has.
 *
 * `recency` has to be the timestamp the encoder writes, not merely a string: it is cast with
 * `::timestamptz` in the page query, so any other string used to reach PostgreSQL and answer 500.
 */
export function decodeChannelCursor(
  value: string | undefined,
): ChannelCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as ChannelCursor;
    return typeof parsed?.id === "string" &&
      typeof parsed?.recency === "string" &&
      CURSOR_RECENCY.test(parsed.recency) &&
      !Number.isNaN(Date.parse(parsed.recency)) &&
      typeof parsed?.pinned === "boolean"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The roster's sort key, as SQL, in the order it sorts.
 *
 * Every part descends, which is what lets the cursor be one row comparison rather than a nest of
 * ORs: a pin is 1 and no pin is 0, so `desc` puts pinned channels first, and both remaining parts
 * already wanted `desc`. Starting a conversation counts as activity — a channel somebody just made
 * has nothing said in it yet and is the one they are about to type in, so ordering on the message
 * alone would bury it under every channel that has one.
 *
 * The browser repeats the recency half when the socket patches a row, and lifts pinned rows at
 * render; both must agree with this, or the list reorders itself on the next event. See `byRecency`
 * in use-channel-events.ts and `pinnedFirst` in app-sidebar.tsx.
 */
const PINNED_RANK = sql`case when ${channelMemberships.pinnedAt} is not null then 1 else 0 end`;
const RECENCY = sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`;
const ROSTER_ORDER = [
  sql`${PINNED_RANK} desc`,
  sql`${RECENCY} desc`,
  desc(channels.id),
];

/** The transaction `create` and `direct` share, as the driver hands it to a callback. */
type ChannelTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ChannelStore = {
  /** Make an ordinary conversation for the people and Bots explicitly selected. */
  create(
    actor: AgentActor,
    agentIds: string[],
    transaction?: ChannelTransaction,
  ): Promise<AgentChannel>;
  /** Open an existing private conversation with the chosen Bot, or create one. */
  direct(actor: AgentActor, agentId: string): Promise<AgentChannel>;
  get(actor: AgentActor, channelId: string): Promise<AgentChannel | null>;
  list(actor: AgentActor, query?: ChannelQuery): Promise<ChannelPage>;
  /** Pin or unpin the caller's own membership. Throws ChannelNotFoundError for a non-member. */
  setPinned(
    actor: AgentActor,
    channelId: string,
    pinned: boolean,
  ): Promise<void>;
  /** Stamp the caller's own membership as read now. Throws ChannelNotFoundError for a non-member. */
  markRead(actor: AgentActor, channelId: string): Promise<void>;
  /**
   * Hide the channel for every member. Soft: the row and the thread survive, every read filters.
   * Throws ChannelNotFoundError for a non-member and ChannelPackageOwnedError for a channel the
   * tenant package defines, which configuration owns rather than any member.
   */
  /**
   * True when this call deleted the channel; false when it was already deleted. A repeat is a
   * no-op, so it announces nothing and its route records nothing.
   */
  softDelete(actor: AgentActor, channelId: string): Promise<boolean>;
};

/** What a conversation made here is described as, until somebody gives it a purpose. */
export const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;

function channelName(names: string[]) {
  const joined = names.join(", ");
  const codePoints = Array.from(joined);
  if (codePoints.length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${codePoints.slice(0, MAX_CHANNEL_NAME_CODE_POINTS - 1).join("")}…`;
}

/** Busy is a read of the same canonical executions returned by the conversation snapshot. */
const CHANNEL_BUSY = sql<boolean>`exists (
  select 1 from local_runs r where r.thread_id = ${CANONICAL_THREAD}
  and r.status in ('running','waiting')
)`;

export function createChannelStore(
  database: Database,
  profileStore: AgentProfileStore,
): ChannelStore {
  const makeChannel = async (
    transaction: ChannelTransaction,
    actor: AgentActor,
    agentIds: string[],
  ): Promise<AgentChannel> => {
    // Validated on this transaction, not through `profileStore.get`: the read has to share
    // the connection this transaction already holds, and has to hold the profile so an agent
    // cannot be deleted between passing the check and being linked to the new channel.
    //
    // Locks are taken in agent-ID order. Two channels selecting the same pair of agents in
    // opposite orders would otherwise be able to deadlock against each other.
    const profilesById = new Map<string, AgentProfile>();
    for (const agentId of [...agentIds].sort()) {
      const profile = await profileStore.getWithin(transaction, actor, agentId);
      if (!profile) throw new AgentNotFoundError(agentId);
      profilesById.set(agentId, profile);
    }

    const id = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    // Named from the caller's ordering, which is the order the channel presents its agents in.
    const name = channelName(
      agentIds.map((agentId) => {
        const profile = profilesById.get(agentId);
        if (!profile) throw new AgentNotFoundError(agentId);
        return profile.name;
      }),
    );

    await transaction.insert(channels).values({
      id,
      name,
      description: PRIVATE_AGENT_CHANNEL_DESCRIPTION,
    });
    await transaction.insert(channelMemberships).values({
      channelId: id,
      userId: actor.id,
    });
    await transaction
      .insert(channelAgents)
      .values(agentIds.map((agentId) => ({ channelId: id, agentId })));
    await transaction.insert(threadChannelMappings).values({
      userId: actor.id,
      channelId: id,
      threadId,
    });

    return { id, name, agentIds, threadId, active: true, lastMessageAt: null };
  };

  const store: ChannelStore = {
    create(actor, agentIds, transaction) {
      if (transaction) return makeChannel(transaction, actor, agentIds);
      return database.transaction(
        async (transaction) => makeChannel(transaction, actor, agentIds),
        { isolationLevel: "read committed" },
      );
    },

    async direct(actor, agentId) {
      const [found] = await database.select({ id: channels.id }).from(channels)
        .innerJoin(channelMemberships, and(eq(channelMemberships.channelId, channels.id), eq(channelMemberships.userId, actor.id)))
        .innerJoin(channelAgents, and(eq(channelAgents.channelId, channels.id), eq(channelAgents.agentId, agentId)))
        .where(and(isNull(channels.deletedAt), sql`(select count(*) from channel_agents where channel_id=${channels.id})=1`))
        .orderBy(...ROSTER_ORDER).limit(1);
      if (found) {
        const channel = await store.get(actor, found.id);
        if (channel) return channel;
      }
      return store.create(actor, [agentId]);
    },
    async get(actor, channelId) {
      const rows = await database
        .select({
          id: channels.id,
          name: channels.name,
          agentId: channelAgents.agentId,
          threadId: CANONICAL_THREAD,
          lastMessageAt: channels.lastMessageAt,
          deletedAt: agentProfiles.deletedAt,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .orderBy(asc(channelAgents.agentId));

      const first = rows[0];
      if (!first) return null;

      return {
        id: first.id,
        name: first.name,
        agentIds: rows.map((row) => row.agentId),
        threadId: first.threadId,
        active: rows.every((row) => row.deletedAt === null),
        lastMessageAt: first.lastMessageAt,
      };
    },

    async list(actor, query = {}) {
      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_CHANNEL_PAGE, 1),
        MAX_CHANNEL_PAGE,
      );
      const cursor = decodeChannelCursor(query.cursor);

      /*
       * The page of channels is chosen first, and the agents are joined to that page.
       *
       * The row set below is one row per channel-agent pair, so a limit on rows would cut a channel
       * in half: its second Bot would arrive on the next page as a separate entry with the same id.
       * Limiting the channels and then joining keeps a channel whole whatever it holds.
       */
      const page = await database
        .select({
          id: channels.id,
          /*
           * To the microsecond, as text, for the cursor only: the audit reader's fix, for the same
           * fault. The column keeps microseconds and a `Date` keeps milliseconds, so a cursor made
           * from a `Date` named a moment just before its own row, and any channel later in that
           * millisecond compared as newer than the cursor and was on no page at all.
           */
          recency: sql<string>`to_char(${RECENCY} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          pinned: sql<boolean>`${channelMemberships.pinnedAt} is not null`,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .where(
          and(
            isNull(channels.deletedAt),
            // One row comparison over the whole sort key, which only reads as "everything after the
            // cursor" because every part of that key descends. See ROSTER_ORDER.
            cursor
              ? sql`(${PINNED_RANK}, ${RECENCY}, ${channels.id}) < (${cursor.pinned ? 1 : 0}::int, ${cursor.recency}::timestamptz, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(...ROSTER_ORDER)
        // One more than asked for, so "is there another page" needs no second count query.
        .limit(limit + 1);

      const wanted = page.slice(0, limit);
      const last = wanted.at(-1);
      const nextCursor =
        page.length > limit && last
          ? encodeChannelCursor({
              pinned: last.pinned,
              recency: last.recency,
              id: last.id,
            })
          : null;

      if (wanted.length === 0) return { channels: [], nextCursor: null };

      const rows = await database
        .select({
          id: channels.id,
          name: channels.name,
          agentId: channelAgents.agentId,
          threadId: CANONICAL_THREAD,
          deletedAt: agentProfiles.deletedAt,
          busy: CHANNEL_BUSY,
          channelSummary: channels.summary,
          lastMessage: channels.lastMessage,
          lastMessageAt: channels.lastMessageAt,
          lastMessageAgentId: channels.lastMessageAgentId,
          createdAt: channels.createdAt,
          pinnedAt: channelMemberships.pinnedAt,
          lastReadAt: channelMemberships.lastReadAt,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(
          and(
            inArray(
              channels.id,
              wanted.map((row) => row.id),
            ),
            // Repeated, not inherited from the query that chose the page: these are two statements
            // on two snapshots, so a delete that commits between them would otherwise hand back a
            // channel this person can no longer see.
            isNull(channels.deletedAt),
          ),
        )
        // The same order the page was chosen in, since the rows below are read in order.
        .orderBy(...ROSTER_ORDER, asc(channelAgents.agentId));

      // One row per channel-agent pair; the ordering above keeps each channel's rows together and
      // its agents in the same lexicographic order `get` returns.
      const summaries = new Map<string, ChannelSummary>();
      for (const row of rows) {
        const summary = summaries.get(row.id);
        if (summary) {
          summary.agentIds.push(row.agentId);
          summary.active &&= row.deletedAt === null;
          continue;
        }
        summaries.set(row.id, {
          id: row.id,
          name: row.name,
          agentIds: [row.agentId],
          threadId: row.threadId,
          active: row.deletedAt === null,
          busy: row.busy,
          summary: row.channelSummary,
          lastMessage: row.lastMessage,
          lastMessageAt: row.lastMessageAt,
          lastMessageAgentId: row.lastMessageAgentId,
          createdAt: row.createdAt,
          pinned: row.pinnedAt !== null,
          lastReadAt: row.lastReadAt,
        });
      }
      return { channels: [...summaries.values()], nextCursor };
    },

    async setPinned(actor, channelId, pinned) {
      await database.transaction(
        async (transaction) => {
          const updated = await transaction
            .update(channelMemberships)
            .set({ pinnedAt: pinned ? new Date() : null })
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
                // A deleted channel is not there to pin. Without this, pinning one succeeds and
                // announces, and the announcement sends this person's tabs to refetch a roster that
                // cannot show the row. `get` and `list` filter the same way.
                exists(
                  transaction
                    .select({ one: sql`1` })
                    .from(channels)
                    .where(
                      and(
                        eq(channels.id, channelId),
                        isNull(channels.deletedAt),
                      ),
                    ),
                ),
              ),
            )
            .returning({ channelId: channelMemberships.channelId });
          // Not a member, no such channel, or a deleted one: the same answer every way, matching
          // ordinary conversation reads.
          if (updated.length === 0) throw new ChannelNotFoundError(channelId);

          /*
           * Announced to this member alone.
           *
           * A pin is a fact about one membership row, so `memberIds` holds the person who made it
           * and nobody else. The hub delivers by that list, which is what carries the pin across
           * this person's own tabs and replicas without putting it on anybody else's roster.
           */
          const event: ChannelActivityEvent = {
            channelId,
            memberIds: [actor.id],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            pinned,
          };
          await announceChannelActivity(transaction, event);
        },
        { isolationLevel: "read committed" },
      );
    },

    async markRead(actor, channelId) {
      const updated = await database
        .update(channelMemberships)
        .set({
          /*
           * The later of this clock and the channel's own last-message stamp. last_message_at is
           * written from the reporting browser's clock and is not bounded; a marker stamped
           * plainly "now" by a server running behind it would leave the row reading as unseen for
           * every member, re-lighting the dot on each refetch until wall clock catches up.
           */
          lastReadAt: sql`greatest(now(), coalesce((select ${channels.lastMessageAt} from ${channels} where ${channels.id} = ${channelMemberships.channelId}), now()))`,
        })
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, actor.id),
            // A deleted channel is not there to read. The same guard `setPinned` carries, for the
            // same reason: the row is gone from every roster, so nothing about it is markable.
            exists(
              database
                .select({ one: sql`1` })
                .from(channels)
                .where(
                  and(eq(channels.id, channelId), isNull(channels.deletedAt)),
                ),
            ),
          ),
        )
        .returning({ channelId: channelMemberships.channelId });
      // Not a member, or no such channel: the same answer either way, matching setPinned.
      if (updated.length === 0) throw new ChannelNotFoundError(channelId);
    },

    async softDelete(actor, channelId) {
      return await database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({ packageId: channels.packageId })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            .where(eq(channels.id, channelId));
          // Not a member, or no such channel: the same answer either way.
          if (!row) throw new ChannelNotFoundError(channelId);
          // Package channels are configuration; the sync that wrote them owns them.
          if (row.packageId !== null) {
            throw new ChannelPackageOwnedError(channelId);
          }
          // The guard on deletedAt is what makes a repeat call a no-op rather than a new stamp.
          const stamped = await transaction
            .update(channels)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
            .returning({ id: channels.id });
          /*
           * And the rest of the no-op: a repeat changed nothing, so nothing is announced. Without
           * this, every repeat told every member again, and the route wrote another
           * `channel.deleted` row to an append-only trail for a deletion that had not happened.
           */
          if (stamped.length === 0) return false;

          // Read on this transaction, so the members told are the ones the channel had when it was
          // hidden. Soft leaves the membership rows in place, so this reads the same list a repeat
          // call would.
          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          /*
           * Announced inside the transaction, so it is delivered on commit and a refused delete —
           * a channel the package owns, or one the caller is not in — announces nothing at all.
           *
           * Every member is told, because the deletion hides the channel for all of them: without
           * this, a second tab and a second replica keep rendering a row whose channel no longer
           * resolves until something else makes them refetch.
           */
          const event: ChannelActivityEvent = {
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            deleted: true,
          };
          await announceChannelActivity(transaction, event);
          return true;
        },
        { isolationLevel: "read committed" },
      );
    },

  };
  return store;
}

export class ChannelNotFoundError extends Error {
  constructor(id: string) {
    super(`Channel ${id} was not found.`);
    this.name = "ChannelNotFoundError";
  }
}

export class ChannelPackageOwnedError extends Error {
  constructor(id: string) {
    super(`Channel ${id} is defined by the deployment package.`);
    this.name = "ChannelPackageOwnedError";
  }
}

type ChannelInputParseResult =
  | { ok: true; value: { agentIds: string[] } }
  | { ok: false; error: string };

type ChannelInputObject = { agentIds?: unknown };

export function parseChannelInput(input: unknown): ChannelInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Channel input must be a JSON object." };
  }

  if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) {
    return { ok: false, error: "Agent IDs must be a non-empty array." };
  }

  const agentIds: string[] = [];
  for (const agentId of input.agentIds) {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "Agent IDs must be non-empty strings." };
    }
    agentIds.push(agentId.trim());
  }

  if (new Set(agentIds).size !== agentIds.length) {
    return { ok: false, error: "Agent IDs must be unique." };
  }

  return { ok: true, value: { agentIds: agentIds.sort() } };
}

function isChannelInputObject(input: unknown): input is ChannelInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function createChannelRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Absent in tests and wherever live updates are not wanted; the routes still work without it. */
  events?: ChannelEventHub,
  /** Where a channel's removal is written. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Write the one audit row this file ever writes, tolerantly.
   *
   * Mirrors `record` in agents/routes.ts: never fatal, because the channel is already hidden and the
   * caller has already been told so by the time this runs. A trail that is briefly unavailable is
   * not a reason to report a failure that did not happen.
   *
   * Reached only after `softDelete` resolves, so a refused delete — a channel the package owns, or
   * one the caller is not in — writes nothing. The trail records acts, not attempts.
   */
  const recordDeleted = async (
    context: Context<{ Variables: AppVariables }>,
    channelId: string,
  ): Promise<void> => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType: "channel.deleted",
        targetType: "channel",
        targetId: channelId,
        /*
         * Attributed, including in single-user mode.
         *
         * The other audited surfaces drop this id when the actor is the local development one, on
         * the grounds that `audit_events.actor_user_id` has a foreign key into `users` that it would
         * violate. It has no foreign key, and `initializeDevActorUser` writes that row at start-up
         * anyway, so neither half of the reason holds. It matters here more than most: single-user
         * is the mode `.env.example` ships switched on, so an unattributed row is what a fork sees
         * by default, and "somebody deleted this conversation" is the whole point of the row.
         */
        actorUserId: actor.id,
        // Named rather than implied: the channel row and its thread are still there, and a later
        // hard delete would be a different fact about the same channel.
        payload: { mechanism: "soft" },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "channel-audit-write-failed",
          eventType: "channel.deleted",
          channelId,
          error: String(error),
        }),
      );
    }
  };

  routes.post("/direct", requireUser, async context => {
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body.agentId !== "string" || !body.agentId.trim())
      return context.json({ error: "A Bot id is required." }, 400);
    try {
      return context.json({ channel: channelDto(await store.direct(context.var.actor, body.agentId)) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  // Before `/:channelId`, or "events" is read as a channel id.
  if (events) {
    routes.get(
      "/events",
      requireUser,
      upgradeWebSocket((context) => {
        // Resolved at upgrade, not per message: the connection belongs to whoever authenticated it,
        // and nothing it later sends can change that.
        const { id: userId } = context.var.actor;
        let detach = () => {};
        return {
          onOpen: (_event, ws) => {
            detach = events.register(userId, (payload) => ws.send(payload));
          },
          onClose: () => detach(),
          onError: () => detach(),
        };
      }),
    );
  }

  routes.post("/", requireUser, async (context) => {
    const parsed = parseChannelInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const channel = await store.create(
        context.var.actor,
        parsed.value.agentIds,
      );
      return context.json({ channel: channelDto(channel) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const url = new URL(context.req.url);
      /*
       * Parsed strictly, not coerced: `Number.parseInt` reads `"12abc"` as 12 and `"3.9"`
       * as 3, so a typo silently returned the wrong page. A run of digits is clamped into
       * range like the store already does; anything else is a 400 naming the parameter.
       */
      const parsed = parsePageLimit(
        url.searchParams.get("limit"),
        MAX_CHANNEL_PAGE,
      );
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);
      const page = await store.list(context.var.actor, {
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      });

      return context.json({
        channels: page.channels.map(channelSummaryDto),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:channelId/pin", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isChannelInputObject(body)) {
      return context.json({ error: "Pin input must be a JSON object." }, 400);
    }
    const { pinned } = body as { pinned?: unknown };
    if (typeof pinned !== "boolean") {
      return context.json({ error: "Pinned must be true or false." }, 400);
    }

    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("channelId"),
        pinned,
      );
      return context.json({ pinned });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:channelId/read", requireUser, async (context) => {
    try {
      await store.markRead(context.var.actor, context.req.param("channelId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:channelId", requireUser, async (context) => {
    const channelId = context.req.param("channelId");
    try {
      const deleted = await store.softDelete(context.var.actor, channelId);
      // A repeat is still 204, but it deleted nothing, and the trail records acts, not attempts.
      if (deleted !== false) await recordDeleted(context, channelId);
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:channelId", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) {
        return context.json({ error: "Couldn't find that conversation." }, 404);
      }
      return context.json({ channel: channelDto(channel) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

/** A channel as it goes over the wire: the same shape, with the date serialised. */
type ChannelWire = Omit<AgentChannel, "lastMessageAt"> & {
  lastMessageAt: string | null;
};

function channelDto(channel: AgentChannel): ChannelWire {
  return {
    id: channel.id,
    name: channel.name,
    agentIds: channel.agentIds,
    threadId: channel.threadId,
    active: channel.active,
    // ISO-8601 so the browser gets a string it can compare, like the roster's copy.
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
  };
}

function channelSummaryDto(channel: ChannelSummary) {
  return {
    ...channelDto(channel),
    busy: channel.busy,
    summary: channel.summary,
    lastMessage: channel.lastMessage,
    lastMessageAgentId: channel.lastMessageAgentId,
    createdAt: channel.createdAt.toISOString(),
    pinned: channel.pinned,
    // Serialised as ISO-8601 like lastMessageAt, so the browser can compare the two as strings.
    lastReadAt: channel.lastReadAt?.toISOString() ?? null,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Couldn't find that Bot." }, 404);
  }
  if (error instanceof ChannelNotFoundError) {
    return context.json({ error: "Couldn't find that conversation." }, 404);
  }
  if (error instanceof ChannelPackageOwnedError) {
    return context.json(
      {
        error: "This conversation is built in and can't be deleted.",
      },
      409,
    );
  }
  throw error;
}

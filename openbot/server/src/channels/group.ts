import type { ThreadMessage } from "@openbot/shared/thread-events";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { channelMemberships, users } from "../db/schema/core";
import type { LocalThreadStore } from "../runtime/thread-store";
import type { ChannelStore } from "./routes";

export class GroupNotFoundError extends Error {
  constructor() {
    super("That group conversation was not found.");
    this.name = "GroupNotFoundError";
  }
}
export class GroupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupRefusedError";
  }
}

export function createGroupConversations(deps: {
  database: Database;
  channels: ChannelStore;
  profiles: AgentProfileStore;
  actorFor(id: string): Promise<AgentActor>;
  threads: LocalThreadStore;
  runTurn: TurnRunner;
}) {
  const people = (channelId: string) => deps.database
    .select({ userId: channelMemberships.userId, email: users.email, name: users.name })
    .from(channelMemberships)
    .innerJoin(users, eq(users.id, channelMemberships.userId))
    .where(eq(channelMemberships.channelId, channelId))
    .orderBy(asc(channelMemberships.createdAt), asc(users.email));

  async function conversation(ownerUserId: string, channelId: string) {
    const actor = await deps.actorFor(ownerUserId);
    const channel = await deps.channels.get(actor, channelId);
    if (!channel || channel.agentIds.length < 2) throw new GroupNotFoundError();
    const available = await deps.profiles.list(actor);
    const bots = channel.agentIds.flatMap(id => {
      const bot = available.find(candidate => candidate.id === id);
      return bot ? [{ id: bot.id, name: bot.name, title: bot.title, roleDescription: bot.roleDescription }] : [];
    });
    return { actor, channel, bots };
  }

  return {
    /** Source migration only. Legacy group tables are never used for new turns. */
    async initialize() {
      await deps.database.transaction(async tx => {
        // The first channel mapping is the conversation's canonical thread, for all members.
        await tx.execute(sql`
          insert into local_threads(id,user_id,agent_id)
          select mapping.thread_id,mapping.user_id,bot.agent_id
          from (
            select distinct on (channel_id) channel_id,thread_id,user_id
            from thread_channel_mappings order by channel_id,created_at,user_id
          ) mapping
          join lateral (
            select agent_id from channel_agents where channel_id=mapping.channel_id
            order by created_at,agent_id limit 1
          ) bot on true
          where exists(select 1 from group_messages g where g.channel_id=mapping.channel_id)
          on conflict(id) do nothing`);
        await tx.execute(sql`
          insert into local_messages(thread_id,id,body)
          select mapping.thread_id,g.id,
            jsonb_build_object('id',g.id,'role',case when g.agent_id is null then 'user' else 'assistant' end,
              'content',g.text,'createdAt',g.created_at)
            || case when g.agent_id is null then jsonb_build_object('senderUserId',g.owner_user_id)
               else jsonb_build_object('senderBotId',g.agent_id) end
          from group_messages g
          join (
            select distinct on (channel_id) channel_id,thread_id
            from thread_channel_mappings order by channel_id,created_at,user_id
          ) mapping on mapping.channel_id=g.channel_id
          where g.text<>''
          order by g.created_at,g.id
          on conflict(thread_id,id) do nothing`);
      });
    },

    async create(ownerUserId: string, input: unknown) {
      const body = z.strictObject({ agentIds: z.array(z.string().min(1)).min(2) }).parse(input);
      if (new Set(body.agentIds).size !== body.agentIds.length)
        throw new GroupRefusedError("Each Bot can be in a group once.");
      return deps.channels.create(await deps.actorFor(ownerUserId), body.agentIds);
    },

    async list(ownerUserId: string, channelId: string) {
      const { channel, bots } = await conversation(ownerUserId, channelId);
      const members = await people(channelId);
      await deps.threads.getOrCreateThread({
        threadId: channel.threadId, userId: ownerUserId, agentId: channel.agentIds[0],
      });
      const snapshot = await deps.threads.snapshot(channel.threadId, ownerUserId);
      return {
        threadId: channel.threadId,
        bots,
        people: members.map((person, index) => ({ ...person, creator: index === 0 })),
        ...snapshot,
      };
    },

    async addMember(ownerUserId: string, channelId: string, input: unknown) {
      const body = z.strictObject({ email: z.string().trim().email().max(320) }).parse(input);
      await conversation(ownerUserId, channelId);
      const [person] = await deps.database.select({ id: users.id }).from(users)
        .where(eq(sql`lower(${users.email})`, body.email.toLowerCase())).limit(1);
      if (!person) throw new GroupRefusedError("Nobody with that email has signed in to this deployment yet.");
      await deps.database.insert(channelMemberships).values({ channelId, userId: person.id }).onConflictDoNothing();
      return { userId: person.id };
    },

    async removeMember(ownerUserId: string, channelId: string, userId: string) {
      await conversation(ownerUserId, channelId);
      const members = await people(channelId);
      const creator = members[0]?.userId;
      if (userId !== ownerUserId && ownerUserId !== creator)
        throw new GroupRefusedError("Only the person who started this group can take others out of it.");
      if (userId === creator && members.length > 1)
        throw new GroupRefusedError("The person who started this group cannot leave while others are in it.");
      if (!members.some(person => person.userId === userId)) throw new GroupNotFoundError();
      await deps.database.delete(channelMemberships).where(and(
        eq(channelMemberships.channelId, channelId), eq(channelMemberships.userId, userId),
      ));
    },

    async send(ownerUserId: string, channelId: string, input: unknown) {
      const body = z.strictObject({
        id: z.string().min(1).max(160),
        text: z.string().trim().min(1).max(16000),
        agentId: z.string().min(1).nullable().optional(),
      }).parse(input);
      const { actor, channel, bots } = await conversation(ownerUserId, channelId);
      const selected = body.agentId ? bots.filter(bot => bot.id === body.agentId) : bots;
      if (!selected.length) throw new GroupRefusedError("Choose an available Bot in this conversation.");
      const message: ThreadMessage = {
        id: body.id, role: "user", content: body.text,
        senderUserId: ownerUserId, createdAt: new Date().toISOString(),
      };
      const [first, ...rest] = selected;
      const run = async (agentId: string, parentRunId?: string) => {
        const result = await deps.runTurn({
          ownerUserId, agentId, threadId: channel.threadId,
          instruction: parentRunId
            ? "Respond to the person's latest message in this shared conversation. Other Bots' answers are already in the conversation."
            : body.text,
          ...(parentRunId ? { parentRunId, persistUserMessage: false } : { runId: body.id, userMessage: message }),
        });
        if (result.replyText) await deps.channels.recordActivity(actor, channelId, {
          text: result.replyText, agentId, at: new Date(),
        }, { id: result.runId });
        return result;
      };
      let result = await run(first.id);
      const rootRunId = result.runId;
      for (const bot of rest) {
        if (result.status === "waiting") break;
        result = await run(bot.id, rootRunId);
      }
      return { id: body.id, runId: result.runId, status: result.status };
    },
  };
}
export type GroupConversations = ReturnType<typeof createGroupConversations>;

export function createGroupRoutes(
  service: GroupConversations,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => context.json({ error: error.message },
    error instanceof GroupNotFoundError ? 404 :
      error instanceof GroupRefusedError || error instanceof z.ZodError ? 400 : 500));
  routes.post("/", async context => context.json({
    channel: await service.create(context.var.actor.id, await context.req.json()),
  }, 201));
  routes.get("/:channelId", async context => context.json(
    await service.list(context.var.actor.id, context.req.param("channelId")),
  ));
  routes.post("/:channelId", async context => context.json(
    await service.send(context.var.actor.id, context.req.param("channelId"), await context.req.json()),
  ));
  routes.post("/:channelId/members", async context => context.json(
    await service.addMember(context.var.actor.id, context.req.param("channelId"), await context.req.json()), 201,
  ));
  routes.delete("/:channelId/members/:userId", async context => {
    await service.removeMember(context.var.actor.id, context.req.param("channelId"), context.req.param("userId"));
    return context.body(null, 204);
  });
  return routes;
}

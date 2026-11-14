import type { ThreadMessage } from "@openbot/shared/thread-events";
import type { Execution } from "../runtime/execution";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { channelMemberships, users } from "../db/schema/core";
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
  execution: Execution;
}) {
  const people = (channelId: string) => deps.database
    .select({ userId: channelMemberships.userId, email: users.email, name: users.name })
    .from(channelMemberships)
    .innerJoin(users, eq(users.id, channelMemberships.userId))
    .where(eq(channelMemberships.channelId, channelId))
    .orderBy(asc(channelMemberships.createdAt), asc(users.email));

  async function groupChannel(actor: AgentActor, channelId: string) {
    const channel = await deps.channels.get(actor, channelId);
    if (!channel || channel.agentIds.length < 2) throw new GroupNotFoundError();
    return channel;
  }

  return {
    async create(actor: AgentActor, input: unknown) {
      const body = z.strictObject({ agentIds: z.array(z.string().min(1)).min(2) }).parse(input);
      if (new Set(body.agentIds).size !== body.agentIds.length)
        throw new GroupRefusedError("Each Bot can be in a group once.");
      return deps.channels.create(actor, body.agentIds);
    },

    async list(actor: AgentActor, channelId: string) {
      const channel = await groupChannel(actor, channelId);
      const available = await deps.profiles.list(actor);
      const bots = channel.agentIds.flatMap(id => {
        const bot = available.find(candidate => candidate.id === id);
        return bot ? [{ id: bot.id, name: bot.name, title: bot.title, roleDescription: bot.roleDescription }] : [];
      });
      const members = await people(channelId);
      return {
        threadId: channel.threadId,
        bots,
        people: members.map((person, index) => ({ ...person, creator: index === 0 })),
      };
    },

    async addMember(actor: AgentActor, channelId: string, input: unknown) {
      const body = z.strictObject({ email: z.string().trim().email().max(320) }).parse(input);
      await groupChannel(actor, channelId);
      const [person] = await deps.database.select({ id: users.id }).from(users)
        .where(eq(sql`lower(${users.email})`, body.email.toLowerCase())).limit(1);
      if (!person) throw new GroupRefusedError("Nobody with that email has signed in to this deployment yet.");
      await deps.database.insert(channelMemberships).values({ channelId, userId: person.id }).onConflictDoNothing();
      return { userId: person.id };
    },

    async removeMember(actor: AgentActor, channelId: string, userId: string) {
      await groupChannel(actor, channelId);
      const members = await people(channelId);
      const creator = members[0]?.userId;
      if (userId !== actor.id && actor.id !== creator)
        throw new GroupRefusedError("Only the person who started this group can take others out of it.");
      if (userId === creator && members.length > 1)
        throw new GroupRefusedError("The person who started this group cannot leave while others are in it.");
      if (!members.some(person => person.userId === userId)) throw new GroupNotFoundError();
      await deps.database.delete(channelMemberships).where(and(
        eq(channelMemberships.channelId, channelId), eq(channelMemberships.userId, userId),
      ));
    },

    async send(actor: AgentActor, channelId: string, input: unknown) {
      const body = z.strictObject({
        id: z.string().min(1).max(160),
        text: z.string().trim().min(1).max(16000),
        agentId: z.string().min(1).nullable().optional(),
      }).parse(input);
      const channel = await deps.channels.get(actor, channelId);
      if (!channel || channel.agentIds.length < 2) throw new GroupNotFoundError();
      if (body.agentId && !channel.agentIds.includes(body.agentId)) throw new GroupRefusedError("Choose a Bot in this conversation.");
      const message: ThreadMessage = { id: body.id, role: "user", content: body.text };
      const { runId } = await deps.execution.start({
        actor, threadId: channel.threadId,
        botIds: body.agentId ? [body.agentId] : channel.agentIds,
        messages: [message],
      });
      return { id: body.id, runId };
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
  routes.onError((error, context) => {
    if (error instanceof GroupNotFoundError) return context.json({ error: error.message }, 404);
    if (error instanceof GroupRefusedError || error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: error.message }, 400);
    if ("status" in error && (error.status === 400 || error.status === 404 || error.status === 409)) return context.json({ error: error.message }, error.status);
    console.error({ type: "group-request-failed", error: error.name });
    return context.json({ error: "The group conversation could not be processed." }, 500);
  });
  routes.post("/", async context => context.json({
    channel: await service.create(context.var.actor, await context.req.json()),
  }, 201));
  routes.get("/:channelId", async context => context.json(
    await service.list(context.var.actor, context.req.param("channelId")),
  ));
  routes.post("/:channelId", async context => context.json(
    await service.send(context.var.actor, context.req.param("channelId"), await context.req.json()), 202,
  ));
  routes.post("/:channelId/members", async context => context.json(
    await service.addMember(context.var.actor, context.req.param("channelId"), await context.req.json()), 201,
  ));
  routes.delete("/:channelId/members/:userId", async context => {
    await service.removeMember(context.var.actor, context.req.param("channelId"), context.req.param("userId"));
    return context.body(null, 204);
  });
  return routes;
}

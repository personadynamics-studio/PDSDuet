import { MessageSchema } from "@ag-ui/core/schemas";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { Execution } from "./execution";
import type { Settlement } from "./settlement";

const runBody = z.strictObject({
  agentId: z.string().min(1).optional(),
  messages: z.array(MessageSchema).min(1),
});

/** HTTP parses the person's request; execution owns admission, history, waiting and completion. */
export function createExecutionRoutes({ execution, settlement, requireUser }: {
  execution: Execution;
  settlement: Settlement;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.onError((error, context) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: "Invalid run input." }, 400);
    if ("status" in error && (error.status === 400 || error.status === 404 || error.status === 409))
      return context.json({ error: error.message }, error.status);
    console.error({ type: "execution-request-failed", error: error.name });
    return context.json({ error: "The conversation could not be processed." }, 500);
  });
  routes.get("/:threadId/messages", requireUser, async context =>
    context.json(await settlement.snapshot(context.req.param("threadId"), context.var.actor.id)),
  );
  routes.post("/:threadId/runs", requireUser, async context => {
    const body = runBody.parse(await context.req.json());
    return context.json(await execution.start({
      actor: context.var.actor,
      threadId: context.req.param("threadId"),
      ...(body.agentId ? { botIds: [body.agentId] } : {}),
      messages: body.messages,
    }), 202);
  });
  routes.post("/:threadId/runs/:runId/stop", requireUser, async context => {
    const threadId = context.req.param("threadId");
    await settlement.requireAccess(threadId, context.var.actor.id);
    return context.json({ stopped: await execution.stop(threadId, context.req.param("runId")) });
  });
  routes.get("/:threadId/events", requireUser, async context => {
    const threadId = context.req.param("threadId");
    await settlement.requireAccess(threadId, context.var.actor.id);
    let cursor = Number(context.req.header("Last-Event-ID") ?? context.req.query("after") ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return context.json({ error: "Invalid event cursor." }, 400);
    return streamSSE(context, async stream => {
      let closed = false;
      let changed = true;
      let wake: (() => void) | undefined;
      const unsubscribe = settlement.subscribe(threadId, () => { changed = true; wake?.(); });
      stream.onAbort(() => { closed = true; wake?.(); });
      const keepalive = setInterval(() => wake?.(), 15_000);
      try {
        await stream.write(": connected\n\n");
        while (!closed) {
          changed = false;
          const events = await settlement.events(threadId, cursor);
          for (const event of events) {
            await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
            cursor = event.seq;
          }
          if (events.length || changed) continue;
          while (!closed && !changed) {
            await new Promise<void>(resolve => { wake = resolve; if (changed || closed) resolve(); });
            wake = undefined;
            if (!closed && !changed) await stream.write(": keep-alive\n\n");
          }
        }
      } finally { clearInterval(keepalive); unsubscribe(); }
    });
  });
  return routes;
}

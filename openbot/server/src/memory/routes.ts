import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { MemoryStore } from "./store";
import {
  MemoryNotFoundError,
  MemoryRefusedError,
  parseMemoryInput,
  parseMemoryPatch,
} from "./types";

export function createMemoryRoutes(
  store: MemoryStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof MemoryNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof MemoryRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "memory-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Memory is unavailable. Try again." }, 503);
  });
  routes.get("/", async (context) => {
    const search = context.req.query("search") ?? "";
    if (search.length > 200) throw new MemoryRefusedError("Search is at most 200 characters.");
    return context.json({ memories: await store.list(context.var.actor.id, search) });
  });
  routes.post("/", async (context) =>
    context.json(
      {
        memory: await store.create(
          context.var.actor.id,
          parseMemoryInput(await body(context.req.raw)),
        ),
      },
      201,
    ),
  );
  routes.patch("/:id", async (context) =>
    context.json({
      memory: await store.update(
        context.var.actor.id,
        context.req.param("id"),
        parseMemoryPatch(await body(context.req.raw)),
      ),
    }),
  );
  routes.delete("/:id", async (context) => {
    await store.remove(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  return routes;
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new MemoryRefusedError("Supply JSON memory settings.");
  try {
    return await request.json();
  } catch {
    throw new MemoryRefusedError("The memory settings could not be read.");
  }
}

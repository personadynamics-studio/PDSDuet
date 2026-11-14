import { serve } from "bun";
import { Hono } from "hono";
import { environmentFor } from "./environment";
import {
  DockerUnavailableError,
  ensure,
  listOwned,
  reachable,
  reset,
  stop,
} from "./docker";
import { namesFor } from "./names";
import { computerMemoryBytes } from "./computer-memory-bytes";
import { listenPort } from "./listen-port";

const port = listenPort(process.env.PORT, 4300);
const image =
  process.env.COMPUTER_IMAGE?.trim() || "openbot-agent-computer:latest";
const network = process.env.COMPUTER_NETWORK?.trim() || undefined;
const runtime = process.env.COMPUTER_RUNTIME?.trim() || undefined;
const resolvedMemory = computerMemoryBytes(process.env.COMPUTER_MEMORY_BYTES);
if (!resolvedMemory.ok) {
  console.error(resolvedMemory.reason);
  process.exit(1);
}
const memoryBytes = resolvedMemory.bytes;

const app = new Hono();

app.get("/health", async (context) =>
  context.json({ status: "ok", docker: await reachable() }),
);

app.post("/computers/:botId/ensure", async (context) => {
  const names = namesFor(context.req.param("botId"));

  try {
    const state = await ensure(names, {
      image,
      environment: environmentFor(names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
    }, context.req.raw.signal);
    return context.json(state);
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/stop", async (context) => {
  const names = namesFor(context.req.param("botId"));
  try {
    const stopped = await stop(names);
    return context.json({ stopped });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/reset", async (context) => {
  const names = namesFor(context.req.param("botId"));
  try {
    const wasThere = await reset(names);
    return context.json({ reset: wasThere });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);

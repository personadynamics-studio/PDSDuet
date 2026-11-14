import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { downloadHeaders } from "@openbot/shared/file-download";
import type { AppVariables } from "../auth/guards";
import {
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  HandoffRequestError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "./gateway";


export function createComputerRoutes(
  gateway: ComputerGateway,
  requireComputer: MiddlewareHandler<{ Variables: AppVariables }>,
  listVisibleBots: (actor: AppVariables["actor"]) => Promise<readonly string[]>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireComputer);

  async function visibleComputers(actor: AppVariables["actor"]) {
    const visible = new Set(await listVisibleBots(actor));
    const fleet = await gateway.computers();
    return { ...fleet, computers: fleet.computers.filter((computer) => visible.has(computer.botId)) };
  }

  routes.get("/:botId/status", async (context) => {
    const botId = context.req.param("botId");
    return context.json(await gateway.status(botId));
  });

  routes.get("/:botId/screenshot", async (context) => {
    try {
      return context.json(await gateway.screenshot(context.req.param("botId"), context.req.raw.signal));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.get("/:botId/read", async (context) => {
    try {
      return context.json(await gateway.read(context.req.param("botId"), context.req.raw.signal));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/navigate", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      url?: unknown;
      toolCallId?: unknown;
    } | null;
    if (typeof body?.url !== "string" || !body.url.trim()) {
      return context.json({ error: "A web address is required." }, 400);
    }
    
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : "";

    try {
      const botId = context.req.param("botId") ?? "default";
      const result = await gateway.navigate(
        botId,
        body.url.trim(),
        toolCallId || undefined,
        context.req.raw.signal,
      );

      return context.json(result);
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/snapshot", async (context) => {
    try {
      return context.json(await gateway.snapshot(context.req.param("botId"), context.req.raw.signal));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  
  routes.post("/:botId/click", (context) =>
    act(context, (botId, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      return gateway.click(botId, ref, signal);
    }),
  );

  routes.post("/:botId/type", (context) =>
    act(context, (botId, body, signal) => {
      const ref = asRef(body);
      if (!ref) return badRef;
      if (typeof body?.text !== "string") {
        return { error: "The text to enter is required." };
      }
      return gateway.type(
        botId,
        {
          ...ref,
          text: body.text,
          submit: body?.submit === true,
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/key", (context) =>
    act(context, (botId, body, signal) => {
      if (typeof body?.key !== "string" || !body.key) {
        return { error: "A key name is required, such as Enter or Tab." };
      }
      const ref = asRef(body);
      return gateway.key(
        botId,
        {
          key: body.key,
          ...(ref ?? {}),
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/scroll", (context) =>
    act(context, (botId, body, signal) => {
      if (!usableDeltaY(body?.deltaY)) return badDeltaY;
      return gateway.scroll(botId, {
        ...(typeof body?.deltaY === "number" ? { deltaY: body.deltaY } : {}),
      }, signal);
    }),
  );

  
  routes.get("/:botId/control", async (context) => {
    try {
      return context.json(
        await gateway.control(
          context.req.param("botId"),
          context.req.query("requestId"),
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/control/request", (context) =>
    act(context, (botId, body, signal) =>
      gateway.requestHelp(
        botId,
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "It can't continue without you.",
        typeof body?.toolCallId === "string" ? body.toolCallId : undefined,
        signal,
      ),
    ),
  );

  
  routes.get("/fleet", async (context) => {
    try {
      return context.json(await visibleComputers(context.var.actor));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.get("/:botId/computers", async (context) => {
    try {
      return context.json(await visibleComputers(context.var.actor));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  
  routes.post("/:botId/computers/stop", (context) =>
    act(context, (botId) => gateway.stopComputer(botId)),
  );

  
  routes.post("/:botId/computers/reset", (context) =>
    act(context, (botId) => gateway.resetComputer(botId)),
  );

  
  routes.post("/:botId/computers/update", (context) =>
    act(context, (botId) => gateway.updateComputer(botId)),
  );

  routes.post("/:botId/control/take", (context) =>
    act(context, (botId, body, signal) =>
      gateway.takeControl(botId, body?.requestId as string | undefined, signal),
    ),
  );

  routes.post("/:botId/control/release", (context) =>
    act(context, (botId, body, signal) =>
      gateway.releaseControl(botId, body?.requestId as string | undefined, signal),
    ),
  );

  routes.post("/:botId/control/cancel", (context) =>
    act(context, (botId, body, signal) =>
      gateway.cancelControl(botId, body?.requestId as string | undefined, signal),
    ),
  );

  
  routes.post("/:botId/control/secret", (context) =>
    act(context, (botId, body, signal) => {
      if (typeof body?.ref !== "string" || !body.ref) {
        return {
          error:
            "Say which field the value goes in, using a ref from your snapshot.",
        };
      }
      return gateway.requestSecret(botId, {
        label:
          typeof body?.label === "string" && body.label.trim()
            ? body.label.trim()
            : "the value this page is asking for",
        ref: body.ref,
        ...(typeof body.toolCallId === "string" ? { toolCallId: body.toolCallId } : {}),
      }, signal);
    }),
  );

  
  routes.post("/:botId/human/secret", (context) =>
    act(context, (botId, body, signal) => {
      if (typeof body?.text !== "string" || !body.text) {
        return { error: "A value is required." };
      }
      return gateway.supplySecret(botId, body.text, signal);
    }),
  );

  
  routes.post("/:botId/human/:kind", async (context) => {
    const kind = context.req.param("kind");
    if (
      kind !== "click" &&
      kind !== "type" &&
      kind !== "key" &&
      kind !== "scroll"
    ) {
      return context.json({ error: "Unknown input." }, 400);
    }
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    
    if (kind === "click") {
      if (
        typeof body?.x !== "number" ||
        !Number.isFinite(body.x) ||
        typeof body?.y !== "number" ||
        !Number.isFinite(body.y)
      ) {
        return context.json(
          { error: "A click needs numeric x and y coordinates." },
          400,
        );
      }
    }
    if (kind === "type") {
      if (typeof body?.text !== "string") {
        return context.json({ error: "The text to enter is required." }, 400);
      }
    }
    if (kind === "key") {
      if (typeof body?.key !== "string" || !body.key) {
        return context.json(
          { error: "A key name is required, such as Enter or Tab." },
          400,
        );
      }
    }
    if (kind === "scroll" && !usableDeltaY(body?.deltaY)) {
      return context.json(badDeltaY, 400);
    }
    try {
      return context.json(
        await gateway.humanInput(context.req.param("botId"), {
          ...(body ?? {}),
          // Last, so the checked value wins. Spread over it, a body carrying its own `kind` replaced
          // the one this route had just checked, and the gateway puts that value into the path it
          // calls on the computer.
          kind,
        } as Parameters<typeof gateway.humanInput>[1], context.req.raw.signal),
      );
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/files/list", (context) =>
    act(context, (botId, body, signal) =>
      gateway.listFiles(botId, {
        ...(typeof body?.path === "string" && body.path.trim()
          ? { path: body.path.trim() }
          : {}),
      }, signal),
    ),
  );

  routes.post("/:botId/files/read", (context) =>
    act(context, (botId, body, signal) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      return gateway.readFile(botId, { path: body.path.trim() }, signal);
    }),
  );

  
  routes.get("/:botId/files/download", async (context) => {
    const path = context.req.query("path");
    if (!path?.trim()) {
      return context.json({ error: "A file path is required." }, 400);
    }

    try {
      const file = await gateway.downloadFile(
        context.req.param("botId"),
        { path: path.trim() },
        context.req.raw.signal,
      );
      return new Response(file.body, {
        headers: downloadHeaders(file.name, file.bytes),
      });
    } catch (error) {
      return actionFailure(context, error);
    }
  });

  
  routes.post("/:botId/exec", (context) =>
    act(context, (botId, body, signal) => {
      if (typeof body?.command !== "string" || !body.command.trim()) {
        return { error: "A command is required." };
      }
      if (body.timeoutMs !== undefined) {
        if (
          typeof body.timeoutMs !== "number" ||
          !Number.isInteger(body.timeoutMs) ||
          body.timeoutMs < 1_000 ||
          body.timeoutMs > 600_000
        ) {
          return {
            error:
              "timeoutMs must be a whole number of milliseconds between 1000 and 600000.",
          };
        }
      }
      // The fourth argument, like every other acting route. Without it the plumbing through
      // gateway.runCommand and into the shell's own abort listener was dead code, and Stop ended the
      // run in the transcript while the command carried on to completion inside the container.
      return gateway.runCommand(
        botId,
        {
          command: body.command,
          ...(typeof body.timeoutMs === "number"
            ? { timeoutMs: body.timeoutMs }
            : {}),
        },
        signal,
      );
    }),
  );

  routes.post("/:botId/files/write", (context) =>
    act(context, (botId, body, signal) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      if (typeof body?.contents !== "string") {
        return { error: "The contents to write are required." };
      }
      return gateway.writeFile(botId, {
        path: body.path.trim(),
        contents: body.contents,
        append: body.append === true,
      }, signal);
    }),
  );

  return routes;
}

type ComputerContext = Context<{ Variables: AppVariables }>;


type BadRequest = { error: string };

const badRef: BadRequest = { error: "A field ref is required." };

const badDeltaY: BadRequest = {
  error: "deltaY must be a finite number of pixels.",
};


function usableDeltaY(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}


async function act(
  context: ComputerContext,
  handler: (
    botId: string,
    body: Record<string, unknown> | null,
    
    signal: AbortSignal,
  ) => Promise<unknown> | BadRequest,
) {
  // Always present on these routes, which all declare `:botId`. The fallback exists because this
  // helper is typed against a generic context that cannot know that, and a thrown "undefined bot"
  // would be a worse outcome than naming the one shared computer.
  const botId = context.req.param("botId") ?? "default";
  const body = (await context.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    const result = await handler(
      botId,
      body,
      context.req.raw.signal,
    );
    if (isBadRequest(result)) {
      return context.json(result, 400);
    }
    return context.json(result as Record<string, unknown>);
  } catch (error) {
    return actionFailure(context, error);
  }
}

function actionFailure(context: ComputerContext, error: unknown) {
  return context.json(errorBody(error), statusFor(error));
}

function isBadRequest(value: unknown): value is BadRequest {
  return (
    !!value &&
    typeof value === "object" &&
    "error" in value &&
    !("action" in value)
  );
}

function asRef(body: Record<string, unknown> | null): { ref: string } | undefined {
  return typeof body?.ref === "string" && body.ref ? { ref: body.ref } : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}


function errorBody(error: unknown): Record<string, unknown> {
  return {
    error: describe(error),
    ...(error instanceof HandoffRequestError
      ? { controlRequestError: true }
      : {}),
  };
}

function statusFor(error: unknown): 400 | 403 | 404 | 409 | 413 | 500 | 503 {
  if (error instanceof HandoffRequestError) return error.status;
  if (error instanceof ElementNotFoundError) return 409;
  if (error instanceof WorkspaceRefusedError) return 403;
  if (error instanceof WorkspaceRequestError) return 400;
  if (error instanceof WorkspaceNotFoundError) return 404;
  if (error instanceof WorkspaceTooLargeError) return 413;
  if (error instanceof ComputerUnavailableError) return 503;
  return 500;
}



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
import type { PageFrameStore } from "./page-frames";

export function createComputerRoutes(
  gateway: ComputerGateway,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  pageFrames?: PageFrameStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);

  routes.get("/:botId/status", async (context) => {
    const botId = context.req.param("botId");
    return context.json(await gateway.status(botId));
  });

  routes.get("/:botId/screenshot", async (context) => {
    try {
      return context.json(await gateway.screenshot(context.req.param("botId")));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.get("/:botId/read", async (context) => {
    try {
      return context.json(await gateway.read(context.req.param("botId")));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /**
   * Whether the same page is on both, ignoring the two ways one page spells itself.
   *
   * The trailing slash a browser adds and the fragment it keeps are not different pages. A URL that
   * cannot be parsed is compared as written.
   */
  function samePage(a: string, b: string): boolean {
    const tidy = (value: string) => {
      try {
        const parsed = new URL(value);
        parsed.hash = "";
        return parsed.toString().replace(/\/$/, "");
      } catch {
        return value.replace(/\/$/, "");
      }
    };
    return tidy(a) === tidy(b);
  }

  /**
   * Whether a screenshot can be trusted to be of the page this turn opened.
   *
   * A SCREENSHOT THAT DOES NOT SAY WHAT IT IS OF IS THE ORDINARY CASE ON AN OLD COMPUTER. The url on
   * a screenshot was added after the first computers shipped, so an `agent-computer` that has not
   * been redeployed sends none. Refusing on a missing url therefore did not fail safe, it failed
   * silently and completely: on a fleet part-way through a rollout the feature kept no frames at all
   * and said nothing about why.
   *
   * So the question is asked where it means something. With a computer each there is no second Bot
   * to race with, nothing can have moved the page between the navigation and the picture, and an
   * unknown page is this turn's page. On one shared computer another Bot's navigation lands in
   * exactly that gap, which is the case this guard exists for, and there an unknown page is refused.
   */
  function frameIsOfThisPage(
    shotUrl: string | undefined,
    pageUrl: string,
  ): { ok: true } | { ok: false; why: string } {
    if (shotUrl === undefined) {
      if (gateway.provider.isolation === "per-bot") return { ok: true };
      return {
        ok: false,
        why: "this computer is shared and the screenshot did not say which page it is of, so it cannot be told apart from another Bot's",
      };
    }
    if (!samePage(shotUrl, pageUrl)) {
      return { ok: false, why: `the screen showed ${shotUrl}` };
    }
    return { ok: true };
  }

  /**
   * Photograph the page this turn just opened.
   *
   * Awaited rather than left running, so a surface asking for the frame the moment the turn ends
   * finds it there. A navigation already costs seconds; one screenshot inside the cluster does not
   * change how the tool feels, and a frame that arrives after the reader has gone is no frame at all.
   *
   * CHECKED AGAINST THE PAGE THE NAVIGATION REPORTED, because the screenshot is a second round trip
   * and nothing holds the browser still between them. With one computer shared by every Bot, another
   * Bot's navigation lands in that gap and this would file its page under this turn. The guard used
   * to live in the browser and was deleted when the capture moved here; it belongs on whichever side
   * does the capturing.
   *
   * Never fatal. A stored picture is a convenience for reading a conversation back, and failing the
   * navigation the Bot was asked to do because the convenience failed would be the wrong trade every
   * time. EVERY REFUSAL SAYS SO, including the two that used to return quietly: a deployment that
   * keeps no frames has to be able to find out why from its own logs rather than by reading this file.
   */
  async function keepFrameOf(
    botId: string,
    toolCallId: string,
    url: string,
    title: string,
  ) {
    if (!pageFrames) return;
    if (!toolCallId) {
      console.warn(
        `[computer] not keeping a frame of ${url}: the caller did not say which turn it was for.`,
      );
      return;
    }
    try {
      /*
       * Only if the computer is already up. `screenshot` goes through `locate`, which resumes a
       * suspended computer, so a convenience picture could wake a machine the culler had just put to
       * sleep and hold a navigation open for the length of a pod schedule while it did.
       */
      const status = await gateway.status(botId);
      if (status.state !== "ready") {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: the computer is ${status.state}, and photographing it would wake it.`,
        );
        return;
      }
      const shot = await gateway.screenshot(botId);
      const verdict = frameIsOfThisPage(shot.url, url);
      if (!verdict.ok) {
        console.warn(
          `[computer] not keeping a frame for ${toolCallId}: ${verdict.why} rather than ${url}.`,
        );
        return;
      }
      await pageFrames.save({
        computerId: botId,
        toolCallId,
        url,
        title,
        frame: shot.base64,
      });
    } catch (error) {
      console.warn(
        `[computer] could not keep a frame of ${url}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  routes.post("/:botId/navigate", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      url?: unknown;
      toolCallId?: unknown;
    } | null;
    if (typeof body?.url !== "string" || !body.url.trim()) {
      return context.json({ error: "A web address is required." }, 400);
    }
    /*
     * Which turn asked, so the picture can be filed under it. Optional: a caller that does not know
     * (the side panel, a script) still navigates, and simply keeps no frame.
     */
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : "";

    try {
      const botId = context.req.param("botId") ?? "default";
      const result = await gateway.navigate(
        botId,
        body.url.trim(),
        toolCallId || undefined,
      );
      await keepFrameOf(botId, toolCallId, result.url, result.title);
      return context.json(result);
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/snapshot", async (context) => {
    try {
      return context.json(await gateway.snapshot(context.req.param("botId")));
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /**
   * The acting routes.
   *
   * Each route passes the request input to the computer gateway.
   */
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
    act(context, (botId, body) => {
      if (!usableDeltaY(body?.deltaY)) return badDeltaY;
      return gateway.scroll(botId, {
        ...(typeof body?.deltaY === "number" ? { deltaY: body.deltaY } : {}),
      });
    }),
  );

  /**
   * Who has the wheel. Polled by the surface next to the screen, so the person sees the Bot ask for
   * help without reloading anything.
   */
  routes.get("/:botId/control", async (context) => {
    try {
      return context.json(
        await gateway.control(
          context.req.param("botId"),
          context.req.query("requestId"),
        ),
      );
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.post("/:botId/control/request", (context) =>
    act(context, (botId, body) =>
      gateway.requestHelp(
        botId,
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "It can't continue without you.",
        typeof body?.toolCallId === "string" ? body.toolCallId : undefined,
      ),
    ),
  );

  /** Every computer in the deployment. */
  routes.get("/fleet", async (context) => {
    try {
      return context.json(await gateway.computers());
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  routes.get("/:botId/computers", async (context) => {
    try {
      return context.json(await gateway.computers());
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /** Stop the browser, keep the logins. */
  routes.post("/:botId/computers/stop", (context) =>
    act(context, (botId) => gateway.stopComputer(botId)),
  );

  /** Delete the profile. Every login goes with it, which is the point and also the danger. */
  routes.post("/:botId/computers/reset", (context) =>
    act(context, (botId) => gateway.resetComputer(botId)),
  );

  /**
   * Move the computer onto the image this deployment now runs. Files and sign-ins stay; a running
   * computer restarts, so this is a person's button and never something a wake does to a busy one.
   */
  routes.post("/:botId/computers/update", (context) =>
    act(context, (botId) => gateway.updateComputer(botId)),
  );

  routes.post("/:botId/control/take", (context) =>
    act(context, (botId, body) =>
      gateway.takeControl(botId, body?.requestId as string | undefined),
    ),
  );

  routes.post("/:botId/control/release", (context) =>
    act(context, (botId, body) =>
      gateway.releaseControl(botId, body?.requestId as string | undefined),
    ),
  );

  routes.post("/:botId/control/cancel", (context) =>
    act(context, (botId, body) =>
      gateway.cancelControl(botId, body?.requestId as string | undefined),
    ),
  );

  /** The Bot asking for a value it must not be told. */
  routes.post("/:botId/control/secret", (context) =>
    act(context, (botId, body) => {
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
      });
    }),
  );

  /**
   * A person supplying it.
   *
   * The value is read from the body, passed straight through, and referred to nowhere else. Its own
   * route rather than a `kind` on the input route below, so that grepping for where a secret can enter
   * this server returns exactly one place.
   */
  routes.post("/:botId/human/secret", (context) =>
    act(context, (botId, body) => {
      if (typeof body?.text !== "string" || !body.text) {
        return { error: "A value is required." };
      }
      return gateway.supplySecret(botId, body.text);
    }),
  );

  /**
   * A person's own mouse and keyboard.
   *
   * Not through the policy decision, and not audited per keystroke. See `ComputerGateway.humanInput`.
   * The takeover is the audited event; what the person typed during it is deliberately unrecorded,
   * because the reason a takeover exists is to let them enter the thing nothing else should keep.
   */
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
    /*
     * Shaped per gesture, like the Bot's acting routes shape theirs. Only scroll was checked:
     * a click with `{"x": "ten"}`, a type with `{"text": 123}` or a key with `{}` travelled
     * to the computer untouched, and the failure surfaced as whatever the computer returned
     * for garbage — mapped here to a 500, or a 200 no-op. The shapes below are the ones the
     * gateway's `HumanInput` type already promises the computer: coordinates in viewport
     * pixels, text to enter, a key name. Scroll keeps its existing check, which allows an
     * absent delta the computer reads as its own default distance.
     */
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
        } as Parameters<typeof gateway.humanInput>[1]),
      );
    } catch (error) {
      return context.json(errorBody(error), statusFor(error));
    }
  });

  /** The Bot's files. Through the gateway, like every other acting call. */
  /**
   * The frame this turn was showing when it opened its page.
   *
   * Read only. Nothing writes through a route: the frame is taken where the navigation happens,
   * which is the one moment the screen is certainly showing the page that was asked for. The surface
   * used to capture it itself, after the turn, and lost the race often enough to show the wrong page
   * or a blank one.
   */
  routes.get("/:botId/page-frame/:toolCallId", async (context) => {
    if (!pageFrames) return context.json({ frame: null });
    // Unvalidated params reach the frame table as-is. Blank or overlong ids can never name a
    // stored frame, so they are refused here instead of becoming junk reads.
    const botId = context.req.param("botId");
    const toolCallId = context.req.param("toolCallId");
    if (!botId.trim() || !toolCallId.trim()) {
      return context.json({ error: "A Bot and a turn are required." }, 400);
    }
    if (botId.length > 200 || toolCallId.length > 200) {
      return context.json({ error: "A Bot and a turn are required." }, 400);
    }
    const stored = await pageFrames.load(botId, toolCallId);
    return context.json({ frame: stored });
  });

  routes.post("/:botId/files/list", (context) =>
    act(context, (botId, body) =>
      gateway.listFiles(botId, {
        ...(typeof body?.path === "string" && body.path.trim()
          ? { path: body.path.trim() }
          : {}),
      }),
    ),
  );

  routes.post("/:botId/files/read", (context) =>
    act(context, (botId, body) => {
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return { error: "A file path is required." };
      }
      return gateway.readFile(botId, { path: body.path.trim() });
    }),
  );

  /**
   * A person downloading a file the Bot generated.
   *
   * This is a GET because a browser download is a navigation, not a JSON action. It still goes
   * through the gateway, so the separate `computer_download_file` intent is decided and audited
   * before the computer is asked for bytes. Ownership is enforced by the `/:botId/*` middleware
   * above, and the response is always an opaque attachment so HTML cannot render on this origin.
   */
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

  /*
   * A command on the Bot's computer.
   *
   * Same shape as every other acting route: the gateway decides and records, this only shapes the
   * request. `timeoutMs` is validated here against the shell's own bounds (1s floor, 600s ceiling),
   * so a NaN, an Infinity, a negative, or a ten-hour value answers 400 instead of travelling to the
   * computer as a RangeError 500 or a run that outlasts the transport backstop.
   */
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
    act(context, (botId, body) => {
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
      });
    }),
  );

  return routes;
}

type ComputerContext = Context<{ Variables: AppVariables }>;

/** A request that was rejected before any decision was needed, because it was not a valid action. */
type BadRequest = { error: string };

const badRef: BadRequest = { error: "A field ref is required." };

const badDeltaY: BadRequest = {
  error: "deltaY must be a finite number of pixels.",
};

/**
 * Whether a wheel delta from an untrusted body can be carried out.
 *
 * `typeof value === "number"` is true of `Infinity`, and JSON carries it: `1e999` parses to it. It
 * then survives every comparison on the way down and is erased by `JSON.stringify` on the hop to the
 * computer, which reads the missing field as absent and scrolls its own default distance instead --
 * so the caller is answered 200 for a scroll nobody asked for. Every other number on this surface is
 * already checked at the edge: the timeout on `exec`, the coordinates behind `human/click`. This one
 * was not.
 */
function usableDeltaY(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}

/**
 * Read an action request and map its result onto an HTTP response.
 */
async function act(
  context: ComputerContext,
  handler: (
    botId: string,
    body: Record<string, unknown> | null,
    /**
     * The person's Stop, as an abort.
     *
     * The surface aborts its request when Stop is pressed; Bun exposes that here, and every acting
     * route passes it on so the abort reaches the Playwright call mid-click. Without it, Stop ended
     * the run in the transcript while the click carried on landing on a live page, harmless most of
     * the time, and not harmless on a Confirm button, which is exactly when Stop gets pressed.
     */
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

/** The error response for a computer call. */
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

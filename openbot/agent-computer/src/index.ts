import { serve } from "bun";
import type { Page } from "playwright";
import { downloadHeaders } from "../../shared/file-download";
import {
  cutAtCodeUnits,
  parseAriaSnapshot,
  type SnapshotElement,
} from "./aria-snapshot";
import { browserRuntimeFromEnv } from "./browser-runtime";
import { detectChallenge } from "./challenge";
import { ControlRequestError, NO_SECRET_PENDING } from "./control";
import { describeHumanGesture } from "./demonstration";
import { identity } from "./identity";
import { assertPageAccess, navigateWebPage, type PagePurpose } from "./navigation";
import { createProfiles, numberFromEnv, VIEWPORT } from "./profiles";
import {
  parseExecTimeout,
  parseInputMessage,
  parseNavigateUrl,
  parseScrollDelta,
} from "./request-validation";
import { type InputMessage, startScreencast } from "./screencast";
import {
  markElementSecret,
  maskSensitiveValues,
  SECRET_ATTRIBUTE,
  SENSITIVE_FIELD_SELECTOR,
  sensitiveRefs,
} from "./secret-masking";
import { createSessions } from "./sessions";
import { createShell } from "./shell";
import {
  fillSignIn,
  fillSignInCode,
  parseSignInCode,
  parseSignInFill,
} from "./sign-in";
import { startVirtualDisplay } from "./virtual-display";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspaceFileNotFoundError,
  WorkspaceFileTooLargeError,
  WorkspacePathError,
} from "./workspace";



const RUNTIME = browserRuntimeFromEnv(process.env);
const BROWSER_MODE = RUNTIME.mode;
const VIRTUAL_DISPLAY = await startVirtualDisplay(
  RUNTIME.useVirtualDisplay ? "headed" : "headless",
);
if (VIRTUAL_DISPLAY) process.env.DISPLAY = VIRTUAL_DISPLAY.name;
console.info(
  JSON.stringify({
    type: "computer-browser-mode",
    mode: BROWSER_MODE,
    display: VIRTUAL_DISPLAY?.name ?? null,
  }),
);

/*
 * A whole port in range, or the default: a fraction never binds and an out-of-range one
 * misbinds at boot, which is a deployment failure instead of the documented fallback.
 */
const PORT = process.env.PORT?.trim() ? Number(process.env.PORT) : 4100;
const NAVIGATION_TIMEOUT_MS = numberFromEnv("NAVIGATION_TIMEOUT_MS", 30000);

/**
 * How long one action waits for its element.
 *
 * Much shorter than a navigation. Playwright waits for a control to become clickable, which is the
 * behaviour we want, but a ref that no longer resolves would otherwise hang for the full navigation
 * timeout before saying so, and the person is sitting watching a screen that is not changing.
 */
const ACTION_TIMEOUT_MS = numberFromEnv("ACTION_TIMEOUT_MS", 10000);

/**
 * How much page text a navigation hands back.
 *
 * Bounded because a page can be megabytes and the text goes into a model's context, where a single
 * unbounded page can push the rest of the conversation out. Generous enough that the visible part of
 * an ordinary page arrives whole, which is what the answer is usually made of.
 */
const TEXT_EXTRACT_LIMIT = 6000;

const sessions = createSessions();

/**
 * Sent by the server as a header on every call. Absent means the caller does not know or does not
 * care, such as a health check, and that gets the default computer rather than an error, because
 * refusing it would make the container undemonstrable on its own.
 */
function botIdOf(request: Request, fallback?: string | null): string {
  return (
    request.headers.get("x-openbot-bot-id")?.trim() ||
    fallback?.trim() ||
    DEFAULT_BOT_ID
  );
}

/**
 * The Bot's durable files.
 *
 * Rooted at WORKSPACE_DIR, which the image creates and docker-compose mounts as a volume, so what a
 * Bot saves outlives the container. Built once at boot: the root is fixed, and resolving it per request
 * would only add a syscall to every call. Everything about why confinement is harder than it looks
 * lives in workspace.ts.
 */
const workspace = createWorkspace(
  process.env.WORKSPACE_DIR?.trim() || "/workspace",
);



/**
 * The Bot's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. Persistent profiles live on a
 * mounted volume so sign-in state survives the container.
 */

const profiles = createProfiles(
  process.env.PROFILES_DIR?.trim() || "/profiles",
  async (botId) => {
    await sessions.get(botId)?.viewer.releaseAll(COMPUTER_STOPPED);
  },
);
// Rooted in the same workspace the file tools use, so a command and a written file see one
// directory rather than two.
const shell = createShell(process.env.WORKSPACE_DIR?.trim() || "/workspace");

/**
 * The id normally arrives as a header on every request. This is the fallback for a caller that has no
 * Bot to name, such as a health check, so the container stays demonstrable on its own rather than
 * refusing everything that is not the server.
 */
const DEFAULT_BOT_ID = process.env.COMPUTER_BOT_ID ?? "shared";

async function currentPage(botId: string, purpose: PagePurpose = "read"): Promise<Page> {
  const page = await profiles.page(botId);
  assertPageAccess(RUNTIME.backend, page.url(), purpose);
  return page;
}

/**
 * The page as text, the way a reader sees it.
 *
 * Script and style bodies are dropped rather than included: they are the bulk of a modern page and
 * none of it is what anybody asked about, so leaving them in spends the extract on noise and pushes
 * the actual article past the limit.
 */
async function readablePageText(
  target: Page,
): Promise<{ text: string; truncated: boolean }> {
  const raw = await target.evaluate(() => {
    const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
    if (!clone) return "";
    for (const node of clone.querySelectorAll("script, style, noscript, svg")) {
      node.remove();
    }
    return clone.innerText ?? "";
  });

  const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim();
  return {
    /*
     * Cut between characters, not through one. #539 fixed this for a control's name and value in the
     * snapshot and left the page text, which is the same bug at thirty times the length: `slice`
     * counts UTF-16 code units, an emoji is two, and a limit landing between the halves hands the Bot
     * a lone high surrogate that reads as U+FFFD — a character that is not on the page.
     *
     * More likely to bite here than there, for the reason the limit is bigger. A 200-unit control
     * name rarely reaches an emoji; 6000 units of somebody's page usually passes through several, and
     * whether the cut lands mid-character is decided by whatever was above it.
     */
    text: cutAtCodeUnits(collapsed, TEXT_EXTRACT_LIMIT),
    // Unaffected by the line above: dropping one more unit cannot make an over-limit string fit.
    truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
  };
}

/**
 * Describe everything on the page a Bot can act on.
 *
 * Uses Playwright's AI snapshot rather than stamping attributes into the DOM. `ariaSnapshot` keeps
 * refs outside the page, survives framework re-renders, resolves accessible names, reports current
 * values and checked state, filters to actionable elements and descends into iframes.
 */
async function snapshotPage(
  target: Page,
): Promise<{
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
}> {
  const yaml = await target.ariaSnapshot({ mode: "ai" });
  const title = await target.title();
  const parsed = parseAriaSnapshot(yaml);
  return {
    url: target.url(),
    title,
    truncated: parsed.truncated,
    // A password field's value is in the aria snapshot in plain text. See secret-masking.ts.
    elements: maskSensitiveValues(
      parsed.elements,
      await sensitiveRefs(target, parsed.elements),
    ),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What a person watching is told when the browser they were watching went away. */
const COMPUTER_STOPPED =
  "This computer stopped, so the screen ended. Start it again to carry on watching.";

/** How often the cast checks that it is still showing the page the Bot is on. */
const FOLLOW_INTERVAL_MS = 1_000;

/** What a live-screen socket carries: the Bot whose screen it is showing. */
type StreamData = { botId: string; recordingId?: string };

serve<StreamData>({
  port: PORT,
  ...(RUNTIME.hostname ? { hostname: RUNTIME.hostname } : {}),
  idleTimeout: 120,
  /**
   * The live screen, pushed by Chrome rather than polled.
   *
   * Upgraded here rather than served as HTTP because the whole point is that frames arrive when the
   * page changes and input goes back over the same connection. See screencast.ts for why polling was
   * not good enough once a person had to type into this.
   */
  websocket: {
    async open(ws) {
      const session = sessions.for(ws.data.botId);
      
      const claim = session.viewer.claim(ws, (reason) => {
        try {
          ws.send(JSON.stringify({ type: "error", error: reason }));
          ws.close();
        } catch {
          // Best effort. The socket may already be gone, which is not a reason to stop tearing down.
        }
      });
      try {
        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            void session.viewer.release(ws);
          }
        };

        /*
         * The cast follows the Bot's current page. Re-checking also handles a page being closed
         * underneath us without a listener per page.
         */
        let casting: Page | undefined;
        const attach = async () => {
          const target = await currentPage(ws.data.botId);
          if (target === casting) return;
          const cast = await startScreencast(target, send);
          if (ws.readyState !== 1) { await cast.stop(); return; }
          await claim.install(cast);
          casting = target;
        };

        await attach();
        if (ws.readyState !== 1) return;
        const follow = setInterval(() => {
          void attach().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        claim.setFollow(() => clearInterval(follow));
      } catch (error) {
        
        await session.viewer.release(ws);
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "The screen could not be started."),
          }),
        );
        ws.close();
      }
    },

    async message(ws, raw) {
      const session = sessions.for(ws.data.botId);
      let message: InputMessage;
      try {
        const parsed: unknown = JSON.parse(String(raw));
        const validated = parseInputMessage(parsed);
        if (!validated.ok) {
          ws.send(JSON.stringify({ type: "error", error: validated.error }));
          return;
        }
        message = validated.message;
      } catch {
        // The validated-but-wrong branch above sends an error frame; unparseable input used to
        // be dropped silently, so a buggy surface saw input "ignored" with no diagnostic.
        ws.send(JSON.stringify({ type: "error", error: "Input is not JSON." }));
        return;
      }
      try {
        const recorded = ws.data.recordingId
          ? await describeHumanGesture(
              await currentPage(ws.data.botId),
              message,
            )
          : null;
        await session.viewer.castFor(ws).send(message);
        if (recorded)
          ws.send(
            JSON.stringify({
              type: "demonstration.action",
              recordingId: ws.data.recordingId,
              action: recorded,
            }),
          );
      } catch (error) {
        // Reported rather than swallowed. A dispatch that fails means the person's input did nothing,
        // and they must not be left believing it landed.
        console.error(
          JSON.stringify({
            type: "screencast-input-error",
            message: message.type,
            error: String(error),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "That input could not be applied."),
          }),
        );
      }
    },

    async close(ws) {
      // `get`, not `for`: a socket closing for a Bot with no session has nothing to release,
      // and creating one here would add a map entry on a teardown path, which is the direction the
      // map is meant to shrink in.
      await sessions.get(ws.data.botId)?.viewer.release(ws);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    const botId = botIdOf(request);

    const session = sessions.for(botId);

    try {
      if (url.pathname === "/stream") {
        /*
         * The socket carries the Bot in the query because it cannot do it in a header. Every other call here names
         * its Bot in `x-openbot-bot-id`, but a websocket client sends no custom headers on the upgrade,
         * so the stream, and only the stream, also accepts the Bot as a query parameter. The header
         * still wins where there is one.
         */
        const streamBotId = botIdOf(request, url.searchParams.get("bot"));
        const recordingId = url.searchParams.get("recording")?.trim();
        if (
          server.upgrade(request, {
            data: {
              botId: streamBotId,
              ...(recordingId ? { recordingId } : {}),
            },
          })
        )
          return undefined as unknown as Response;
        return json({ error: "Expected a WebSocket upgrade." }, 400);
      }

      

      // Who has the wheel. Polled by the surface alongside the screen, so the person sees the Bot ask
      // for help without having to reload anything.
      if (url.pathname === "/control" && request.method === "GET") {
        return json(
          session.control.get(),
        );
      }

      // The Bot asking for help. It does not take control: it says it is stuck and why, and a person
      // decides. A Bot that could hand itself to a human could also hand a human a page they never
      // asked to see.
      if (url.pathname === "/control/request" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          reason?: unknown;
          toolCallId?: unknown;
        } | null;
        if (
          body?.toolCallId !== undefined &&
          typeof body.toolCallId !== "string"
        )
          return json({ error: "toolCallId must be a string." }, 400);
        // The page the Bot is stuck on, recorded with the request. A browser that will not start is
        // no reason to refuse the request: the person is the one who can see why.
        const stuckOn = await currentPage(botId).catch(() => undefined);
        const state = session.control.requestHelp(
          body?.reason,
          body?.toolCallId,
          "model",
          stuckOn?.url(),
        );
        return json(state);
      }

      // The Bot asking for one value it must not be told. It has already focused the field.
      if (url.pathname === "/control/secret" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          label?: unknown;
          ref?: unknown;
        } | null;
        try {
          return json(session.control.requestSecret(body ?? {}));
        } catch (error) {
          if (error instanceof ControlRequestError) {
            return json({ error: error.message }, 400);
          }
          throw error;
        }
      }

      
      if (url.pathname === "/human/secret" && request.method === "POST") {
        const pending = session.control.pendingSecret();
        if (!pending) {
          return json({ error: NO_SECRET_PENDING }, 409);
        }
        const body = (await request.json().catch(() => null)) as {
          text?: unknown;
        } | null;
        if (typeof body?.text !== "string" || !body.text) {
          return json({ error: "A value is required." }, 400);
        }
        try {
          const target = await currentPage(botId);
          const field = target.locator(`aria-ref=${pending.ref}`);
          await field.click({ timeout: ACTION_TIMEOUT_MS });
          await field.fill(body.text, { timeout: ACTION_TIMEOUT_MS });
          // Marked so the snapshot, screenshots and the live screen never show it back.
          await field
            .evaluate(markElementSecret, SECRET_ATTRIBUTE)
            .catch(() => undefined);
          const characters = body.text.length;
          // Cleared only after it actually landed, so a failure leaves the request open and the person
          // can try again rather than being told to start over.
          session.control.secretSupplied();
          return json({ supplied: true, characters, url: target.url() });
        } catch (error) {
          // The field is gone, which is unretryable, so the request is closed rather than left open.
          // Keeping it open is right for a mistyped value and wrong here: the person would retype their
          // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
          // on its next turn that nothing is pending and ask again against a fresh snapshot.
          session.control.secretSupplied();
          return json(
            {
              error: describe(
                error,
                "That value could not be entered: the field is no longer on the page. Ask the assistant to request it again.",
              ),
            },
            502,
          );
        }
      }

      
      if (url.pathname === "/sign-in/fill" && request.method === "POST") {
        const input = parseSignInFill(await request.json().catch(() => null));
        if (typeof input === "string") return json({ error: input }, 400);
        const target = await currentPage(botId);
        const result = await fillSignIn(target, input);
        return json(result);
      }

      /**
       * The verification code a site asked for after the password, from the same private form.
       *
       * Handled exactly as the login above: read once, typed by `fillSignInCode` into the page that is
       * waiting for it, and dropped.
       */
      if (url.pathname === "/sign-in/code" && request.method === "POST") {
        const input = parseSignInCode(await request.json().catch(() => null));
        if (typeof input === "string") return json({ error: input }, 400);
        const target = await currentPage(botId);
        const result = await fillSignInCode(target, input);
        return json(result);
      }

      if (
        ["/control/take", "/control/release", "/control/cancel"].includes(
          url.pathname,
        ) &&
        request.method === "POST"
      ) {
        if (url.pathname === "/control/take") return json(session.control.take());
        if (url.pathname === "/control/cancel") return json(session.control.cancel());
        return json(session.control.release());
      }

      // A person's input, by pixel. The Bot addresses elements by reference because it reads a list; a
      // person addresses them by pointing, because they are looking at a picture. Different problem,
      // different endpoint.
      if (HUMAN_INPUT.has(url.pathname) && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (url.pathname === "/human/scroll") {
          const parsed = parseScrollDelta(body?.deltaY);
          if (!parsed.ok) {
            return json({ error: parsed.error }, 400);
          }
        }
        try {
          const target = await currentPage(botId);
          return json(
            await performHumanInput(target, url.pathname, body ?? {}),
          );
        } catch (error) {
          return json({ error: describe(error, "That did not work.") }, 502);
        }
      }

      if (url.pathname === "/health") {
        const [profile] = profiles.summary([botId]);
        return json({
          status: "ok",
          // `browser` kept as it was: it is in the published contract and start.sh reads it.
          browser: profile?.running ?? false,
          profile,
          identity: await identity(),
          browserMode: BROWSER_MODE,
          browserBackend: RUNTIME.backend,
          browserChannel: RUNTIME.channel,
        });
      }

      /**
       * The computers this process holds. The shape is a list because the admin surface is a
       * list, and because a Bot that has a profile has a computer whether or not a browser is running
       * for it this second.
       */
      if (url.pathname === "/computers" && request.method === "GET") {
        return json({ computers: profiles.summary(await profiles.known()) });
      }

      /**
       * Stop the browser, keep what it knows.
       *
       * Closed gracefully so Chromium flushes its profile, and deliberately
       * not restarted here: the next request starts it again, which is the same path as a first ever
       * start, so there is no second way for a browser to come into existence.
       */
      if (url.pathname === "/computers/stop" && request.method === "POST") {
        const wasRunning = await profiles.stop(botId);
        session.control.interrupt(
          "The computer stopped; the previous task was interrupted.",
        );
        return json({ stopped: true, wasRunning });
      }

      /**
       * Forget everything and start over.
       *
       * Signs the computer out of everything by deleting the profile. Irreversible, which is why it is
       * its own endpoint rather than a flag on the one above: a person clicking "stop" must not be able
       * to discard a login by mistyping a parameter.
       */
      if (url.pathname === "/computers/reset" && request.method === "POST") {
        await profiles.reset(botId);
        session.control.interrupt(
          "The computer was reset; the previous task was interrupted.",
        );
        return json({ reset: true, botId });
      }

      if (url.pathname === "/navigate" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          url?: unknown;
          toolCallId?: unknown;
        } | null;
        const parsed = parseNavigateUrl(body?.url);
        if (!parsed.ok) {
          return json({ error: parsed.error }, 400);
        }

        const startedAt = Date.now();
        try {
          const target = await currentPage(botId, "navigate");
          const response = await navigateWebPage(
            target,
            parsed.url,
            RUNTIME.backend,
            NAVIGATION_TIMEOUT_MS,
          );
          const extract = await readablePageText(target);
          return json({
            url: target.url(),
            title: await target.title(),
            text: extract.text,
            truncated: extract.truncated,
            elapsedMs: Date.now() - startedAt,
            challenge: await detectChallenge(target, session.control, {
              cfMitigated: response
                ? await response.headerValue("cf-mitigated")
                : undefined,
              toolCallId:
                typeof body?.toolCallId === "string"
                  ? body.toolCallId
                  : undefined,
            }),
          });
        } catch (error) {
          // The page is the Bot's working surface, so a failed navigation is reported rather than
          // thrown: the transcript needs to say what happened, and the browser stays usable.
          return json(
            {
              error:
                error instanceof Error ? error.message : "Navigation failed.",
            },
            502,
          );
        }
      }

      if (url.pathname === "/screenshot" && request.method === "GET") {
        try {
          const target = await currentPage(botId);
          // Sensitive fields are masked in the picture the Bot is handed. See secret-masking.ts.
          const buffer = await target.screenshot({
            type: "png",
            mask: [target.locator(SENSITIVE_FIELD_SELECTOR)],
          });
          const size = target.viewportSize() ?? { width: 1280, height: 800 };
          return json({
            base64: buffer.toString("base64"),
            width: size.width,
            height: size.height,
            capturedAt: new Date().toISOString(),
            // Which page this is a picture of. A browser that has not been sent anywhere sits on
            // `about:blank`, and a screenshot of that is a valid, entirely white PNG, indistinguishable
            // from a real page to anything looking only at the bytes. The transcript needs to tell
            // those apart to avoid presenting a blank browser as though it were a loaded page.
            url: target.url(),
          });
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error ? error.message : "Screenshot failed.",
            },
            502,
          );
        }
      }

      // The Bot's files in the durable workspace.
      if (url.pathname === "/files/download" && request.method === "GET") {
        try {
          const file = await workspace.download(
            url.searchParams.get("path") ?? "",
          );
          return new Response(file.body, {
            headers: downloadHeaders(file.name, file.bytes),
          });
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be downloaded.") },
            fileStatus(error),
          );
        }
      }

      if (url.pathname === "/files/read" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        try {
          return json(await workspace.read(String(body?.path ?? "")));
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be read.") },
            fileStatus(error),
          );
        }
      }

      if (url.pathname === "/files/list" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        try {
          return json(
            await workspace.list(
              typeof body?.path === "string" ? body.path : undefined,
            ),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The folder could not be listed.") },
            fileStatus(error),
          );
        }
      }

      
      if (url.pathname === "/exec" && request.method === "POST") {
        if (!RUNTIME.allowExec)
          return json(
            {
              error:
                "Shell execution is disabled for local Chrome. Use the approved host-access tools to run commands on this computer.",
            },
            403,
          );
        const body = (await request.json().catch(() => null)) as {
          command?: unknown;
          timeoutMs?: unknown;
        } | null;
        if (typeof body?.command !== "string" || !body.command.trim()) {
          return json({ error: "A command is required." }, 400);
        }
        const timeout = parseExecTimeout(body.timeoutMs);
        if (!timeout.ok) {
          return json({ error: timeout.error }, 400);
        }
        try {
          return json(
            await shell.run({
              command: body.command,
              ...(timeout.timeoutMs !== undefined
                ? { timeoutMs: timeout.timeoutMs }
                : {}),
              signal: request.signal,
            }),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The command could not be run.") },
            500,
          );
        }
      }

      if (url.pathname === "/files/write" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
          contents?: unknown;
          append?: unknown;
        } | null;
        if (typeof body?.contents !== "string") {
          return json({ error: "The contents to write are required." }, 400);
        }
        try {
          return json(
            await workspace.write(String(body?.path ?? ""), body.contents, {
              append: body.append === true,
            }),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be written.") },
            fileStatus(error),
          );
        }
      }

      // The current page as text, without navigating anywhere.
      //
      // Reading must be available after actions too. Returning page text only from `/navigate` would be enough if
      // opening a page were the only way to change what is on screen. It is not: the Bot presses
      // "Submit order", the page becomes a confirmation, and it has no way to find out what the
      // confirmation said. "I clicked the button" is not an answer to what happened.
      if (url.pathname === "/read" && request.method === "GET") {
        try {
          const target = await currentPage(botId);
          const extract = await readablePageText(target);
          return json({
            url: target.url(),
            title: await target.title(),
            text: extract.text,
            truncated: extract.truncated,
            challenge: await detectChallenge(target, session.control),
          });
        } catch (error) {
          return json(
            { error: describe(error, "Reading the page failed.") },
            502,
          );
        }
      }

      // The list of things on the page a Bot can act on. POST rather than GET because it mutates the
      // page, stamping every element it describes, and a GET that changes the document is a lie that
      // caches and prefetchers eventually punish.
      if (url.pathname === "/snapshot" && request.method === "POST") {
        try {
          const target = await currentPage(botId);
          const snapshot = await snapshotPage(target);
          return json({
            ...snapshot,
            challenge: await detectChallenge(target, session.control),
          });
        } catch (error) {
          return json({ error: describe(error, "Snapshot failed.") }, 502);
        }
      }

      if (ACTIONS.has(url.pathname) && request.method === "POST") {
        const body = (await request
          .json()
          .catch(() => null)) as ActionBody | null;
        if (!body) {
          return json({ error: "An action needs a JSON body." }, 400);
        }
        if (url.pathname === "/scroll") {
          const parsed = parseScrollDelta(body.deltaY);
          if (!parsed.ok) {
            return json({ error: parsed.error }, 400);
          }
        }

        const startedAt = Date.now();
        try {
          const target = await currentPage(botId);
          const detail = await performAction(
            target,
            url.pathname,
            body,
            // The caller going away is the stop signal: the surface aborts its request, the server
            // aborts the one it made to this computer, and Bun aborts this one in turn.
            request.signal,
          );
          return json({ ...detail, elapsedMs: Date.now() - startedAt });
        } catch (error) {
          /*
           * Stopped, not failed. The signal is checked rather than the error text: Playwright words an
           * abort differently per call, and the caller's own request going away is the fact that
           * matters either way.
           *
           * Logged because the response is not observed after the caller aborts. The log distinguishes
           * "stopped in time" from "ran to completion after cancellation".
           */
          if (request.signal.aborted) {
            console.info(
              JSON.stringify({
                type: "action-stopped",
                action: url.pathname,
                ref: typeof body.ref === "string" ? body.ref : undefined,
                elapsedMs: Date.now() - startedAt,
              }),
            );
            // 499, the convention for a client that closed the request: this is not the computer
            // failing, and a 502 here would be counted as one.
            return json({ error: "Stopped.", stopped: true }, 499);
          }
          return json({ error: describe(error, "The action failed.") }, 502);
        }
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof ControlRequestError)
        return json(
          { error: error.message, controlRequestError: true },
          error.status,
        );
      throw error;
    }
  },
});

type ActionBody = {
  ref?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
  submit?: unknown;
};

const ACTIONS = new Set(["/click", "/type", "/key", "/scroll"]);

const HUMAN_INPUT = new Set([
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
]);

/**
 * Carry out one thing a person did with their mouse or keyboard.
 *
 * Coordinates are viewport pixels, which the surface works out from the screenshot it is displaying:
 * it knows the image's natural size and the size it drew it at, so it can scale a click back. Doing
 * that conversion in the browser rather than here keeps this endpoint bound to page coordinates
 * rather than window coordinates.
 *
 * Nothing a person types here reaches the model. It goes from their keyboard to this browser and
 * stops. That is what makes a password or a one-time code safe to enter during a takeover: not a
 * filter that strips it out afterwards, but a path the model is not on. The same reason the value is
 * never returned and never logged below.
 */
async function performHumanInput(
  target: Page,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A click needs an x and a y inside the page.");
    }
    // Clamped rather than rejected. A click a pixel outside the viewport is a rounding artefact of
    // scaling the screenshot, not a mistake worth refusing.
    return {
      x: Math.min(Math.max(x, 0), VIEWPORT.width - 1),
      y: Math.min(Math.max(y, 0), VIEWPORT.height - 1),
    };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    await target.mouse.click(x, y);
    return { action: "human_click", url: target.url() };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") {
      throw new Error("Typing needs text.");
    }
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    await target.keyboard.insertText(body.text);
    // Length only, never the value. See the note above about the model not being on this path.
    return {
      action: "human_type",
      characters: body.text.length,
      url: target.url(),
    };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name.");
    }
    await target.keyboard.press(body.key);
    return { action: "human_key", key: body.key, url: target.url() };
  }

  const parsed = parseScrollDelta(body.deltaY);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const deltaY = parsed.deltaY ?? 400;
  await target.mouse.wheel(0, deltaY);
  return { action: "human_scroll", deltaY, url: target.url() };
}


async function performAction(
  target: Page,
  action: string,
  body: ActionBody,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Passed to every Playwright call below. It does not disable the timeout, which still applies.
  const acting = { timeout: ACTION_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;

  if (action === "/click") {
    if (!ref) throw new Error("A click needs the ref of an element to click.");
    await target.locator(`aria-ref=${ref}`).click(acting);
    return { action: "click", ref, url: target.url() };
  }

  if (action === "/type") {
    if (!ref) throw new Error("Typing needs the ref of a field to type into.");
    if (typeof body.text !== "string") {
      throw new Error("Typing needs the text to enter.");
    }
    const field = target.locator(`aria-ref=${ref}`);
    // `fill` rather than keystrokes: it clears the field first, which is what "put this value in
    // this box" means. Typing into a field a previous attempt half-filled otherwise appends, and the
    // form ends up with "AlicAlice" in it.
    await field.fill(body.text, acting);
    if (body.submit === true) {
      await field.press("Enter", acting);
    }
    // The text itself is deliberately NOT returned. It is echoed nowhere: this response is read by
    // the model and logged by the server, and a value typed into a form is exactly where a password
    // or a card number lives. The caller already knows what it sent.
    return {
      action: "type",
      ref,
      characters: body.text.length,
      submitted: body.submit === true,
      url: target.url(),
    };
  }

  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name, such as Enter or Tab.");
    }
    if (ref) {
      await target.locator(`aria-ref=${ref}`).press(
        body.key,
        acting,
      );
    } else {
      await target.keyboard.press(body.key);
    }
    return { action: "key", key: body.key, ref, url: target.url() };
  }

  // Scroll. A plain wheel event on the page, which is what moves a long form, rather than scrolling a
  // specific element into view: the Bot asked to see further down, not to hunt for one control.
  const parsed = parseScrollDelta(body.deltaY);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const deltaY = parsed.deltaY ?? 600;
  await target.mouse.wheel(0, deltaY);
  return { action: "scroll", deltaY, url: target.url() };
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing download is 404, an oversized
 * download is 413, and an ordinary bad file request is 400, because a different request could
 * succeed. Collapsing these into 500 would tell the caller the computer is broken and invite a retry
 * of the same request.
 */
function fileStatus(error: unknown): 400 | 403 | 404 | 413 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileTooLargeError) return 413;
  if (error instanceof WorkspaceFileNotFoundError) return 404;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}

console.info(`agent-computer listening on port ${PORT}`);

/**
 * Hand the profile back before dying.
 *
 * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait, so this is the window in
 * which Chromium can flush its profile to the volume. This is the graceful-shutdown path for normal
 * container restarts.
 *
 * `stop_grace_period` in docker-compose.yml is what gives this time to run.
 */
let shuttingDown = false;

async function shutDown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  // Set before the first await: a display exiting while Chromium flushes is part of this shutdown,
  // not a second failure racing it.
  shuttingDown = true;
  console.info(`${reason}: closing the browser so its profile is flushed`);
  await profiles.closeAll();
  await VIRTUAL_DISPLAY?.stop();
  process.exit(exitCode);
}

if (VIRTUAL_DISPLAY) {
  void VIRTUAL_DISPLAY.terminated.then(({ code, expected }) => {
    if (expected || shuttingDown) return;
    console.error(
      JSON.stringify({
        type: "computer-virtual-display-exited",
        exitCode: code,
      }),
    );
    // A headed Chromium cannot recover without its display. Let the container restart policy build
    // the pair together again instead of advertising a healthy service whose next browser fails.
    void shutDown("virtual display exited", 1);
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutDown(signal, 0);
  });
}

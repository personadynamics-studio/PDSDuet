import { serve } from "bun";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { downloadHeaders } from "../../shared/file-download";
import { cutAtCodeUnits, parseAriaSnapshot } from "./aria-snapshot";
import { browserRuntimeFromEnv } from "./browser-runtime";
import { profileDirectoryFor } from "./bot-id";
import { ControlRequestError, HumanControlError, NO_SECRET_PENDING } from "./control";
import { assertPageAccess, navigateWebPage, type PagePurpose } from "./navigation";
import { createProfiles, numberFromEnv, VIEWPORT } from "./profiles";
import { parseExecTimeout, parseInputMessage, parseNavigateUrl, parseScrollDelta } from "./request-validation";
import { startScreencast } from "./screencast";
import { markElementSecret, maskSensitiveValues, SECRET_ATTRIBUTE, SENSITIVE_FIELD_SELECTOR, sensitiveRefs } from "./secret-masking";
import { createSessions } from "./sessions";
import { createShell } from "./shell";
import { fillSignIn, fillSignInCode, parseSignInCode, parseSignInFill } from "./sign-in";
import { startVirtualDisplay } from "./virtual-display";
import { createWorkspace, WorkspaceFileError, WorkspaceFileNotFoundError, WorkspaceFileTooLargeError, WorkspacePathError } from "./workspace";

const runtime = browserRuntimeFromEnv(process.env);
const display = await startVirtualDisplay(runtime.useVirtualDisplay ? "headed" : "headless");
if (display) process.env.DISPLAY = display.name;
const port = numberFromEnv("PORT", 4100, { min: 1, max: 65535 });
const navigationTimeout = numberFromEnv("NAVIGATION_TIMEOUT_MS", 30_000);
const actionTimeout = numberFromEnv("ACTION_TIMEOUT_MS", 10_000);
const sessions = createSessions();
const profiles = createProfiles(process.env.PROFILES_DIR?.trim() || "/profiles", async (botId) => {
  const session = sessions.get(botId);
  session?.control.interrupt("The browser stopped.");
  await session?.viewer.releaseAll("The browser stopped. Reopen the screen to continue.");
});
const workspaceRoot = process.env.WORKSPACE_DIR?.trim() || "/workspace";
const actions = new Set(["/click", "/type", "/key", "/scroll"]);
const humanInputs = new Set(["/human/click", "/human/type", "/human/key", "/human/scroll"]);

async function workspaceDirectory(botId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // A dedicated container keeps its existing volume layout. Shared containers separate Bot files.
  const directory = process.env.COMPUTER_BOT_ID === botId ? workspaceRoot : profileDirectoryFor(workspaceRoot, botId);
  await mkdir(directory, { recursive: true });
  signal.throwIfAborted();
  return directory;
}
async function workspaceFor(botId: string, signal: AbortSignal) {
  return createWorkspace(await workspaceDirectory(botId, signal));
}

function botIdOf(request: Request, fallback?: string | null): string | undefined {
  return request.headers.get("x-openbot-bot-id")?.trim() || fallback?.trim() || process.env.COMPUTER_BOT_ID?.trim();
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
async function currentPage(botId: string, signal?: AbortSignal, purpose: PagePurpose = "read"): Promise<Page> {
  const page = await profiles.page(botId, signal);
  signal?.throwIfAborted();
  assertPageAccess(runtime.backend, page.url(), purpose);
  return page;
}
async function readPage(page: Page, signal: AbortSignal) {
  const raw = (await page.locator("body").innerText({ signal })).replace(/\n{3,}/g, "\n\n").trim();
  signal.throwIfAborted();
  const title = await page.title();
  signal.throwIfAborted();
  return { url: page.url(), title, text: cutAtCodeUnits(raw, 6000), truncated: raw.length > 6000 };
}
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A JSON object is required.");
  return body as Record<string, unknown>;
}

serve<{ botId: string }>({
  port,
  ...(runtime.hostname ? { hostname: runtime.hostname } : {}),
  idleTimeout: 120,
  websocket: {
    async open(ws) {
      const session = sessions.for(ws.data.botId);
      const slot = session.viewer.claim(ws, (error) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error }));
        ws.close();
      });
      try {
        let showing: Page | undefined;
        const attach = async () => {
          const page = await currentPage(ws.data.botId);
          if (page === showing || ws.readyState !== 1) return;
          const cast = await startScreencast(page, (frame) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(frame));
          });
          if (ws.readyState !== 1) { await cast.stop(); return; }
          await slot.install(cast);
          showing = page;
        };
        await attach();
        if (ws.readyState !== 1) return;
        const timer = setInterval(() => {
          void attach().catch((error) => {
            console.error("Browser screen failed", error);
            ws.close();
          });
        }, 1000);
        slot.setFollow(() => clearInterval(timer));
      } catch (error) {
        await session.viewer.release(ws);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error: describe(error) }));
        ws.close();
      }
    },
    async message(ws, raw) {
      try {
        const parsed = parseInputMessage(JSON.parse(String(raw)));
        if (!parsed.ok) throw new Error(parsed.error);
        const session = sessions.for(ws.data.botId);
        await session.control.runHuman(() => session.viewer.castFor(ws).send(parsed.message));
      } catch (error) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", error: describe(error) }));
      }
    },
    async close(ws) { await sessions.get(ws.data.botId)?.viewer.release(ws); },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    const botId = botIdOf(request, url.pathname === "/stream" ? url.searchParams.get("bot") : undefined);
    const signal = request.signal;
    try {
      if (url.pathname === "/health") {
        return json({ status: "ok", browser: botId ? profiles.isLive(botId) : false, browserMode: runtime.mode, browserBackend: runtime.backend, browserChannel: runtime.channel });
      }
      if (url.pathname === "/computers" && request.method === "GET") return json({ computers: profiles.summary(await profiles.known()) });
      if (!botId) return json({ error: "Select a Bot's computer." }, 400);
      const session = sessions.for(botId);
      if (url.pathname === "/stream") {
        if (server.upgrade(request, { data: { botId } })) return undefined as unknown as Response;
        return json({ error: "Expected a WebSocket upgrade." }, 400);
      }
      if (url.pathname === "/computers/stop" && request.method === "POST") return json({ stopped: true, wasRunning: await profiles.stop(botId) });
      if (url.pathname === "/computers/reset" && request.method === "POST") {
        await profiles.reset(botId);
        return json({ reset: true, botId });
      }
      if (url.pathname === "/control" && request.method === "GET") return json(session.control.get());
      if (url.pathname === "/control/request" && request.method === "POST") {
        const body = await bodyOf(request);
        signal.throwIfAborted();
        return json(session.control.requestHelp(body.reason, typeof body.toolCallId === "string" ? body.toolCallId : undefined));
      }
      if (url.pathname === "/control/secret" && request.method === "POST") {
        const body = await bodyOf(request);
        signal.throwIfAborted();
        session.control.requestSecret(body);
        return json(session.control.requestHelp(`Enter ${typeof body.label === "string" ? body.label : "the requested value"} directly into the page.`, typeof body.toolCallId === "string" ? body.toolCallId : undefined));
      }
      if (url.pathname === "/control/take" && request.method === "POST") return json(await session.control.take());
      if (url.pathname === "/control/release" && request.method === "POST") return json(session.control.release());
      if (url.pathname === "/control/cancel" && request.method === "POST") return json(session.control.cancel());
      if (url.pathname === "/human/secret" && request.method === "POST") {
        const pending = session.control.pendingSecret();
        if (!pending) return json({ error: NO_SECRET_PENDING }, 409);
        const body = await bodyOf(request);
        if (typeof body.text !== "string" || !body.text) return json({ error: "A value is required." }, 400);
        const text = body.text;
        return await session.control.runHuman(async () => {
          const page = await currentPage(botId, signal);
          const field = page.locator(`aria-ref=${pending.ref}`);
          await field.fill(text, { timeout: actionTimeout, signal });
          await field.evaluate(markElementSecret, SECRET_ATTRIBUTE, { signal });
          session.control.secretSupplied();
          return json({ supplied: true, characters: text.length, url: page.url() });
        });
      }
      if (url.pathname === "/sign-in/fill" && request.method === "POST") {
        const input = parseSignInFill(await bodyOf(request));
        if (typeof input === "string") return json({ error: input }, 400);
        return await session.control.runBot(signal, async (signal) => json(await fillSignIn(await currentPage(botId, signal), input, signal)));
      }
      if (url.pathname === "/sign-in/code" && request.method === "POST") {
        const input = parseSignInCode(await bodyOf(request));
        if (typeof input === "string") return json({ error: input }, 400);
        return await session.control.runBot(signal, async (signal) => json(await fillSignInCode(await currentPage(botId, signal), input, signal)));
      }
      if (humanInputs.has(url.pathname) && request.method === "POST") {
        const body = await bodyOf(request);
        return await session.control.runHuman(async () => json(await humanInput(await currentPage(botId, signal), url.pathname, body, signal)));
      }
      if (url.pathname === "/navigate" && request.method === "POST") {
        const body = await bodyOf(request);
        const parsed = parseNavigateUrl(body.url);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const startedAt = Date.now();
        return await session.control.runBot(signal, async (signal) => {
          const page = await currentPage(botId, signal, "navigate");
          await navigateWebPage(page, parsed.url, runtime.backend, navigationTimeout, signal);
          return json({ ...await readPage(page, signal), elapsedMs: Date.now() - startedAt });
        });
      }
      if (url.pathname === "/read" && request.method === "GET") return json(await readPage(await currentPage(botId, signal), signal));
      if (url.pathname === "/screenshot" && request.method === "GET") {
        const page = await currentPage(botId, signal);
        const image = await page.screenshot({ type: "png", mask: [page.locator(SENSITIVE_FIELD_SELECTOR)], signal });
        const size = page.viewportSize() ?? VIEWPORT;
        return json({ base64: image.toString("base64"), width: size.width, height: size.height, capturedAt: new Date().toISOString(), url: page.url() });
      }
      if (url.pathname === "/snapshot" && request.method === "POST") {
        const page = await currentPage(botId, signal);
        const parsed = parseAriaSnapshot(await page.ariaSnapshot({ mode: "ai", signal }));
        const sensitive = await sensitiveRefs(page, parsed.elements, signal);
        signal.throwIfAborted();
        return json({ url: page.url(), title: await page.title(), elements: maskSensitiveValues(parsed.elements, sensitive), truncated: parsed.truncated });
      }
      if (actions.has(url.pathname) && request.method === "POST") {
        const body = await bodyOf(request);
        const startedAt = Date.now();
        return await session.control.runBot(signal, async (signal) => json({ ...await botAction(await currentPage(botId, signal), url.pathname, body, signal), elapsedMs: Date.now() - startedAt }));
      }
      if (url.pathname === "/files/download" && request.method === "GET") {
        const file = await (await workspaceFor(botId, signal)).download(url.searchParams.get("path") ?? "", signal);
        return new Response(file.body, { headers: downloadHeaders(file.name, file.bytes) });
      }
      if (url.pathname === "/files/read" && request.method === "POST") {
        const body = await bodyOf(request);
        return json(await (await workspaceFor(botId, signal)).read(String(body.path ?? ""), signal));
      }
      if (url.pathname === "/files/list" && request.method === "POST") {
        const body = await bodyOf(request);
        return json(await (await workspaceFor(botId, signal)).list(typeof body.path === "string" ? body.path : undefined, signal));
      }
      if (url.pathname === "/files/write" && request.method === "POST") {
        const body = await bodyOf(request);
        if (typeof body.contents !== "string") return json({ error: "Text contents are required." }, 400);
        return json(await (await workspaceFor(botId, signal)).write(String(body.path ?? ""), body.contents, { append: body.append === true, signal }));
      }
      if (url.pathname === "/exec" && request.method === "POST") {
        if (!runtime.allowExec) return json({ error: "Use host-access tools for commands on the local computer." }, 403);
        const body = await bodyOf(request);
        if (typeof body.command !== "string" || !body.command.trim()) return json({ error: "A command is required." }, 400);
        const timeout = parseExecTimeout(body.timeoutMs);
        if (!timeout.ok) return json({ error: timeout.error }, 400);
        return json(await createShell(await workspaceDirectory(botId, signal)).run({ command: body.command, timeoutMs: timeout.timeoutMs, signal }));
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (signal.aborted) return json({ error: "Stopped.", stopped: true }, 499);
      const status = error instanceof ControlRequestError ? error.status : error instanceof WorkspacePathError ? 403 : error instanceof WorkspaceFileTooLargeError ? 413 : error instanceof WorkspaceFileNotFoundError ? 404 : error instanceof WorkspaceFileError || error instanceof SyntaxError ? 400 : 502;
      return json({ error: describe(error), ...(error instanceof ControlRequestError ? { controlRequestError: true } : {}), ...(error instanceof HumanControlError ? { code: "HUMAN_CONTROL" } : {}) }, status);
    }
  },
});

async function botAction(page: Page, action: string, body: Record<string, unknown>, signal: AbortSignal) {
  const options = { timeout: actionTimeout, signal };
  signal.throwIfAborted();
  if (action === "/scroll") {
    const parsed = parseScrollDelta(body.deltaY);
    if (!parsed.ok) throw new Error(parsed.error);
    await page.mouse.wheel(0, parsed.deltaY ?? 600);
    signal.throwIfAborted();
    return { action: "scroll", deltaY: parsed.deltaY ?? 600, url: page.url() };
  }
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;
  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key) throw new Error("A key name is required.");
    await page.locator(ref ? `aria-ref=${ref}` : ":focus, body:not(:has(:focus))").press(body.key, options);
    return { action: "key", key: body.key, ref, url: page.url() };
  }
  if (!ref) throw new Error("An element ref is required.");
  const element = page.locator(`aria-ref=${ref}`);
  if (action === "/click") await element.click(options);
  else {
    if (typeof body.text !== "string") throw new Error("Text is required.");
    await element.fill(body.text, options);
    if (body.submit === true) await element.press("Enter", options);
  }
  return { action: action.slice(1), ref, ...(typeof body.text === "string" ? { characters: body.text.length } : {}), ...(body.submit === true ? { submitted: true } : {}), url: page.url() };
}
async function humanInput(page: Page, action: string, body: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  if (action === "/human/click") {
    if (typeof body.x !== "number" || typeof body.y !== "number" || !Number.isFinite(body.x) || !Number.isFinite(body.y)) throw new Error("A click needs numeric x and y.");
    await page.mouse.click(Math.max(0, Math.min(body.x, VIEWPORT.width - 1)), Math.max(0, Math.min(body.y, VIEWPORT.height - 1)));
  } else if (action === "/human/type") {
    if (typeof body.text !== "string") throw new Error("Text is required.");
    await page.keyboard.insertText(body.text);
  } else if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) throw new Error("A key is required.");
    await page.keyboard.press(body.key);
  } else {
    const parsed = parseScrollDelta(body.deltaY);
    if (!parsed.ok) throw new Error(parsed.error);
    await page.mouse.wheel(0, parsed.deltaY ?? 400);
  }
  return { action: action.slice(1).replace("/", "_"), url: page.url() };
}
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
let shuttingDown = false;
async function shutDown(reason: string, code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(reason);
  try { await profiles.closeAll(); } finally { await display?.stop(); }
  process.exit(code);
}
if (display) void display.terminated.then(({ expected }) => { if (!expected) return shutDown("Virtual display exited", 1); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { void shutDown(signal, 0); });
console.info(`agent-computer listening on port ${port}`);

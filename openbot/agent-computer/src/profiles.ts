import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { profileDirectoryFor } from "./bot-id";
import { browserRuntimeFromEnv } from "./browser-runtime";
import { egressFor, egressLabel } from "./egress";
import { numberFromEnv } from "./env";
import { chooseLivePage } from "./live-page";
import { botIdsIn } from "./profile-listing";

export { numberFromEnv };
export const VIEWPORT = { width: 1280, height: 800 };
const runtime = browserRuntimeFromEnv(process.env);
const local = runtime.backend === "local-chrome";
const sandbox = local || process.env.COMPUTER_SANDBOX === "on";

export type BotBrowser = { botId: string; context: BrowserContext; page: Page };
export type ProfileSummary = { botId: string; running: boolean; startedAt: string | null; egress: string | null };
export type BrowserClosed = (botId: string) => void | Promise<void>;

/** Cancelling a borrower must not cancel a lifecycle operation owned by another caller. */
async function borrow<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([operation, stopped]); }
  finally { signal.removeEventListener("abort", cancel); }
}

/** A configured HTTP proxy must also carry WebRTC traffic. */
export async function keepWebRtcInsideProxy(profileDir: string): Promise<void> {
  const file = join(profileDir, "Default", "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    preferences = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const webrtc = preferences.webrtc as Record<string, unknown> | undefined;
  if (webrtc?.ip_handling_policy === "disable_non_proxied_udp") return;
  preferences.webrtc = { ...webrtc, ip_handling_policy: "disable_non_proxied_udp" };
  await mkdir(join(profileDir, "Default"), { recursive: true });
  await writeFile(file, JSON.stringify(preferences));
}

/** Persistent browser contexts own login state. Turns only borrow a page. */
export function createProfiles(root: string, onClosed: BrowserClosed) {
  type Browser = {
    context: BrowserContext;
    page: Page;
    startedAt: string;
  };
  const live = new Map<string, Browser>();
  const starting = new Map<string, Promise<Page>>();
  const closing = new Map<string, Promise<unknown>>();
  const directoryFor = (botId: string) => profileDirectoryFor(root, botId);

  async function close(botId: string): Promise<boolean> {
    const pending = starting.get(botId);
    if (pending) {
      try { await pending; } catch { /* A failed launch has no live context. */ }
    }
    const browser = live.get(botId);
    if (!browser) return false;
    try {
      await onClosed(botId);
    } finally {
      await browser.context.close();
      live.delete(botId);
    }
    return true;
  }

  async function closingProfile<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = closing.get(botId);
    const operation = (async () => {
      if (previous) {
        try { await previous; } catch { /* Its own caller receives the previous operation's failure. */ }
      }
      return work();
    })();
    // The map holds the actual lifecycle operation, rather than a second completion promise.
    closing.set(botId, operation);
    try {
      return await operation;
    } finally {
      if (closing.get(botId) === operation) closing.delete(botId);
    }
  }

  async function page(botId: string, signal?: AbortSignal): Promise<Page> {
    signal?.throwIfAborted();
    const stopping = closing.get(botId);
    if (stopping) await borrow(stopping, signal);
    signal?.throwIfAborted();
    const pending = starting.get(botId);
    if (pending) {
      const target = await borrow(pending, signal);
      signal?.throwIfAborted();
      return target;
    }
    const existing = live.get(botId);
    if (existing?.context.browser()?.isConnected()) {
      const target = chooseLivePage(existing.context.pages()) ?? await existing.context.newPage();
      existing.page = target;
      signal?.throwIfAborted();
      return target;
    }
    if (existing) {
      await existing.context.close();
      live.delete(botId);
    }
    const launch = (async () => {
      const dir = directoryFor(botId);
      const proxy = egressFor(botId, process.env);
      if (proxy && !local) await keepWebRtcInsideProxy(dir);
      signal?.throwIfAborted();
      const context = await chromium.launchPersistentContext(dir, {
        channel: runtime.channel,
        headless: runtime.mode === "headless",
        args: [
          ...(sandbox ? [] : ["--no-sandbox"]),
          "--disable-dev-shm-usage",
          ...(local ? [] : ["--password-store=basic"]),
          "--disable-blink-features=AutomationControlled",
          "--restore-last-session",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
        chromiumSandbox: sandbox,
        viewport: VIEWPORT,
        handleSIGTERM: false,
        handleSIGINT: false,
        handleSIGHUP: false,
        ...(proxy ? { proxy } : {}),
        signal,
      });
      try {
        const target = chooseLivePage(context.pages()) ?? await context.newPage();
        live.set(botId, { context, page: target, startedAt: new Date().toISOString() });
        return target;
      } catch (error) {
        await context.close();
        throw error;
      }
    })();
    starting.set(botId, launch);
    try {
      const target = await launch;
      signal?.throwIfAborted();
      return target;
    } finally {
      starting.delete(botId);
    }
  }

  return {
    page,
    stop: (botId: string) => closingProfile(botId, () => close(botId)),
    reset: (botId: string) => closingProfile(botId, async () => {
      await close(botId);
      await rm(directoryFor(botId), { recursive: true, force: true });
    }),
    async known(): Promise<string[]> {
      let onDisk;
      try { onDisk = await readdir(root, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        onDisk = [];
      }
      return [...new Set([...botIdsIn(onDisk), ...live.keys()])].sort();
    },
    summary(botIds: string[]): ProfileSummary[] {
      return [...new Set([...botIds, ...live.keys()])].sort().map((botId) => ({
        botId,
        running: live.has(botId),
        startedAt: live.get(botId)?.startedAt ?? null,
        egress: egressLabel(botId, process.env),
      }));
    },
    async closeAll(): Promise<void> {
      await Promise.all([...new Set([...live.keys(), ...starting.keys()])].map((botId) => closingProfile(botId, () => close(botId))));
    },
    liveCount: () => live.size,
    isLive: (botId: string) => live.has(botId),
  };
}
export type Profiles = ReturnType<typeof createProfiles>;

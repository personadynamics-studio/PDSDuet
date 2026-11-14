/**
 * What a computer is told about itself.
 *
 * Kept separate from the HTTP server so the exact environment boundary is testable without
 * starting a listener or connecting to Docker. Nothing here is caller-supplied: a request says
 * which Bot, never what to run or what to set.
 */
export function environmentFor(
  botId: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const proxy = env[`EGRESS_PROXY_${botId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`] ?? env.EGRESS_PROXY_DEFAULT;
  // Fail fast here rather than forwarding an invalid mode that crashes the child at
  // `browserModeFromEnv`: whitespace-only is falsy after trim, anything else must be headless
  // or headed.
  const rawBrowserMode = env.COMPUTER_BROWSER_MODE?.trim() || undefined;
  if (
    rawBrowserMode !== undefined &&
    rawBrowserMode !== "headless" &&
    rawBrowserMode !== "headed"
  ) {
    throw new Error(
      `COMPUTER_BROWSER_MODE must be headless or headed, not ${JSON.stringify(env.COMPUTER_BROWSER_MODE)}.`,
    );
  }
  const browserMode = rawBrowserMode;
  return [
    `COMPUTER_BOT_ID=${botId}`,
    ...(browserMode ? [`COMPUTER_BROWSER_MODE=${browserMode}`] : []),
    ...(proxy ? [`EGRESS_PROXY_DEFAULT=${proxy}`] : []),
  ];
}

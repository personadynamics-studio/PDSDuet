import type { Message } from "@ag-ui/core";

/** Each connection owns its gates; an old replay cannot release a new connection's send. */
export function connectionGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, error: null as string | null };
}

const OWNERS = "openduet:channel-turn-owners:";

/** Only client claim IDs are retained, so a reopened phone can release its own finished claims. */
export function rememberedTurnOwners(channelId: string): string[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(OWNERS + channelId) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter(
          (id): id is string =>
            typeof id === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(id),
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberTurnOwner(channelId: string, owner: string): void {
  try {
    const owners = new Set([...rememberedTurnOwners(channelId), owner]);
    window.localStorage.setItem(OWNERS + channelId, JSON.stringify([...owners]));
  } catch {
    // Restricted storage affects claim recovery, never whether the message may be sent.
  }
}

export function forgetTurnOwner(channelId: string, owner: string): void {
  try {
    const remaining = rememberedTurnOwners(channelId).filter((id) => id !== owner);
    if (remaining.length)
      window.localStorage.setItem(OWNERS + channelId, JSON.stringify(remaining));
    else window.localStorage.removeItem(OWNERS + channelId);
  } catch {
    // The server also expires abandoned claims.
  }
}

/** A client-owned tool must not be detached just because there is no model run between its steps. */
export function hasPendingFrontendTool(messages: readonly Message[]): boolean {
  const start = messages.findLastIndex((message) => message.role === "user");
  const turn = messages.slice(start + 1);
  const answered = new Set(
    turn.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []),
  );
  return turn.some(
    (message) => message.role === "assistant" &&
      (message.toolCalls ?? []).some((call) => !answered.has(call.id)),
  );
}

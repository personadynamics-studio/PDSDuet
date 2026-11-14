import type { ComputerControlState, HandoffRequest, HandoffSource } from "../../shared/computer-control";

export type ControlState = ComputerControlState;
export class ControlRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ControlRequestError";
  }
}
export class HumanControlError extends ControlRequestError {
  constructor() { super("The person has control of the browser. Wait until they return it.", 409); }
}
export const NO_SECRET_PENDING = "Nothing is waiting for a secret.";

export function createControl(now: () => string = () => new Date().toISOString()) {
  let holder: "bot" | "human" = "bot";
  let since = now();
  let request: HandoffRequest | undefined;
  let secret: { label: string; ref: string } | undefined;
  const actions = new Map<AbortController, Promise<unknown>>();

  function get(): ControlState {
    return {
      holder,
      since,
      requested: request?.status === "waiting",
      reason: request?.reason,
      request: request ? { ...request } : undefined,
      secretWanted: secret?.label,
      secretRef: secret?.ref,
    };
  }
  function finish(status: "completed" | "cancelled" | "interrupted", reason?: string) {
    if (request) {
      request.status = status;
      request.updatedAt = now();
      request.finishedAt = request.updatedAt;
      if (reason) request.interruption = reason;
    }
    holder = "bot";
    since = now();
    secret = undefined;
    return get();
  }

  return {
    get,
    async runBot<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      if (holder === "human") throw new HumanControlError();
      const action = new AbortController();
      const operation = work(AbortSignal.any([signal, action.signal]));
      actions.set(action, operation);
      try {
        return await operation;
      } catch (error) {
        if (action.signal.aborted) throw action.signal.reason;
        throw error;
      } finally {
        actions.delete(action);
      }
    },
    async runHuman<T>(work: () => Promise<T>): Promise<T> {
      if (holder !== "human") throw new ControlRequestError("Take control of the browser before sending input.", 409);
      await Promise.allSettled(actions.values());
      if (holder !== "human") throw new ControlRequestError("Browser control has been returned to the Bot.", 409);
      return work();
    },
    requestHelp(reason: unknown, toolCallId?: string, source: HandoffSource = "model", pageUrl?: string): ControlState {
      const at = now();
      request = {
        id: toolCallId ?? crypto.randomUUID(),
        ...(toolCallId ? { toolCallId } : {}),
        reason: typeof reason === "string" ? reason : "The assistant needs a person to continue.",
        source,
        status: "waiting",
        createdAt: at,
        updatedAt: at,
        ...(pageUrl ? { url: pageUrl } : {}),
      };
      return get();
    },
    async take(): Promise<ControlState> {
      if (request) {
        request.status = "taken";
        request.updatedAt = now();
      }
      holder = "human";
      for (const action of actions.keys()) action.abort(new HumanControlError());
      since = now();
      await Promise.allSettled(actions.values());
      return get();
    },
    release(): ControlState { return finish("completed"); },
    cancel(): ControlState { return finish("cancelled"); },
    interrupt(reason: string): void {
      for (const action of actions.keys()) action.abort(new Error(reason));
      finish("interrupted", reason);
    },
    requestSecret(input: { label?: unknown; ref?: unknown }): ControlState {
      if (typeof input.ref !== "string" || !input.ref.trim())
        throw new ControlRequestError("Say which field the value goes in, using a ref from your snapshot.");
      secret = {
        label: typeof input.label === "string" ? input.label : "the value this page is asking for",
        ref: input.ref,
      };
      return get();
    },
    pendingSecret(): { ref: string } | null { return secret ? { ref: secret.ref } : null; },
    secretSupplied(): void { finish("completed"); },
  };
}
export type Control = ReturnType<typeof createControl>;

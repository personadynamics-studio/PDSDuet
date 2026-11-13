import { mintRunAssertion, type RunAssertion } from "./callback-token";
import type { HandoffWork } from "./handoff-runner";

/** The real execution identity, signed for the addressed Bot. */
export function handoffDeliveryRunAssertion(work: HandoffWork, runId: string): RunAssertion {
  return {
    botId: work.toBotId, actorId: work.actorId, runId, threadId: runId, depth: work.depth,
    ...(work.initiator ? { initiator: work.initiator } : {}),
  };
}
export function signHandoffDeliveryRun(work: HandoffWork, encryptionKey: string, runId: string): string {
  return mintRunAssertion(handoffDeliveryRunAssertion(work, runId), encryptionKey);
}

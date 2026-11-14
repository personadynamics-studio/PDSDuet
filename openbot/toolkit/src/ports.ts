import type { HeadlessTool } from "./headless-tools";
import type { AuditInitiator } from "./initiator";

/**
 * The display components a Bot can draw in a turn with no browser, so it can still answer with a
 * chart. The server's catalog is `headlessComponentCatalog` in components/headless.ts.
 */
export type ComponentCatalog = {
  /** Every component's tool name, so a turn can tell which of its tool calls drew one. */
  names: ReadonlySet<string>;
  /** The component tools this Bot is offered, decided as the browser would decide them. */
  toolsForTurn: (input: {
    agentId: string;
    ownerUserId: string;
    initiator: AuditInitiator;
  }) => Promise<HeadlessTool[]>;
};


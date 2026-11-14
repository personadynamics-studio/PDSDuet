import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import type { ThreadMessage, ThreadRun, RunStatus } from "@openbot/shared/thread-events";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";

export type ExecutionInput = {
  actor: AgentActor;
  threadId: string;
  botIds?: string[];
  messages?: ThreadMessage[];
  instruction?: string;
  parentRunId?: string;
  runId?: string;
  signal?: AbortSignal;
  initiator?: AuditInitiator;
  childResultRunId?: string;
};
export type ExecutionResult = {
  runId: string;
  status: RunStatus;
  replyText: string;
  messages: ThreadMessage[];
  waiting?: ThreadRun["waiting"];
  error?: string;
};
export type ExecutionRecord = ThreadRun & {
  threadId: string;
  userId: string;
  botIds: string[];
  botIndex: number;
  parentRunId?: string;
  instruction?: string;
  initiator?: AuditInitiator;
  stopRequested: boolean;
  modelStates: Record<string, unknown>;
};
export type PreparedExecution = {
  run: ExecutionRecord;
  actor: AgentActor;
  history: ThreadMessage[];
  added: ThreadMessage[];
  state: unknown;
  resume: RunAgentInput["resume"];
  ancestors: string[];
};
export type ExecutionOutcome = {
  status: RunStatus;
  error?: string;
  waiting?: ThreadRun["waiting"];
};
export type SettlementWriter = {
  phase(botIndex: number, modelInput: readonly Message[]): Promise<void>;
  record(event: BaseEvent): Promise<void>;
  context(botIndex: number): Promise<{ messages: ThreadMessage[]; state: unknown }>;
  readonly outputs: ThreadMessage[];
  readonly state: unknown;
};

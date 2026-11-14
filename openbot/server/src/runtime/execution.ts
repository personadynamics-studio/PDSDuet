import { EventType, type AbstractAgent, type AGUIEvent, type BaseEvent, type RunAgentInput, type RunFinishedEvent } from "@ag-ui/client";
import { HeadlessToolsMiddleware, OPENBOT_WAITING_METADATA, type HeadlessTool } from "@openbot/toolkit/headless-tools";
import { historyForBot, mergeContinuationHistory } from "@openbot/toolkit/history-sanitize";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";
import type { Settlement } from "./settlement";
import type { ExecutionInput, ExecutionOutcome, ExecutionResult, PreparedExecution, SettlementWriter } from "./types";
export type { ExecutionInput, ExecutionResult } from "./types";

class ExecutionStopped extends Error {
  constructor() { super("The work was cancelled."); this.name = "ExecutionStopped"; }
}

type Running = {
  threadId: string;
  controller: AbortController;
  path: readonly string[];
  admitted: Promise<void>;
  promise: Promise<ExecutionResult>;
};

/** An execution owns its SDK subscriptions and tools; settlement alone owns conversation data. */
export function createExecution(options: {
  settlement: Settlement;
  createAgent(actor: AgentActor, botId: string, initiator?: AuditInitiator): Promise<AbstractAgent>;
  toolsForRun(input: { actor: AgentActor; botId: string; threadId: string; runId: string; initiator?: AuditInitiator }): Promise<HeadlessTool[]>;
}) {
  const { settlement } = options;
  const active = new Map<string, Running>();

  async function phase(prepared: PreparedExecution, writer: SettlementWriter, index: number, controller: AbortController, resume: RunAgentInput["resume"]) {
    const { run } = prepared;
    const { signal } = controller;
    signal.throwIfAborted();
    const context = await writer.context(index);
    const answered = new Set((resume ?? []).map(entry => entry.interruptId));
    const siblings = new Set(context.messages.flatMap(message => message.role === "assistant" && message.toolCalls?.some(call => answered.has(call.id)) ? message.toolCalls.map(call => call.id) : []));
    const messages = historyForBot(mergeContinuationHistory(context.messages, []), run.botIds[index], siblings);
    await writer.phase(index, messages);
    signal.throwIfAborted();
    const agent = await options.createAgent(prepared.actor, run.botIds[index], run.initiator);
    signal.throwIfAborted();
    const tools = await options.toolsForRun({ actor: prepared.actor, botId: run.botIds[index], threadId: run.threadId, runId: run.id, initiator: run.initiator });
    signal.throwIfAborted();
    const middleware = new HeadlessToolsMiddleware(tools, signal);
    agent.use(middleware);
    agent.threadId = run.threadId;
    agent.setMessages(messages);
    agent.setState(context.state);
    const input: RunAgentInput = {
      threadId: run.threadId,
      runId: run.id,
      messages,
      state: context.state,
      tools: tools.filter(tool => !tool.hidden).map(tool => tool.definition),
      context: run.instruction ? [{ description: "Execution instruction", value: run.instruction }] : [],
      ...(resume?.length ? { resume } : {}),
    };
    let writes = Promise.resolve();
    const enqueue = (event: BaseEvent) => {
      writes = writes.then(() => writer.record(event));
      void writes.catch(error => controller.abort(error));
      return writes;
    };
    let terminal: RunFinishedEvent | undefined;
    let applying: AGUIEvent | undefined;
    let detaching: Promise<void> | undefined;
    const detach = () => {
      detaching = agent.detachActiveRun();
      void detaching.catch(() => undefined); // Awaited by this phase's finally.
    };
    signal.addEventListener("abort", detach, { once: true });
    try {
      signal.throwIfAborted();
      await agent.runAgent(input, {
        onEvent: ({ event: raw }) => {
          const event = raw as AGUIEvent;
          applying = event;
          if (event.type === "RUN_STARTED") return;
          if (event.type === "RUN_FINISHED") { terminal = event as RunFinishedEvent; return; }
          if (event.type === "RUN_ERROR") {
            writes = writes.then(() => { throw new Error(event.message); });
            void writes.catch(error => controller.abort(error));
            return writes;
          }
          if (event.type === "STATE_DELTA" || event.type === "STATE_SNAPSHOT" || event.type === "ACTIVITY_DELTA") return;
          return enqueue(event);
        },
        onStateChanged: ({ state }) => {
          if (applying?.type !== "STATE_DELTA" && applying?.type !== "STATE_SNAPSHOT") return;
          applying = undefined;
          void enqueue({ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(state) });
        },
        onMessagesChanged: ({ messages }) => {
          if (applying?.type !== "ACTIVITY_DELTA") return;
          const id = applying.messageId;
          applying = undefined;
          const activity = messages.find(message => message.id === id && message.role === "activity");
          if (activity?.role === "activity") void enqueue({ type: EventType.ACTIVITY_SNAPSHOT, messageId: activity.id, activityType: activity.activityType, content: structuredClone(activity.content) });
        },
      });
      await writes;
      signal.throwIfAborted();
      if (!terminal) throw new Error("The agent ended without a terminal event.");
      if (terminal.outcome?.type !== "interrupt") return undefined;
      const canonical = await writer.context(index);
      return terminal.outcome.interrupts.map(interrupt => {
        const toolCallId = interrupt.toolCallId ?? interrupt.id;
        const call = canonical.messages.flatMap(message => message.role === "assistant" ? message.toolCalls ?? [] : []).find(call => call.id === toolCallId);
        const metadata = interrupt.metadata?.[OPENBOT_WAITING_METADATA] as Record<string, unknown> | undefined;
        return { toolCallId, toolName: call?.function.name ?? "", answerable: !metadata || ["person_question", "computer_handoff", "computer_secret"].includes(String(metadata.kind)), ...(metadata ? { metadata } : {}) };
      });
    } finally {
      signal.removeEventListener("abort", detach);
      try { await middleware.settled(); }
      finally {
        try { await detaching; }
        finally { await writes; }
      }
    }
  }

  async function perform(prepared: PreparedExecution, controller: AbortController): Promise<ExecutionResult> {
    const writer = settlement.writer(prepared);
    let outcome: ExecutionOutcome = { status: "completed" };
    try {
      for (let index = prepared.run.botIndex; index < prepared.run.botIds.length; index++) {
        controller.signal.throwIfAborted();
        const waiting = await phase(prepared, writer, index, controller, index === prepared.run.botIndex ? prepared.resume : undefined);
        controller.signal.throwIfAborted();
        if (waiting) { outcome = { status: "waiting", waiting }; break; }
      }
    } catch (failure) {
      const error = controller.signal.aborted ? controller.signal.reason : failure;
      outcome = { status: error instanceof ExecutionStopped ? "stopped" : "failed", error: error instanceof Error ? error.message : String(error) };
    }
    return settlement.settle(prepared, writer, outcome);
  }

  async function execute(initial: PreparedExecution, controller: AbortController): Promise<ExecutionResult> {
    let prepared = initial;
    for (;;) {
      const result = await perform(prepared, controller);
      if (controller.signal.aborted) return result;
      const ready = await settlement.ready(prepared.run.id);
      let continuation: PreparedExecution | undefined;
      for (const childResultRunId of ready) {
        if (controller.signal.aborted) return result;
        const input: ExecutionInput = { actor: prepared.actor, threadId: prepared.run.threadId, childResultRunId, signal: controller.signal };
        const parent = await settlement.prepare(input);
        if (controller.signal.aborted) return result;
        if (parent.run.id === initial.run.id) continuation = parent;
        else await (await open(input, parent)).promise;
      }
      if (!continuation || controller.signal.aborted) return result;
      await settlement.begin(continuation);
      prepared = continuation;
    }
  }

  async function open(input: ExecutionInput, supplied?: PreparedExecution): Promise<Running & { runId: string }> {
    const prepared = supplied ?? await settlement.prepare(input);
    const runId = prepared.run.id;
    const existing = active.get(runId);
    if (existing) {
      if (input.childResultRunId) {
        await existing.promise;
        const ready = await settlement.ready(input.childResultRunId);
        if (ready.includes(input.childResultRunId)) return open(input);
      } else if (prepared.run.status === "waiting" && input.messages?.some(message => message.role === "tool")) {
        await existing.promise;
        return open(input);
      }
      return { ...existing, runId };
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(new ExecutionStopped());
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const admitted = settlement.begin(prepared);
    const promise = admitted.then(() => execute(prepared, controller)).finally(() => {
      input.signal?.removeEventListener("abort", cancel);
      if (active.get(runId)?.promise === promise) active.delete(runId);
    });
    void promise.catch(error => console.error("Execution ended with an error", runId, error));
    const running = { threadId: prepared.run.threadId, path: [...prepared.ancestors, runId], controller, admitted, promise };
    active.set(runId, running);
    return { ...running, runId };
  }

  async function stop(threadId: string, runId: string): Promise<boolean> {
    const root = [...active.values()].find(work => work.threadId === threadId && work.path.includes(runId))?.path[0];
    if (root) for (const work of active.values()) if (work.path[0] === root) work.controller.abort(new ExecutionStopped());
    const ids = await settlement.cancel(threadId, runId, [...active.keys()]);
    for (const id of ids) active.get(id)?.controller.abort(new ExecutionStopped());
    return ids.length > 0 || root !== undefined;
  }

  return {
    async start(input: ExecutionInput): Promise<{ runId: string }> {
      const running = await open(input);
      await running.admitted;
      return { runId: running.runId };
    },
    async run(input: ExecutionInput): Promise<ExecutionResult> { return (await open(input)).promise; },
    stop,
    async close(): Promise<void> {
      const running = [...active.values()];
      const roots = [...new Set(running.map(work => work.path[0]!))];
      try { await Promise.all(roots.map(root => stop(running.find(work => work.path[0] === root)!.threadId, root))); }
      finally { await Promise.allSettled(running.map(work => work.promise)); }
    },
  };
}
export type Execution = ReturnType<typeof createExecution>;

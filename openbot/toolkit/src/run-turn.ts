import type { AbstractAgent, BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import type { Observable } from "rxjs";
import { NOT_SHOWN } from "@openbot/shared/component-markers";
import type { RunStatus } from "@openbot/shared/thread-events";
import { HeadlessToolsMiddleware, HeadlessToolSuspension, OPENBOT_WAITING_METADATA, type HeadlessTool, type HeadlessWaiting } from "./headless-tools";
import { historyForBot, mergeContinuationHistory } from "./history-sanitize";
import type { AuditInitiator } from "./initiator";
import type { ComponentCatalog } from "./ports";

export type TurnInput = {
  ownerUserId: string; agentId: string; threadId: string; instruction: string;
  initiator?: AuditInitiator; signal?: AbortSignal; runId?: string; parentRunId?: string;
  depth?: number; routineId?: string; persistUserMessage?: boolean;
  userMessage?: Message; messages?: Message[];
  systemMessages?: Extract<Message, { role: "system" }>[];
  context?: RunAgentInput["context"];
  onText?: (text: string) => void;
};
export type DrawnComponent = { name: string; args: Record<string, unknown> };
export type TurnResult = { runId: string; replyText: string; status: RunStatus; waiting?: HeadlessWaiting; components?: DrawnComponent[]; replyChips?: boolean };
export type TurnRunner = (input: TurnInput) => Promise<TurnResult>;
export type ThreadStoreLike = {
  getOrCreateThread(input: { threadId: string; userId: string; agentId: string }): Promise<{ state?: unknown }>;
  getThreadMessages(input: { threadId: string; userId: string }): Promise<{ messages: Message[] }>;
};
export type RunnerLike = {
  start(input: { threadId: string; userId?: string; agent: AbstractAgent; agentId?: string; input: RunAgentInput; persistedInputMessages?: Message[]; parentRunId?: string; signal?: AbortSignal }): Promise<Observable<BaseEvent>>;
  stop(input: { threadId: string; runId: string }): Promise<boolean | undefined>;
};

export function drawnComponents(messages: Message[], names: ReadonlySet<string>): DrawnComponent[] {
  const results = new Map(messages.flatMap(message => message.role === "tool" && typeof message.content === "string" ? [[message.toolCallId, message.content] as const] : []));
  const drawn: DrawnComponent[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const result = results.get(call.id);
      if (!names.has(call.function.name) || result === undefined || result.startsWith(NOT_SHOWN)) continue;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (args && typeof args === "object" && !Array.isArray(args)) drawn.push({ name: call.function.name, args });
      } catch { /* Invalid arguments were refused by the tool. */ }
    }
  }
  return drawn;
}

/** All callers share Bot construction, tools, persistence and cancellation. */
export function createTurnExecutor(options: {
  threads: ThreadStoreLike; runner: RunnerLike;
  buildAgentFor(input: { ownerUserId: string; agentId: string; initiator: AuditInitiator; depth?: number }): Promise<AbstractAgent>;
  toolsForTurn?(input: { ownerUserId: string; agentId: string; initiator: AuditInitiator; threadId: string; runId: string }): Promise<HeadlessTool[]>;
  components?: ComponentCatalog;
}) {
  async function start(request: TurnInput) {
    request.signal?.throwIfAborted();
    const { ownerUserId, agentId, threadId } = request;
    const initiator = request.initiator ?? { kind: "person" as const };
    const runId = request.runId ?? crypto.randomUUID();
    const thread = await options.threads.getOrCreateThread({ threadId, userId: ownerUserId, agentId });
    const history = (await options.threads.getThreadMessages({ threadId, userId: ownerUserId })).messages;
    const historicIds = new Set(history.map(message => message.id));
    const supplied = request.messages ?? (request.userMessage ? [request.userMessage] : request.instruction ? [{ id: crypto.randomUUID(), role: "user" as const, content: request.instruction }] : []);
    const answers=supplied.filter(message=>message.role==="tool");
    const answered=new Set(answers.map(message=>message.toolCallId));
    const pendingBatch=new Set(history.flatMap(message=>message.role==="assistant"&&message.toolCalls?.some(call=>answered.has(call.id))?message.toolCalls.map(call=>call.id):[]));
    const messages = historyForBot([
      ...mergeContinuationHistory(history, [], answers),
      ...(request.systemMessages ?? []), ...supplied.filter(message=>message.role!=="tool"),
    ],agentId,pendingBatch);
    const agent = await options.buildAgentFor({ ownerUserId, agentId, initiator, depth: request.depth });
    agent.threadId = threadId; agent.setMessages(messages);
    agent.setState(thread.state ?? null);
    const tools = [
      ...(await options.toolsForTurn?.({ ownerUserId, agentId, initiator, threadId, runId }) ?? []),
      ...(await options.components?.toolsForTurn({ ownerUserId, agentId, initiator }) ?? []),
    ];
    if (tools.length) agent.use(new HeadlessToolsMiddleware(tools));
    const input: RunAgentInput = {
      threadId, runId, messages, state: agent.state,
      tools: tools.filter(tool => !tool.hidden).map(tool => tool.definition),
      context: request.context ?? [],
      ...(answers.length?{resume:answers.map(message=>({interruptId:message.toolCallId,status:"resolved" as const,payload:message.content}))}:{}),
    };
    const events = await options.runner.start({
      threadId, userId: ownerUserId, agent, agentId, input, signal: request.signal,
      parentRunId: request.parentRunId,
      persistedInputMessages: (request.persistUserMessage===false?[]:supplied).filter(message=>!historicIds.has(message.id)),
    });
    return { runId, events, agent, historicIds };
  }

  const run: TurnRunner = async request => {
    const { runId, events, agent, historicIds } = await start(request);
    let terminal: (BaseEvent & { status?: RunStatus; error?: string }) | undefined;
    let waiting: HeadlessToolSuspension | undefined;
    let text = "";
    await new Promise<void>((resolve, reject) => events.subscribe({
      next: event => {
        if (event.type === "TEXT_MESSAGE_CONTENT") { text += String(event.delta ?? ""); request.onText?.(text); }
        if (event.type === "CUSTOM" && event.name === "openbot.headless.waiting") {
          const value = event.value as HeadlessWaiting & { message?: string };
          waiting = new HeadlessToolSuspension(value.message ?? "The Bot is waiting for human input.", value);
        }
        if (event.type === "RUN_FINISHED") {
          terminal = event;
          if (event.outcome?.type === "interrupt") {
            const interrupt = event.outcome.interrupts.find(item => item.metadata?.[OPENBOT_WAITING_METADATA]);
            if (interrupt) waiting = new HeadlessToolSuspension("The Bot is waiting for human input.", interrupt.metadata?.[OPENBOT_WAITING_METADATA] as HeadlessWaiting);
          }
        }
      }, error: reject, complete: resolve,
    }));
    if (!terminal || (terminal.status !== "completed" && terminal.status !== "waiting")) {
      const error = new Error(terminal?.error ?? "The Bot did not finish this turn.");
      if (terminal?.status === "stopped") error.name = "RunStoppedError";
      throw error;
    }
    const added = agent.messages.filter(message => !historicIds.has(message.id));
    return {
      runId, status: terminal.status, ...(waiting ? { waiting: waiting.waiting } : {}),
      replyText: added.filter(message => message.role === "assistant").map(message => typeof message.content === "string" ? message.content : "").filter(Boolean).join("\n\n") || text,
      components: drawnComponents(added, options.components?.names ?? new Set()),
      ...(added.some(message => message.role === "tool" && String(message.content).startsWith("The buttons are")) ? { replyChips: true } : {}),
    };
  };
  return { start, run };
}
export type TurnExecutor = ReturnType<typeof createTurnExecutor>;

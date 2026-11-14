import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
  type Tool,
  type ToolCall,
} from "@ag-ui/client";
import { finalize, Observable, type Subscription } from "rxjs";
import { mergeContinuationHistory } from "./history-sanitize";

export type HeadlessTool = {
  definition: Tool;
  /** An available executor omitted from the model's offered list. */
  hidden?: boolean;
  execute(args: unknown, context: { toolCallId: string; signal: AbortSignal }): Promise<unknown>;
};

export const OPENBOT_WAITING_METADATA = "openbotWaiting";
export type HeadlessWaiting = {
  kind: string;
  requestId?: string;
  [key: string]: unknown;
};
export class HeadlessToolSuspension extends Error {
  constructor(message: string, readonly waiting: HeadlessWaiting) {
    super(message);
    this.name = "HeadlessToolSuspension";
  }
}

/** One owner executes the deployment's tools between model segments. */
export class HeadlessToolsMiddleware extends Middleware {
  constructor(private readonly tools: HeadlessTool[]) {
    super();
    if (new Set(tools.map(tool => tool.definition.name)).size !== tools.length)
      throw new Error("Headless tool names must be unique.");
  }

  run(originalInput: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return new Observable(subscriber => {
      const controller = new AbortController();
      const tools = new Map(this.tools.map(tool => [tool.definition.name, tool]));
      let subscription: Subscription | undefined;
      const work = async () => {
        let request: RunAgentInput = {
          ...originalInput,
          tools: [
            ...originalInput.tools.filter(tool => !tools.has(tool.name)),
            ...this.tools.filter(tool => !tool.hidden).map(tool => tool.definition),
          ],
        };
        let messages = request.messages;
        let state = request.state;
        let terminal: RunFinishedEvent = {
          type: EventType.RUN_FINISHED,
          threadId: request.threadId,
          runId: request.runId,
        };
        const resumed = new Set((request.resume ?? []).filter(entry => entry.status === "resolved").map(entry => entry.interruptId));
        const answered = new Set(messages.flatMap(message => message.role === "tool" ? [message.toolCallId] : []));
        // Only a formally answered batch resumes before the model. Old cancelled calls are not replayed.
        let pending: ToolCall[] = messages.flatMap(message =>
          message.role === "assistant" && message.toolCalls?.some(call => resumed.has(call.id))
            ? message.toolCalls.filter(call => !answered.has(call.id))
            : [],
        );
        subscriber.next({ type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId });

        for (;;) {
          if (subscriber.closed) return;
          controller.signal.throwIfAborted();
          if (pending.length === 0) {
            const historical = new Set(request.messages.flatMap(message =>
              message.role === "assistant" ? (message.toolCalls ?? []).map(call => call.id) : [],
            ));
            const emitted = new Set<string>();
            let finished: RunFinishedEvent | undefined;
            await new Promise<void>((resolve, reject) => {
              subscription = this.runNextWithState(request, new InvocationTransport(next, request))
                .pipe(finalize(resolve))
                .subscribe({
                  next: ({ event, messages: updatedMessages, state: updatedState }) => {
                    messages = updatedMessages;
                    state = updatedState;
                    if (event.type === EventType.RUN_STARTED) return;
                    if (event.type === EventType.RUN_ERROR) {
                      reject(new Error(event.message));
                      return;
                    }
                    if (event.type === EventType.TOOL_CALL_START) emitted.add(event.toolCallId);
                    if (event.type === EventType.MESSAGES_SNAPSHOT) {
                      for (const message of messages) {
                        if (message.role !== "assistant") continue;
                        for (const call of message.toolCalls ?? []) if (!historical.has(call.id)) emitted.add(call.id);
                      }
                    }
                    if (event.type === EventType.RUN_FINISHED) {
                      finished = event as RunFinishedEvent;
                      return;
                    }
                    subscriber.next(event);
                  },
                  error: reject,
                });
            });
            controller.signal.throwIfAborted();
            request = { ...request, resume: undefined };
            if (!finished) throw new Error("The agent ended without a terminal event.");
            terminal = finished;
            const answered = new Set(messages.flatMap(message => message.role === "tool" ? [message.toolCallId] : []));
            pending = messages.flatMap(message => message.role === "assistant"
              ? (message.toolCalls ?? []).filter(call => emitted.has(call.id) && !historical.has(call.id) && !answered.has(call.id))
              : [],
            );
            if (pending.length === 0) {
              subscriber.next(terminal);
              return;
            }
          }

          const interrupts = terminal.outcome?.type === "interrupt" ? terminal.outcome.interrupts : [];
          const unhandled = pending.filter(call => !tools.has(call.function.name) &&
            !interrupts.some(interrupt => (interrupt.toolCallId ?? interrupt.id) === call.id));
          if (unhandled.length) throw new Error(`No executor or human interrupt handles: ${unhandled.map(call => `${call.function.name} (${call.id})`).join(", ")}.`);

          const results = new Map<string, string>();
          for (const call of pending) {
            const tool = tools.get(call.function.name);
            if (!tool) continue; // Its explicit harness interrupt remains waiting below.
            controller.signal.throwIfAborted();
            let content: string;
            let error: string | undefined;
            try {
              const args: unknown = JSON.parse(call.function.arguments || "{}");
              const result = await tool.execute(args, { toolCallId: call.id, signal: controller.signal });
              controller.signal.throwIfAborted();
              const serialized = typeof result === "string" ? result : JSON.stringify(result);
              if (serialized === undefined) throw new Error(`The tool ${call.function.name} returned no result.`);
              content = serialized;
            } catch (failure) {
              controller.signal.throwIfAborted();
              if (failure instanceof HeadlessToolSuspension) {
                const waiting: HeadlessWaiting = {
                  ...failure.waiting,
                  toolCallId: call.id,
                  toolName: call.function.name,
                  message: failure.message,
                };
                subscriber.next({ type: EventType.CUSTOM, name: "openbot.headless.waiting", value: waiting });
                subscriber.next({
                  ...terminal,
                  outcome: { type: "interrupt", interrupts: [{
                    id: call.id,
                    toolCallId: call.id,
                    reason: "human_input",
                    message: failure.message,
                    metadata: { [OPENBOT_WAITING_METADATA]: waiting },
                  }] },
                });
                return;
              }
              error = failure instanceof Error ? failure.message : String(failure);
              content = JSON.stringify({ ok: false, error });
            }
            const message: Message = {
              id: `tool-result:${call.id}`,
              role: "tool",
              toolCallId: call.id,
              content,
              ...(error ? { error } : {}),
            };
            messages = [...messages, message];
            results.set(call.id, content);
            subscriber.next({ type: EventType.TOOL_CALL_RESULT, messageId: message.id, toolCallId: call.id, role: "tool", content });
          }
          const unresolved = interrupts.filter(interrupt => !results.has(interrupt.toolCallId ?? interrupt.id));
          if (unresolved.length) {
            subscriber.next({ ...terminal, outcome: { type: "interrupt", interrupts: unresolved } });
            return;
          }
          request = {
            ...request,
            messages:mergeContinuationHistory(messages,[]),
            state,
            resume: interrupts.length ? interrupts.map(interrupt => ({
              interruptId: interrupt.id,
              status: "resolved" as const,
              payload: results.get(interrupt.toolCallId ?? interrupt.id),
            })) : request.resume,
          };
          pending = [];
        }
      };
      void work().then(
        () => subscriber.complete(),
        error => { if (!subscriber.closed) subscriber.error(error); },
      );
      return () => {
        controller.abort();
        subscription?.unsubscribe();
      };
    });
  }
}

/** The SDK reducer starts from agent.messages; seed it with this segment's actual model input. */
class InvocationTransport extends AbstractAgent {
  constructor(private readonly transport: AbstractAgent, input: RunAgentInput) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run(input: RunAgentInput) { return this.transport.run(input); }
}

import { AbstractAgent, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { jsonSchema, streamText, type ModelMessage, type ToolSet } from "ai";
import { Observable } from "rxjs";

export type LocalLanguageModel = LanguageModelV3;
export const PLAN_RUN_COMPLETED = Symbol("plan-run-completed");
export type NativeAgentConfiguration = {
  model: string | LanguageModelV3 | ((input: RunAgentInput, signal: AbortSignal) => LanguageModelV3);
  apiKey?: string;
  prompt?: string;
};
export function resolveLocalModel(model: string | LanguageModelV3, apiKey?: string): LanguageModelV3 {
  if (typeof model !== "string") return model;
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const name = model.slice(slash + 1);
  if (provider === "anthropic") return createAnthropic({ apiKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined })(name);
  if (provider !== "openai") throw new Error(`Unsupported model provider: ${provider}`);
  return createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL || undefined }).responses(name);
}

function modelMessages(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") { result.push({ role: "system", content: String(message.content ?? "") }); continue; }
    if (message.role === "user") {
      const content = typeof message.content === "string" ? message.content : message.content.map((raw) => {
        const part = raw as unknown as Record<string, any>;
        if (part.type === "text") return { type: "text" as const, text: String(part.text ?? "") };
        if ((part.type === "image" || part.type === "document") && part.source) {
          const data = part.source.type === "data" ? Buffer.from(part.source.value, "base64") : new URL(part.source.value);
          return part.type === "image" ? { type: "image" as const, image: data, mediaType: part.source.mimeType } : { type: "file" as const, data, mediaType: part.source.mimeType, filename: part.name };
        }
        throw new Error("Unsupported message attachment.");
      });
      result.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant") {
      const content: any[] = [];
      if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) content.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input: JSON.parse(call.function.arguments || "{}") });
      if (content.length) result.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "tool") {
      const call = messages.flatMap((row) => row.role === "assistant" ? row.toolCalls ?? [] : []).find((row) => row.id === message.toolCallId);
      if (call) result.push({ role: "tool", content: [{ type: "tool-result", toolCallId: message.toolCallId, toolName: call.function.name, output: { type: "text", value: String(message.content ?? "") } }] });
    }
  }
  return result;
}

/** One model segment. All deployment tools are executed by HeadlessToolsMiddleware. */
export class NativeAgent extends AbstractAgent {
  constructor(private readonly config: NativeAgentConfiguration) { super(); }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable(subscriber => {
      const controller = new AbortController();
      let completionReason: unknown;
      const emit = (event: Record<string, unknown>) => subscriber.next(event as BaseEvent);
      const work = async () => {
        emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
        const tools: ToolSet = {};
        for (const tool of input.tools) tools[tool.name] = {
          description: tool.description,
          inputSchema: jsonSchema(tool.parameters as Record<string, any>),
        };
        const calls = new Set<string>();
        const textIds = new Map<string, string>();
        let messageId: string | undefined;
        const assistantId = () => messageId ??= crypto.randomUUID();
        const result = streamText({
          model: typeof this.config.model === "function" ? this.config.model(input, controller.signal) : resolveLocalModel(this.config.model, this.config.apiKey),
          system: [this.config.prompt, ...input.context.map(entry => `${entry.description}: ${entry.value}`)].filter(Boolean).join("\n\n"),
          messages: modelMessages(input.messages),
          tools,
          abortSignal: controller.signal,
          maxRetries: 0,
          providerOptions: { openai: { store: false } },
        });
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "start-step": messageId = undefined; break;
            case "text-start": {
              const id = assistantId(); textIds.set(part.id, id);
              emit({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }); break;
            }
            case "text-delta": emit({ type: "TEXT_MESSAGE_CONTENT", messageId: textIds.get(part.id), delta: part.text }); break;
            case "text-end": emit({ type: "TEXT_MESSAGE_END", messageId: textIds.get(part.id) }); break;
            case "tool-call": {
              if (!calls.has(part.toolCallId)) {
                calls.add(part.toolCallId);
                emit({ type: "TOOL_CALL_START", toolCallId: part.toolCallId, toolCallName: part.toolName, parentMessageId: assistantId() });
              }
              emit({ type: "TOOL_CALL_ARGS", toolCallId: part.toolCallId, delta: JSON.stringify(part.input) });
              emit({ type: "TOOL_CALL_END", toolCallId: part.toolCallId });
              break;
            }
            case "tool-result": emit({ type: "TOOL_CALL_RESULT", messageId: `tool-result:${part.toolCallId}`, toolCallId: part.toolCallId, role: "tool", content: typeof part.output === "string" ? part.output : JSON.stringify(part.output) }); break;
            case "tool-error": throw part.error;
            case "error": throw part.error;
          }
        }
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
      };
      void work().then(() => { completionReason = PLAN_RUN_COMPLETED; subscriber.complete(); }, error => { completionReason = error; if (!subscriber.closed) subscriber.error(error); });
      return () => controller.abort(completionReason);
    });
  }
  clone(): NativeAgent { return new NativeAgent(this.config); }
}

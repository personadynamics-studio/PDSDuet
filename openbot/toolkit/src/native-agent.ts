import { AbstractAgent, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { jsonSchema, stepCountIs, streamText, type ModelMessage, type ToolSet } from "ai";
import { Observable } from "rxjs";

export type LocalLanguageModel = LanguageModelV3;
export type NativeAgentConfiguration = {
  model?: string | LanguageModelV3;
  apiKey?: string;
  prompt?: string;
  tools?: { name: string; description: string; parameters: unknown; execute(args: unknown, context?: { toolCallId?: string; messages?: readonly unknown[] }): Promise<unknown> }[];
  maxSteps?: number;
  type?: "custom";
  factory?: () => AsyncGenerator<unknown>;
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

/** Model and tool execution uses the public AI SDK; the host owns storage and run control. */
export class NativeAgent extends AbstractAgent {
  private active?: AbortController;
  constructor(private readonly config: NativeAgentConfiguration) { super(); }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      this.active = controller;
      const emit = (event: Record<string, unknown>) => subscriber.next(event as BaseEvent);
      const work = async () => {
        if (this.config.factory) { for await (const _ of this.config.factory()) {} return; }
        if (!this.config.model) throw new Error("Model is not configured.");
        emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
        const owned = new Map((this.config.tools ?? []).map((tool) => [tool.name, tool]));
        const definitions = new Map(input.tools.map((tool) => [tool.name, tool]));
        for (const tool of owned.values()) definitions.set(tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> });
        const tools: ToolSet = {};
        const calls = new Set<string>();
        const ids = new Map<string, string>();
        const startCall = (id: string, name: string) => {
          if (calls.has(id)) return;
          calls.add(id);
          emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, parentMessageId: ids.get("message") ?? input.runId });
        };
        for (const tool of definitions.values()) {
          const executor = owned.get(tool.name);
          tools[tool.name] = {
            description: tool.description,
            inputSchema: tool.parameters && typeof tool.parameters === "object" && "safeParse" in tool.parameters ? tool.parameters as any : jsonSchema(tool.parameters as Record<string, any>),
            ...(executor ? { execute: async (args: unknown, options: { toolCallId: string; messages: ModelMessage[] }) => {
              return executor.execute(args, options);
            } } : {}),
          };
        }
        const resumed = (input.resume ?? []).filter((entry)=>!input.messages.some((message)=>message.role==="tool"&&message.toolCallId===entry.interruptId)).map((entry) => ({ id: crypto.randomUUID(), role: "tool" as const, toolCallId: entry.interruptId, content: typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload ?? null) }));
        const result = streamText({
          model: resolveLocalModel(this.config.model, this.config.apiKey),
          system: [this.config.prompt, ...input.context.map((entry) => `${entry.description}: ${entry.value}`)].filter(Boolean).join("\n\n"),
          messages: modelMessages([...input.messages, ...resumed]),
          tools,
          stopWhen: stepCountIs(this.config.maxSteps ?? 8),
          abortSignal: controller.signal,
          maxRetries: 0,
          providerOptions: { openai: { store: false } },
        });
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-start": {
              const id = crypto.randomUUID(); ids.set(part.id, id); ids.set("message", id);
              emit({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }); break;
            }
            case "text-delta": emit({ type: "TEXT_MESSAGE_CONTENT", messageId: ids.get(part.id), delta: part.text }); break;
            case "text-end": emit({ type: "TEXT_MESSAGE_END", messageId: ids.get(part.id) }); break;
            case "tool-call":
              startCall(part.toolCallId, part.toolName);
              emit({ type: "TOOL_CALL_ARGS", toolCallId: part.toolCallId, delta: JSON.stringify(part.input) });
              emit({ type: "TOOL_CALL_END", toolCallId: part.toolCallId });
              break;
            case "tool-result": emit({ type: "TOOL_CALL_RESULT", messageId: crypto.randomUUID(), toolCallId: part.toolCallId, role: "tool", content: typeof part.output === "string" ? part.output : JSON.stringify(part.output) }); break;
            case "tool-error": throw part.error;
            case "error": throw part.error;
          }
        }
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
      };
      void work().then(() => subscriber.complete(), (error) => subscriber.error(error));
      return () => { controller.abort(); if (this.active === controller) this.active = undefined; };
    });
  }
  abortRun(): void { this.active?.abort(); super.abortRun(); }
  clone(): NativeAgent { return new NativeAgent(this.config); }
}

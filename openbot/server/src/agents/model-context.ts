import type { Message, RunAgentInput } from "@ag-ui/client";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export const MAX_CONTEXT_TOKENS = 300_000;
let tokenizer: Tiktoken | undefined;

function tokens(value: unknown): number {
  const text = JSON.stringify(value, (key, entry) => {
    // PDF bytes/URLs are deliberately outside this application context budget.
    if (key === "source" && (entry?.type === "data" || entry?.type === "url") &&
      typeof entry.mimeType === "string" && entry.mimeType.split(";")[0].trim().toLowerCase() === "application/pdf") {
      return { type: entry.type, mimeType: entry.mimeType };
    }
    return entry;
  }) ?? "";
  tokenizer ??= new Tiktoken(o200kBase);
  return tokenizer.encode(text, [], []).length;
}

function messageTokens(message: Message): number {
  return 16 + tokens({
    role: message.role,
    content: "content" in message ? message.content : undefined,
    ...(message.role === "assistant" ? { toolCalls: message.toolCalls } : {}),
    ...(message.role === "tool" ? { toolCallId: message.toolCallId } : {}),
  });
}

/** Keep a recent window of whole turns; never summarize or alter stored history. */
export function limitModelContext(input: RunAgentInput, instructions = ""): RunAgentInput {
  let remaining = MAX_CONTEXT_TOKENS - tokens({ instructions, context: input.context, tools: input.tools });
  const turns: Message[][] = [];
  for (const message of input.messages) {
    if (message.role === "system") {
      remaining -= messageTokens(message);
      continue;
    }
    // A turn includes its assistant/tool records, so a window cannot split their protocol pairs.
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  if (remaining < 0) throw new Error("固定指令及工具定義已超出 300,000 tokens 的上下文上限（PDF 除外）。");

  const kept = new Set<Message>();
  for (let index = turns.length - 1; index >= 0; index--) {
    const size = turns[index].reduce((total, message) => total + messageTokens(message), 0);
    if (size > remaining) {
      if (kept.size === 0) throw new Error("當次訊息及工具結果已超出 300,000 tokens 的上下文上限（PDF 除外），請縮短訊息或減少附件內容。");
      break;
    }
    remaining -= size;
    for (const message of turns[index]) kept.add(message);
  }
  return { ...input, messages: input.messages.filter(message => message.role === "system" || kept.has(message)) };
}

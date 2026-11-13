/**
 * The one filter that keeps a broken conversation from being replayed at a model provider for ever.
 *
 * IT LIVES HERE BECAUSE BOTH TURN PATHS NEED IT. A routine's headless turn seeds history itself
 * (`toolkit/run-turn.ts`) and a chat turn is handed history by the browser (`copilot.ts`). Both
 * hand that history to a `BuiltInAgent`, which converts it and lets the model provider validate the
 * call/result pairing. A module of its own, in the toolkit, so the chat path can use it without
 * importing the headless turn runner.
 */
import type { Message, ToolCall } from "@ag-ui/client";

/** Merge actual calls and decisions into stored history, keeping stored prose authoritative. */
export function mergeContinuationHistory(
  history: readonly Message[],
  snapshot: readonly Message[],
  answers: readonly Message[] = [],
): Message[] {
  const rows = new Map(history.map((message) => [message.id, message]));
  for (const message of [...snapshot, ...answers]) {
    const stored = rows.get(message.id);
    if (stored?.role === "assistant" && message.role === "assistant") {
      rows.set(message.id, {
        ...message,
        ...stored,
        toolCalls: [...new Map([...(stored.toolCalls ?? []), ...(message.toolCalls ?? [])]
          .map((call) => [call.id, call])).values()],
      });
    } else if (!stored && (message.role === "assistant" || message.role === "tool")) {
      rows.set(message.id, message);
    }
  }
  const results = new Map([...rows.values()].flatMap((message) =>
    message.role === "tool" ? [[message.toolCallId, message] as const] : []));
  return [...rows.values()].flatMap((message) => {
    if (message.role === "tool") return [];
    return [message, ...(message.role === "assistant" ? (message.toolCalls ?? [])
      .flatMap((call) => { const result = results.get(call.id); return result ? [result] : []; }) : [])];
  });
}

/** Whether a message said nothing at all — no text, no parts, nothing to show a person. */
function isSilent(message: Message): boolean {
  const content = (message as { content?: unknown }).content;
  if (content === undefined || content === null) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}


export function sanitizeSeededHistory(
  history: Message[],
  answeredElsewhere: ReadonlySet<string> = new Set(),
): Message[] {
  /*
   * Where a call's answer may still land: before the next thing a person said, and before the
   * assistant speaks again.
   *
   * The model API walks the CONVERTED conversation in order and refuses it the moment a user or
   * system message arrives while a call is still unanswered (`ai`'s `MissingToolResultsError`, in
   * `convertToLanguageModelPrompt`). So a result that turns up after a later user message does not
   * answer anything, however real it was. This happened live: a browser tool handler resolved late,
   * its result was appended after the person had already typed the next message, and the call read
   * as answered here while the API still threw on every retry.
   *
   * ONLY A USER ROW IS A BOUNDARY, though the API also stops at a system row. That is because it
   * checks the converted messages, and `BuiltInAgent` drops every `system` and `developer` row on
   * the way there unless `forwardSystemMessages` or `forwardDeveloperMessages` is set, which this
   * deployment never does (`builtInAgentConfiguration` in `copilot.ts`). A skill's instructions
   * arrive as a system row the browser inserts ahead of the person's message, so a call answered
   * after one of those is answered as far as the model call is concerned, and treating the row as
   * a boundary would drop a call the request would have carried fine. If either forwarding flag is
   * ever turned on, that role becomes a boundary here too.
   *
   * A LATER ASSISTANT ROW IS A BOUNDARY TOO. A provider wants a call's result in the very next
   * message: Anthropic refuses "`tool_use` ids were found without `tool_result` blocks immediately
   * after", and OpenAI wants the tool rows straight after the call. Found live, on a conversation
   * where an approval's continuation ran again from an older point: the thread is append-only, so
   * the late run's answer to a call landed dozens of rows after it, behind other turns, and every
   * message the person sent after that was refused with that error in red.
   */
  const boundaryAfter: number[] = new Array(history.length).fill(
    history.length,
  );
  for (
    let index = history.length - 1, next = history.length;
    index >= 0;
    index -= 1
  ) {
    boundaryAfter[index] = next;
    const { role } = history[index] as { role?: string };
    if (role === "user" || role === "assistant") next = index;
  }

  /** Where each call was made: the first assistant row carrying its id. */
  const callAt = new Map<string, number>();
  for (const [index, message] of history.entries()) {
    const { toolCalls } = message as { toolCalls?: ToolCall[] };
    for (const call of toolCalls ?? []) {
      if (!callAt.has(call.id)) callAt.set(call.id, index);
    }
  }
  /*
   * The one position that answers each call: the first result after the call and before the
   * boundary. Recording every position instead would let a result AHEAD of its call survive on
   * the strength of a real answer behind it, and send a `tool` row before any call — the exact
   * shape the browser's `repair-history.ts` treats as misplaced.
   */
  const answerAt = new Map<string, number>();
  for (const [index, message] of history.entries()) {
    const { toolCallId } = message as { toolCallId?: string };
    if (toolCallId === undefined || answerAt.has(toolCallId)) continue;
    const called = callAt.get(toolCallId);
    if (called === undefined || index <= called) continue;
    if (index >= (boundaryAfter[called] ?? history.length)) continue;
    answerAt.set(toolCallId, index);
  }

  const surviving = new Set<string>();
  const kept: (Message | undefined)[] = history.map((message) => {
    const { toolCalls } = message as { toolCalls?: ToolCall[] };
    if (toolCalls === undefined) return message;

    const answered = toolCalls.filter(
      (call) => answeredElsewhere.has(call.id) || answerAt.has(call.id),
    );
    for (const call of answered) surviving.add(call.id);

    // The husk check goes FIRST so it also catches a row that arrived with no calls and nothing
    // said — the same invalid shape, reached without a dangle.
    if (answered.length === 0 && isSilent(message)) return undefined;
    // The healthy path, and the only one that returns the very same object.
    if (answered.length === toolCalls.length) return message;

    /*
     * Cast for the same reason `toAgentMessage` casts: `Message` is a union discriminated on `role`,
     * and a spread over the union widens past every branch of it. Neither rewrite here can change
     * the role or the shape — one narrows the `toolCalls` array, the other removes the key — so
     * there is nothing to narrow against and nothing that could stop being a `Message`.
     */
    if (answered.length > 0) {
      return { ...message, toolCalls: answered } as Message;
    }
    // Text it did say, minus a call it cannot complete.
    const { toolCalls: _dropped, ...rest } = message as Message & {
      toolCalls?: ToolCall[];
    };
    return rest as Message;
  });

  return kept.filter((message, index): message is Message => {
    if (message === undefined) return false;
    const { toolCallId } = message as { toolCallId?: string };
    if (toolCallId === undefined) return true;
    return surviving.has(toolCallId) && answerAt.get(toolCallId) === index;
  });
}

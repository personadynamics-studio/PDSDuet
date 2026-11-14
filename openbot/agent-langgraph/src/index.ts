import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { ChatAnthropic } from "@langchain/anthropic";
import type { AIMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { serve } from "bun";
import { listenPort } from "../../shared/listen-port";
import {
  apiKeyOrPlaceholder,
  baseUrlVariableFor,
  botSettings,
  keyIsRequired,
  keyVariableFor,
  requiresResponsesApi,
} from "../../shared/model-providers";
import { toLangChainMessages } from "./history";
import { readReasoningEffort } from "./model-options";
import { streamRun } from "./stream";

/**
 * The same Bot, on a framework.
 *
 * `agent-bot` is a proof of concept written against a model SDK; this process uses framework integrations while
 * keeping the same AG-UI endpoint contract.
 *
 * A Bot is a registry row pointing at an AG-UI endpoint, so adding a framework does not require
 * server changes.
 *
 * The model API stops being ours. `agent-bot` speaks `/v1/chat/completions` by hand, which is why
 * gpt-5.6 costs it a rewritten streaming loop: those models reject function tools on that endpoint
 * unless reasoning is turned off, and turning reasoning off on a Bot that has to decide when to ask
 * a person for help is the wrong trade. Here it is `useResponsesApi`, one line, because the
 * migration belongs to the people who maintain the integration.
 *
 * The graph produces one model segment. Every tool supplied in input.tools belongs to the
 * server's execution loop, which returns actual results in the next segment's messages.
 */

const PORT = listenPort(process.env.PORT, 4201);


/**
 * Which model drives this Bot, and from whom.
 *
 * The framework integration owns provider-specific HTTP and streaming details. The proof-of-concept Bot
 * speaks one provider's HTTP API
 * directly, so changing provider there means rewriting its streaming loop and its message
 * translation. Here it is a name and a key, because the integrations already exist and are
 * maintained by the people whose API it is.
 *
 * Each provider reads its own key. A deployment that only runs Anthropic never needs an OpenAI key,
 * which is the point of making this configurable rather than assuming one vendor.
 *
 * The default comes from `shared/model-providers.json` — this Bot's `bots.agent-langgraph` row —
 * so the two shipped Bots stay comparable out of the box and every language in the box reads the
 * same decision. Which variable each provider's key and endpoint arrive in is read from the same
 * file's provider rows rather than repeated here.
 *
 * Blank is OpenAI, the reading every other consumer of `BOT_PROVIDER` gives it: the desktop writes
 * an empty provider when switching back to OpenAI, and the server reads empty as OpenAI. An unset
 * environment falls through to the spec row, and when that says openai — as it does today — the
 * two readings are the same. Padded and differently-cased names are the same provider, because a
 * value typed into a setup window arrives with a space on it more often than not. A name nobody
 * has heard of is kept, so the check below can put it in its message. The lookup order is
 * environment over spec file over provider default; see `botSettings`.
 */
const { provider: PROVIDER, model: MODEL } = botSettings("agent-langgraph");
/**
 * OpenAI only. Its newer models require the Responses API, which the integration handles.
 *
 * Inferred from the model rather than left to a separate switch. `gpt-5.6-*` rejects function tools
 * on `/v1/chat/completions`, so a deployment that set `BOT_MODEL` to one and did not also know about
 * this flag got a Bot that started, looked healthy, and failed on its first tool call. The switch is
 * still honoured, so a model the registry has not heard of can be told to use it.
 */
const NEEDS_RESPONSES_API = requiresResponsesApi(MODEL);
const USE_RESPONSES_API =
  process.env.BOT_RESPONSES_API === "true" || NEEDS_RESPONSES_API;
/**
 * Read from the provider registry rather than spelled out here three times, under the names the
 * API server already reads. Sharing the names is the point: one line moves the built-in agents and
 * this Bot together, and a deployment cannot end up with half of itself pointed somewhere else.
 *
 * Unset, this is that provider's own public endpoint. Set, it means any endpoint speaking that API:
 * a gateway in front of several providers, a proxy, or a model on hardware you control. The
 * integration owns the HTTP, so this is a base URL rather than another provider branch, and
 * `BOT_MODEL` is sent verbatim because an endpoint names its own catalogue.
 *
 * Only the provider this Bot was configured for is read, and each branch of `buildModel` below
 * ever took its own and no other, so nothing that used to be visible has changed.
 */
const baseUrlVariable = baseUrlVariableFor(PROVIDER);
const BASE_URL = baseUrlVariable
  ? process.env[baseUrlVariable]?.trim() || undefined
  : undefined;

/**
 * OpenAI only, and Responses API only: how hard this Bot is allowed to think.
 *
 * Checked here rather than sent onward and forgotten. An effort the API does not have is dropped
 * somewhere down the stack, and a Bot that starts, looks healthy and then thinks for as long as it
 * likes is a worse outcome than one that refuses to start and says why.
 */
const { effort: REASONING_EFFORT, problem: REASONING_PROBLEM } =
  readReasoningEffort(process.env.BOT_REASONING_EFFORT);
if (REASONING_PROBLEM) {
  console.error(REASONING_PROBLEM);
  process.exit(1);
}
/*
 * The two ways this setting would reach an API with nowhere to put it.
 *
 * Anthropic and Google express thinking budgets differently, and on `/v1/chat/completions` the
 * field does not exist at all. Refusing is the same call the issue makes about invalid values:
 * configuration that goes nowhere is worse than configuration that is absent, because the Bot looks
 * configured either way. Both messages name the variable that would make it work.
 */
if (REASONING_EFFORT && PROVIDER !== "openai") {
  console.error(
    `BOT_REASONING_EFFORT is OpenAI's setting, and BOT_PROVIDER=${PROVIDER}. Unset it, or set BOT_PROVIDER=openai.`,
  );
  process.exit(1);
}
if (REASONING_EFFORT && !USE_RESPONSES_API) {
  console.error(
    `BOT_REASONING_EFFORT needs the Responses API, and BOT_MODEL=${MODEL} is not being run on it. Use a model that requires it, or set BOT_RESPONSES_API=true.`,
  );
  process.exit(1);
}

/**
 * The key this provider needs, checked at startup rather than on the first run.
 *
 * Refusing to start matches the computer-token posture:
 * a missing key should fail in front of whoever is deploying, not as a conversation that errors in
 * front of somebody trying to use it.
 */
const keyVariable = keyVariableFor(PROVIDER);
if (!keyVariable) {
  console.error(
    `BOT_PROVIDER=${PROVIDER} is not one this Bot knows. Use openai, anthropic or google.`,
  );
  process.exit(1);
}
const API_KEY = process.env[keyVariable]?.trim();
// Unless an endpoint was named to answer instead: see `keyIsRequired`.
if (!API_KEY && keyIsRequired(PROVIDER, BASE_URL)) {
  console.error(
    `${keyVariable} is not set, and BOT_PROVIDER=${PROVIDER} needs it. This Bot cannot answer without a model.`,
  );
  process.exit(1);
}

/**
 * Every tool comes from the caller. This service publishes none of its own, on purpose.
 *
 * Same rule as `agent-bot`: a new capability on the front end needs no change here.
 */
function toBoundTools(input: RunAgentInput) {
  if (!input.tools?.length) return [];
  return input.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * The chat model, from whichever provider this deployment chose.
 *
 * Every one of these binds tools the same way and streams the same way, which is exactly why the
 * rest of this file does not know which one it got.
 */
function buildModel() {
  if (PROVIDER === "anthropic") {
    return new ChatAnthropic({
      model: MODEL,
      apiKey: apiKeyOrPlaceholder(API_KEY),
      streaming: true,
      ...(BASE_URL ? { anthropicApiUrl: BASE_URL } : {}),
    });
  }
  if (PROVIDER === "google") {
    return new ChatGoogleGenerativeAI({
      model: MODEL,
      apiKey: apiKeyOrPlaceholder(API_KEY),
      streaming: true,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    });
  }
  return new ChatOpenAI({
    model: MODEL,
    apiKey: apiKeyOrPlaceholder(API_KEY),
    streaming: true,
    ...(BASE_URL ? { configuration: { baseURL: BASE_URL } } : {}),
    ...(USE_RESPONSES_API ? { useResponsesApi: true } : {}),
    /*
     * `reasoning.effort`, not the `reasoningEffort` convenience field: the integration deprecated
     * the latter in favour of merging it into this object, and one of them is the one that survives.
     */
    ...(REASONING_EFFORT ? { reasoning: { effort: REASONING_EFFORT } } : {}),
  });
}

/** The model emits calls; the server's one tool owner supplies their real results. */
function buildGraph(input: RunAgentInput, signal: AbortSignal) {
  const model = buildModel();
  const tools = toBoundTools(input);
  const bound = tools.length ? model.bindTools(tools) : model;
  const offered = new Set((input.tools ?? []).map(tool => tool.name));
  return new StateGraph(MessagesAnnotation)
    .addNode("answer", async state => ({
      messages: [await bound.invoke(state.messages, { signal })],
    }))
    .addEdge(START, "answer")
    .addConditionalEdges("answer", state => {
      const last = state.messages.at(-1) as AIMessage | undefined;
      if ((last?.tool_calls ?? []).some(call => !offered.has(call.name)))
        throw new Error("The model requested a tool that was not offered for this run.");
      return END;
    })
    .compile();
}

async function runAgent(input: RunAgentInput, requestSignal: AbortSignal): Promise<Response> {
  const encoder = new EventEncoder();
  const cancellation = new AbortController();
  const signal = AbortSignal.any([requestSignal, cancellation.signal]);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) => {
        if (!signal.aborted) controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      };

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      // The graph is built and its event stream opened inside `streamRun`, so a failure doing either
      // is reported as RUN_ERROR through the same path as a failure mid-stream.
      await streamRun(
        async () =>
          buildGraph(input, signal).streamEvents(
            { messages: toLangChainMessages(input, PROVIDER) },
            { version: "v2", signal },
          ),
        input,
        send,
      );

      if (!signal.aborted) controller.close();
    },
    cancel(reason) { cancellation.abort(reason); },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        provider: PROVIDER,
        model: MODEL,
        framework: "langgraph",
        responsesApi: USE_RESPONSES_API,
      });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input, request.signal);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-langgraph listening on http://127.0.0.1:${PORT}/ag-ui`);

/**
 * Mastra as a Bot.
 *
 * Mastra brings its own HTTP server, so unlike the Python harnesses this one is not a FastAPI app
 * with a route bolted on: it is a plain Mastra server, and that is the whole point. Mastra already
 * serves its agents over its own API, and OpenBot dials that API through `@ag-ui/mastra`, the bridge
 * Mastra and AG-UI maintain between them. See `remoteTransport` in server/src/copilot.ts.
 *
 * SO THERE IS NO AG-UI ROUTE HERE, deliberately. An earlier version mounted `registerCopilotKit`
 * from `@ag-ui/mastra/copilotkit`, which serves the CopilotKit Runtime protocol rather than AG-UI:
 * a different wire format that answers a run with a complaint about a missing `method` field. The
 * translation belongs on OpenBot's side, in one place, where every remote Bot is governed the same
 * way — not in each harness.
 */
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { listenPort } from "../../../shared/listen-port";
import {
  apiKeyOrPlaceholder,
  botSettings,
  providerSpec,
} from "../../../shared/model-providers";

/** The providers this Bot can drive: the ones whose SDK modules it loads below. */
const SUPPORTED_PROVIDERS = new Set(["openai", "anthropic"]);

/**
 * The model this Bot answers with, read from the spec file rather than remembered in this file.
 *
 * `shared/model-providers.json` holds this Bot's `bots.agent-mastra` row and the provider facts
 * around it; `BOT_PROVIDER` and `BOT_MODEL` still win over both, as they always have. The file
 * says which providers exist; this file still decides which of them it can drive, because only two
 * SDK modules are loaded here. Both halves refuse at startup: a provider the file has not heard of,
 * and one it has that this harness has no module for, used to fall through to the OpenAI branch
 * below and answer with a model the deployment never chose.
 */
async function buildModel() {
  const settings = botSettings("agent-mastra");
  const providerName = settings.provider;
  const spec = providerSpec(providerName);
  if (!spec) {
    // What to use is what this harness answers on, which is narrower than the registry.
    throw new Error(
      `BOT_PROVIDER=${providerName} is not one this Bot knows. Use ${[...SUPPORTED_PROVIDERS].join(" or ")}.`,
    );
  }
  if (!SUPPORTED_PROVIDERS.has(spec.id)) {
    throw new Error(
      `BOT_PROVIDER=${providerName} names ${spec.label}, and this Bot loads no ${spec.label} module. It answers on OpenAI and Anthropic only.`,
    );
  }
  const model = settings.model;
  const baseVariable = spec.baseUrlVariable;
  const baseURL = process.env[baseVariable]?.trim();
  // Provider modules create default clients at import, which reject Compose's empty overrides.
  if (!baseURL) delete process.env[baseVariable];

  if (spec.id === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    // Other harnesses accept an Anthropic origin; AI SDK expects the /v1 API prefix.
    const origin = (baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
    return createAnthropic({
      baseURL: origin.endsWith("/v1") ? origin : `${origin}/v1`,
    })(model);
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  const compatible =
    Boolean(baseURL) &&
    baseURL?.replace(/\/+$/, "") !== "https://api.openai.com/v1";
  const openai = createOpenAI({
    baseURL: baseURL || "https://api.openai.com/v1",
    apiKey: compatible
      ? apiKeyOrPlaceholder(process.env[spec.keyVariable])
      : undefined,
  });
  // Compatible endpoints commonly expose Chat Completions; OpenAI keeps its Responses default.
  return compatible ? openai.chat(model) : openai(model);
}
const port = listenPort(process.env.PORT, 4213);

export const openbotBaseInstructions =
  "Answer the question you are asked, briefly and correctly.";

const OPENBOT_CONTEXT_DESCRIPTIONS = [
  "OpenBot standing role",
  "OpenBot granted tools guidance",
] as const;

type OpenBotInstructionArgs = {
  requestContext?: {
    get(key: string): unknown;
  };
};

function agUiContextEntries(
  requestContext?: OpenBotInstructionArgs["requestContext"],
) {
  const agUi = requestContext?.get("ag-ui");
  if (
    typeof agUi !== "object" ||
    agUi === null ||
    !("context" in agUi) ||
    !Array.isArray(agUi.context)
  ) {
    return [];
  }
  return agUi.context;
}

export function buildOpenBotInstructions({
  requestContext,
}: OpenBotInstructionArgs = {}) {
  const contextEntries = agUiContextEntries(requestContext);
  const openbotInstructions = OPENBOT_CONTEXT_DESCRIPTIONS.flatMap(
    (description) =>
      contextEntries
        .filter(
          (entry): entry is { description: string; value: string } =>
            typeof entry === "object" &&
            entry !== null &&
            "description" in entry &&
            entry.description === description &&
            "value" in entry &&
            typeof entry.value === "string" &&
            entry.value.trim().length > 0,
        )
        .map((entry) => entry.value.trim()),
  );

  if (openbotInstructions.length === 0) return openbotBaseInstructions;
  return [openbotBaseInstructions, ...openbotInstructions].join("\n\n");
}

const openbot = new Agent({
  id: "openbot",
  name: "openbot",
  instructions: buildOpenBotInstructions,
  model: await buildModel(),
});

export const mastra = new Mastra({
  agents: { openbot },
  server: {
    port: port,
    host: "0.0.0.0",
    apiRoutes: [
      registerApiRoute("/health", {
        method: "GET",
        handler: async (context) =>
          context.json({ ok: true, harness: "mastra" }),
      }),
    ],
  },
});

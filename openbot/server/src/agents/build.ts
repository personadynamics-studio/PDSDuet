import { type AbstractAgent, HttpAgent, type Message, type RunAgentInput } from "@ag-ui/client";
import { CloningRemoteAgent, UnavailableAgent } from "@openbot/toolkit/agents";
import { NativeAgent, type NativeAgentConfiguration } from "@openbot/toolkit/native-agent";
import { PROVENANCE_GUIDANCE } from "@openbot/shared/bot-prompt";
import { defaultModelFor } from "@openbot/shared/model-providers";
import { from, switchMap } from "rxjs";
import { PlanModel, type PlanModelConfig, planModelForEnvironment } from "./plan-model";
import type { AgentActor } from "./profile-types";
import { attachmentIdsIn, newInlineBudget, resolveAttachmentParts, type StoredAttachment } from "../channels/attachment-parts";
import type { AgentFetch } from "../channels/stall-guard";
import { UNTRUSTED_GUIDANCE } from "../untrusted-content";
import { limitModelContext } from "./model-context";

type RegisteredBuiltInAgent = { id: string; name: string; type: "built_in"; systemPrompt: string };
type RegisteredRemoteAgent = {
  id: string; name: string; type: "remote_ag_ui" | "remote_mastra";
  endpoint: string; remoteAgentId?: string; headers?: Record<string, string>;
  standingMessage: StandingRoleMessage;
};
export type RegisteredAgent = RegisteredBuiltInAgent | RegisteredRemoteAgent | { id: string; name: string; type: "unavailable"; reason: string };
export type StandingRoleMessage = Extract<Message, { role: "system" }>;
export type AgentStandingProfile = { id: string; name: string; title: string; roleDescription: string };
export type RuntimeModel = { provider: "openai" | "anthropic"; defaultModel: string; plan?: PlanModelConfig };
export type LoadAgentsForActor = (actor: AgentActor, botId?: string) => Promise<RegisteredAgent[]>;
export function standingRoleMessage(
  profile: AgentStandingProfile,
): StandingRoleMessage {
  return {
    id: `standing-role:${profile.id}`,
    role: "system",
    content: [
      `You are the Bot ${profile.name}, ${profile.title}. Your Bot ID is ${profile.id}.`,
      profile.roleDescription,
      "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
      
      PROVENANCE_GUIDANCE,
      // And for the same reason, how to read the untrusted-content envelope its tool results carry.
      UNTRUSTED_GUIDANCE,
    ].join("\n\n"),
  };
}

export function normalizeModelBaseUrls(
  environment: Record<string, string | undefined> = process.env,
): void {
  for (const key of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) {
    const value = environment[key]?.trim();
    if (!value) {
      delete environment[key];
    } else if (key === "ANTHROPIC_BASE_URL") {
      // The SDK appends only /messages; match the selector's versioned-base contract.
      const base = value.replace(/\/+$/, "");
      environment[key] = /\/v\d+$/.test(base) ? base : `${base}/v1`;
    } else {
      environment[key] = value;
    }
  }
}


const BUILT_IN_OPENAI_FALLBACK_MODEL = "gpt-5.6-terra";

export function runtimeModelForEnvironment(
  packageModel: RuntimeModel,
  environment: Record<string, string | undefined> = process.env,
): RuntimeModel {
  const selectedModel = environment.BOT_MODEL?.trim();
  const selectedProvider = environment.BOT_PROVIDER?.trim().toLowerCase();
  // The desktop writes an empty provider when switching back to OpenAI. An absent
  // choice leaves the tenant package authoritative.
  const provider =
    selectedProvider === "anthropic"
      ? "anthropic"
      : selectedProvider === "openai" || selectedProvider === ""
        ? "openai"
        : packageModel.provider;
  const defaultModel =
    provider === packageModel.provider
      ? packageModel.defaultModel
      : provider === "anthropic"
        ? defaultModelFor("anthropic")
        : BUILT_IN_OPENAI_FALLBACK_MODEL;
  const selectedModelApplies =
    provider === "anthropic" ||
    ((!selectedProvider || selectedProvider === "openai") &&
      !!environment.OPENAI_BASE_URL?.trim());
  return {
    provider,
    plan: planModelForEnvironment(environment),
    defaultModel:
      selectedModelApplies && selectedModel ? selectedModel : defaultModel,
  };
}

type RuntimeAgentRow = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration: unknown;
  title: string;
  roleDescription: string;
};

export function registeredAgentFromRow(
  row: RuntimeAgentRow,
): RegisteredAgent | null {
  if (!isPlainObject(row.configuration)) {
    return null;
  }
  const configuration = row.configuration;
  if (row.type === "built_in") {
    const systemPrompt = configuration?.systemPrompt;
    const trimmedSystemPrompt =
      typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    return trimmedSystemPrompt.length > 0
      ? {
          id: row.id,
          name: row.name,
          type: "built_in",
          systemPrompt: trimmedSystemPrompt,
        }
      : null;
  }

  const endpoint = configuration?.endpoint;
  
  const remoteAgentId = configuration?.remoteAgentId;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: row.type === "remote_mastra" ? "remote_mastra" : "remote_ag_ui",
        endpoint,
        ...(typeof remoteAgentId === "string" && remoteAgentId.length > 0
          ? { remoteAgentId }
          : {}),
        standingMessage: standingRoleMessage(row),
      }
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}


export function standingInstructionsGuidance(
  instructions: string | null | undefined,
): string | null {
  const trimmed = instructions?.trim() ?? "";
  if (trimmed.length === 0) return null;

  return [
    `The person you are working with has standing instructions that apply in every channel and every task, alongside your role: ${trimmed}`,
    "Where the two conflict, the role decides what you do and these decide how you do it.",
  ].join("\n\n");
}

export type LoadInstructions = () => Promise<string | null>;


export type LoadAttachment = (
  id: string,
  threadId: string,
) => Promise<StoredAttachment | null>;


export type MarkAttachmentsSent = (
  ids: readonly string[],
  
  threadId: string,
) => Promise<void>;


async function inlineAttachments(
  messages: Message[],
  load: LoadAttachment | undefined,
  
  threadId: string,
  markSent?: MarkAttachmentsSent,
): Promise<Message[]> {
  const asked = messages.reduce(
    (latest, message, index) => (message.role === "user" ? index : latest),
    -1,
  );
  const budget = newInlineBudget();
  const inlined = [...messages];
  
  let sentIds: readonly string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    let content = message.content;
    if (index !== asked && Array.isArray(content)) {
      // Historical file bodies never reach a later turn, including inline images and PDFs.
      content = content.map(part => part.type === "text" && attachmentIdsIn([part]).length === 0
        ? part
        : { type: "text" as const, text: "[Attachment from an earlier message omitted. Attach the file again to read it.]" });
    } else if (index === asked && load) {
      content = await resolveAttachmentParts(content, id => load(id, threadId), "fail", budget) as typeof message.content;
    }
    
    if (index === asked && markSent) {
      sentIds = attachmentIdsIn(message.content);
    }
    if (content !== message.content) {
      inlined[index] = { ...message, content } as Message;
    }
  }
  if (markSent && sentIds.length > 0) {
    await markSent(sentIds, threadId);
  }
  return inlined;
}

export type AgentBuildOptions = {
  model: RuntimeModel;
  apiKey: string | null;
  computerGuidance?: string;
  loadInstructions?: LoadInstructions;
  loadAttachment?: LoadAttachment;
  markAttachmentsSent?: MarkAttachmentsSent;
  agentFetch?: AgentFetch;
};

/** Agent construction supplies the model and real transport boundaries. Execution supplies every tool. */
export async function buildAgent(agent: RegisteredAgent, options: AgentBuildOptions): Promise<AbstractAgent> {
  if (agent.type === "unavailable") return new UnavailableAgent(agent);
  if (agent.type !== "built_in") {
    const remote = await remoteTransport(agent, options.agentFetch);
    return new CloningRemoteAgent(remote, target => {
      target.use((input, next) => {
        const instructions: Message[] = input.context.map((entry, index) => ({
          id: `model-context:${agent.id}:${input.runId}:${index}`,
          role: "system",
          content: `${entry.description}: ${entry.value}`,
        }));
        const messages = [agent.standingMessage, ...instructions, ...input.messages.filter(message => message.id !== agent.standingMessage.id)];
        return from(inlineAttachments(messages, options.loadAttachment, input.threadId, options.markAttachmentsSent))
          .pipe(switchMap(messages => next.run({ ...input, messages, context: [] })));
      });
    }, limitModelContext);
  }
  if (!options.apiKey && !options.model.plan) throw new Error(`Model credential is not configured for ${agent.name}.`);
  const standing = standingInstructionsGuidance(await options.loadInstructions?.());
  const plan = options.model.plan;
  const prompt = [`You are the Bot ${agent.name}. Your Bot ID is ${agent.id}.`, agent.systemPrompt, standing, PROVENANCE_GUIDANCE, UNTRUSTED_GUIDANCE, options.computerGuidance].filter(Boolean).join("\n\n");
  const configuration: NativeAgentConfiguration = {
    model: plan ? (input, signal) => new PlanModel(plan, agent.id, input, new Set(input.tools.map(tool => tool.name)), signal) : `${options.model.provider}/${options.model.defaultModel}`,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    prompt,
    prepareInput: input => limitModelContext(input, prompt),
  };
  const built = new NativeAgent(configuration);
  const load = options.loadAttachment;
  built.use((input, next) => from(inlineAttachments(input.messages, load, input.threadId, options.markAttachmentsSent))
    .pipe(switchMap(messages => next.run({ ...input, messages }))));
  built.agentId = agent.id;
  built.description = agent.name;
  return built;
}

type MastraClientForBridge = Parameters<typeof import("@ag-ui/mastra").getRemoteAgents>[0]["mastraClient"];
async function remoteTransport(agent: RegisteredRemoteAgent, agentFetch?: AgentFetch): Promise<AbstractAgent> {
  if (agent.type === "remote_ag_ui") return new HttpAgent({
    url: agent.endpoint, agentId: agent.id,
    ...(agent.headers ? { headers: agent.headers } : {}),
    ...(agentFetch ? { fetch: agentFetch } : {}),
  });
  const [{ MastraClient }, { getRemoteAgents }] = await Promise.all([import("@mastra/client-js"), import("@ag-ui/mastra")]);
  const client = new MastraClient({ baseUrl: agent.endpoint, ...(agent.headers ? { headers: agent.headers } : {}), ...(agentFetch ? { fetch: agentFetch as unknown as typeof fetch } : {}) });
  const roster = await getRemoteAgents({ mastraClient: client as unknown as MastraClientForBridge, resourceId: agent.id });
  return roster[pickFromRoster(Object.keys(roster), agent)] as AbstractAgent;
}
export function pickFromRoster(served: readonly string[], agent: { id: string; remoteAgentId?: string }): string {
  const wanted = agent.remoteAgentId ?? agent.id;
  if (served.includes(wanted)) return wanted;
  if (!agent.remoteAgentId && served.length === 1) return served[0]!;
  throw new Error(`The endpoint does not serve the selected agent ${wanted}.`);
}

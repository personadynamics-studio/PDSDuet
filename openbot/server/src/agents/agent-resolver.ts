import type { AbstractAgent } from "@ag-ui/client";
import type { AuditInitiator } from "../audit";
import type { AgentFetch } from "../channels/stall-guard";
import { buildAgent, type LoadAgentsForActor, type LoadAttachment, type LoadInstructions, type MarkAttachmentsSent, type RuntimeModel } from "./build";
import type { AgentActor } from "./profile-types";

export type AgentResolutionContext = { initiator?: AuditInitiator };
export class CoworkerUnavailableError extends Error {}
export type ActorAgentResolver = {
  resolveAgentForActor(actor: AgentActor, agentId: string, context?: AgentResolutionContext): Promise<AbstractAgent>;
};
export type ActorAgentResolverDependencies = {
  loadAgents: LoadAgentsForActor;
  model: RuntimeModel;
  resolveModelApiKey(): Promise<string | null>;
  computerGuidance?: string;
  agentFetch?: AgentFetch;
  loadInstructionsForActor?: (actorId: string) => LoadInstructions;
  loadAttachmentForActor?: (actorId: string) => LoadAttachment;
  markAttachmentsSentForActor?: (actorId: string) => MarkAttachmentsSent;
};

export function createActorAgentResolver(deps: ActorAgentResolverDependencies): ActorAgentResolver {
  return {
    async resolveAgentForActor(actor, agentId) {
      const agent = (await deps.loadAgents(actor, agentId)).find(agent => agent.id === agentId);
      if (!agent) throw new CoworkerUnavailableError(`Coworker ${agentId} is unavailable.`);
      return buildAgent(agent, {
        model: deps.model,
        apiKey: agent.type === "built_in" && !deps.model.plan ? await deps.resolveModelApiKey() : null,
        computerGuidance: deps.computerGuidance,
        agentFetch: deps.agentFetch,
        loadInstructions: deps.loadInstructionsForActor?.(actor.id),
        loadAttachment: deps.loadAttachmentForActor?.(actor.id),
        markAttachmentsSent: deps.markAttachmentsSentForActor?.(actor.id),
      });
    },
  };
}

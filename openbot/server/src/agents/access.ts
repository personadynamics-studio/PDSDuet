import { type SQL, sql } from "drizzle-orm";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import { teamBotAccess } from "../team-bots/access";
import type { AgentActor } from "./profile-types";

export function managedBy(actor: AgentActor): SQL {
  return actor.role === "admin"
    ? sql`true`
    : sql`${agentProfiles.ownerUserId} = ${actor.id}`;
}

/** A private Team Bot's publication shares its work, not its signed-in browser. */
export function computerAccessibleTo(actor: AgentActor): SQL {
  return sql`(${managedBy(actor)} or ${agentProfiles.visibility} = 'public')`;
}

export function visibleTo(actor: AgentActor): SQL {
  return sql`(${computerAccessibleTo(actor)} or ${teamBotAccess(actor.id, agents.id)})`;
}

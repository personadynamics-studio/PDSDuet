import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

/** Features recorded by historical default opt-outs. */
export type DefaultFeature = "memory_source" | "proactive_research";

/**
 * Persisted opt-outs for earlier memory sources and background research.
 * `scope` is the source app's server id, or empty for research on a person and Bot.
 */
export const defaultOptOuts = pgTable(
  "default_opt_outs",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    feature: text("feature").$type<DefaultFeature>().notNull(),
    scope: text("scope").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerUserId, table.agentId, table.feature, table.scope],
    }),
    check(
      "default_opt_outs_feature_check",
      sql`${table.feature} IN ('memory_source', 'proactive_research')`,
    ),
  ],
);

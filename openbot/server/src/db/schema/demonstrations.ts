import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";
type DemonstrationAction = {
  kind: "click" | "type" | "key" | "scroll";
  url: string;
  target: { role: string; name: string; sensitive: boolean };
  key?: "Enter" | "Tab" | "Escape" | "Backspace" | "Delete" | "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageDown" | "PageUp";
  deltaY?: number;
};
type DemonstrationDraft = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  tools: string[];
  requiredTools: string[];
  sourceRecordingId: string;
};

export const demonstrations = pgTable(
  "demonstrations",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status")
      .$type<"recording" | "stopped" | "drafted" | "published">()
      .notNull()
      .default("recording"),
    actions: jsonb("actions")
      .$type<DemonstrationAction[]>()
      .notNull()
      .default([]),
    draft: jsonb("draft").$type<DemonstrationDraft>(),
    skillSlug: text("skill_slug"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("demonstrations_owner_idx").on(table.ownerUserId, table.createdAt),
    uniqueIndex("demonstrations_active_bot_idx")
      .on(table.botId)
      .where(sql`${table.status} = 'recording'`),
  ],
);

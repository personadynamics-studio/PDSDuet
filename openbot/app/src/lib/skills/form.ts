import { z } from "zod";
import { RESEARCH_ROLES } from "@openbot/shared/research";

/**
 * The four things a person decides about a skill.
 *
 * THE LIMITS MATCH THE SERVER'S PARSER EXACTLY, so a form that submits is a form that will be
 * accepted, and a rejection is shown next to the field that caused it rather than as a failed
 * request with a sentence at the top of the page.
 *
 * The slug pattern is `routes.ts`'s, character for character: lower-case letters, digits and
 * hyphens, starting and ending on an alphanumeric, 2 to 40 long. Loosening it here would only move
 * the refusal later, to a place where it reads as the save being broken.
 */
export const skillFormSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "請填寫指令。")
    .regex(
      /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/,
      "請使用小寫英文字母、數字及連字號，長度為 2 至 40 個字元。",
    ),
  title: z
    .string()
    .trim()
    .min(1, "請填寫標題。")
    .max(120, "標題不得超過 120 個字元。"),
  /** Optional on the server too, which is why there is no minimum here. */
  summary: z
    .string()
    .trim()
    .max(200, "簡介不得超過 200 個字元。"),
  instructions: z
    .string()
    .trim()
    .min(1, "請填寫機械人須遵循的指示。"),
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * No minimum, and no validation of the refs themselves. A skill needing no tool is ordinary — most
   * are prose — and the server already refuses a ref it has never seen with a sentence naming it,
   * which is a better answer than anything this file could reconstruct about which tools exist.
   *
   * Part of the form rather than saved on press, unlike granting. What a skill needs is the author's
   * draft until they save it, so unticking one and closing the panel has to change nothing.
   */
  tools: z.array(z.string()),
});

export type SkillFormValues = z.infer<typeof skillFormSchema>;

export const emptySkillForm: SkillFormValues = {
  slug: "",
  title: "",
  summary: "",
  instructions: "",
  tools: [],
};

/**
 * The declared refs no connected server offers.
 *
 * WHY THIS EXISTS. The picker draws the tools of the servers this deployment has connected, and a
 * skill's declared set is not confined to those: a package ships skills declaring tools for
 * connectors nobody has added yet, and a person's own skill outlives the server it was written
 * against. Rendering only what matched meant the screen showed a subset of the declaration and
 * presented it as the whole thing — a skill needing two tools drew one, and nothing said the other
 * was there. Editing it silently kept a tool the author had just been shown they did not have.
 *
 * A wrong number on a screen somebody governs with is worse than no number, so the leftovers are
 * named rather than dropped. They are not an error: a ref for a connector that does not exist here
 * loads nothing, because the offer is intersected with the Bot's grants.
 */
export function undeclaredElsewhere(
  selected: readonly string[],
  offered: readonly string[],
): string[] {
  const known = new Set([
    ...offered,
    ...RESEARCH_ROLES.map((role) => role.ref),
  ]);
  return selected.filter((ref) => !known.has(ref));
}

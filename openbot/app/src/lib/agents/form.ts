import { z } from "zod";
import type { AgentProfile } from "./queries";

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "請填寫名稱。")
    .max(80, "名稱不得超過 80 個字元。"),
  title: z
    .string()
    .trim()
    .min(1, "請填寫職稱。")
    .max(120, "職稱不得超過 120 個字元。"),
  roleDescription: z
    .string()
    .trim()
    .max(4000, "工作內容不得超過 4000 個字元。"),
  visibility: z.enum(["public", "private"]),
  /**
   * The explicit remote AG-UI endpoint. Empty selects the Native runtime with the supplied role.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "請輸入以 http:// 或 https:// 開頭的網址。",
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
}).superRefine((values, context) => {
  if (!values.endpoint && !values.roleDescription) context.addIssue({ code: "custom", path: ["roleDescription"], message: "原生機械人需要你填寫角色指令。" });
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
};

/** Convert form values to API input; omit an empty key so editing preserves the current credential. */
export function agentInputFrom(values: AgentFormValues) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    visibility: values.visibility,
    endpoint: values.endpoint,
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
  };
}

/** Keep the current Bot's real role and endpoint when editing other profile fields. */
export function profileUpdateInput(
  profile: AgentProfile,
  patch: Partial<AgentFormValues>,
) {
  return agentInputFrom({
    name: profile.name,
    title: profile.title,
    roleDescription: profile.roleDescription,
    visibility: profile.visibility,
    endpoint: profile.builtIn ? "" : (profile.endpoint ?? ""),
    authValue: "",
    ...patch,
  });
}

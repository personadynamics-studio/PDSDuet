import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The setup checklist, as the server decided it for the person asking. See
 * server/src/openduet/setup.ts.
 *
 * Every sentence and every fix comes from the server, already shaped for its reader: an admin is
 * told which page to open or which variable to set, and a member is told only that it is configured or that
 * their admin sets it up. The browser draws what it is given and never decides who may see a fix.
 * Nothing on it is a secret's value: a key is reported as there or not there.
 */
export type SetupRowId =
  | "model"
  | "google"
  | "gmail"
  | "computer"
  | "apps"
  | "chat";

export type SetupFix =
  | {
      kind: "env";
      names: string[];
      docsUrl: string;
      page?: { label: string; path: string };
    }
  | { kind: "page"; label: string; path: string; docsUrl?: string }
  | { kind: "connect"; serverId: string };

/**
 * `ready` means the required configuration is present. `needs_setup` means something is missing.
 */
export type SetupStatus = "ready" | "needs_setup";

export type SetupRow = {
  id: SetupRowId;
  /** A deployment row is an admin's to set up; a person row is the reader's own. */
  scope: "deployment" | "person";
  title: string;
  /** True only where the product cannot answer without it. */
  required: boolean;
  status: SetupStatus;
  /** `status === "ready"`. */
  ready: boolean;
  /** Which configuration is present, or what remains to be configured. */
  detail: string;
  fix: SetupFix | null;
};

export type SetupChecklist = {
  audience: "admin" | "member";
  rows: SetupRow[];
};

export const setupKeys = {
  all: ["setup"] as const,
  checklist: () => ["setup", "checklist"] as const,
};

export function setupChecklistQueryOptions() {
  return queryOptions({
    queryKey: setupKeys.checklist(),
    queryFn: (): Promise<SetupChecklist> =>
      client("/api/openduet/setup", "checklist", {
        fallback: "Couldn't read your setup.",
      }),
  });
}

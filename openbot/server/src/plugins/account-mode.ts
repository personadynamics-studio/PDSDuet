import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type AccountMode,
  type Holder,
  mintDeploymentVendorUserId,
} from "./shared-accounts";
import { exposureOf, type SharedUseApproval } from "./shared-use";
import type { SharedUseStore } from "./shared-use-store";
import type { PluginStore } from "./store";

export type AccountModePreview = {
  mode: AccountMode;
  wouldRevoke: { holder: Holder; count: number };
  bots: { botId: string; exposure: SharedUseApproval }[];
};
export type AccountModeResult =
  | { changed: false; preview: AccountModePreview }
  | { changed: true; revoked: number }
  | { changed: false; failures: { account: string; error: string }[] };

/**
 * Personal ⇄ Shared, as one decision an administrator makes once.
 *
 * NOTHING CHANGES UNTIL EVERY OLD ACCOUNT IS ENDED AT THE VENDOR. A switch that half-happened would
 * leave people's mailboxes attached to an app that no longer reaches them, or a team account
 * attached to an app that no longer uses it — standing grants nothing on screen accounts for. So a
 * failed revoke leaves the mode alone; the rows of accounts that WERE ended are removed, because a
 * row here claiming an account the vendor no longer holds is the other way to lie.
 */
export function createAccountModeSwitch(deps: {
  store: PluginStore;
  sharedUse: SharedUseStore;
  deploymentId: string;
  audit: AuditStore;
}) {
  const { store, sharedUse } = deps;

  async function preview(
    appId: string,
    mode: AccountMode,
  ): Promise<AccountModePreview> {
    const on = await store.accountsOn(appId);
    const leaving: Holder = mode === "shared" ? "person" : "deployment";
    const bots =
      mode === "shared"
        ? await Promise.all(
            (await sharedUse.botsHolding(appId)).map(async (botId) => ({
              botId,
              exposure: exposureOf(await sharedUse.botFacts(botId)),
            })),
          )
        : [];
    return {
      mode,
      wouldRevoke: {
        holder: leaving,
        count: (on?.accounts ?? []).filter(
          (account) => account.holder === leaving,
        ).length,
      },
      bots,
    };
  }

  /** Save the current Bot audience the administrator approved for the shared account. */
  async function ensureShared(input: {
    appId: string;
    bots: AccountModePreview["bots"];
    approvals: Record<string, SharedUseApproval> | undefined;
    by: string;
    overwrite: boolean;
  }): Promise<number> {
    let made = 0;
    for (const bot of input.bots) {
      if (
        !input.overwrite &&
        (await sharedUse.approvalFor(bot.botId, input.appId))
      ) {
        continue;
      }
      await sharedUse.setApproval({
        botId: bot.botId,
        serverId: input.appId,
        by: input.by,
        approval: input.approvals?.[bot.botId] ?? bot.exposure,
      });
      made += 1;
    }
    return made;
  }

  async function switchMode(input: {
    serverId: string;
    mode: AccountMode;
    by: string;
    confirm: boolean;
    approvals?: Record<string, SharedUseApproval>;
  }): Promise<AccountModeResult> {
    /*
     * THE APP, NOT THE DIALLED ROW. Several rows may name one app, and the gate reads the mode and
     * the approvals off the answering row alone — so a switch dialled through a duplicate writes
     * there, keys approvals there and names its rule after it, or it would be a switch nobody reads.
     */
    const appId = await sharedUse.appIdOf(input.serverId);
    const planned = await preview(appId, input.mode);
    if (!input.confirm) return { changed: false, preview: planned };

    if ((await store.serverAddress(appId))?.accountMode === input.mode) {
      if (input.mode === "shared") {
        const repaired = await ensureShared({
          appId,
          bots: planned.bots,
          approvals: input.approvals,
          by: input.by,
          overwrite: false,
        });
        if (repaired > 0) {
          await recordAuditEvent(deps.audit, {
            eventType: "mcp.account_mode_changed",
            targetType: "mcp_server",
            targetId: appId,
            actorUserId: input.by,
            payload: { server: appId, mode: input.mode, repaired },
          });
        }
      } else {
        await sharedUse.deleteApprovalsFor(appId);
      }
      return { changed: true, revoked: 0 };
    }

    const on = await store.accountsOn(appId);
    if (!on) throw new Error(`${input.serverId} is not a brokered app.`);
    const leaving = on.accounts.filter(
      (account) => account.holder === planned.wouldRevoke.holder,
    );
    const failures: { account: string; error: string }[] = [];
    for (const account of leaving) {
      try {
        await store.disconnectBrokered({
          toolkit: on.toolkit,
          account,
          by: input.by,
          reason: "mode_switched",
        });
      } catch (error) {
        failures.push({
          account: account.vendorUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length > 0) return { changed: false, failures };

    if (input.mode === "shared") {
      await ensureShared({
        appId,
        bots: planned.bots,
        approvals: input.approvals,
        by: input.by,
        overwrite: true,
      });
      await store.setAccountModeColumns(
        appId,
        "shared",
        mintDeploymentVendorUserId(deps.deploymentId),
      );
    } else {
      await store.setAccountModeColumns(appId, "personal", null);
      await sharedUse.deleteApprovalsFor(appId);
    }
    await recordAuditEvent(deps.audit, {
      eventType: "mcp.account_mode_changed",
      targetType: "mcp_server",
      targetId: appId,
      actorUserId: input.by,
      payload: {
        server: appId,
        mode: input.mode,
        revoked: leaving.length,
        bots: planned.bots.length,
      },
    });
    return { changed: true, revoked: leaving.length };
  }

  return { switchMode };
}

export type AccountModeSwitch = ReturnType<typeof createAccountModeSwitch>;

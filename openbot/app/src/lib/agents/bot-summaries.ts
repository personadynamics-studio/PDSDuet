/**
 * The current answer each "Settings for this Bot" row states, computed from its query on every
 * render so it updates itself when the page behind it changes something.
 */

import { appConfig } from "@/lib/generated/application-config";

export function countLabel(
  count: number,
  one: string,
  many: string,
  none: string,
): string {
  if (count === 0) return none;
  return `${count} ${count === 1 ? one : many}`;
}

export function accessSummary(skills: number, apps: number): string {
  const parts = [
    skills ? countLabel(skills, "項技能", "項技能", "") : "",
    apps ? countLabel(apps, "個應用程式", "個應用程式", "") : "",
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "尚未授予權限";
}

/**
 * Who else can use it. Publishing and visibility are separate records: a public Bot nobody published
 * is still open to everyone in the deployment.
 */
export function sharingSummary(
  published: { audience: "team" | "people" } | undefined,
  visibility: "public" | "private",
): string {
  if (!published) {
    return visibility === "public" ? "所有人（公開）" : "尚未共用";
  }
  return published.audience === "team"
    ? "整個團隊"
    : "指定成員及群組";
}

export function setupSummary(agent: {
  builtIn: boolean;
  endpoint: string | null;
}): string {
  if (agent.builtIn || !agent.endpoint) return "內置";
  try {
    return new URL(agent.endpoint).host;
  } catch {
    return agent.endpoint;
  }
}

const TRANSPORT_LABEL: Record<string, string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  sms: "短訊",
};

/** Where this Bot's conversations continue outside OpenBot, each place once. */
export function reachSummary(transports: readonly string[]): string {
  const places = [...new Set(transports)]
    .map((transport) => TRANSPORT_LABEL[transport] ?? transport)
    .sort((a, b) => a.localeCompare(b));
  return places.length
    ? places.join("、")
    : `只在 ${appConfig.brand.productName} 內使用`;
}

/** The apps feeding this Bot facts, and whether it researches in the background. */
export function memorySummary(sources: number, research: boolean): string {
  const parts = [
    sources ? countLabel(sources, "個來源", "個來源", "") : "",
    research
      ? sources
        ? "已開啟背景資料搜尋"
        : "已開啟背景資料搜尋"
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "尚未連接";
}

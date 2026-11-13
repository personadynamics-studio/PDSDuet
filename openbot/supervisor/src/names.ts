export const DEFAULT_NAMESPACE = "openbot";
export const NAMESPACE = process.env.COMPUTER_NAMESPACE?.trim() || DEFAULT_NAMESPACE;
export const OWNER_LABEL = "openbot.supervisor";
export const BOT_LABEL = "openbot.bot-id";
export const NAMESPACE_LABEL = "openbot.namespace";

export type ComputerNames = {
  botId: string;
  container: string;
  profileVolume: string;
  workspaceVolume: string;
};

export function namesFor(botId: string): ComputerNames {
  return {
    botId,
    container: `${NAMESPACE}-computer-${botId}`,
    profileVolume: `${NAMESPACE}-profile-${botId}`,
    workspaceVolume: `${NAMESPACE}-workspace-${botId}`,
  };
}

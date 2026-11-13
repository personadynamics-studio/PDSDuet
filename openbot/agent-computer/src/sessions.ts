import { type Control, createControl } from "./control";
import { createViewerSlot, type ViewerSlot } from "./viewer";

export type BotSession = { control: Control; viewer: ViewerSlot };

export function createSessions() {
  const sessions = new Map<string, BotSession>();
  return {
    for(botId: string): BotSession {
      let session = sessions.get(botId);
      if (!session) {
        session = { control: createControl(), viewer: createViewerSlot() };
        sessions.set(botId, session);
      }
      return session;
    },
    get(botId: string): BotSession | undefined { return sessions.get(botId); },
  };
}

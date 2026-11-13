import type { Screencast } from "./screencast";

type Entry = { notify: (reason: string) => void; cast?: Screencast; cancelFollow?: () => void };
export type ViewerSlot = ReturnType<typeof createViewerSlot>;

export function createViewerSlot() {
  const screens = new Map<unknown, Entry>();
  async function stop(entry: Entry, reason?: string) {
    entry.cancelFollow?.();
    if (reason) entry.notify(reason);
    await entry.cast?.stop();
  }
  return {
    claim(socket: unknown, notify: (reason: string) => void) {
      const entry: Entry = { notify };
      screens.set(socket, entry);
      return {
        async install(cast: Screencast): Promise<void> {
          const previous = entry.cast;
          entry.cast = cast;
          await previous?.stop();
        },
        setFollow(cancel: () => void): void { entry.cancelFollow = cancel; },
      };
    },
    castFor(socket: unknown): Screencast { return screens.get(socket)!.cast!; },
    async release(socket: unknown): Promise<void> {
      const entry = screens.get(socket);
      screens.delete(socket);
      if (entry) await stop(entry);
    },
    async releaseAll(reason: string): Promise<void> {
      const entries = [...screens.values()];
      screens.clear();
      await Promise.all(entries.map((entry) => stop(entry, reason)));
    },
  };
}

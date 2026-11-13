export type ProfileEntry = { name: string; isDirectory: () => boolean };
export function botIdsIn(entries: readonly ProfileEntry[]): string[] {
  return [...new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))].sort();
}

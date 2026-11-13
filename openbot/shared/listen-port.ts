export function listenPort(raw: string | undefined, fallback: number): number {
  return raw?.trim() ? Number(raw) : fallback;
}

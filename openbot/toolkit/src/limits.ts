/** Shared bound for scheduled work expiry and background turn deadlines. */
export const TURN_LIMITS = {
  turnTimeoutMs: 5 * 60_000,
} as const;

/** Lease lifetime shared by local execution and handoff renewal. */
export const THREAD_LOCK_TTL_SECONDS = 120;

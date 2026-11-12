/**
 * Joining a channel's durable thread, bounded, and OVER when it says it is over.
 *
 * THE DEADLINE ENDS THE CONNECT RATHER THAN OUTRUNNING IT: one left in flight is torn down by the
 * next run, and ends by replacing the agent's messages — losing anything added in between.
 */

/** Resolves once `connect` has finished, ending it early if `deadline` comes first. */
export async function joinWithin({
  connect,
  deadline,
  detach,
}: {
  /** The join already in progress. Its rejection is an outcome, not a failure of this function. */
  connect: Promise<unknown>;
  /** How long the join is worth waiting for. Resolving means "stop waiting", not "stop". */
  deadline: Promise<void>;
  /** End the in-flight connect. Asked for once, and only when the deadline came first. */
  detach: () => Promise<unknown>;
}): Promise<void> {
  // Settled either way: a connect that failed is a join that is over, and the caller restores
  // history separately. Kept as one promise so it can be awaited twice without a second rejection.
  const finished = connect.then(
    () => undefined,
    () => undefined,
  );

  const outcome = await Promise.race([
    finished.then(() => "connected" as const),
    deadline.then(() => "deadline" as const),
  ]);
  if (outcome === "connected") {
    return;
  }

  // Detach itself may stall too; the completion below owns the entire grace period.
  void Promise.resolve().then(detach).catch(() => undefined);
  /*
   * Bounded, because a detach is a request and not a guarantee.
   *
   * This was a bare `await finished`, on the reasoning that a detached connect ends promptly. When
   * it does not, nothing here ever returns: the caller's `finally` never runs, the gate it opens
   * stays shut, and every message typed afterwards waits on it forever. That is silence — the
   * message appears in the transcript, no run is ever started, no request reaches the server and
   * nothing is logged, which is the hardest failure of all to read.
   *
   * If the old connect remains active, fail this gate and let the caller replace its connection.
   * Never send through it: its eventual replay could overwrite a newly added message.
   */
  const detached = await Promise.race([
    finished.then(() => true),
    afterMs(DETACH_GRACE_MS).then(() => false),
  ]);
  if (!detached) {
    const error = new Error("舊連線仍未結束，正在重新建立連線。訊息尚未送出。");
    error.name = "JoinStillActiveError";
    throw error;
  }
}

/**
 * How long a detached connect is given to finish before its connection must be replaced.
 */
const DETACH_GRACE_MS = 2_000;

/** A deadline, as a promise. Separate so a test can supply one it controls. */
export function afterMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

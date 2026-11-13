

/** Milliseconds, from whatever source the caller trusts. Injected so tests need not sleep. */
export type Clock = () => number;

/**
 * What the watch is told about a stream, which is deliberately almost nothing: a way to find it
 * again and the Bot on the far end. Never the bytes, because nothing in here is allowed to read
 * them, and never the response, because holding one would make this a party to the stream rather
 * than an observer of it.
 */
export type WatchedStream = {
  /**
   * How the caller finds this stream again. Minted per stream rather than taken from the run,
   * because the id has to exist before the first byte arrives and the run identifiers are inside the
   * request the stream is answering.
   */
  id: string;
  /** The Bot on the far end, so a stall names what went quiet rather than which socket it was. */
  botId: string;
};

export type StalledStream = WatchedStream & {
  /** How long it had been silent when it was given up on. Never less than `stallMs`. */
  silentForMs: number;
  /** Chunks that arrived before the silence. Zero means the Bot never said anything at all. */
  chunks: number;
};

export type TurnWatchdogOptions = {
  /**
   * Silence this long means the stream is wedged.
   *
   * Zero, or anything below it, switches the watchdog off completely: `open` records nothing and
   * `sweep` has nothing to find. A deployment that has not asked for a watchdog gets the behaviour
   * it had before there was one, rather than a watchdog with a surprising number in it.
   */
  stallMs: number;
  /** Called once per stalled stream, after the stream has been taken off the watch. */
  onStall: (stream: StalledStream) => void;
  now?: Clock;
};

type OpenStream = WatchedStream & {
  lastChunkAt: number;
  chunks: number;
  /** While true the clock is not running, because the wait is not on the Bot. See `pause`. */
  paused: boolean;
};

export class TurnWatchdog {
  private readonly stallMs: number;
  private readonly onStall: (stream: StalledStream) => void;
  private readonly now: Clock;
  private readonly streams = new Map<string, OpenStream>();

  constructor(options: TurnWatchdogOptions) {
    this.stallMs = options.stallMs;
    this.onStall = options.onStall;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether this deployment asked for a watchdog at all. */
  get enabled(): boolean {
    return this.stallMs > 0;
  }

  /**
   * Read by whoever owns the sweep, so a process with nothing to watch can stop looking rather than
   * hold a timer that ticks for the life of the deployment.
   */
  get watching(): number {
    return this.streams.size;
  }

  /**
   * Start watching a stream.
   *
   * The clock starts here rather than at the first chunk, so a Bot that accepts a connection and
   * then says nothing at all is caught by the same rule as one that stops halfway. That case is the
   * common one: an endpoint that has been redeployed answers the request and never writes.
   *
   * Opening an id that is already open restarts its clock rather than raising. A second open for the
   * same stream can only mean the caller believes it is alive, and the safe reading of that is to
   * believe them.
   */
  open(stream: WatchedStream): void {
    if (!this.enabled) return;
    this.streams.set(stream.id, {
      ...stream,
      lastChunkAt: this.now(),
      chunks: 0,
      paused: false,
    });
  }

  /**
   * Note that something arrived from the Bot.
   *
   * Called when a read off the Bot's own body resolves, which is the only moment this process learns
   * anything about the endpoint. Anywhere later in the relay would be measuring how promptly the
   * next component took delivery instead.
   *
   * An id that is not being watched is ignored rather than started, and that is what makes the
   * callback fire exactly once per stream: `sweep` removes a stream as it reports it, so a chunk
   * that arrives from a Bot after it was given up on cannot quietly begin a second watch which would
   * stall again and report the same wedged turn twice.
   */
  record(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.lastChunkAt = this.now();
    stream.chunks += 1;
  }

  /**
   * Stop counting silence against a stream, because the wait has stopped being the Bot's.
   *
   * Between one chunk and the next, this process is not waiting on the endpoint at all: it is
   * waiting for whoever reads the relayed stream to take the chunk it already has. That wait can be
   * long for reasons that have nothing to do with the Bot, and a Bot that is streaming steadily must
   * not be ended because the far side of the relay went to sleep. Counting only the stretches spent
   * waiting on the endpoint is what keeps the number in the audit row true to its own name.
   *
   * The cost is that a stream whose reader stops for good is never reported. It is not silent from
   * the Bot, so nothing here ends it, and it stays in the watch until the relay errors and the pump
   * releases it. That is the right way round: believing a healthy Bot is broken ends somebody's
   * turn, and believing a broken reader is healthy costs an entry in a map.
   */
  pause(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.paused = true;
  }

  /**
   * Start counting again, from now rather than from the last chunk.
   *
   * The stretch that just ended was not the Bot's, so it must not be carried forward into the next
   * deadline; a handover that took most of the timeout would otherwise leave the Bot a sliver of it.
   */
  resume(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.lastChunkAt = this.now();
    stream.paused = false;
  }

  /** Stop watching. Unknown ids are ignored, so closing a stream that already stalled is harmless. */
  close(id: string): void {
    this.streams.delete(id);
  }

  /**
   * Reports every stream that has gone quiet, and returns how many there were.
   *
   * Each one is removed before its callback runs, so a callback that throws still leaves the
   * watchdog consistent, and a slow callback cannot be entered twice for the same stream.
   */
  sweep(): number {
    if (!this.enabled) return 0;
    const now = this.now();
    let stalled = 0;

    for (const [id, stream] of this.streams) {
      if (stream.paused) continue;
      const silentForMs = now - stream.lastChunkAt;
      if (silentForMs < this.stallMs) continue;

      this.streams.delete(id);
      stalled += 1;
      try {
        this.onStall({
          id,
          botId: stream.botId,
          silentForMs,
          chunks: stream.chunks,
        });
      } catch (error) {
        // One Bot's failure must not stop the others being closed. This is the same blast-radius
        // argument the process-level rejection handler in index.ts makes: a wedged Bot is somebody
        // else's infrastructure, and the sweep it happens to be in is holding every other person's
        // stuck turn. Logged loudly, because a watchdog that fails silently is worse than none.
        console.error(
          JSON.stringify({
            type: "turn-watchdog-callback-error",
            stream: id,
            bot: stream.botId,
            error: String(error),
          }),
        );
      }
    }

    return stalled;
  }
}

/**
 * Per-key serial write lock used by the channel storage layer.
 *
 * Why a key-based lock instead of a single global mutex: per CHANNEL_PROTOCOL.md
 * §4.2, `events.jsonl` is the source of truth and snapshots are written once
 * at terminal state. The append-vs-finalise race test (Phase 1 DoD §3)
 * requires concurrent appends + a final snapshot write to the same turn to
 * serialise without torn writes, while writes to DIFFERENT turns proceed in
 * parallel for throughput.
 *
 * Keys are caller-defined. The orchestrator uses `<channelId>:<turnId>` so
 * the lock is per-turn within a channel and per-channel writes never block
 * each other.
 *
 * No IO. Lock state lives in-process for the daemon's lifetime; on restart
 * the orchestrator re-reads `events.jsonl` so any in-flight writes that
 * crashed mid-call are detectable by the reader's replay-fallback.
 */
export class ChannelWriteSerializer {
  private readonly locks = new Map<string, Promise<unknown>>()

  /**
   * Runs `fn` with exclusive access to `key`. Calls with the same key are
   * serialised in submission order; calls with different keys may run in
   * parallel. The lock is released regardless of whether `fn` resolves or
   * rejects.
   */
  async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.then(async () => fn())
    // Store a rejection-swallowing chain so a failing inner call doesn't poison
    // subsequent callers' locks; the original rejection still surfaces via the
    // returned `next` promise below. Keep a reference to `swallowed` so the
    // finally block can identity-compare and clean up the map entry when
    // nobody queued behind us during execution.
    const swallowed = next.catch(() => {})
    this.locks.set(key, swallowed)

    try {
      return await next
    } finally {
      if (this.locks.get(key) === swallowed) {
        this.locks.delete(key)
      }
    }
  }
}

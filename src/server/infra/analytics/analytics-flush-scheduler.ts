const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_THRESHOLD_COUNT = 20

export interface AnalyticsFlushSchedulerDeps {
  /**
   * Async flush operation invoked when a trigger fires. MUST NOT throw —
   * the scheduler wraps every call in `.catch` so a flush failure cannot
   * crash the interval loop or shutdown sequence.
   */
  flush: () => Promise<unknown>
  /**
   * Lazy analytics-enabled gate. Re-checked on every trigger so a runtime
   * `brv settings set analytics.share false` (M1.4) immediately suspends scheduled flushes
   * without restarting the daemon.
   */
  isEnabled: () => boolean
  /**
   * M5.4 (ENG-2658): live "is the backend currently rate-limiting us?" gate,
   * wired to `AnalyticsBackoffPolicy.isRateLimited()`. When true, the
   * threshold (burst) trigger is suppressed so a 20-event burst cannot hammer a
   * backend that returned 429/503 and asked us to wait — the periodic tick,
   * already stretched to the server's `Retry-After` via `nextIntervalMs`, ships
   * the backlog once the window elapses. Defaults to never-rate-limited so the
   * periodic-tick path and existing callers/tests are unaffected.
   */
  isRateLimited?: () => boolean
  /**
   * M4.5: live next-tick delay in milliseconds. Read AFTER each tick
   * settles, when the scheduler arms its `setTimeout` for the next
   * tick — so the latest backoff state (advanced by the just-finished
   * flush via `AnalyticsClient.runFlush`) takes effect immediately.
   *
   * Production wires this to `analyticsBackoffPolicy.nextDelayMs()`.
   * Tests pass a literal (`() => 30_000`) or a closure over a mutable
   * value to exercise dynamic intervals. Defaults to 30s so existing
   * test fakes that omit the dep keep working.
   */
  nextIntervalMs?: () => number
  /**
   * Count of records pending shipment (JSONL `status='pending'` rows).
   * Used by the interval timer and `flushFinal()` to skip flushes when
   * there is nothing left to ship.
   *
   * MUST track JSONL state, NOT the in-memory queue mirror: the queue
   * never decrements after a successful flush (queue.drain only runs on
   * auth transitions), so using it here would make the scheduler fire
   * every 30s indefinitely and waste a no-op HTTP call each time.
   * `HttpAnalyticsSender` flips rows from `pending` to `sent` on 2xx, so
   * this counter shrinks as work completes.
   *
   * Async because reading the JSONL file is I/O; the cost is one read
   * per trigger (≤ once per `intervalMs` plus any threshold firings).
   */
  pendingCount: () => Promise<number>
  /**
   * Synchronous in-memory queue depth, read by the threshold trigger
   * inside `notifyPushed()`. Sync + cheap so `track()` stays on the
   * fast-path; correctness here only requires that the counter grows
   * monotonically across recent pushes, which the bounded queue
   * satisfies.
   */
  queueSize: () => number
  /** Queue depth that trips the threshold-based trigger. Defaults to 20. */
  thresholdCount?: number
}

export type FlushFinalOptions = {
  /** Hard cap on how long the shutdown flush is allowed to take. */
  timeoutMs: number
}

/**
 * Drives automatic flushes for the daemon-scoped analytics client.
 *
 * Two triggers (whichever fires first wins):
 *   - **Periodic tick** (`nextIntervalMs()`, default 30s): each tick
 *     re-arms via `setTimeout` AFTER the previous flush settles, reading
 *     the delay live at arm-time. In production this is wired to
 *     `AnalyticsBackoffPolicy.nextDelayMs()`, so a failing backend
 *     stretches the gap to 60s → 2m → 5m (M4.5); on first success the
 *     policy resets and the next tick is 30s again.
 *   - **Threshold notification** (`thresholdCount`, default 20): callers
 *     invoke `notifyPushed()` after enqueuing a record; if the queue
 *     has grown by `thresholdCount` since the last threshold fire, a
 *     flush is scheduled via `setImmediate` so `track()` stays
 *     synchronous from the consumer's view. The threshold path is NOT
 *     throttled by the M4.5 *backoff schedule* (failures) — single-flight
 *     rate-limits it, and gating the 20-event burst on transient failures
 *     would defeat its batching purpose. It IS suppressed, however, while
 *     an explicit server *rate-limit* is active (M5.4 / ENG-2658
 *     `isRateLimited`): a 429/503 means "stop sending", so the burst path
 *     stands down and the stretched periodic tick ships the backlog.
 *
 * Single-flight: while a flush is in flight, any new trigger is dropped
 * (NOT queued). The in-flight promise is exposed via `flushFinal()` so
 * shutdown can join it rather than starting a second send.
 *
 * `flushFinal({timeoutMs})` is the shutdown hook: races the in-flight or
 * fresh flush against a timeout and resolves either way, so the daemon
 * exit sequence cannot hang on a slow telemetry backend.
 *
 * Lifecycle owned by the composition root: `start()` after construction,
 * `stop()` during shutdown (before `flushFinal()` so no new ticks fire
 * mid-shutdown).
 *
 * Errors from `flush()` are swallowed at this layer. The M4.5 backoff
 * policy reacts to the structured failure reason via
 * `AnalyticsClient.runFlush`; the scheduler itself only needs the live
 * `nextDelayMs()` value at each re-arm and otherwise keeps ticking.
 */
export class AnalyticsFlushScheduler {
  private readonly deps: Required<AnalyticsFlushSchedulerDeps>
  // M4.5: handle of the most-recently armed `setTimeout` for the
  // periodic tick. Each tick re-arms itself from `nextIntervalMs()`
  // after the flush settles, so the backoff policy's latest state
  // takes effect on the very next tick. `start()` is idempotent via
  // this slot (a second start while running is a no-op).
  private intervalHandle: ReturnType<typeof setTimeout> | undefined
  // Snapshot of `queueSize` at the last threshold fire. Together with
  // `thresholdCount` this gates `notifyPushed` on the DELTA since last
  // fire (queue depths 20/40/60/...) instead of the absolute size — the
  // queue mirror is monotonic across a session (drained only on auth
  // transitions), so without a moving baseline every push past the
  // first threshold crossing would re-fire.
  private lastTriggerQueueSize: number = 0
  // Single-flight slot. Any trigger that arrives while this is set is
  // dropped; `flushFinal()` awaits it so shutdown joins rather than races.
  private pendingFlush: Promise<void> | undefined
  // M4.5: set true on `stop()` so a settling flush's `.finally` does
  // NOT re-arm the next tick. Without this, calling `stop()` while a
  // tick was in flight would still queue one more tick after the
  // current one settled.
  private stopped = false

  public constructor(deps: AnalyticsFlushSchedulerDeps) {
    this.deps = {
      flush: deps.flush,
      isEnabled: deps.isEnabled,
      isRateLimited: deps.isRateLimited ?? (() => false),
      nextIntervalMs: deps.nextIntervalMs ?? (() => DEFAULT_INTERVAL_MS),
      pendingCount: deps.pendingCount,
      queueSize: deps.queueSize,
      thresholdCount: deps.thresholdCount ?? DEFAULT_THRESHOLD_COUNT,
    }
  }

  /**
   * Best-effort final flush for the daemon shutdown sequence. Races the
   * underlying flush against `timeoutMs` and resolves either way so the
   * caller cannot hang on a slow backend.
   *
   * Joins an in-flight flush (returns its promise) rather than starting
   * a second send. Skips the flush entirely when there is nothing in
   * JSONL pending (avoids a wasted no-op HTTP call during shutdown).
   */
  public async flushFinal(options: FlushFinalOptions): Promise<void> {
    if (!this.deps.isEnabled()) return

    // Snapshot the existing in-flight before checking pendingCount so a
    // concurrent flush we should join is honored even if pendingCount
    // reports zero at this exact moment (race-safe: an in-flight flush
    // implies records WERE pending when it started).
    if (this.pendingFlush !== undefined) {
      await this.race(this.pendingFlush, options.timeoutMs)
      return
    }

    if ((await this.deps.pendingCount()) === 0) return

    // Double-check the slot AFTER the pendingCount I/O. During that
    // await, a competing trigger (a queued setImmediate from
    // `notifyPushed`, or an interval tick still mid-flight when `stop()`
    // ran) may have called `startFlush` and claimed `pendingFlush`.
    // Without this re-check the next line would call `startFlush` again,
    // overwrite the slot with a second promise, and the backend would
    // ingest the same records twice. Join the in-flight flush instead.
    if (this.pendingFlush !== undefined) {
      await this.race(this.pendingFlush, options.timeoutMs)
      return
    }

    await this.race(this.startFlush(), options.timeoutMs)
  }

  /**
   * Called by `AnalyticsClient.track()` after enqueuing a record. Fires a
   * flush via `setImmediate` once the queue has grown by `thresholdCount`
   * since the last trigger, so `track()` stays synchronous from the
   * consumer's view.
   *
   * Threshold uses `queueSize` (not `pendingCount`) because: (a) it runs
   * on every track and must stay sync + cheap, and (b) the gate's intent
   * is "fire every N pushes". The mirror is monotonic across a session
   * (drained only on auth transitions), so we compare against a moving
   * baseline `lastTriggerQueueSize` rather than the absolute size —
   * otherwise every push past the first threshold crossing would re-fire
   * and the batching contract would collapse for slow-emit workloads.
   *
   * When the queue size drops below the previous baseline (auth-transition
   * drain), the baseline resets to 0 so the next N pushes fire again.
   */
  public notifyPushed(): void {
    if (!this.deps.isEnabled()) return
    // M5.4 (ENG-2658): while the backend is rate-limiting us (429/503), suppress
    // the burst trigger so a 20-event burst cannot hammer a backend that asked
    // us to wait. The periodic tick — already stretched to the server's
    // Retry-After via `nextIntervalMs` — ships the backlog once the window
    // elapses. The threshold baseline is intentionally left untouched here, so
    // once the rate-limit clears the next push can still trigger a flush.
    if (this.deps.isRateLimited()) return
    const size = this.deps.queueSize()
    if (size < this.lastTriggerQueueSize) this.lastTriggerQueueSize = 0
    if (size - this.lastTriggerQueueSize < this.deps.thresholdCount) return
    this.lastTriggerQueueSize = size
    setImmediate(() => {
      // eslint-disable-next-line no-void
      void this.tryFlush()
    })
  }

  /**
   * Start the recurring tick. Idempotent: a second call while already
   * running is a no-op (the slot is occupied). M4.5: implemented as a
   * `setTimeout` chain so each tick reads `nextIntervalMs()` at arm-time;
   * the backoff policy's latest state takes effect on the very next tick.
   */
  public start(): void {
    if (this.intervalHandle !== undefined) return
    this.stopped = false
    this.armNextTick()
  }

  /**
   * Stop the recurring tick. Idempotent. Does NOT cancel an in-flight
   * flush — call `flushFinal()` for that. The `stopped` flag prevents
   * a settling flush's `.finally` from arming one extra tick after stop.
   */
  public stop(): void {
    this.stopped = true
    if (this.intervalHandle === undefined) return
    clearTimeout(this.intervalHandle)
    this.intervalHandle = undefined
  }

  /**
   * Arm the next periodic tick at `nextIntervalMs()` from now. Called
   * by `start()` initially and by each tick's `.finally` after the
   * flush settles. `stopped` guard short-circuits when the daemon is
   * winding down so we don't keep firing post-stop().
   */
  private armNextTick(): void {
    if (this.stopped) {
      this.intervalHandle = undefined
      return
    }

    this.intervalHandle = setTimeout(() => {
      // eslint-disable-next-line no-void
      void this.tryFlush().finally(() => this.armNextTick())
    }, this.deps.nextIntervalMs())
  }

  /**
   * Race the given flush promise against a timeout. Used by `flushFinal`
   * to enforce the shutdown budget without blocking on a slow backend.
   */
  private async race(flushPromise: Promise<void>, timeoutMs: number): Promise<void> {
    await Promise.race([
      flushPromise,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs)
      }),
    ])
  }

  /**
   * Invoke the flush and own the single-flight slot for its lifetime.
   * Errors are swallowed at this layer — M4.5 owns retry/backoff.
   */
  private startFlush(): Promise<void> {
    const promise: Promise<void> = this.deps
      .flush()
      .then(
        () => {
          // Discard the flush return value; the scheduler only cares
          // about settlement, not the AnalyticsBatch payload.
        },
        () => {
          // Analytics MUST NOT crash the daemon. M4.5 will surface
          // failure reasons via a different channel.
        },
      )
      .finally(() => {
        if (this.pendingFlush === promise) {
          this.pendingFlush = undefined
        }
      })
    this.pendingFlush = promise
    return promise
  }

  /**
   * Common gate for interval and threshold triggers. Honors the
   * isEnabled gate, the empty-pending skip (JSONL-backed, not queue),
   * and single-flight; delegates to `startFlush` for the actual call.
   *
   * Async so the pendingCount I/O is awaited inside the gate rather
   * than fanned out as a fire-and-forget side effect. Errors are
   * swallowed by `startFlush`; this method itself never throws.
   */
  private async tryFlush(): Promise<void> {
    if (!this.deps.isEnabled()) return
    if (this.pendingFlush !== undefined) return
    if ((await this.deps.pendingCount()) === 0) return
    // pendingFlush may have been set by a competing trigger during the
    // pendingCount I/O — re-check before claiming the slot.
    if (this.pendingFlush !== undefined) return
    await this.startFlush()
  }
}

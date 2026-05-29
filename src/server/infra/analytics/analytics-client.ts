import {formatISO} from 'date-fns'
import {randomUUID} from 'node:crypto'

import type {AnalyticsEventName} from '../../../shared/analytics/event-names.js'
import type {PropsArg, PropsForEvent} from '../../../shared/analytics/events/index.js'
import type {StoredAnalyticsRecord} from '../../../shared/analytics/stored-record.js'
import type {IAnalyticsBackoffPolicy} from '../../core/interfaces/analytics/i-analytics-backoff-policy.js'
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {IAnalyticsQueue} from '../../core/interfaces/analytics/i-analytics-queue.js'
import type {IAnalyticsSender, SendResult} from '../../core/interfaces/analytics/i-analytics-sender.js'
import type {IIdentityResolver} from '../../core/interfaces/analytics/i-identity-resolver.js'
import type {IJsonlAnalyticsStore} from '../../core/interfaces/analytics/i-jsonl-analytics-store.js'
import type {ISuperPropertiesResolver} from '../../core/interfaces/analytics/i-super-properties-resolver.js'

import {toWireEvent} from '../../../shared/analytics/stored-record.js'
import {AnalyticsBatch} from '../../core/domain/analytics/batch.js'

export interface AnalyticsClientDeps {
  /**
   * M4.5: optional failure-resilience policy. When wired, `runFlush`
   * feeds the `SendResult.reason` into the policy after every flush:
   *   - undefined reason (all-succeeded) → `onSuccess()` resets the backoff.
   *   - `timeout` / `network` / `http_5xx` → `onFailure()` advances the
   *     backoff one step (capped at 5m by the policy impl).
   *   - `http_4xx` → neither call. 4xx is a payload-shape error, not a
   *     backend health signal — retrying or backing off won't help.
   *   - Aborted (controller.signal.aborted) → neither call. User-driven
   *     cancellation (M4.4 disable) must not poison the M4.6
   *     reachability counter.
   *
   * Optional so M2/M4.3 test fakes that don't care about backoff keep
   * working with their pre-M4.5 construction shape.
   */
  backoffPolicy?: IAnalyticsBackoffPolicy
  identityResolver: IIdentityResolver
  isEnabled: () => boolean
  jsonlStore: IJsonlAnalyticsStore
  /**
   * Optional structured log sink for operational visibility. Used by
   * `onAuthTransition` to surface a `clear()` failure that would
   * otherwise silently leave prior-session events on disk. Defaults to
   * a no-op when omitted so existing callers don't have to wire it.
   */
  log?: (message: string) => void
  /**
   * M4.6: monotonic clock used to stamp `lastSuccessfulFlushAt`. Injected
   * so tests can assert against a known value; production defaults to
   * `Date.now`. Daemon restart resets the in-memory timestamp; the
   * status command surfaces "never" when undefined.
   */
  now?: () => number
  /**
   * M4.3: optional notification fired after a record has been durably
   * appended (JSONL + queue mirror). The composition root wires this to
   * `AnalyticsFlushScheduler.notifyPushed()` so the scheduler can check
   * its 20-event threshold without coupling AnalyticsClient to the
   * scheduler's concrete type. Called best-effort — throws are swallowed
   * by the surrounding try/catch in `trackAsync`.
   */
  onAfterTrack?: () => void
  queue: IAnalyticsQueue
  sender: IAnalyticsSender
  superPropsResolver: ISuperPropertiesResolver
}

/**
 * Daemon-scoped analytics client. Implements the M2.1 IAnalyticsClient
 * contract by composing M2.2 (queue), M2.3 (super-props), and M2.4
 * (identity).
 *
 * `track()` is sync per the M2.1 interface — when enabled, the actual
 * resolve+enqueue work is fire-and-forget via the async trackAsync,
 * matching the established `auth-state-store.ts` pattern. Errors during
 * the async work (resolver rejection, queue push failure) are silently
 * swallowed: analytics MUST NOT crash a correctly-configured consumer,
 * and per ticket scope no error reporting surface exists yet.
 *
 * The no-crash guarantee covers ASYNC errors only. The sync `isEnabled()`
 * callback is called directly; if it throws, the throw propagates to the
 * caller. This is intentional: `isEnabled` is wired to
 * GlobalConfigHandler.getCachedAnalytics(), which throws when invoked
 * before `refreshCache()` has populated the cache. That throw surfaces
 * a bootstrap-misconfiguration bug loudly rather than silently miscounting.
 * Callers MUST ensure the cache is populated before the first `track()`.
 *
 * When disabled, `track()` is a true no-op: no resolver calls, no
 * allocations beyond the function call frame.
 */
export class AnalyticsClient implements IAnalyticsClient {
  // M4.4 cancellation slot. Held only while a flush is in flight; the
  // signal is piped through `sender.send` to the underlying HTTP client.
  // `abort()` is a no-op when this is undefined (no in-flight to cancel).
  private currentFlushController?: AbortController
  private readonly deps: AnalyticsClientDeps
  // M4.6: timestamp of the last flush that actually shipped at least one
  // record cleanly (same gate as the M4.5 backoff `onSuccess()` path).
  // Surfaced through `getRuntimeState()` for `brv settings get analytics.status`.
  // Daemon restart resets to undefined; status renders "never".
  private lastSuccessfulFlushAt: number | undefined
  // Single-flight slot for an in-flight `flush()`. Concurrent callers join the
  // existing promise instead of starting a second read-then-decide cycle —
  // without this, two parallel flushes would both `loadPending()` the same set,
  // both invoke `sender.send`, and both mirror `updateStatus(_, 'failed')` into
  // the write chain (which serializes the WRITES but not the READ-decisions),
  // double-incrementing `attempts` per cycle and tripping the M9.2 retry cap
  // in MAX_ATTEMPTS/2 cycles instead of MAX_ATTEMPTS.
  private pendingFlush?: Promise<AnalyticsBatch>
  // M4.1 in-flight tracking. Each `trackAsync` registers its promise here
  // so `onAuthTransition` can await every track that started BEFORE the
  // transition before issuing `clear()`. Without this barrier:
  //   - a track that resolved old identity but hasn't appended yet may
  //     enqueue its append AFTER clear → record persists with stale
  //     identity → backend rejects on mismatch.
  //   - a track that already enqueued append BEFORE clear is correctly
  //     nuked by clear (intentional — pre-transition events drop).
  // The barrier removes the first failure mode; the second is the
  // designed behavior.
  private readonly pendingTracks = new Set<Promise<void>>()

  public constructor(deps: AnalyticsClientDeps) {
    this.deps = deps
  }

  /**
   * M4.4 cancellation hook. Aborts the AbortController tied to the
   * in-flight `flush()`'s HTTP request (if any). The signal propagates
   * through `sender.send` to the underlying `IAnalyticsHttpClient`,
   * which classifies aborted requests as `network` failures — JSONL
   * records stay `pending` (so they ship on the next enabled flush).
   *
   * Called from `GlobalConfigHandler` when `brv settings set analytics.enabled false`
   * flips the flag, so the daemon doesn't half-ship a batch across an
   * enable/disable boundary. No-op when no flush is in flight.
   */
  public abort(): void {
    this.currentFlushController?.abort()
  }

  /**
   * Reads pending rows from JSONL (NOT from the in-memory queue), invokes
   * the registered sender, and mirrors the per-record outcome back to JSONL
   * via `updateStatus`. The queue is intentionally bypassed: it can drop
   * oldest entries on burst overflow (>maxSize), and a queue-based flush
   * would miss those rows even though JSONL still has them.
   *
   * Returns an `AnalyticsBatch` of wire-shape events (id/attempts/status
   * stripped via `toWireEvent`) so a future caller can inspect what was
   * shipped on this tick. `flush()` itself does NOT transmit — the sender
   * does. The returned batch reflects the input snapshot, not the per-record
   * succeeded/failed split.
   *
   * A sender that throws is treated as `{succeeded: [], failed: <all ids>}`
   * — analytics MUST NOT crash the daemon. M9.2's `updateStatus(_, 'failed')`
   * owns the retry-cap policy: rows stay at `'pending'` until
   * `attempts >= MAX_ATTEMPTS`, then transition to terminal `'failed'`.
   * `flush()` is a thin caller — it does not inspect attempts.
   */
  public async flush(): Promise<AnalyticsBatch> {
    // M4.4: `brv settings set analytics.enabled false` semantically means "stop shipping to
    // remote" — local tracking (JSONL + queue) continues unconditionally.
    // Gate here, NOT in `track()`. Records stay at `status='pending'` in
    // JSONL; the next flush after re-enable picks them up automatically.
    if (!this.deps.isEnabled()) return AnalyticsBatch.create([])

    // Single-flight: if a flush is already running, hand its promise to the
    // joining caller so both observe the same loadPending snapshot, the same
    // sender invocation, and the same mirror writes.
    if (this.pendingFlush !== undefined) return this.pendingFlush

    this.pendingFlush = this.runFlush()
    try {
      return await this.pendingFlush
    } finally {
      this.pendingFlush = undefined
    }
  }

  /**
   * Snapshot of client-owned runtime state for `brv settings get analytics.status`
   * (M4.6). Backoff state, endpoint, and the enabled flag are NOT here
   * — those are composed by the daemon-side status handler from other
   * sources (the policy + envConfig + GlobalConfigHandler). Async
   * because `queueDepth` reads JSONL pending rows (the authoritative
   * "waiting to ship" metric, NOT the in-memory queue mirror which
   * caps at 1000 via drop-oldest).
   */
  public async getRuntimeState(): Promise<{droppedCount: number; lastSuccessfulFlushAt: number | undefined; queueDepth: number}> {
    const pending = await this.deps.jsonlStore.loadPending()
    return {
      droppedCount: this.deps.queue.droppedCount(),
      lastSuccessfulFlushAt: this.lastSuccessfulFlushAt,
      queueDepth: pending.length,
    }
  }

  public async onAuthTransition(): Promise<void> {
    // Snapshot in-flight tracks then wait for them to settle. Any
    // `trackAsync` that started before this point may still be between
    // identity-resolve and `jsonlStore.append` / `queue.push`; awaiting
    // it guarantees its append has either landed in the write chain (so
    // the clear enqueued below nukes it — correct, those identities are
    // stale) or failed (so there is nothing to nuke). New `track()`
    // calls that arrive after this snapshot resolve identity from the
    // post-transition cached token and are NOT included in the barrier.
    //
    // `Promise.allSettled` rather than `all` because individual track
    // promises may already swallow-and-resolve on error; we just need
    // the settled signal, not the result.
    if (this.pendingTracks.size > 0) {
      await Promise.allSettled(this.pendingTracks)
    }

    // Drain the in-memory mirror AFTER the barrier so any push that the
    // completing track did is also wiped. Draining before the barrier
    // would leave a window where the late-completing track pushes back
    // into a fresh queue → prior-session record stays visible to webui.
    this.deps.queue.drain()

    try {
      await this.deps.jsonlStore.clear()
    } catch (error) {
      // Analytics MUST NOT crash the consumer. Surface the failure
      // through the optional log sink so operators see why a flush
      // after transition would ship prior-session events.
      this.deps.log?.(
        `analytics.onAuthTransition: clear failed (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  public track<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
    // M4.4 semantic: local tracking is unconditional. `isEnabled` only
    // gates `flush()` (remote send). A disabled session still writes
    // every track to JSONL + the in-memory queue; re-enabling picks the
    // backlog up on the next flush.
    // Capture the timestamp synchronously at call-site so it reflects WHEN the
    // user action happened, not when the async resolver chain settled. Under
    // burst load (many tracks queued before the first resolver completes) this
    // preserves the inter-event durations downstream consumers care about.
    //
    // A single `new Date()` read drives both fields so the local numeric
    // sort key (`timestamp`, epoch ms) and the wire-bound ISO 8601 string
    // (`created_at`) always describe the same instant.
    const now = new Date()
    const timestamp = now.getTime()
    const createdAt = formatISO(now)
    const [properties] = rest
    const pending = this.trackAsync({createdAt, event, properties, timestamp})
    this.pendingTracks.add(pending)
    // Remove from the in-flight set once the track settles either way.
    // `void` keeps `track()` synchronous per the IAnalyticsClient contract.
    // eslint-disable-next-line no-void
    void pending.finally(() => {
      this.pendingTracks.delete(pending)
    })
  }

  /**
   * Feed the `SendResult` into the optional M4.5 backoff policy.
   *
   * Decision table (skip = call neither onSuccess nor onFailure):
   *   - policy not wired                      → skip
   *   - aborted (M4.4 disable cancel)         → skip (user action, not a backend signal)
   *   - reason = `http_4xx`                   → skip (payload-shape, not a health signal)
   *   - reason undefined AND succeeded.length === 0 → skip (empty no-op
   *     race, or HttpAnalyticsSender's `missing-deviceId` path that
   *     returns failed-without-reason; neither is a clean ship)
   *   - reason undefined AND succeeded.length > 0   → onSuccess() + M4.6 timestamp stamp
   *   - reason = `timeout` / `network` / `http_5xx` → onFailure()
   *
   * Emits a structured log line on every real transition so ops can
   * trace "why did flushes suddenly slow down" without grepping for
   * implicit cadence changes.
   */
  private feedBackoffPolicy(result: SendResult, aborted: boolean): void {
    const policy = this.deps.backoffPolicy
    if (aborted) return
    if (result.reason === 'http_4xx') {
      if (policy !== undefined) {
        // Tag 4xx in the log so ops sees the divergence (we do NOT advance
        // backoff for permanent payload errors, only for transient ones).
        this.deps.log?.(
          `analytics.backoff: http_4xx ignored (consecutive_failures=${policy.consecutiveFailures()}, next=${policy.nextDelayMs()}ms)`,
        )
      }

      return
    }

    if (result.reason === undefined) {
      if (result.succeeded.length === 0) return // empty no-op or uncategorized failure: no signal
      // M4.6: stamp the timestamp on the same gate as the backoff
      // `onSuccess()` so "Last successful flush" reflects real ships.
      const now = (this.deps.now ?? Date.now)()
      this.lastSuccessfulFlushAt = now
      if (policy !== undefined) {
        const beforeFailures = policy.consecutiveFailures()
        policy.onSuccess()
        if (beforeFailures > 0) {
          this.deps.log?.(
            `analytics.backoff: reset on success (was consecutive_failures=${beforeFailures}, next=${policy.nextDelayMs()}ms)`,
          )
        }
      }

      return
    }

    if (policy !== undefined) {
      policy.onFailure()
      this.deps.log?.(
        `analytics.backoff: advanced on ${result.reason} (consecutive_failures=${policy.consecutiveFailures()}, next=${policy.nextDelayMs()}ms)`,
      )
    }
  }

  private async runFlush(): Promise<AnalyticsBatch> {
    const records = await this.deps.jsonlStore.loadPending()

    // M4.4: per-flush AbortController, exposed via `abort()` so the
    // disable-handler can cancel the in-flight HTTP. Cleared in finally
    // so a stale controller can't be aborted after settlement.
    const controller = new AbortController()
    this.currentFlushController = controller

    let result: SendResult
    try {
      result = await this.deps.sender.send(records, {signal: controller.signal})
    } catch {
      result = {failed: records.map((r) => r.id), succeeded: []}
    } finally {
      if (this.currentFlushController === controller) {
        this.currentFlushController = undefined
      }
    }

    await this.deps.jsonlStore.updateStatus(result.succeeded, 'sent')
    // M4.4 N3 fix: when we cancelled the send ourselves (`abort()` fired
    // because `brv settings set analytics.enabled false` flipped the flag), DO NOT mark the
    // failed records as 'failed' — that bumps the M9.2 retry-cap
    // `attempts` counter on every cancel, and a few disable/enable
    // toggles during shipping could terminate records as `'failed'`
    // before they ever land. Leaving them at `status='pending'`
    // preserves the invariant the `abort()` JSDoc claims: aborted
    // records ship cleanly on the next enabled flush.
    if (!controller.signal.aborted) {
      await this.deps.jsonlStore.updateStatus(result.failed, 'failed')
    }

    this.feedBackoffPolicy(result, controller.signal.aborted)

    return AnalyticsBatch.create(records.map((r) => toWireEvent(r)))
  }

  private async trackAsync<E extends AnalyticsEventName>(
    input: Readonly<{
      createdAt: string
      event: E
      properties: PropsForEvent<E> | undefined
      timestamp: number
    }>,
  ): Promise<void> {
    const {createdAt, event, properties, timestamp} = input
    try {
      const [identity, superProps] = await Promise.all([
        this.deps.identityResolver.resolve(),
        this.deps.superPropsResolver.resolve(),
      ])

      // M9.3: compose a StoredAnalyticsRecord — JSONL is the durable source of
      // truth (M10.2's flush reads from JSONL, not the queue). The queue is a
      // fast in-memory mirror for status display / future webui hot path.
      const record: StoredAnalyticsRecord = {
        attempts: 0,
        // eslint-disable-next-line camelcase
        created_at: createdAt,
        id: randomUUID(),
        identity,
        name: event,
        // Super-properties are authoritative: they overwrite any user-supplied
        // property with the same key. This guarantees a consistent envelope
        // (cli_version, device_id, environment, node_version, os) on every event.
        properties: {...properties, ...superProps},
        status: 'pending',
        timestamp,
      }

      // Persist to JSONL FIRST. If `append` throws — disk error, or
      // `JsonlCapFullError` when the file-size cap is saturated with non-sent
      // rows — the outer catch silently drops and queue.push is skipped. This
      // preserves the "JSONL is source of truth" invariant: no record reaches
      // the in-memory mirror queue without a durable on-disk row.
      await this.deps.jsonlStore.append(record)
      this.deps.queue.push(record)

      // M4.3: notify the flush scheduler that a record landed so it can
      // check its 20-event threshold. Fires only on the durable success
      // path (jsonlStore.append resolved + queue.push completed) so a
      // failed persist does NOT trigger a flush of a queue that did not
      // grow. Errors are swallowed by the outer try/catch.
      this.deps.onAfterTrack?.()
    } catch {
      // Analytics MUST NOT crash the consumer. Errors silently dropped.
    }
  }
}

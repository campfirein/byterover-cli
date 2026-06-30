import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {AnalyticsBatch} from '../../domain/analytics/batch.js'

/**
 * Consumer-facing analytics tracking contract. Every consumer surface
 * (TUI, oclif commands, MCP server, webui, agent processes) ultimately
 * routes events into an implementation of this interface inside the
 * daemon. Implementations are responsible for identity resolution,
 * super-property stamping, and queueing; consumers just call `track()`.
 *
 * `track()` is typed against the discriminated union catalog
 * (`AnyAnalyticsEvent` in `shared/analytics/events/index.ts`): magic-string
 * typos and wrong-shape payloads become compile errors. Adding a new event
 * requires registering it in the catalog first; emit sites then become
 * statically checked.
 */
export interface IAnalyticsClient {
  /**
   * Cancel any in-flight `flush()`'s HTTP request. M4.4: invoked by
   * `GlobalConfigHandler` when `brv settings set analytics.share false` flips the flag
   * so the daemon doesn't half-ship a batch across an enable/disable
   * boundary. No-op when no flush is in flight.
   */
  abort: () => void

  /**
   * Drains the queue and returns the events as a serializable batch.
   * Used by the network sender (M4) and by tests.
   */
  flush: () => Promise<AnalyticsBatch>

  /**
   * M4.6: client-owned runtime state for the `brv settings get analytics.status`
   * command. Returns the timestamp of the last successful flush (or
   * `undefined` if none has run this daemon-lifetime), the count of
   * records currently pending in JSONL, and the cumulative count of
   * events dropped by the in-memory queue's drop-oldest cap.
   *
   * Async because `queueDepth` reads JSONL — that's the authoritative
   * "waiting to ship" metric. The in-memory queue mirror caps at 1000
   * via drop-oldest and would mislead operators.
   */
  getRuntimeState: () => Promise<{
    droppedCount: number
    lastSuccessfulFlushAt: number | undefined
    queueDepth: number
  }>

  /**
   * Notify the client that the daemon-wide auth state transitioned
   * (login, logout, account switch, token revoked).
   *
   * M4.1 contract: every pending and historical event in the JSONL queue
   * MUST be dropped, plus the in-memory mirror queue cleared. This
   * preserves the invariant that every event waiting to flush was
   * tracked under the current auth state. Without this drop, a batch
   * flushed across a transition would mix two sessions' identities and
   * the backend (which trusts per-event identity) would attribute past
   * events to the new session — or vice-versa.
   *
   * Errors are swallowed: analytics MUST NOT crash a consumer. A
   * disk-write failure during clear is logged best-effort but never
   * propagates.
   */
  onAuthTransition: () => Promise<void>

  /**
   * Records an analytics event. When the analytics flag is disabled the
   * call must be a true no-op (no allocations, no resolver calls).
   *
   * The generic `<E extends AnalyticsEventName>` plus `PropsArg<E>` rest
   * tuple force callers to pick a registered event name and supply a
   * matching property shape. Events with no required properties (e.g.
   * `daemon_start`) allow the properties argument to be omitted.
   */
  track: <E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>) => void
}

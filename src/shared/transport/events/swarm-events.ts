/**
 * Events for `brv swarm` — federated memory-provider operations.
 *
 * Three emit-only events the swarm CLI commands and the LLM `swarm_*`
 * tools dispatch to the daemon AFTER doing their client-side work
 * (`swarm-coordinator` lives in the agent process, not the daemon).
 * The handler validates the payload against the matching per-event
 * Zod schema in `src/shared/analytics/events/swarm-*.ts` and forwards
 * to `analyticsClient.track()`.
 *
 * Why a dedicated transport namespace vs `analytics:track`:
 * - Typed wire surface — request shapes mirror the analytics
 *   schemas so the CLI gets compile-time validation.
 * - Stable seam — when (if) the swarm coordinator is moved into the
 *   daemon, this same transport channel will carry the operation
 *   request itself. The emit event names stay the same; only the
 *   handler internals change.
 */

import type {SwarmOnboardedProps} from '../../analytics/events/swarm-onboarded.js'
import type {SwarmQueryCompletedProps} from '../../analytics/events/swarm-query-completed.js'
import type {SwarmStoreCompletedProps} from '../../analytics/events/swarm-store-completed.js'

export const SwarmEvents = {
  TRACK_ONBOARDED: 'swarm:trackOnboarded',
  TRACK_QUERY_COMPLETED: 'swarm:trackQueryCompleted',
  TRACK_STORE_COMPLETED: 'swarm:trackStoreCompleted',
} as const

/**
 * Wire shape mirrors `SwarmQueryCompletedProps` exactly. Re-exported here
 * so CLI callers can import a transport-flavored type even though the
 * shape is structurally identical to the analytics props.
 */
export type SwarmTrackQueryCompletedRequest = SwarmQueryCompletedProps

export type SwarmTrackStoreCompletedRequest = SwarmStoreCompletedProps

export type SwarmTrackOnboardedRequest = SwarmOnboardedProps

/**
 * Closed enum so a typo or stray ad-hoc reason becomes a compile error
 * rather than a silent miss on the consumer side.
 */
export type SwarmTrackReason = 'analytics-throw' | 'analytics-unavailable' | 'schema-rejection'

/**
 * The handler returns a small ack so the CLI can confirm the emit was
 * accepted (or learn it was schema-rejected). Analytics-handler.ts pattern.
 */
export interface SwarmTrackResponse {
  /** Set when the daemon dropped the emit; populated for schema-rejection or analytics-disabled. */
  reason?: SwarmTrackReason
  /**
   * True when the daemon accepted the payload and forwarded to the
   * analytics client. False when validation failed or the analytics
   * client was unavailable.
   */
  tracked: boolean
}

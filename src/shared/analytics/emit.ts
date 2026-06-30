import type {ITransportClient} from '@campfirein/brv-transport-client'

import type {AnalyticsEventName} from './event-names.js'
import type {AnyAnalyticsEvent} from './events/index.js'

import {AnalyticsEvents, type AnalyticsTrackPayload} from '../transport/events/analytics-events.js'

/**
 * Type-derived properties for a given event name. Combined with the
 * generic `<E extends AnalyticsEventName>` on `emitAnalytics`, callers
 * cannot pass an unknown event name and cannot pass mismatched
 * properties for a known event. Magic-string typos (e.g.
 * `'daemon_starts'`) and wrong-shape payloads (e.g. `tool_name` on
 * `cli_invocation`) become compile errors instead of runtime drops.
 */
type PropsForEvent<E extends AnalyticsEventName> = Extract<AnyAnalyticsEvent, {name: E}>['properties']

/**
 * If the event has no required properties (e.g. `daemon_start`), the
 * `properties` argument is optional. Otherwise it is required. Implemented
 * via a rest tuple so the call site stays ergonomic.
 */
type PropsArg<E extends AnalyticsEventName> = keyof PropsForEvent<E> extends never
  ? [properties?: PropsForEvent<E>]
  : [properties: PropsForEvent<E>]

/**
 * Fire-and-forget analytics emission for non-forked daemon clients
 * (TUI, oclif, MCP, webui). Uses `client.request` (no ack) so the caller
 * never waits on the daemon.
 *
 * NEVER throws. If the client is not connected or `request` throws for
 * any reason, the error is swallowed: analytics MUST NOT crash the caller.
 */
export function emitAnalytics<E extends AnalyticsEventName>(
  client: ITransportClient,
  event: E,
  ...rest: PropsArg<E>
): void {
  const [properties] = rest
  const payload: AnalyticsTrackPayload = {event, properties}
  try {
    client.request(AnalyticsEvents.TRACK, payload)
  } catch {
    // Intentional: analytics must not crash consumers.
  }
}

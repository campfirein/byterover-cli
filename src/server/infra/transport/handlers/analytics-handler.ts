import type {IWireEventTracker} from '../../../core/interfaces/analytics/i-wire-event-tracker.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {ALL_EVENT_SCHEMAS, isAnalyticsEventName} from '../../../../shared/analytics/events/index.js'
import {
  AnalyticsEvents,
  type AnalyticsTrackPayload,
  AnalyticsTrackPayloadSchema,
} from '../../../../shared/transport/events/analytics-events.js'

export interface AnalyticsHandlerDeps {
  analyticsClient: IWireEventTracker
  transport: ITransportServer
}

/**
 * Daemon-side handler for `analytics:track`. Validates the wire payload and
 * forwards the validated event to the analytics pipeline, which stamps
 * identity + super-properties and enqueues it for later flush.
 *
 * Validation runs in two layers, both off the single source of truth
 * (`ALL_EVENT_SCHEMAS`):
 *   1. Wire envelope (`AnalyticsTrackPayloadSchema`) — `event` is a non-empty
 *      string, `properties` is record-or-undefined.
 *   2. Per-event — `isAnalyticsEventName` narrows the event to a registered
 *      name, then `ALL_EVENT_SCHEMAS[event].safeParse(properties ?? {})`
 *      validates the property shape. Unknown events and shape mismatches drop
 *      here, so the pipeline only ever receives a validated pair.
 *
 * `properties ?? {}` is injected before validation so an absent `properties`
 * is checked as `{}` — events with required properties drop, no-property
 * events pass.
 *
 * Malformed payloads and any throw from the client are silently dropped:
 * analytics MUST NOT crash the emitting client.
 */
export class AnalyticsHandler {
  private readonly analyticsClient: IWireEventTracker
  private readonly transport: ITransportServer

  public constructor(deps: AnalyticsHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.transport = deps.transport
  }

  public setup(): void {
    this.transport.onRequest<AnalyticsTrackPayload, void>(AnalyticsEvents.TRACK, async (data: unknown) => {
      const envelope = AnalyticsTrackPayloadSchema.safeParse(data)
      if (!envelope.success) return

      const {event, properties} = envelope.data
      if (!isAnalyticsEventName(event)) return

      const validated = ALL_EVENT_SCHEMAS[event].safeParse(properties ?? {})
      if (!validated.success) return

      try {
        this.analyticsClient.trackEvent(event, validated.data)
      } catch {
        // Defensive: never crash the emitter.
      }
    })
  }
}

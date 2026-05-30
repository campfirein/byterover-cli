import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'

/**
 * Capability for forwarding an already-validated analytics event (one that
 * arrived over the `analytics:track` transport event and was checked against
 * `ALL_EVENT_SCHEMAS`) into the analytics pipeline.
 *
 * Segregated from `IAnalyticsClient` (ISP): the transport handler depends only
 * on the single method it uses, so the many `IAnalyticsClient` test doubles
 * that emit via the typed `track<E>` path are unaffected. The daemon-scoped
 * `AnalyticsClient` implements both interfaces.
 *
 * `properties` is the Zod-validated property object (or `undefined`); the
 * runtime validation against the event's schema is the type guarantee, so the
 * boundary stays cast-free.
 */
export interface IWireEventTracker {
  trackEvent: (event: AnalyticsEventName, properties: Record<string, unknown> | undefined) => void
}

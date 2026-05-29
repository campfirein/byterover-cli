/**
 * Internal analytics event shape, before identity stamping. This is the wire-
 * bound event type: `AnalyticsBatch.events` carries `AnalyticsEventWithIdentity`
 * values, which extend this shape with `identity`.
 *
 * `created_at` is the wire timestamp: a strict ISO 8601 string with a
 * timezone designator (e.g. `2026-05-28T21:32:11+07:00` or `...Z`). The
 * local-only numeric sort key (`timestamp` on `StoredAnalyticsRecord`)
 * lives only on disk and never crosses the wire — see
 * `src/shared/analytics/stored-record.ts`.
 */
export type AnalyticsEvent = Readonly<{
  created_at: string
  name: string
  properties: Record<string, unknown>
}>

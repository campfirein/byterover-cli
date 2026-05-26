/**
 * Internal analytics event shape, before identity stamping. CamelCase
 * member names follow internal TS conventions; serializers at the wire
 * boundary convert (or, for analytics, the wire shape happens to coincide
 * with these field names — `name`, `properties`, `timestamp` are not
 * snake_cased on the wire).
 */
export type AnalyticsEvent = Readonly<{
  name: string
  properties: Record<string, unknown>
  timestamp: number
}>

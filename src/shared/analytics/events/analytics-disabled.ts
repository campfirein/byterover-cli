import {z} from 'zod'

/**
 * Per-event schema for `analytics_disabled`.
 *
 * No properties. The emit captures the moment the user opts out via
 * `brv settings set analytics.enabled false`; identity is stamped by the per-event identity
 * resolver and `client_kind` by the super-property layer. The disable
 * action itself is the entire signal.
 */
export const AnalyticsDisabledSchema = z.object({}).strict()

export type AnalyticsDisabledProps = z.infer<typeof AnalyticsDisabledSchema>

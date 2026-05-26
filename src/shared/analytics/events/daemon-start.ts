 
import {z} from 'zod'

/**
 * Per-event schema for `daemon_start`.
 *
 * No properties: every cold-start dimension worth tracking is already
 * stamped as a super property on every event (cli_version, os,
 * node_version, environment, device_id) by the SuperPropertiesResolver.
 * Strict mode rejects accidental property bleed.
 */
export const DaemonStartSchema = z.object({}).strict()

export type DaemonStartProps = z.infer<typeof DaemonStartSchema>

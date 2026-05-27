/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `daemon_reset_executed`.
 *
 * `brv reset` escape hatch.
 */
export const DaemonResetExecutedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    reset_scope: z.enum(['project', 'global']),
  })
  .strict()

export type DaemonResetExecutedProps = z.infer<typeof DaemonResetExecutedSchema>

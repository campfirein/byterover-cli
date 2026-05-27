/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_reset_executed`.
 */
export const VcResetExecutedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    reset_mode: z.enum(['soft', 'mixed', 'hard']),
  })
  .strict()

export type VcResetExecutedProps = z.infer<typeof VcResetExecutedSchema>

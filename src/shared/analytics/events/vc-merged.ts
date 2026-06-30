/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_merged`.
 *
 * `had_fast_forward` only known on success.
 */
export const VcMergedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    had_fast_forward: z.boolean().optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type VcMergedProps = z.infer<typeof VcMergedSchema>

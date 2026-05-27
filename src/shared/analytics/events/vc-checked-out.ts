/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_checked_out`.
 *
 * `branch_kind = 'existing' | 'created'`. Only meaningful on success.
 */
export const VcCheckedOutSchema = z
  .object({
    branch_kind: z.enum(['existing', 'created']).optional(),
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type VcCheckedOutProps = z.infer<typeof VcCheckedOutSchema>

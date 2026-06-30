/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_branched`.
 *
 * `from_default_branch` only meaningful on success.
 */
export const VcBranchedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    from_default_branch: z.boolean().optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type VcBranchedProps = z.infer<typeof VcBranchedSchema>

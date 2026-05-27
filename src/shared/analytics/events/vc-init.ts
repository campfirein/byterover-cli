/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_init`.
 *
 * `had_existing_git_dir` separates fresh-init from convert-existing.
 */
export const VcInitSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    had_existing_git_dir: z.boolean(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type VcInitProps = z.infer<typeof VcInitSchema>

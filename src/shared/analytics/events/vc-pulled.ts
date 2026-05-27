/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_pulled`.
 *
 * `branch_name_hash` = sha256 of the branch name (raw branch names may
 * carry user-identifying tokens at organizations using `<user>/<topic>`
 * conventions).
 */
export const VcPulledSchema = z
  .object({
    branch_name_hash: z.string().regex(/^[0-9a-f]{64}$/),
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    remote_kind: z.enum(['byterover', 'external']),
  })
  .strict()

export type VcPulledProps = z.infer<typeof VcPulledSchema>

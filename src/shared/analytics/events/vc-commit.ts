/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_commit`.
 *
 * `files_changed_count` is only known on success (post-commit). `had_message`
 * is known at request time. `client_kind` super-property segments CLI-typed
 * commits vs WebUI Changes-tab clicks.
 */
export const VcCommitSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    files_changed_count: z.number().int().nonnegative().optional(),
    had_message: z.boolean(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type VcCommitProps = z.infer<typeof VcCommitSchema>

/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_cloned`.
 *
 * First-touch event for a new project. `project_path_hash` only stable on
 * success (the directory exists). `remote_kind` is known at request time.
 */
export const VcClonedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    remote_kind: z.enum(['byterover', 'external']),
  })
  .strict()

export type VcClonedProps = z.infer<typeof VcClonedSchema>

/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_remote_changed`.
 *
 * Collapses the 3 `brv vc remote` subcommands via `change_kind`.
 */
export const VcRemoteChangedSchema = z
  .object({
    change_kind: z.enum(['added', 'removed', 'url_set']),
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    remote_kind: z.enum(['byterover', 'external']),
  })
  .strict()

export type VcRemoteChangedProps = z.infer<typeof VcRemoteChangedSchema>

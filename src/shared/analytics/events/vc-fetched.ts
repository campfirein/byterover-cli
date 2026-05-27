/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_fetched`.
 */
export const VcFetchedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    remote_kind: z.enum(['byterover', 'external']),
  })
  .strict()

export type VcFetchedProps = z.infer<typeof VcFetchedSchema>

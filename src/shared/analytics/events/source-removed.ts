/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `source_removed`.
 */
export const SourceRemovedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type SourceRemovedProps = z.infer<typeof SourceRemovedSchema>

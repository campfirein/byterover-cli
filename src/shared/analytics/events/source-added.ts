/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `source_added`.
 *
 * Adds another project's context tree as a read-only knowledge source.
 * `source_origin_hash` is only stable on success (raw path forbidden) —
 * optional.
 */
export const SourceAddedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    source_origin_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()

export type SourceAddedProps = z.infer<typeof SourceAddedSchema>

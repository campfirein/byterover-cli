/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `context_tree_file_edited`.
 *
 * Direct WebUI edit of a context-tree file. `byte_delta` is only known on
 * success — optional. `file_relative_path_hash` is computed at request time
 * and stays valid for both outcomes.
 */
export const ContextTreeFileEditedSchema = z
  .object({
    byte_delta: z.number().int().optional(),
    failure_kind: z.string().min(1).max(64).optional(),
    file_relative_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type ContextTreeFileEditedProps = z.infer<typeof ContextTreeFileEditedSchema>

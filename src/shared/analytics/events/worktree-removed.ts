/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `worktree_removed`.
 */
export const WorktreeRemovedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type WorktreeRemovedProps = z.infer<typeof WorktreeRemovedSchema>

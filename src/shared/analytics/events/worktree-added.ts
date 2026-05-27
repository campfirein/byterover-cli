/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `worktree_added`.
 *
 * `worktree_kind` classifies the worktree model (e.g. `pointer`, `real`).
 * Only known on success.
 */
export const WorktreeAddedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    worktree_kind: z.string().min(1).optional(),
  })
  .strict()

export type WorktreeAddedProps = z.infer<typeof WorktreeAddedSchema>

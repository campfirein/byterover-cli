/** File change type shown in the Changes panel. */
export type ChangeFileStatus = 'added' | 'deleted' | 'modified' | 'unmerged' | 'untracked'

/** Specific kind of merge conflict (mirrors git status XY codes). */
export type ConflictType = 'both_added' | 'both_modified' | 'deleted_modified'

/**
 * Agent-authored metadata attached to a `ChangeFile` when the curate tool
 * touched the same path. Joined client-side from `review:listOperations`.
 */
export interface AgentChangeMeta {
  impact?: 'high' | 'low'
  /** entry.startedAt — used to dedup multiple ops on the same file (latest wins). */
  opCreatedAt: number
  reason?: string
  reviewStatus?: 'approved' | 'pending' | 'rejected'
  summary?: string
  taskId: string
  type: 'ADD' | 'DELETE' | 'MERGE' | 'UPDATE' | 'UPSERT'
}

export function getEffectiveImpact(agentMeta: AgentChangeMeta): 'high' | 'low' {
  if (agentMeta.impact) return agentMeta.impact
  if (agentMeta.type === 'DELETE') return 'high'
  return 'low'
}

export interface ChangeFile {
  /** Agent-authored metadata; present when the curate tool touched this file. */
  agentMeta?: AgentChangeMeta
  /** Specific conflict kind; only set when `status === 'unmerged'`. */
  conflictType?: ConflictType
  /** True when the working-tree file still contains `<<<<<<<` / `=======` / `>>>>>>>` markers. */
  hasMarkers?: boolean
  /** Whether this file is currently staged. */
  isStaged: boolean
  /** Relative path from the repo root. */
  path: string
  status: ChangeFileStatus
}

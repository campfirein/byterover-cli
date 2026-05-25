import type {AgentChangeOperation} from '../../../../shared/transport/events/review-events'
import type {AgentChangeMeta, ChangeFile} from '../types'

/**
 * Attaches per-file agent metadata onto a list of `ChangeFile`s. When multiple
 * operations target the same file (e.g. several curate runs touched it), the
 * latest one wins (highest `opCreatedAt`). Files with no matching op are
 * returned unchanged. Pure — never mutates the input.
 */
export function joinAgentMeta(files: ChangeFile[], operations: AgentChangeOperation[]): ChangeFile[] {
  if (operations.length === 0) return files

  const latestByPath = new Map<string, AgentChangeOperation>()
  for (const op of operations) {
    const existing = latestByPath.get(op.filePath)
    if (!existing || op.opCreatedAt > existing.opCreatedAt) {
      latestByPath.set(op.filePath, op)
    }
  }

  return files.map((file) => {
    const op = latestByPath.get(file.path)
    if (!op) return file

    const agentMeta: AgentChangeMeta = {
      opCreatedAt: op.opCreatedAt,
      taskId: op.taskId,
      type: op.type,
    }
    if (op.impact) agentMeta.impact = op.impact
    if (op.reason) agentMeta.reason = op.reason
    if (op.summary) agentMeta.summary = op.summary
    if (op.reviewStatus) agentMeta.reviewStatus = op.reviewStatus

    return {...file, agentMeta}
  })
}

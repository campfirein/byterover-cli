/**
 * Activity Logs Hook
 *
 * Transforms tasks from transport events into ActivityLog format for display.
 */

import {useMemo} from 'react'
import {array as zArray, number as zNumber, object as zObject, string as zString} from 'zod'

import type {ActivityLog, ExecutionStatus, ToolCallStatus} from '../../../types/index.js'
import type {Task, ToolCallEvent} from '../../tasks/stores/tasks-store.js'

import {formatTaskError} from '../../../utils/error-messages.js'
import {useTasksStore} from '../../tasks/stores/tasks-store.js'

const ExecutionInputSchema = zObject({
  content: zString(),
})

// Schema for curate tool result (direct call)
const CurateResultSchema = zObject({
  result: zObject({
    applied: zArray(
      zObject({
        filePath: zString(),
        path: zString(),
        status: zString(),
        type: zString(),
      }),
    ).optional(),
  }).optional(),
})

// Schema for curate result from code_exec (via tools.curate())
// Note: summary fields are numbers (added: 1, updated: 0, etc.)
const CodeExecCurateResultSchema = zObject({
  returnValue: zObject({
    applied: zArray(
      zObject({
        filePath: zString().optional(),
        path: zString(),
        status: zString(),
        type: zString(),
      }),
    ).optional(),
    summary: zObject({
      added: zNumber().optional(),
      deleted: zNumber().optional(),
      failed: zNumber().optional(),
      merged: zNumber().optional(),
      updated: zNumber().optional(),
    }).optional(),
  }).optional(),
})

/**
 * Parse execution input to extract content
 */
export function parseExecutionContent(input: string): string {
  try {
    return ExecutionInputSchema.safeParse(JSON.parse(input))?.data?.content ?? input
  } catch {
    return input
  }
}

/**
 * Extract file changes from curate tool calls (transport events)
 * Handles both direct curate calls and curate via code_exec (tools.curate())
 */
function composeChangesFromToolCalls(toolCalls: ToolCallEvent[]): {created: string[]; updated: string[]} {
  const changes: {created: string[]; updated: string[]} = {created: [], updated: []}

  for (const tc of toolCalls) {
    if (tc.status !== 'completed' || !tc.result) {
      continue
    }

    // Parse JSON - skip if invalid
    let parsed: unknown
    try {
      parsed = JSON.parse(String(tc.result))
    } catch {
      continue
    }

    // Try to extract curate results based on tool type
    if (tc.toolName === 'curate') {
      // Direct curate tool call
      const parseResult = CurateResultSchema.safeParse(parsed)
      if (!parseResult.success) {
        continue
      }

      const result = parseResult.data.result || {}
      extractChangesFromApplied(result.applied || [], changes)
    } else if (tc.toolName === 'code_exec') {
      // Curate via code_exec (tools.curate() in sandbox)
      const parseResult = CodeExecCurateResultSchema.safeParse(parsed)
      if (!parseResult.success) {
        continue
      }

      const {returnValue} = parseResult.data
      if (returnValue?.applied) {
        extractChangesFromApplied(returnValue.applied, changes)
      }
    }
  }

  return changes
}

/**
 * Helper to extract file changes from curate applied operations
 */
function extractChangesFromApplied(
  applied: Array<{filePath?: string; path: string; status: string; type: string}>,
  changes: {created: string[]; updated: string[]},
): void {
  for (const operation of applied) {
    if (operation.status !== 'success' || !operation.filePath) {
      continue
    }

    // Handle ADD, UPDATE, and UPSERT types
    switch (operation.type) {
      case 'ADD': {
        changes.created.push(operation.filePath)
        break
      }

      case 'UPDATE': {
        changes.updated.push(operation.filePath)
        break
      }

      case 'UPSERT': {
        // UPSERT can be either create or update based on message content
        // Default to updated since UPSERT typically updates existing
        changes.updated.push(operation.filePath)
        break
      }

      default: {
        // Ignore other operation types (DELETE, MERGE, etc.)
        break
      }
    }
  }
}

export interface UseActivityLogsReturn {
  /** Activity logs derived from tasks */
  logs: ActivityLog[]
}

/**
 * Map task status to execution status
 */
function mapTaskStatusToExecutionStatus(taskStatus: Task['status']): ExecutionStatus {
  switch (taskStatus) {
    case 'cancelled': {
      return 'failed'
    }

    case 'completed': {
      return 'completed'
    }

    case 'created':
    case 'started': {
      return 'running'
    }

    case 'error': {
      return 'failed'
    }

    default: {
      return 'running'
    }
  }
}

/**
 * Map tool call status to ToolCallStatus
 */
function mapToolCallStatus(status: ToolCallEvent['status']): ToolCallStatus {
  switch (status) {
    case 'completed': {
      return 'completed'
    }

    case 'error': {
      return 'failed'
    }

    case 'running': {
      return 'running'
    }

    default: {
      return 'running'
    }
  }
}

/**
 * Hook that transforms tasks from transport events into ActivityLog format
 */
export function useActivityLogs(): UseActivityLogsReturn {
  const tasks = useTasksStore((s) => s.tasks)

  const logs = useMemo(() => {
    const taskArray = [...tasks.values()]

    return taskArray
      .filter((task) => task.status !== 'created')
      .map((task) => {
        // Include tool args and timestamp in progress items for display
        const progress = task.toolCalls.map((tc, index) => ({
          args: tc.args,
          id: tc.callId ?? `${task.taskId}-${index}`,
          status: mapToolCallStatus(tc.status),
          timestamp: tc.timestamp,
          toolCallName: tc.toolName,
        }))

        const changes = composeChangesFromToolCalls(task.toolCalls)

        let content = task.status === 'error' ? formatTaskError(task.error) : (task.result ?? '')
        if (task.reviewNotification) {
          const {pendingCount, reviewUrl} = task.reviewNotification
          const fileLabel = pendingCount === 1 ? 'file needs' : 'files need'
          content += `\n\n⚠ ${pendingCount} ${fileLabel} review` + (reviewUrl ? `: ${reviewUrl}` : '')
        }

        const activityLog: ActivityLog = {
          changes,
          content,
          files: task.files,
          folders: task.folders,
          id: task.taskId,
          input: task.content,
          isStreaming: task.isStreaming,
          reasoningContents: task.reasoningContents,
          source: 'agent',
          status: mapTaskStatusToExecutionStatus(task.status),
          streamingContent: task.streamingContent,
          timestamp: new Date(task.startedAt ?? task.createdAt),
          toolCalls: progress,
          type: task.type,
        }

        return activityLog
      })
  }, [tasks])

  return {logs}
}

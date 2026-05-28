import type {TaskListItem, TaskListItemStatus} from '../../../../shared/transport/events/task-events'

export type TaskStatusGroup = 'completed' | 'in_progress' | 'pending'

/**
 * Display the task type without internal mode suffixes. All curate variants
 * (`curate`, `curate-folder`, `curate-tool-mode`) flatten to `curate`; the
 * query MCP/CLI variant (`query-tool-mode`) flattens to `query`. The detail
 * view shows mode-specific rendering when it matters.
 */
export function displayTaskType(type: string): string {
  if (type === 'curate-folder' || type === 'curate-tool-mode') return 'curate'
  if (type === 'query-tool-mode') return 'query'
  return type
}

/**
 * Expand a list of UI-facing task-type filters into the underlying server
 * task-type values. `curate` matches all curate variants; `query` matches
 * both LLM-driven and tool-mode queries.
 */
export function expandTaskTypeFilter(typeFilter: readonly string[]): string[] {
  const expanded = new Set<string>()
  for (const value of typeFilter) {
    if (value === 'curate') {
      expanded.add('curate').add('curate-folder').add('curate-tool-mode')
    } else if (value === 'query') {
      expanded.add('query').add('query-tool-mode')
    } else {
      expanded.add(value)
    }
  }

  return [...expanded]
}

export const TASK_STATUS_GROUPS: TaskStatusGroup[] = ['pending', 'in_progress', 'completed']

const TERMINAL_STATUSES = new Set<TaskListItemStatus>(['cancelled', 'completed', 'error'])

export function toStatusGroup(status: TaskListItemStatus): TaskStatusGroup {
  if (status === 'created') return 'pending'
  if (status === 'started') return 'in_progress'
  return 'completed'
}

export function isTerminalStatus(status: TaskListItemStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function isActiveStatus(status: TaskListItemStatus): boolean {
  return !TERMINAL_STATUSES.has(status)
}

export interface TaskGroupCounts {
  completed: number
  inProgress: number
  pending: number
  total: number
}

export function countByGroup(tasks: TaskListItem[]): TaskGroupCounts {
  const counts: TaskGroupCounts = {completed: 0, inProgress: 0, pending: 0, total: tasks.length}
  for (const task of tasks) {
    const group = toStatusGroup(task.status)
    if (group === 'pending') counts.pending++
    else if (group === 'in_progress') counts.inProgress++
    else counts.completed++
  }

  return counts
}

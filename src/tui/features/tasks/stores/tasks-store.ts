/**
 * Tasks Store
 *
 * Zustand store for task lifecycle state.
 * Subscribes to task:* and llmservice:* transport events.
 */

import {create} from 'zustand'

import type {ReasoningContentItem, ToolCallEvent} from '../../../../shared/transport/events/task-events.js'
import type {TaskStats} from '../../../types/ui.js'

// ============================================================================
// Task Types (local to TUI — no server imports)
// ============================================================================

export type TaskStatus = 'cancelled' | 'completed' | 'created' | 'error' | 'started'

export type {ReasoningContentItem, ToolCallEvent} from '../../../../shared/transport/events/task-events.js'

export interface TaskErrorData {
  code?: string
  message: string
}

export interface ReviewNotification {
  pendingCount: number
  reviewUrl?: string
}

export interface Task {
  completedAt?: number
  content: string
  createdAt: number
  error?: TaskErrorData
  files?: string[]
  folders?: string[]
  input: string
  isStreaming?: boolean
  reasoningContents?: ReasoningContentItem[]
  result?: string
  /** Set when curate completes with pending HITL review operations. */
  reviewNotification?: ReviewNotification
  sessionId?: string
  startedAt?: number
  status: TaskStatus
  streamingContent?: string
  taskId: string
  toolCalls: ToolCallEvent[]
  type: 'curate' | 'query'
}

// ============================================================================
// Store
// ============================================================================

export interface TasksState {
  stats: TaskStats
  tasks: Map<string, Task>
}

export interface TasksActions {
  /** Add a reasoning content item to a task */
  addReasoningContent: (taskId: string, item: ReasoningContentItem) => void
  /** Add or update a tool call on a task */
  addToolCall: (taskId: string, toolCall: ToolCallEvent) => void
  /** Append streaming content to a task */
  appendStreamingContent: (params: {
    content: string
    isComplete: boolean
    sessionId?: string
    taskId: string
    type: 'reasoning' | 'text'
  }) => void
  /** Clear the review notification on a task (called after approve/reject) */
  clearReviewNotification: (taskId: string) => void
  /** Clear all tasks */
  clearTasks: () => void
  /** Create a new task */
  createTask: (taskId: string, type: 'curate' | 'query', content: string, files?: string[]) => void
  /** Get a task by ID */
  getTask: (taskId: string) => Task | undefined
  /** Remove a task from local state (driven by `task:deleted` broadcast). */
  removeTask: (taskId: string) => void
  /** Set task to cancelled */
  setCancelled: (taskId: string) => void
  /** Set task to completed with result */
  setCompleted: (taskId: string, result?: string) => void
  /** Set task error */
  setError: (taskId: string, error: TaskErrorData) => void
  /** Set task LLM response (final) */
  setResponse: (taskId: string, content: string, sessionId?: string) => void
  /** Set review notification on a completed curate task */
  setReviewNotification: (taskId: string, notification: ReviewNotification) => void
  /** Set task to started */
  setStarted: (taskId: string) => void
  /** Update a tool call result */
  updateToolCallResult: (params: {
    callId: string | undefined
    error?: string
    errorType?: string
    result?: unknown
    success: boolean
    taskId: string
    toolName: string
  }) => void
}

function computeStats(tasks: Map<string, Task>): TaskStats {
  let created = 0
  let started = 0
  for (const task of tasks.values()) {
    if (task.status === 'created') created++
    else if (task.status === 'started') started++
  }

  return {created, started}
}

export const useTasksStore = create<TasksActions & TasksState>()((set, get) => ({
  addReasoningContent: (taskId, item) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) return state

      // Deduplicate: don't add another thinking item if last one is still thinking
      const existing = task.reasoningContents ?? []
      const last = existing.at(-1)
      if (item.isThinking && last?.isThinking) return state

      const tasks = new Map(state.tasks)
      tasks.set(taskId, {
        ...task,
        reasoningContents: [...existing, item],
      })
      return {stats: computeStats(tasks), tasks}
    }),
  addToolCall: (taskId, toolCall) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) return state

      const tasks = new Map(state.tasks)

      // Deduplicate by callId
      const existingIndex = toolCall.callId ? task.toolCalls.findIndex((tc) => tc.callId === toolCall.callId) : -1

      if (existingIndex >= 0) {
        const existing = task.toolCalls[existingIndex]
        const hasNewArgs = toolCall.args && Object.keys(toolCall.args).length > 0
        const updatedCalls = [...task.toolCalls]
        updatedCalls[existingIndex] = {
          ...existing,
          args: hasNewArgs ? toolCall.args : existing.args,
          sessionId: toolCall.sessionId,
        }
        tasks.set(taskId, {...task, sessionId: toolCall.sessionId, toolCalls: updatedCalls})
      } else {
        tasks.set(taskId, {
          ...task,
          sessionId: toolCall.sessionId,
          toolCalls: [...task.toolCalls, toolCall],
        })
      }

      return {stats: computeStats(tasks), tasks}
    }),

  appendStreamingContent: ({content, isComplete, sessionId, taskId, type}) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) return state

      const tasks = new Map(state.tasks)

      if (type === 'reasoning') {
        const existing = task.reasoningContents ?? []
        const lastIndex = existing.length - 1
        const lastItem = existing[lastIndex]
        if (lastItem) {
          const updated = [...existing]
          updated[lastIndex] = {
            ...lastItem,
            content: lastItem.content + content,
            isThinking: false,
          }
          tasks.set(taskId, {
            ...task,
            isStreaming: !isComplete,
            reasoningContents: updated,
            sessionId: sessionId ?? task.sessionId,
          })
        } else {
          // No placeholder from llmservice:thinking — create one from first chunk
          tasks.set(taskId, {
            ...task,
            isStreaming: !isComplete,
            reasoningContents: [{content, isThinking: false, timestamp: Date.now()}],
            sessionId: sessionId ?? task.sessionId,
          })
        }
      } else {
        tasks.set(taskId, {
          ...task,
          isStreaming: !isComplete,
          sessionId: sessionId ?? task.sessionId,
          streamingContent: (task.streamingContent ?? '') + content,
        })
      }

      return {stats: computeStats(tasks), tasks}
    }),

  clearReviewNotification: (taskId) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task?.reviewNotification) return state

      const tasks = new Map(state.tasks)
      tasks.set(taskId, {...task, reviewNotification: undefined})
      return {stats: computeStats(tasks), tasks}
    }),

  clearTasks: () => set({stats: {created: 0, started: 0}, tasks: new Map()}),

  createTask: (taskId, type, content, files) =>
    set((state) => {
      const tasks = new Map(state.tasks)
      tasks.set(taskId, {
        content,
        createdAt: Date.now(),
        files,
        input: content,
        status: 'created',
        taskId,
        toolCalls: [],
        type,
      })
      return {stats: computeStats(tasks), tasks}
    }),

  getTask: (taskId) => get().tasks.get(taskId),

  removeTask: (taskId) =>
    set((state) => {
      if (!state.tasks.has(taskId)) return state
      const tasks = new Map(state.tasks)
      tasks.delete(taskId)
      return {stats: computeStats(tasks), tasks}
    }),

  setCancelled: (taskId) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) {
        // Handle missed task:created
        const tasks = new Map(state.tasks)
        const now = Date.now()
        tasks.set(taskId, {
          completedAt: now,
          content: '',
          createdAt: now,
          input: '',
          startedAt: now,
          status: 'cancelled',
          taskId,
          toolCalls: [],
          type: 'query',
        })
        return {stats: computeStats(tasks), tasks}
      }

      const tasks = new Map(state.tasks)
      tasks.set(taskId, {...task, completedAt: Date.now(), status: 'cancelled'})
      return {stats: computeStats(tasks), tasks}
    }),

  setCompleted: (taskId, result) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      const now = Date.now()
      const tasks = new Map(state.tasks)

      if (task) {
        const finalizedToolCalls = task.toolCalls.map((tc) =>
          tc.status === 'running' ? {...tc, status: 'completed' as const} : tc,
        )
        const finalizedReasoning = task.reasoningContents?.filter((rc) => !rc.isThinking)
        tasks.set(taskId, {
          ...task,
          completedAt: now,
          reasoningContents: finalizedReasoning,
          result,
          status: 'completed',
          toolCalls: finalizedToolCalls,
        })
      } else {
        tasks.set(taskId, {
          completedAt: now,
          content: '',
          createdAt: now,
          input: '',
          result,
          startedAt: now,
          status: 'completed',
          taskId,
          toolCalls: [],
          type: 'query',
        })
      }

      return {stats: computeStats(tasks), tasks}
    }),

  setError: (taskId, error) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      const now = Date.now()
      const tasks = new Map(state.tasks)

      if (task) {
        const finalizedToolCalls = task.toolCalls.map((tc) =>
          tc.status === 'running' ? {...tc, status: 'error' as const} : tc,
        )
        tasks.set(taskId, {
          ...task,
          completedAt: now,
          error,
          status: 'error',
          toolCalls: finalizedToolCalls,
        })
      } else {
        tasks.set(taskId, {
          completedAt: now,
          content: '',
          createdAt: now,
          error,
          input: '',
          startedAt: now,
          status: 'error',
          taskId,
          toolCalls: [],
          type: 'query',
        })
      }

      return {stats: computeStats(tasks), tasks}
    }),

  setResponse: (taskId, content, sessionId) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) return state

      const tasks = new Map(state.tasks)
      tasks.set(taskId, {
        ...task,
        isStreaming: false,
        result: content,
        sessionId: sessionId ?? task.sessionId,
        streamingContent: undefined,
      })
      return {stats: computeStats(tasks), tasks}
    }),

  setReviewNotification: (taskId, notification) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) return state

      const tasks = new Map(state.tasks)
      tasks.set(taskId, {...task, reviewNotification: notification})
      return {stats: computeStats(tasks), tasks}
    }),

  setStarted: (taskId) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) return state

      const tasks = new Map(state.tasks)
      tasks.set(taskId, {...task, startedAt: Date.now(), status: 'started'})
      return {stats: computeStats(tasks), tasks}
    }),

  stats: {created: 0, started: 0},

  tasks: new Map(),

  updateToolCallResult: ({callId, error, errorType, result, success, taskId, toolName}) =>
    set((state) => {
      const task = state.tasks.get(taskId)
      if (!task) return state

      // Find by callId first, then fallback to toolName
      let index = -1
      if (callId) {
        index = task.toolCalls.findIndex((tc) => tc.callId === callId)
      }

      if (index === -1 && toolName) {
        for (let i = task.toolCalls.length - 1; i >= 0; i--) {
          if (task.toolCalls[i].toolName === toolName && task.toolCalls[i].status === 'running') {
            index = i
            break
          }
        }
      }

      if (index === -1) return state

      const updatedCalls = [...task.toolCalls]
      updatedCalls[index] = {
        ...updatedCalls[index],
        error,
        errorType,
        result,
        status: success ? 'completed' : 'error',
      }

      const tasks = new Map(state.tasks)
      tasks.set(taskId, {...task, toolCalls: updatedCalls})
      return {stats: computeStats(tasks), tasks}
    }),
}))

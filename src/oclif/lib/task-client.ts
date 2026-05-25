/**
 * Shared task event subscription utilities for oclif commands.
 *
 * Mirrors TUI's useTaskSubscriptions pattern: subscribes to all task and LLM events,
 * collects tool calls, and streams output in real-time.
 *
 * Used by: curate, query commands.
 */
import type {
  ITransportClient,
  LlmChunk,
  LlmResponse,
  LlmToolCall,
  LlmToolResult,
  TaskCompleted,
  TaskError,
} from '@campfirein/brv-transport-client'

import type {QueryLogMatchedDoc, QueryLogTier} from '../../server/core/domain/entities/query-log-entry.js'

import {TaskErrorCode} from '../../server/core/domain/errors/task-error.js'
import {LlmEvents, TaskEvents, type TaskHeartbeatEvent} from '../../shared/transport/events/index.js'
import {ReviewEvents, type ReviewNotifyEvent} from '../../shared/transport/events/review-events.js'
import {writeJsonResponse} from './json-response.js'

/**
 * Extends brv-transport-client's TaskCompleted with daemon-merged extras contributed by
 * lifecycle hooks (`getTaskCompletionData`):
 * - `logId` — query/curate log id
 * - `pendingReviewCount` — HITL signal from CurateLogHandler
 * - `matchedDocs`/`tier`/`durationMs`/`topScore` — query recall metadata from QueryLogHandler
 *   (flattened from QueryExecutorResult's nested timing/searchMetadata)
 *
 * All fields are optional — older daemons or non-query tasks omit them.
 */
type TaskCompletedWithLogId = TaskCompleted & {
  durationMs?: number
  logId?: string
  matchedDocs?: QueryLogMatchedDoc[]
  pendingReviewCount?: number
  tier?: QueryLogTier
  topScore?: number
}

/** Extends brv-transport-client's TaskError with logId from ENG-1259 */
type TaskErrorWithLogId = TaskError & {logId?: string}

/** Collected tool call with result (mirrors TUI ToolCallEvent) */
export interface ToolCallRecord {
  args: Record<string, unknown>
  callId?: string
  error?: string
  result?: unknown
  status: 'completed' | 'error' | 'running'
  success?: boolean
  toolName: string
}

/** Completion result passed to onCompleted callback */
export interface TaskCompletionResult {
  /** Wall-clock execution time for query tasks, in milliseconds. Absent for non-query tasks. */
  durationMs?: number
  logId?: string
  /** Documents matched by the query. Empty array on cache hits; absent for non-query tasks. */
  matchedDocs?: QueryLogMatchedDoc[]
  /** Pending review notification from the server, present when review is required after task completion. */
  pendingReview?: {pendingCount: number; reviewUrl?: string}
  result?: string
  taskId: string
  /** Resolution tier for query tasks. Absent for non-query tasks. */
  tier?: QueryLogTier
  toolCalls: ToolCallRecord[]
  /** Top compound score across matchedDocs. Absent for cache hits and non-query tasks. */
  topScore?: number
}

/** Error result passed to onError callback */
export interface TaskErrorResult {
  error: {code?: string; message: string}
  logId?: string
  taskId: string
  toolCalls: ToolCallRecord[]
}

/**
 * Subset of ITransportClient used by waitForTaskCompletion + installSigintCancel.
 * Narrow on purpose so test stubs can satisfy the contract structurally without
 * an `as unknown as ITransportClient` cast.
 */
export type WaitForTaskClient = Pick<ITransportClient, 'on' | 'onStateChange' | 'request'>

/** Options for waitForTaskCompletion */
export interface WaitForTaskOptions {
  /** Client to subscribe events on */
  client: WaitForTaskClient
  /** Command name for JSON output */
  command: string
  /** Output format */
  format: 'json' | 'text'
  /** Called on task:cancelled (terminal). Optional; defaults to a no-op so legacy callers stay compatible. */
  onCancelled?: (result: {taskId: string; toolCalls: ToolCallRecord[]}) => void
  /** Called on task:completed */
  onCompleted: (result: TaskCompletionResult) => void
  /** Called on task:error */
  onError: (result: TaskErrorResult) => void
  /** Called on llmservice:response (optional, used by query to display final answer) */
  onResponse?: (content: string, taskId: string) => void
  /** Task ID to wait for */
  taskId: string
}

/** Grace period before treating 'reconnecting' as daemon death (ms) */
const DISCONNECT_GRACE_MS = 10_000
/** Default timeout for task completion (seconds) — kept for back-compat with the deprecated `--timeout` flag. */
export const DEFAULT_TIMEOUT_SECONDS = 300
/** Minimum --timeout value accepted from the CLI (seconds). Deprecated. */
export const MIN_TIMEOUT_SECONDS = 10
/** Maximum --timeout value accepted from the CLI (seconds). Deprecated. */
export const MAX_TIMEOUT_SECONDS = 3600

/**
 * Maximum time the CLI tolerates without any task-scoped event before
 * declaring the daemon stuck. Sized at ~3x the daemon's heartbeat
 * interval (`TASK_HEARTBEAT_INTERVAL_MS = 10_000`) so a single missed
 * heartbeat does not trigger a false positive.
 */
const STALE_THRESHOLD_MS = 30_000
/** How often the CLI re-checks `Date.now() - lastActivityAt`. */
const STALE_CHECK_INTERVAL_MS = 5000

/**
 * Format tool call for CLI display (simplified version of TUI formatToolDisplay).
 */
export function formatToolDisplay(toolName: string, args: Record<string, unknown>): string {
  switch (toolName.toLowerCase()) {
    case 'bash': {
      const cmd = args.command ? String(args.command) : ''
      return `Bash ${cmd.length > 60 ? `$ ${cmd.slice(0, 57)}...` : `$ ${cmd}`}`
    }

    case 'code_exec': {
      return 'CodeExec'
    }

    case 'edit': {
      const filePath = args.file_path ?? args.filePath
      return filePath ? `Edit ${filePath}` : 'Edit'
    }

    case 'glob': {
      const {path, pattern} = args
      return pattern ? `Glob "${pattern}"${path ? ` in ${path}` : ''}` : 'Glob'
    }

    case 'grep': {
      const {path, pattern} = args
      return pattern ? `Grep "${pattern}"${path ? ` in ${path}` : ''}` : 'Grep'
    }

    case 'read': {
      const filePath = args.file_path ?? args.filePath
      return filePath ? `Read ${filePath}` : 'Read'
    }

    case 'write': {
      const filePath = args.file_path ?? args.filePath
      return filePath ? `Write ${filePath}` : 'Write'
    }

    default: {
      return toolName
    }
  }
}

/**
 * Install a SIGINT handler that turns Ctrl-C into a graceful cancel for the
 * current foreground task. First Ctrl-C emits `task:cancel` and writes a hint
 * to stderr (so JSON stdout stays clean). Second Ctrl-C hard-exits with code
 * 130 — the conventional SIGINT exit code.
 *
 * Returns an unsubscribe function so callers can remove the handler in their
 * cleanup path. Always uninstall to keep the signal stack clean for any work
 * that runs after wait returns (e.g., subsequent commands in the same process).
 */
function installSigintCancel(deps: {client: Pick<ITransportClient, 'request'>; taskId: string}): () => void {
  let cancelRequested = false

  const onSigint = (): void => {
    if (cancelRequested) {
      // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
      process.exit(130)
      return
    }

    cancelRequested = true
    process.stderr.write('\nCancelling task... (Ctrl-C again to force exit)\n')
    // Fire-and-forget; we await the daemon's task:cancelled broadcast in the
    // wait loop. The daemon may also respond with success/false on a stale id;
    // we ignore that here because the wait loop times out or sees a terminal
    // event either way. Wrapped in try/catch so a synchronously-throwing
    // transport (already-disconnected socket, etc.) doesn't propagate out of
    // the signal handler and crash the process with an uncaught exception.
    try {
      deps.client.request(TaskEvents.CANCEL, {taskId: deps.taskId})
    } catch (error) {
      // Transport unavailable — the wait loop will time out or see a
      // disconnect event and surface that path instead. Log the swallowed
      // throw to stderr so a genuine bug (bad payload, transport regression)
      // leaves a breadcrumb instead of failing silently.
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[brv] cancel request failed locally: ${message}\n`)
    }
  }

  process.on('SIGINT', onSigint)
  return () => process.off('SIGINT', onSigint)
}

/**
 * Wait for task completion by subscribing to all events (same as TUI useTaskSubscriptions).
 * In text mode: streams tool calls and thinking in real-time via log().
 * In JSON mode: streams each event as a separate JSON line.
 *
 * Rejects with a retryable error (AGENT_DISCONNECTED) on daemon disconnect,
 * allowing withDaemonRetry to handle reconnection.
 */
export function waitForTaskCompletion(options: WaitForTaskOptions, log: (msg: string) => void): Promise<void> {
  const {client, command, format, onCancelled, onCompleted, onError, onResponse, taskId} = options
  const isText = format === 'text'

  return new Promise((resolve, reject) => {
    let completed = false
    let disconnectTimer: NodeJS.Timeout | undefined
    const toolCalls: ToolCallRecord[] = []
    let pendingReview: undefined | {pendingCount: number; reviewUrl?: string}
    let lastActivityAt = Date.now()
    const markActive = (): void => {
      lastActivityAt = Date.now()
    }

    const rejectRetryable = (message: string): void => {
      if (completed) return
      completed = true
      cleanup()
      reject(Object.assign(new Error(message), {code: TaskErrorCode.AGENT_DISCONNECTED}))
    }

    // Heartbeat-driven liveness watcher. The daemon emits
    // `TaskEvents.HEARTBEAT` every ~10s during quiet periods and any
    // other task-scoped event refreshes `lastActivityAt`. A single
    // "Task timed out after Xs" misfire while the daemon was making
    // progress is what M6 is replacing — when nothing arrives within
    // ~30s the daemon really is stuck.
    const staleCheckTimer = setInterval(() => {
      if (completed) return
      if (Date.now() - lastActivityAt > STALE_THRESHOLD_MS) {
        completed = true
        cleanup()
        const message = 'Daemon is unresponsive on this task'
        if (isText) {
          reject(new Error(message))
        } else {
          writeJsonResponse({
            command,
            data: {event: 'error', message, status: 'error'},
            success: false,
          })
          resolve()
        }
      }
    }, STALE_CHECK_INTERVAL_MS)

    const unsubscribers = [
      // Heartbeat — keeps the stale-check alive during quiet phases.
      client.on<TaskHeartbeatEvent>(TaskEvents.HEARTBEAT, (data) => {
        if (data.taskId !== taskId) return
        markActive()
      }),

      // Cold-start liveness signals. The daemon emits `task:created`
      // synchronously and `task:ack` after lifecycle hooks, both BEFORE
      // the agent forks. `task:started` follows once the agent has
      // booted and is the trigger for heartbeat registration. Without
      // subscribing here, a cold start that exceeds `STALE_THRESHOLD_MS`
      // before the first heartbeat (e.g. agent fork + provider RTTs on
      // Windows under AV) falsely rejects as "Daemon is unresponsive".
      client.on<{taskId: string}>(TaskEvents.CREATED, (data) => {
        if (data.taskId !== taskId) return
        markActive()
      }),
      client.on<{taskId: string}>(TaskEvents.ACK, (data) => {
        if (data.taskId !== taskId) return
        markActive()
      }),
      client.on<{taskId: string}>(TaskEvents.STARTED, (data) => {
        if (data.taskId !== taskId) return
        markActive()
      }),

      // Tool call started (same as TUI addToolCall)
      client.on<LlmToolCall>(LlmEvents.TOOL_CALL, (data) => {
        if (data.taskId !== taskId) return
        markActive()
        toolCalls.push({
          args: data.args,
          callId: data.callId,
          status: 'running',
          toolName: data.toolName,
        })

        if (!isText) {
          writeJsonResponse({
            command,
            data: {args: data.args, event: 'toolCall', taskId, toolName: data.toolName},
            success: true,
          })
        }
      }),

      // Tool call completed (same as TUI updateToolCallResult)
      client.on<LlmToolResult>(LlmEvents.TOOL_RESULT, (data) => {
        if (data.taskId !== taskId) return
        markActive()

        let index = -1
        if (data.callId) {
          index = toolCalls.findIndex((tc) => tc.callId === data.callId)
        }

        if (index === -1) {
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].toolName === data.toolName && toolCalls[i].status === 'running') {
              index = i
              break
            }
          }
        }

        if (index >= 0) {
          const tc = toolCalls[index]
          toolCalls[index] = {
            ...tc,
            error: data.error,
            result: data.result,
            status: data.success ? 'completed' : 'error',
            success: data.success,
          }

          if (isText) {
            const icon = data.success ? '✓' : '✗'
            log(`  ${icon} ${formatToolDisplay(tc.toolName, tc.args)}`)
          } else {
            writeJsonResponse({
              command,
              data: {
                error: data.error,
                event: 'toolResult',
                success: data.success,
                taskId,
                toolName: data.toolName,
              },
              success: true,
            })
          }
        }
      }),

      // Thinking started (same as TUI addReasoningContent)
      client.on<{taskId: string}>(LlmEvents.THINKING, (data) => {
        if (data.taskId !== taskId) return
        markActive()

        if (isText) {
          log('  Thinking...')
        } else {
          writeJsonResponse({
            command,
            data: {event: 'thinking', taskId},
            success: true,
          })
        }
      }),

      // Streaming chunk (same as TUI appendStreamingContent) — silent for CLI
      client.on<LlmChunk>(LlmEvents.CHUNK, (data) => {
        // Collected by TUI for streaming display; CLI doesn't render partial chunks
        if (data.taskId !== taskId) return
        markActive()
      }),

      // LLM response (final answer — used by query command)
      client.on<LlmResponse>(LlmEvents.RESPONSE, (data) => {
        if (data.taskId !== taskId) return
        markActive()
        if (onResponse) onResponse(data.content, data.taskId)
      }),

      // Pending review notification — emitted by server after curate completes with review-required ops
      client.on<ReviewNotifyEvent>(ReviewEvents.NOTIFY, (data) => {
        if (data.taskId === taskId) {
          pendingReview = {pendingCount: data.pendingCount, reviewUrl: data.reviewUrl}
        }
      }),

      // Task completed
      client.on<TaskCompletedWithLogId>(TaskEvents.COMPLETED, (payload) => {
        if (payload.taskId !== taskId || completed) return
        completed = true
        cleanup()
        // Prefer pendingReviewCount embedded in payload (set synchronously by server before task:completed).
        // Falls back to review:notify capture for backward compatibility.
        const resolvedPendingReview =
          payload.pendingReviewCount !== undefined && payload.pendingReviewCount > 0
            ? {pendingCount: payload.pendingReviewCount, reviewUrl: pendingReview?.reviewUrl}
            : pendingReview
        onCompleted({
          durationMs: payload.durationMs,
          logId: payload.logId,
          matchedDocs: payload.matchedDocs,
          pendingReview: resolvedPendingReview,
          result: payload.result,
          taskId,
          tier: payload.tier,
          toolCalls,
          topScore: payload.topScore,
        })
        resolve()
      }),

      // Task error
      client.on<TaskErrorWithLogId>(TaskEvents.ERROR, (payload) => {
        if (payload.taskId !== taskId || completed) return
        completed = true
        cleanup()
        onError({error: payload.error, logId: payload.logId, taskId, toolCalls})
        if (isText) {
          reject(
            Object.assign(new Error(payload.error.message), {code: payload.error.code ?? TaskErrorCode.TASK_EXECUTION}),
          )
        } else {
          resolve()
        }
      }),

      // Task cancelled (terminal) — broadcast by the daemon in response to
      // either a foreground Ctrl-C (handler below) or a remote --cancel from
      // another terminal. Treated as a terminal event so the wait loop
      // unblocks instead of hanging and no phantom "Daemon is unresponsive"
      // fires afterward. The per-command `onCancelled` callback owns the
      // user-facing message (success flag, exit code semantics).
      client.on<{taskId: string}>(TaskEvents.CANCELLED, (payload) => {
        if (payload.taskId !== taskId || completed) return
        completed = true
        cleanup()
        onCancelled?.({taskId, toolCalls})
        resolve()
      }),

      // Connection state monitoring
      client.onStateChange((state) => {
        if (completed) return

        if (state === 'reconnecting') {
          disconnectTimer = setTimeout(() => {
            rejectRetryable('Daemon disconnected')
          }, DISCONNECT_GRACE_MS)
        }

        if (state === 'connected' && disconnectTimer) {
          clearTimeout(disconnectTimer)
          disconnectTimer = undefined
        }

        if (state === 'disconnected') {
          if (disconnectTimer) {
            clearTimeout(disconnectTimer)
            disconnectTimer = undefined
          }

          rejectRetryable('Daemon disconnected')
        }
      }),

      () => clearInterval(staleCheckTimer),
      () => {
        if (disconnectTimer) clearTimeout(disconnectTimer)
      },
      installSigintCancel({client, taskId}),
    ]

    const cleanup = (): void => {
      for (const unsub of unsubscribers) unsub()
    }
  })
}

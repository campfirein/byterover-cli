/**
 * Agent executor terminal-error handler.
 *
 * Decides between two terminal events when the task body throws:
 *   - `SessionCancelledError`  → suppress `task:error` (T1.1's cancel listener
 *     has already emitted `task:cancelled`). Returns silently so the persisted
 *     history reflects the daemon's `status: 'cancelled'` instead of `error`.
 *   - Anything else            → emit `task:error` with the usual serialized
 *     payload.
 *
 * Extracted from agent-process.ts so the dispatch logic is unit-testable.
 */

import type {ITransportClient} from '@campfirein/brv-transport-client'

import {SessionCancelledError} from '../../../agent/core/domain/errors/session-error.js'
import {serializeTaskError} from '../../core/domain/errors/task-error.js'
import {TransportTaskEventNames} from '../../core/domain/transport/schemas.js'

export type HandleExecutorTerminalErrorOptions = {
  clientId: string
  error: unknown
  log: (msg: string) => void
  projectPath: string
  taskId: string
  transport: Pick<ITransportClient, 'request'>
}

/**
 * Map one executor throw to the right terminal transport event.
 * Cancellation is treated as a deliberate end, not a failure: no `task:error`
 * is emitted on that path. The cancel listener in T1.1 owns the
 * `task:cancelled` emission, so this handler stays silent on cancel.
 *
 * @param options - error + identifiers + transport/log collaborators
 */
export function handleExecutorTerminalError(options: HandleExecutorTerminalErrorOptions): void {
  const {clientId, error, log, projectPath, taskId, transport} = options

  if (error instanceof SessionCancelledError) {
    log(`task cancelled mid-execute taskId=${taskId} — suppressing task:error (cancel listener emits task:cancelled)`)
    return
  }

  const errorData = serializeTaskError(error)
  log(`task:error taskId=${taskId} error=${errorData.message}`)
  try {
    transport.request(TransportTaskEventNames.ERROR, {clientId, error: errorData, projectPath, taskId})
  } catch (sendError) {
    const message = sendError instanceof Error ? sendError.message : String(sendError)
    log(`task:error send failed taskId=${taskId}: ${message}`)
  }
}

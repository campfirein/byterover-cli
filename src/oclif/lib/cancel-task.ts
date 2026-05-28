/**
 * Shared CLI helper that emits one task:cancel request and surfaces the
 * response either as a plain text line or as the project's standard JSON
 * envelope. Consumed by the curate, query, and dream commands' `--cancel`
 * flag — the only place in the CLI where the cancel transport event name
 * and request shape appear.
 *
 * Lives in the oclif layer only; do not export beyond it.
 */

import type {ITransportClient} from '@campfirein/brv-transport-client'

import type {TaskCancelRequest, TaskCancelResponse} from '../../shared/transport/events/task-events.js'

import {TaskEvents} from '../../shared/transport/events/task-events.js'
import {type DaemonClientOptions, withDaemonRetry} from './daemon-client.js'
import {writeJsonResponse} from './json-response.js'

export type RunCancelTaskOptions = {
  /** Pre-connected transport client (caller owns the lifecycle / retry wrapper). */
  client: ITransportClient
  /** Name of the invoking CLI command — stamped on the JSON envelope. */
  command: string
  /** Output format. JSON writes the project's standard envelope to stdout; text logs a single line. */
  format: 'json' | 'text'
  /** Callback for text-mode output. Caller decides whether this goes to stdout, stderr, or oclif. */
  log: (msg: string) => void
  /** Task to cancel. */
  taskId: string
}

const UNKNOWN_ERROR = 'unknown error'

/**
 * Send the cancel request, format the response, return whether the cancel
 * succeeded so the caller can decide on exit code. Does not throw on a
 * daemon-reported failure — only on transport-level errors propagated by
 * `client.requestWithAck`.
 */
export async function runCancelTask(options: RunCancelTaskOptions): Promise<boolean> {
  const {client, command, format, log, taskId} = options

  const response = await client.requestWithAck<TaskCancelResponse, TaskCancelRequest>(TaskEvents.CANCEL, {taskId})

  if (format === 'json') {
    writeJsonResponse({
      command,
      data: response.success
        ? {status: 'cancelled', taskId}
        : {error: response.error ?? UNKNOWN_ERROR, status: 'error', taskId},
      success: response.success,
    })
    return response.success
  }

  if (response.success) {
    log(`Cancelled ${taskId}`)
  } else {
    log(`Failed to cancel ${taskId}: ${response.error ?? UNKNOWN_ERROR}`)
  }

  return response.success
}

export type RunCancelBranchOptions = {
  /** Name of the invoking CLI command — stamped on the JSON envelope. */
  command: string
  /** Forwarded to withDaemonRetry. Lets each command override retry/connector for tests. */
  daemonClientOptions: DaemonClientOptions
  /** Output format. */
  format: 'json' | 'text'
  /** Text-mode log sink (typically `(msg) => this.log(msg)` in oclif). */
  log: (msg: string) => void
  /** Called when `withDaemonRetry` rethrows. Caller decides what to print and whether to exit. */
  onTransportError: (error: unknown) => void
  /** Task to cancel. */
  taskId: string
}

/**
 * Reusable cancel-branch wiring for oclif commands' `--cancel <id>` flag.
 * Runs `runCancelTask` inside `withDaemonRetry`, surfaces transport errors
 * via the supplied callback, and returns the helper's success flag so the
 * caller can decide on exit code. Single point of evolution if the cancel
 * pipeline ever grows extra retry/finalization concerns.
 */
export async function runCancelBranchWithRetry(options: RunCancelBranchOptions): Promise<boolean> {
  const {command, daemonClientOptions, format, log, onTransportError, taskId} = options
  let success = false
  try {
    await withDaemonRetry(async (client) => {
      success = await runCancelTask({client, command, format, log, taskId})
    }, daemonClientOptions)
  } catch (error) {
    onTransportError(error)
    return false
  }

  return success
}

/**
 * Agent cancel listener helper.
 *
 * Pure handler logic extracted from agent-process.ts for testability.
 * Given a cancel request, asks the agent to cancel and conditionally
 * emits `task:cancelled` upstream. Best-effort by design: any failure is
 * logged and swallowed so the cancel pipeline never crashes the agent.
 */

import type {ITransportClient} from '@campfirein/brv-transport-client'

import type {ICipherAgent} from '../../../agent/core/interfaces/i-cipher-agent.js'

import {TransportTaskEventNames} from '../../core/domain/transport/schemas.js'

export type HandleAgentCancelEventOptions = {
  agent: Pick<ICipherAgent, 'cancelTask'>
  log: (msg: string) => void
  taskId: string
  transport: Pick<ITransportClient, 'request'>
}

/**
 * Handle one `task:cancel` event inside the agent child process.
 *
 * Behavior:
 * - Calls `agent.cancelTask(taskId)`.
 * - On a truthy result, emits `task:cancelled` back to the daemon so it can
 *   broadcast to clients and run lifecycle hooks.
 * - On a falsy result (no controller held the task), stays silent: the daemon
 *   reconciles via its own state.
 * - Any error from the agent or the transport is logged and suppressed.
 *
 * @param options - taskId + agent/transport/log collaborators
 */
export async function handleAgentCancelEvent(options: HandleAgentCancelEventOptions): Promise<void> {
  const {agent, log, taskId, transport} = options
  log(`task:cancel received taskId=${taskId}`)
  try {
    const cancelled = await agent.cancelTask(taskId)
    if (!cancelled) return
    transport.request(TransportTaskEventNames.CANCELLED, {taskId})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`task:cancel handler error taskId=${taskId} err=${message}`)
  }
}

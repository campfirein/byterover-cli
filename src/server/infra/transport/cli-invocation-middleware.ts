 
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer, RequestHandler} from '../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../shared/analytics/event-names.js'
import {CliInvocationSchema} from '../../../shared/analytics/events/cli-invocation.js'
import {processLog} from '../../utils/process-logger.js'

export type CliInvocationMiddlewareDeps = {
  /**
   * Lazy getter for the analytics client. Resolved per-request because the
   * client is constructed AFTER the middleware is attached (during
   * setupFeatureHandlers); a value-bound dep would capture `undefined`
   * forever.
   */
  getAnalyticsClient: () => IAnalyticsClient | undefined
}

type OnRequestFn = ITransportServer['onRequest']

/**
 * Symbol marker stamped on the wrapped `onRequest` so a second
 * `attachCliInvocationMiddleware(server, ...)` call can detect the prior
 * attach and bail. Without this, the second call would wrap the
 * already-wrapped function and double-fire `cli_invocation` per request.
 *
 * `Symbol.for(...)` (not `Symbol(...)`) so the marker survives module
 * re-loads in test harnesses that re-import the file.
 */
const CLI_INVOCATION_ATTACHED = Symbol.for('M15.8/cli-invocation-middleware-attached')

type MarkedOnRequest = OnRequestFn & {[CLI_INVOCATION_ATTACHED]?: true}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * M15.8 — wrap `transportServer.onRequest` so every incoming payload is
 * inspected for a `cli_metadata` block. When present and Zod-valid, emit
 * `cli_invocation` BEFORE forwarding to the real handler. The original
 * handler is invoked even on parse failure or when analytics is off —
 * analytics is opportunistic, never blocking.
 *
 * Idempotent: a second call on the same transport server is a no-op (a
 * marker symbol on the wrapped function flags the prior attach).
 */
export function attachCliInvocationMiddleware(
  transportServer: ITransportServer,
  deps: CliInvocationMiddlewareDeps,
): void {
  const current = transportServer.onRequest as MarkedOnRequest
  if (current[CLI_INVOCATION_ATTACHED]) return

  const original = current.bind(transportServer)
  const wrappedOnRequest: MarkedOnRequest = <TRequest = unknown, TResponse = unknown>(
    event: string,
    handler: RequestHandler<TRequest, TResponse>,
  ): void => {
    const wrapped: RequestHandler<TRequest, TResponse> = (data, clientId) => {
      maybeEmitCliInvocation(data, deps.getAnalyticsClient())
      return handler(data, clientId)
    }

    original(event, wrapped)
  }

  wrappedOnRequest[CLI_INVOCATION_ATTACHED] = true
  transportServer.onRequest = wrappedOnRequest
}

function maybeEmitCliInvocation(data: unknown, client: IAnalyticsClient | undefined): void {
  if (client === undefined) return
  if (!isRecord(data)) return
  if (!('cli_metadata' in data)) return

  const parsed = CliInvocationSchema.safeParse(data.cli_metadata)
  if (!parsed.success) return

  try {
    client.track(AnalyticsEventNames.CLI_INVOCATION, parsed.data)
  } catch (error) {
    processLog(
      `cli_invocation middleware track failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

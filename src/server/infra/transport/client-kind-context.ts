/* eslint-disable camelcase */
import {AsyncLocalStorage} from 'node:async_hooks'

import type {ClientType} from '../../core/domain/client/client-info.js'

/**
 * Async-context scope for the daemon-stamped Socket.IO `client_kind`.
 *
 * The Socket.IO transport layer wraps every incoming transport-handler
 * invocation in `clientKindContext.run({client_kind}, ...)` keyed off
 * the originating socket's registered ClientType. SuperPropertiesResolver
 * reads the value during super-property resolution so every analytics
 * event automatically carries the originating client kind on its outer
 * envelope — no per-handler signature change required.
 *
 * Same propagation model as `reviewDisabledStorage` in
 * src/agent/infra/tools/implementations/curate-tool-task-context.ts.
 *
 * Outside any scope, `getClientKindFromContext()` returns `undefined`
 * and the resolver omits `client_kind` from the stamped envelope —
 * exercised by the agent-fork bypass and any direct daemon-internal
 * track() call that does not originate from a Socket.IO event.
 */
export const clientKindContext = new AsyncLocalStorage<{client_kind: ClientType}>()

export function runWithClientKind<T>(client_kind: ClientType, fn: () => Promise<T>): Promise<T> {
  return clientKindContext.run({client_kind}, fn)
}

export function getClientKindFromContext(): ClientType | undefined {
  return clientKindContext.getStore()?.client_kind
}

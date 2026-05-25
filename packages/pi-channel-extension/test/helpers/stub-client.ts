import type {ChannelClient, TurnEvent} from '@brv/channel-client'

import type {ConnectFn} from '../../src/commands.js'
import type {PiCommandContext} from '../../src/pi-api.js'

// Lightweight stub for a ChannelClient that records request() calls and
// can be primed with canned ack data + subscribeTurn events. The Pi
// extension never talks to the real channel-client in unit tests; we
// inject this stub via `dispatchChannelCommand(..., connect)`.

export type RecordedRequest = {readonly event: string; readonly data: unknown}

export type StubClient = {
  readonly client: ChannelClient
  readonly requests: RecordedRequest[]
  prime: (event: string, data: unknown) => void
  primeFailure: (event: string, error: Error) => void
  primeTurnEvents: (events: readonly TurnEvent[]) => void
  closed: boolean
}

export const makeStubClient = (): StubClient => {
  const requests: RecordedRequest[] = []
  const canned = new Map<string, unknown>()
  const failures = new Map<string, Error>()
  let turnEvents: readonly TurnEvent[] = []
  const state: {closed: boolean} = {closed: false}

  const fakeClient = {
    get connected(): boolean {
      return !state.closed
    },

    async close(): Promise<void> {
      state.closed = true
    },

    on(): () => void {
      return () => undefined
    },

    async request<TReq, TRes>(event: string, data: TReq): Promise<TRes> {
      requests.push({data, event})
      const failure = failures.get(event)
      if (failure !== undefined) throw failure
      return (canned.get(event) ?? {}) as TRes
    },

    async subscribe(): Promise<void> {
      return undefined
    },

    async *subscribeTurn(_channelId: string, _turnId: string): AsyncIterableIterator<TurnEvent> {
      for (const ev of turnEvents) yield ev
    },

    async unsubscribe(): Promise<void> {
      return undefined
    },
  }

  return {
    client: fakeClient as unknown as ChannelClient,
    get closed(): boolean {
      return state.closed
    },
    prime(event, data) {
      canned.set(event, data)
    },
    primeFailure(event, error) {
      failures.set(event, error)
    },
    primeTurnEvents(events) {
      turnEvents = events
    },
    requests,
  }
}

export const makeStubConnect = (stub: StubClient): ConnectFn => async () => stub.client

export const makeStubCtx = (overrides: {readonly cwd?: string} = {}): {
  readonly ctx: PiCommandContext
  readonly notifications: Array<{readonly message: string; readonly level: string | undefined}>
} => {
  const notifications: Array<{readonly message: string; readonly level: string | undefined}> = []
  const ctx: PiCommandContext = {
    cwd: overrides.cwd ?? '/tmp/pi-test',
    ui: {
      notify(message, level) {
        notifications.push({level, message})
      },
    },
  }
  return {ctx, notifications}
}

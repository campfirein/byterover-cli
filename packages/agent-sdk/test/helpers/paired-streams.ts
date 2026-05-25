import type {Agent, Client, Stream} from '@agentclientprotocol/sdk'

import {ClientSideConnection} from '@agentclientprotocol/sdk'

/**
 * Builds an in-memory paired-stream test rig:
 *  - `agentStream` is what you pass to `ChannelAgent.run({stream})`.
 *  - `connect(toClient)` builds a `ClientSideConnection` on the OTHER end so
 *    your test can call `client.initialize(...)`, `client.newSession(...)`,
 *    `client.prompt(...)` exactly as a real host would.
 *
 * The two `TransformStream`s give us full-duplex `AnyMessage` plumbing
 * without going through stdio or NDJSON encoding — fast, deterministic,
 * and lets us assert on the upstream library's own validation.
 */
export type PairedStreamsRig = {
  readonly agentStream: Stream
  readonly close: () => void
  readonly connect: (toClient: (agent: Agent) => Client) => ClientSideConnection
}

export const createPairedStreams = (): PairedStreamsRig => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientToAgent = new TransformStream<any, any>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentToClient = new TransformStream<any, any>()

  const agentStream: Stream = {
    readable: clientToAgent.readable,
    writable: agentToClient.writable,
  }

  const clientStream: Stream = {
    readable: agentToClient.readable,
    writable: clientToAgent.writable,
  }

  return {
    agentStream,
    close(): void {
      // Best-effort — closing a transform's writable is idempotent.
      clientToAgent.writable.close().catch(() => {})
      agentToClient.writable.close().catch(() => {})
    },
    connect(toClient): ClientSideConnection {
      return new ClientSideConnection(toClient, clientStream)
    },
  }
}

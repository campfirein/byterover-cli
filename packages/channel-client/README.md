# @brv/channel-client

TypeScript client for the [brv channel-protocol](../../plan/channel-protocol/CHANNEL_PROTOCOL.md) wire surface. Use it to drive `channel:*` requests + subscribe to broadcasts from any Node/TS host (Pi extension, kimi-cli wrapper, custom CLI, …).

This package does NOT spawn the brv daemon. It expects one to be running already — run any `brv` command once (e.g. `brv channel list`) to boot it.

## Install

```bash
npm install @brv/channel-client socket.io-client
```

`socket.io-client` is a peer dependency so the host app controls the version.

## Usage

```ts
import {ChannelClient, ChannelClientError} from '@brv/channel-client'

const client = await ChannelClient.connect()
try {
  const {channels} = await client.request<unknown, {channels: Array<{channelId: string}>}>(
    'channel:list',
    {},
  )
  console.log(channels)
} catch (error) {
  if (error instanceof ChannelClientError) {
    console.error(`[${error.code}] ${error.message}`)
  } else {
    throw error
  }
} finally {
  await client.close()
}
```

### Streaming a turn

```ts
for await (const event of client.subscribeTurn(channelId, turnId)) {
  console.log(event.kind, event.seq)
}
```

The iterator joins the channel room on entry, forwards every `channel:turn-event` whose `turnId` matches, and ends when a terminal `turn_state_change` (`to: 'completed' | 'cancelled'`) arrives.

## Discovery

`ChannelClient.connect()` reads `<dataDir>/daemon.json` for the URL and `<dataDir>/state/daemon-auth-token` for the handshake token (default `dataDir` = `~/.brv`, override via `BRV_DATA_DIR`). Pass `{daemonUrl, authToken}` to skip disk discovery — useful for tests.

## Errors

All failures throw `ChannelClientError`. Codes:

- `BRV_DAEMON_NOT_INITIALISED` — `daemon.json` missing (run `brv` once).
- `BRV_CHANNEL_CONNECT_FAILED` — Socket.IO handshake failed after the retry budget.
- `CHANNEL_REQUEST_TIMEOUT` — daemon did not ack within the per-request timeout.
- `MALFORMED_RESPONSE` — daemon returned a non-conforming ack envelope.
- Daemon-supplied codes — propagated verbatim on `{success: false}` ack responses.

## Status

Slice 7.−1a of the channel-protocol implementation. See `plan/channel-protocol/IMPLEMENTATION_PHASE_7.md`.

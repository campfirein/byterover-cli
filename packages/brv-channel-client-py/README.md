# brv-channel-client

Python client for the [brv channel-protocol](../../plan/channel-protocol/CHANNEL_PROTOCOL.md) wire surface. Drive `channel:*` requests and subscribe to broadcasts from any asyncio host (kimi-cli, custom CLIs, …).

This package does NOT spawn the brv daemon. It expects one to be running already — run any `brv` command once (e.g. `brv channel list`) to boot it.

## Install

```bash
pip install brv-channel-client
```

## Usage

```python
import asyncio
from brv_channel_client import ChannelClient, ChannelClientError


async def main() -> None:
    async with await ChannelClient.connect() as client:
        try:
            result = await client.request("channel:list", {})
            for channel in result["channels"]:
                print(channel["channelId"], channel.get("title", ""))
        except ChannelClientError as exc:
            print(f"[{exc.code}] {exc.message}")


asyncio.run(main())
```

### Streaming a turn

```python
async for event in client.subscribe_turn(channel_id, turn_id):
    if event["kind"] == "agent_message_chunk":
        print(event["content"], end="", flush=True)
```

The iterator joins the channel room on entry, forwards every `channel:turn-event` whose `turnId` matches, and ends when a terminal `turn_state_change` (`to == "completed" | "cancelled"`) arrives.

## Discovery

`ChannelClient.connect()` reads `<data_dir>/daemon.json` for the URL and `<data_dir>/state/daemon-auth-token` for the handshake token. `data_dir` resolves from: explicit argument → `BRV_DATA_DIR` env var → `~/.brv`. Pass `daemon_url=` + `auth_token=` to skip disk discovery (useful for tests).

## Errors

All failures raise `ChannelClientError(code, message, details)`. Codes:

- `BRV_DAEMON_NOT_INITIALISED` — `daemon.json` missing (run `brv` once).
- `BRV_CHANNEL_CONNECT_FAILED` — Socket.IO handshake refused after the retry budget.
- `CHANNEL_REQUEST_TIMEOUT` — daemon did not ack within the per-request timeout.
- `MALFORMED_RESPONSE` — daemon returned a non-conforming ack envelope.
- Daemon-supplied codes — propagated verbatim on `{success: False}` ack envelopes.

## Status

Slice 7.−1b of the channel-protocol implementation. Mirrors `packages/channel-client` (TypeScript). See `plan/channel-protocol/IMPLEMENTATION_PHASE_7.md`.

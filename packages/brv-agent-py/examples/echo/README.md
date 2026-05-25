# `echo-py` — minimal `brv-agent` example

A ~30-LOC ACP agent in Python that replies with `you said: <your text>`. Use it as a starting point for your own channel agent.

## Prerequisites

- Python 3.10+
- `brv-agent` installed (`pip install -e /abs/path/to/byterover-cli/packages/brv-agent-py`)

## Run it

```bash
# From your project directory (any dir that has a .brv/ context tree):
brv channel onboard echo-py -- python /abs/path/to/byterover-cli/packages/brv-agent-py/examples/echo/main.py

brv channel new my-test
brv channel invite my-test @echo-py --profile echo-py
brv channel mention my-test "@echo-py hi there"
```

Expected output:

```text
[@echo-py] you said: hi there
turn 01HX… completed
```

When publishing lands, the install step becomes `pip install brv-agent`.

## What the SDK gives you

The 30 lines in `main.py` are everything you need. The SDK handles:

- ACP `initialize` / `session/new` / `session/cancel` plumbing
- NDJSON framing over stdio (via upstream `agent-client-protocol`)
- The `session/update` notification you emit via `ctx.send_message_chunk(...)`
- The `session/request_permission` round-trip (call `await ctx.request_permission(...)` from your handler)

See [`CHANNEL_PROTOCOL.md` §15](../../../../plan/channel-protocol/CHANNEL_PROTOCOL.md) for what's happening on the wire.

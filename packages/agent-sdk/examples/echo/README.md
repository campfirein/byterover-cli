# `echo` — minimal `@brv/agent-sdk` example

A ~25-LOC ACP agent that replies with `you said: <your text>`. Use it as a starting point for your own channel agent.

## Prerequisites

- `byterover-cli` built locally (`cd byterover-cli && npm run build`)
- `byterover-cli/packages/agent-sdk/dist/` exists (`npm run build:agent-sdk`)

## Run it (development — from inside this repo)

```bash
# From the byterover-cli repo root.
npm run build:agent-sdk

# In your project directory (any dir that has a .brv/ context tree):
brv channel onboard echo -- node /abs/path/to/byterover-cli/packages/agent-sdk/examples/echo/index.mjs

brv channel new my-test
brv channel invite my-test @echo --profile echo
brv channel mention my-test "@echo hi there"
```

Expected output:

```text
[@echo] you said: hi there
turn 01HX… completed
```

## Run it (downstream — `npm install` the local package)

When `@brv/agent-sdk` is v0.1 (unpublished), install from the repo path:

```bash
mkdir my-agent && cd my-agent
npm init -y
npm install /abs/path/to/byterover-cli/packages/agent-sdk
cp /abs/path/to/byterover-cli/packages/agent-sdk/examples/echo/index.mjs ./agent.mjs

brv channel onboard echo -- node $PWD/agent.mjs
```

When publishing lands, this becomes `npm install @brv/agent-sdk`.

## What the SDK gives you

The 25 lines in `index.mjs` are everything you need. The SDK handles:

- ACP `initialize` / `session/new` / `session/cancel` plumbing
- NDJSON framing over stdio
- The `session/update` notification you emit via `ctx.sendMessageChunk(...)`
- The `session/request_permission` round-trip (call `ctx.requestPermission({...})` from your handler)

See [`CHANNEL_PROTOCOL.md` §15](../../../../plan/channel-protocol/CHANNEL_PROTOCOL.md) for what's happening on the wire.

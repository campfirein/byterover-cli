# `@brv/agent-sdk`

> Thin ergonomic wrapper over the [Agent Client Protocol](https://agentclientprotocol.com) for building agents that join [brv channels](../../plan/channel-protocol/CHANNEL_PROTOCOL.md).

Write a custom ACP agent in 25 lines of TypeScript / JavaScript without reading the wire spec.

## Status

**v0.1 — unpublished.** Install from the repo path; `npm publish` is a follow-up.

## Install

```bash
# In your agent project (after byterover-cli has been built once):
npm install /abs/path/to/byterover-cli/packages/agent-sdk
```

When publishing lands this becomes `npm install @brv/agent-sdk`.

## Quickstart — the echo agent (25 LOC)

```javascript
// my-agent.mjs
import {ChannelAgent} from '@brv/agent-sdk'

const agent = new ChannelAgent({
  name: 'echo',
  promptCapabilities: {embeddedContext: true},
  version: '0.1.0',
})

agent.onPrompt(async (req, ctx) => {
  const userText = req.prompt
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
  await ctx.sendMessageChunk(`you said: ${userText}`)
  return {stopReason: 'end_turn'}
})

agent.run()
```

```bash
brv channel onboard echo -- node my-agent.mjs
brv channel new my-test
brv channel invite my-test @echo --profile echo
brv channel mention my-test "@echo hi"
# [@echo] you said: hi
```

A working version of this lives at [`examples/echo/`](./examples/echo/).

## API

### `new ChannelAgent({name, version, promptCapabilities})`

Construct an agent. `promptCapabilities` controls what your agent advertises to the host in `initialize` — common values are `{embeddedContext: true}` (your agent accepts channel-history blocks) and `{image: true}` (your agent renders image content blocks).

### `agent.onPrompt(handler)`

```typescript
agent.onPrompt(async (request, ctx) => {
  // ... do work, call ctx.send*() ...
  return {stopReason: 'end_turn'}
})
```

Register the handler that runs for every `session/prompt`. `ctx` is a [`PromptContext`](#promptcontext).

### `agent.onCancel(handler)`

Optional. Called when the host sends `session/cancel`. If you don't register this, the SDK still aborts the in-flight prompt by setting `ctx.signal` — `onCancel` is for any extra teardown.

### `agent.run({stream?})`

Start the agent loop. Defaults to stdio (NDJSON), which is what `brv channel onboard` expects. Tests pass an explicit in-memory stream pair.

### `PromptContext`

The `ctx` object passed to `onPrompt`. Methods:

| Method | What it does |
|---|---|
| `ctx.sendMessageChunk(text \| block)` | Emit `agent_message_chunk` — visible reply text. |
| `ctx.sendThoughtChunk(text \| block)` | Emit `agent_thought_chunk` — reasoning text the host may render in a collapsed pane. |
| `ctx.sendToolCall({toolCallId, title, kind?, rawInput?, content?})` | Emit `tool_call` — "I'm about to call X". |
| `ctx.sendToolCallUpdate({toolCallId, status?, rawOutput?, content?})` | Emit `tool_call_update` — "Tool X is now in state Y". |
| `ctx.requestPermission({toolCall, options})` → `Promise<outcome>` | Ask the user before doing something privileged. |
| `ctx.signal` | `AbortSignal` that fires when the host cancels the turn. |

Calling any `ctx.send*()` AFTER `onPrompt` returns throws (agents must not stream out-of-prompt).

## Wire spec

See [`CHANNEL_PROTOCOL.md` §15](../../plan/channel-protocol/CHANNEL_PROTOCOL.md) for what the SDK is doing under the hood.

## Companion

Same surface, idiomatic Python: [`brv-agent`](../brv-agent-py/).

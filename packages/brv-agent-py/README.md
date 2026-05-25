# `brv-agent`

> Thin ergonomic wrapper over the [Agent Client Protocol](https://agentclientprotocol.com) for building agents that join [brv channels](../../plan/channel-protocol/CHANNEL_PROTOCOL.md).

Write a custom ACP agent in ~30 lines of Python without reading the wire spec.

## Status

**v0.1 — unpublished.** Install from the repo path; `twine upload` is a follow-up.

## Install

```bash
pip install -e /abs/path/to/byterover-cli/packages/brv-agent-py
```

When publishing lands this becomes `pip install brv-agent`.

Python 3.10+. Builds on the upstream [`agent-client-protocol`](https://pypi.org/project/agent-client-protocol/) library (the same one [kimi-cli](https://github.com/MoonshotAI/Kimi-CLI) uses).

## Quickstart — the echo agent (~30 LOC)

```python
# my_agent.py
import asyncio
from brv_agent import ChannelAgent

agent = ChannelAgent(
    name="echo-py",
    version="0.1.0",
    prompt_capabilities={"embeddedContext": True},
)


@agent.on_prompt
async def handle_prompt(req, ctx):
    user_text = " ".join(b.text for b in req.prompt if b.type == "text")
    await ctx.send_message_chunk(f"you said: {user_text}")
    return {"stop_reason": "end_turn"}


if __name__ == "__main__":
    asyncio.run(agent.run())
```

```bash
brv channel onboard echo-py -- python my_agent.py
brv channel new my-test
brv channel invite my-test @echo-py --profile echo-py
brv channel mention my-test "@echo-py hello from python"
# [@echo-py] you said: hello from python
```

A working version lives at [`examples/echo/`](./examples/echo/).

## API

### `ChannelAgent(*, name, version, prompt_capabilities=None)`

Construct an agent. `prompt_capabilities` is a `dict[str, bool]` like `{"embeddedContext": True, "image": True}` (camelCase keys, matching the wire format).

### `@agent.on_prompt`

```python
@agent.on_prompt
async def handle(request, ctx):
    # ... do work, await ctx.send_*() ...
    return {"stop_reason": "end_turn"}
```

Decorator: register the handler that runs for every `session/prompt`. `ctx` is a [`PromptContext`](#promptcontext).

### `@agent.on_cancel`

Optional. Called when the host sends `session/cancel`. The SDK already aborts the in-flight prompt by setting `ctx.signal` (an `asyncio.Event`).

### `await agent.run(*, input_stream=None, output_stream=None)`

Start the agent loop. Defaults to stdio (NDJSON) — what `brv channel onboard` expects. Tests pass explicit streams.

### `PromptContext`

| Method | What it does |
|---|---|
| `await ctx.send_message_chunk(text_or_block)` | Emit `agent_message_chunk` — visible reply text. |
| `await ctx.send_thought_chunk(text_or_block)` | Emit `agent_thought_chunk`. |
| `await ctx.send_tool_call(*, tool_call_id, title, kind=None, raw_input=None, content=None)` | Emit `tool_call`. |
| `await ctx.send_tool_call_update(*, tool_call_id, status=None, raw_output=None, content=None)` | Emit `tool_call_update`. |
| `await ctx.request_permission(*, tool_call, options)` | Ask the user; await `AllowedOutcome \| DeniedOutcome`. |
| `ctx.signal` | `asyncio.Event` set when the host cancels the turn. |

Calling any `ctx.send_*()` after the prompt handler returns raises `RuntimeError` (agents must not stream out-of-prompt).

## Wire spec

See [`CHANNEL_PROTOCOL.md` §15](../../plan/channel-protocol/CHANNEL_PROTOCOL.md) for what's happening on the wire.

## Companion

Same surface, idiomatic TypeScript: [`@brv/agent-sdk`](../agent-sdk/).

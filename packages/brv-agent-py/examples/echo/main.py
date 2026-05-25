#!/usr/bin/env python3
"""`echo` — the minimal `brv-agent` example. ~30 LOC.

Onboard with:
    brv channel onboard echo-py -- python packages/brv-agent-py/examples/echo/main.py

Mention with:
    brv channel mention <ch> "@echo-py hello"

See packages/brv-agent-py/examples/echo/README.md for the full walkthrough.
"""

from __future__ import annotations

import asyncio
from typing import Any

from brv_agent import ChannelAgent

agent = ChannelAgent(
    name="echo-py",
    version="0.1.0",
    prompt_capabilities={"embeddedContext": True},
)


@agent.on_prompt
async def handle_prompt(req: Any, ctx: Any) -> dict:
    user_text = " ".join(
        getattr(b, "text", "") for b in req.prompt if getattr(b, "type", "") == "text"
    )
    await ctx.send_message_chunk(f"you said: {user_text}")
    return {"stop_reason": "end_turn"}


if __name__ == "__main__":
    asyncio.run(agent.run())

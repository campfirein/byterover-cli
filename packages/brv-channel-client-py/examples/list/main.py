"""Smoke-test example for brv-channel-client.

Prereq: a running ``brv`` daemon (any prior CLI command will boot one).
Usage: ``python examples/list/main.py``

Prints the list of channels visible to the daemon. No agent loop — just
demonstrates the connect → request → close shape so downstream consumers
(kimi-cli wrapper, custom CLIs) can model their own usage.
"""

from __future__ import annotations

import asyncio
import sys

from brv_channel_client import ChannelClient, ChannelClientError


async def main() -> None:
    try:
        client = await ChannelClient.connect()
    except ChannelClientError as exc:
        print(f"[{exc.code}] {exc.message}", file=sys.stderr)
        sys.exit(1)

    try:
        result = await client.request("channel:list", {})
        channels = result.get("channels", []) if isinstance(result, dict) else []
        if not channels:
            print("(no channels — create one with `brv channel create <id>`)")
            return

        for channel in channels:
            channel_id = channel.get("channelId", "?")
            state = channel.get("state", "unknown")
            title = channel.get("title", "(untitled)")
            print(f"{channel_id:<20} {state:<10} {title}")
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())

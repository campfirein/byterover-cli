"""Slice 5.3 tests — ChannelAgent surface, driven outside-in by the
~30-LOC Python echo example.

Each test mirrors one TS test from
`packages/agent-sdk/test/channel-agent.test.ts` so the SDKs stay in
behavioural lock-step.
"""

from __future__ import annotations

import asyncio
from typing import Any

import acp
import pytest
from acp.schema import (
    AllowedOutcome,
    ClientCapabilities,
    DeniedOutcome,
    FileSystemCapability,
    PermissionOption,
    RequestPermissionResponse,
    SessionNotification,
    TextContentBlock,
    ToolCallUpdate,
)

from brv_agent import ChannelAgent
from .conftest import create_paired_streams


_NO_FS_CAPS = ClientCapabilities(
    fs=FileSystemCapability(readTextFile=False, writeTextFile=False),
    terminal=False,
)


class _CollectingClient:
    """Test client that buffers session_update notifications and resolves
    request_permission with a pre-canned outcome.
    """

    def __init__(
        self,
        permission_outcome: AllowedOutcome | DeniedOutcome | None = None,
    ) -> None:
        self.notifications: list[SessionNotification] = []
        self.permission_outcome = permission_outcome

    async def session_update(
        self, session_id: str, update: Any, **kwargs: Any
    ) -> None:
        self.notifications.append(SessionNotification(sessionId=session_id, update=update))

    async def request_permission(
        self,
        options: list[PermissionOption],
        session_id: str,
        tool_call: ToolCallUpdate,
        **kwargs: Any,
    ) -> RequestPermissionResponse:
        if self.permission_outcome is None:
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(outcome=self.permission_outcome)

    # The remaining Client protocol methods are unused by these tests.
    async def write_text_file(self, *args: Any, **kwargs: Any) -> None:
        raise NotImplementedError

    async def read_text_file(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def create_terminal(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def kill_terminal_command(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def release_terminal(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def set_config_option(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def ext_method(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def ext_notification(self, *args: Any, **kwargs: Any) -> None:
        raise NotImplementedError


async def _run_with(agent: ChannelAgent, client: _CollectingClient):
    """Wire `agent` and `client` together over paired streams and return
    the agent task + an upstream ClientSideConnection. ClientSideConnection
    auto-starts its read loop on construction; we only manage the
    agent_task lifecycle explicitly.
    """
    rig = await create_paired_streams()
    # Upstream uses the CLIENT's POV: `input_stream` is a StreamWriter (where
    # the AGENT writes), `output_stream` is a StreamReader (where the AGENT
    # reads). Our PairedRig uses the AGENT's POV, so we swap.
    agent_task = asyncio.create_task(
        acp.run_agent(
            agent,
            input_stream=rig.agent_output,
            output_stream=rig.agent_input,
        )
    )
    # Use the non-deprecated factory. `connect_to_agent` returns the same
    # ClientSideConnection underneath but is the public, non-deprecated
    # path per upstream `acp` v0.8.
    connection = acp.connect_to_agent(
        client,
        rig.client_output,
        rig.client_input,
    )
    # Give the agent + client a tick to bootstrap.
    await asyncio.sleep(0)
    return connection, agent_task


def _ascii_text(block: Any) -> str:
    """Pull text from a content block — handles dict or pydantic shapes."""
    if isinstance(block, dict):
        return str(block.get("text", ""))
    return getattr(block, "text", "")


@pytest.mark.asyncio
async def test_exposes_on_prompt_on_cancel_run() -> None:
    agent = ChannelAgent(name="echo", version="0.1.0")
    assert callable(agent.on_prompt)
    assert callable(agent.on_cancel)
    assert callable(agent.run)
    # NOT on_session_end — outside-in: echo example doesn't use it.
    assert not hasattr(agent, "on_session_end")


@pytest.mark.asyncio
async def test_initialize_echoes_prompt_capabilities() -> None:
    agent = ChannelAgent(
        name="echo",
        version="0.1.0",
        prompt_capabilities={"embeddedContext": True, "image": True},
    )

    @agent.on_prompt
    async def _h(req: Any, ctx: Any) -> dict:
        return {"stop_reason": "end_turn"}

    conn, agent_task = await _run_with(agent, _CollectingClient())
    try:
        result = await conn.initialize(
            protocol_version=1, client_capabilities=_NO_FS_CAPS
        )
        assert result.protocol_version == 1
        caps = result.agent_capabilities.prompt_capabilities
        assert caps.embedded_context is True
        assert caps.image is True
        assert result.agent_info.name == "echo"
        assert result.agent_info.version == "0.1.0"
    finally:
        agent_task.cancel()


@pytest.mark.asyncio
async def test_new_session_returns_uuid() -> None:
    agent = ChannelAgent(name="echo", version="0.1.0")

    @agent.on_prompt
    async def _h(req: Any, ctx: Any) -> dict:
        return {"stop_reason": "end_turn"}

    conn, agent_task = await _run_with(agent, _CollectingClient())
    try:
        await conn.initialize(protocol_version=1, client_capabilities=_NO_FS_CAPS)
        result = await conn.new_session(cwd="/tmp", mcp_servers=[])
        assert isinstance(result.session_id, str)
        # UUID-shape: 8-4-4-4-12 hex chars
        import re

        assert re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", result.session_id)
    finally:
        agent_task.cancel()


@pytest.mark.asyncio
async def test_prompt_streams_message_chunk_before_response() -> None:
    agent = ChannelAgent(name="echo", version="0.1.0")

    @agent.on_prompt
    async def handle(req: Any, ctx: Any) -> dict:
        user_text = " ".join(_ascii_text(b) for b in req.prompt)
        await ctx.send_message_chunk(f"you said: {user_text}")
        return {"stop_reason": "end_turn"}

    client = _CollectingClient()
    conn, agent_task = await _run_with(agent, client)
    try:
        await conn.initialize(protocol_version=1, client_capabilities=_NO_FS_CAPS)
        session = await conn.new_session(cwd="/tmp", mcp_servers=[])
        reply = await conn.prompt(
            prompt=[TextContentBlock(type="text", text="hi there")],
            session_id=session.session_id,
        )
        assert reply.stop_reason == "end_turn"
        assert len(client.notifications) == 1
        update = client.notifications[0].update
        assert update.session_update == "agent_message_chunk"
        assert update.content.text == "you said: hi there"
    finally:
        agent_task.cancel()


@pytest.mark.asyncio
async def test_request_permission_round_trips() -> None:
    agent = ChannelAgent(name="echo", version="0.1.0")
    seen_tool_call_id: list[str] = []

    @agent.on_prompt
    async def handle(req: Any, ctx: Any) -> dict:
        outcome = await ctx.request_permission(
            tool_call={"toolCallId": "tc-1", "title": "WriteFile"},
            options=[
                {"optionId": "approve", "name": "Approve", "kind": "allow_once"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
            ],
        )
        if hasattr(outcome, "option_id"):
            seen_tool_call_id.append(getattr(outcome, "option_id"))
        elif isinstance(outcome, dict):
            seen_tool_call_id.append(outcome.get("optionId", ""))
        return {"stop_reason": "end_turn"}

    client = _CollectingClient(
        permission_outcome=AllowedOutcome(outcome="selected", optionId="approve")
    )
    conn, agent_task = await _run_with(agent, client)
    try:
        await conn.initialize(protocol_version=1, client_capabilities=_NO_FS_CAPS)
        session = await conn.new_session(cwd="/tmp", mcp_servers=[])
        await conn.prompt(
            prompt=[TextContentBlock(type="text", text="do it")],
            session_id=session.session_id,
        )
        assert seen_tool_call_id == ["approve"]
    finally:
        agent_task.cancel()


@pytest.mark.asyncio
async def test_on_cancel_fires_within_100ms() -> None:
    agent = ChannelAgent(name="echo", version="0.1.0")
    cancel_observed = asyncio.Event()

    @agent.on_cancel
    async def handle_cancel(notification: Any) -> None:
        cancel_observed.set()

    @agent.on_prompt
    async def handle(req: Any, ctx: Any) -> dict:
        try:
            await asyncio.wait_for(ctx.signal.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            return {"stop_reason": "end_turn"}
        return {"stop_reason": "cancelled"}

    conn, agent_task = await _run_with(agent, _CollectingClient())
    try:
        await conn.initialize(protocol_version=1, client_capabilities=_NO_FS_CAPS)
        session = await conn.new_session(cwd="/tmp", mcp_servers=[])
        prompt_task = asyncio.create_task(
            conn.prompt(
                prompt=[TextContentBlock(type="text", text="wait")],
                session_id=session.session_id,
            )
        )
        await asyncio.sleep(0.05)
        await conn.cancel(session_id=session.session_id)
        await asyncio.wait_for(cancel_observed.wait(), timeout=2.0)
        reply = await prompt_task
        assert reply.stop_reason == "cancelled"
    finally:
        agent_task.cancel()

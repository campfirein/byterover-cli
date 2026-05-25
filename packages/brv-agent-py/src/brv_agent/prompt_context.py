"""PromptContext — the per-prompt context object passed to the user's
``@agent.on_prompt`` handler.

Owns the bridge from "I want to stream something to the host" to the
underlying ``Client.session_update(...)`` call. The context is
INVALIDATED when the prompt handler returns; calling
``send_message_chunk`` etc. after that raises (Channel Protocol §15.2
— agents must not stream out-of-prompt).
"""

from __future__ import annotations

import asyncio
from typing import Any, Sequence, Union

import acp
from acp.schema import (
    AgentMessageChunk,
    AgentThoughtChunk,
    AllowedOutcome,
    DeniedOutcome,
    PermissionOption,
    TextContentBlock,
    ToolCallStart,
    ToolCallProgress,
    ToolCallUpdate,
)

# The upstream Python schema models the outcome as a discriminated union
# rather than the TS-style single type. Re-export the union for SDK users.
PermissionOutcome = Union[AllowedOutcome, DeniedOutcome]

TextOrBlock = Union[str, TextContentBlock]


class PromptContext:
    """Per-prompt helper passed to ``@agent.on_prompt`` handlers.

    Attributes:
        signal: ``asyncio.Event`` set when the host cancels this turn via
            ``session/cancel``. Long-running prompt handlers SHOULD check
            ``signal.is_set()`` and bail.
    """

    def __init__(
        self,
        *,
        client: acp.Client,
        session_id: str,
        cancel_event: asyncio.Event,
    ) -> None:
        self._client = client
        self._session_id = session_id
        self._active = True
        self.signal = cancel_event

    def _deactivate(self) -> None:
        self._active = False

    def _assert_active(self, method: str) -> None:
        if not self._active:
            raise RuntimeError(
                f"ctx.{method}() called after the prompt handler ended; agents must "
                "not stream out-of-prompt (Channel Protocol §15.2)."
            )

    @staticmethod
    def _coerce_text(value: TextOrBlock) -> TextContentBlock:
        if isinstance(value, str):
            return TextContentBlock(type="text", text=value)
        return value

    async def send_message_chunk(self, value: TextOrBlock) -> None:
        """Emit an ``agent_message_chunk`` notification."""
        self._assert_active("send_message_chunk")
        await self._client.session_update(
            session_id=self._session_id,
            update=AgentMessageChunk(
                sessionUpdate="agent_message_chunk", content=self._coerce_text(value)
            ),
        )

    async def send_thought_chunk(self, value: TextOrBlock) -> None:
        """Emit an ``agent_thought_chunk`` notification."""
        self._assert_active("send_thought_chunk")
        await self._client.session_update(
            session_id=self._session_id,
            update=AgentThoughtChunk(
                sessionUpdate="agent_thought_chunk", content=self._coerce_text(value)
            ),
        )

    async def send_tool_call(
        self,
        *,
        tool_call_id: str,
        title: str,
        kind: str | None = None,
        raw_input: Any = None,
        content: Sequence[Any] | None = None,
    ) -> None:
        """Emit a ``tool_call`` notification."""
        self._assert_active("send_tool_call")
        kwargs: dict[str, Any] = {
            "sessionUpdate": "tool_call",
            "toolCallId": tool_call_id,
            "title": title,
        }
        if kind is not None:
            kwargs["kind"] = kind
        if raw_input is not None:
            kwargs["rawInput"] = raw_input
        if content is not None:
            kwargs["content"] = list(content)
        await self._client.session_update(
            session_id=self._session_id, update=ToolCallStart(**kwargs)
        )

    async def send_tool_call_update(
        self,
        *,
        tool_call_id: str,
        status: str | None = None,
        raw_output: Any = None,
        content: Sequence[Any] | None = None,
    ) -> None:
        """Emit a ``tool_call_update`` notification."""
        self._assert_active("send_tool_call_update")
        kwargs: dict[str, Any] = {
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool_call_id,
        }
        if status is not None:
            kwargs["status"] = status  # type: ignore[assignment]
        if raw_output is not None:
            kwargs["rawOutput"] = raw_output
        if content is not None:
            kwargs["content"] = list(content)
        await self._client.session_update(
            session_id=self._session_id, update=ToolCallProgress(**kwargs)
        )

    async def request_permission(
        self,
        *,
        tool_call: ToolCallUpdate | dict[str, Any],
        options: Sequence[PermissionOption | dict[str, Any]],
    ) -> PermissionOutcome:
        """Send a ``session/request_permission`` request to the host and
        await the user's decision. Returns the resolved outcome.
        """
        self._assert_active("request_permission")
        normalized_options = [
            opt if isinstance(opt, PermissionOption) else PermissionOption(**opt)
            for opt in options
        ]
        normalized_tool_call = (
            tool_call
            if isinstance(tool_call, ToolCallUpdate)
            else ToolCallUpdate(**tool_call)
        )
        response = await self._client.request_permission(
            session_id=self._session_id,
            options=normalized_options,
            tool_call=normalized_tool_call,
        )
        return response.outcome

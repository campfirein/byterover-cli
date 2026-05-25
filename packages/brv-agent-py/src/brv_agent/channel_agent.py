"""ChannelAgent — ergonomic wrapper around the upstream ``acp`` Python lib's
agent protocol. See Channel Protocol §15 for the wire spec this targets.
"""

from __future__ import annotations

import asyncio
import inspect
import uuid
from typing import Any, Awaitable, Callable, Optional

import acp
from acp.schema import (
    AgentCapabilities,
    ClientCapabilities,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PromptCapabilities,
    PromptResponse,
)

from .prompt_context import PromptContext

PromptHandler = Callable[["acp.PromptRequest", PromptContext], Awaitable[PromptResponse]]
CancelHandler = Callable[["acp.CancelNotification"], Awaitable[None] | None]


class ChannelAgent:
    """Build a channel-aware ACP agent in ~30 LOC.

    Example:
        >>> agent = ChannelAgent(name="echo", version="0.1.0",
        ...                       prompt_capabilities={"embedded_context": True})
        >>>
        >>> @agent.on_prompt
        ... async def handle(req, ctx):
        ...     await ctx.send_message_chunk("hi")
        ...     return {"stop_reason": "end_turn"}
        >>>
        >>> import asyncio; asyncio.run(agent.run())
    """

    def __init__(
        self,
        *,
        name: str,
        version: str,
        prompt_capabilities: dict[str, bool] | PromptCapabilities | None = None,
    ) -> None:
        self._name = name
        self._version = version
        if prompt_capabilities is None:
            self._prompt_capabilities = PromptCapabilities()
        elif isinstance(prompt_capabilities, PromptCapabilities):
            self._prompt_capabilities = prompt_capabilities
        else:
            self._prompt_capabilities = PromptCapabilities(**prompt_capabilities)

        self._prompt_handler: PromptHandler | None = None
        self._cancel_handler: CancelHandler | None = None
        # session_id -> asyncio.Event (set when host cancels)
        self._cancel_events: dict[str, asyncio.Event] = {}

    def on_prompt(self, handler: PromptHandler) -> PromptHandler:
        """Decorator: register the prompt handler.

        Usage:
            @agent.on_prompt
            async def handle(req, ctx): ...
        """
        self._prompt_handler = handler
        return handler

    def on_cancel(self, handler: CancelHandler) -> CancelHandler:
        """Decorator: register an optional cancel observer.

        The SDK already triggers ``ctx.signal`` for in-flight prompt
        handlers; ``on_cancel`` is for agents that want to do extra
        bookkeeping (e.g. tear down an external resource) on cancel.
        """
        self._cancel_handler = handler
        return handler

    async def run(
        self,
        *,
        input_stream: Any = None,
        output_stream: Any = None,
    ) -> None:
        """Run the agent loop. Defaults to stdio (NDJSON) — the runner
        used for ``brv channel onboard``. Tests pass explicit
        ``input_stream`` / ``output_stream``.
        """
        await acp.run_agent(
            self,
            input_stream=input_stream,
            output_stream=output_stream,
        )

    # ─── acp.Agent protocol implementation ──────────────────────────────

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: ClientCapabilities | None = None,
        client_info: Optional[Implementation] = None,
        **kwargs: Any,
    ) -> InitializeResponse:
        return InitializeResponse(
            protocolVersion=1,
            agentCapabilities=AgentCapabilities(
                promptCapabilities=self._prompt_capabilities,
            ),
            agentInfo=Implementation(name=self._name, version=self._version),
        )

    async def new_session(
        self,
        cwd: str,
        mcp_servers: Any = None,
        **kwargs: Any,
    ) -> NewSessionResponse:
        session_id = str(uuid.uuid4())
        self._cancel_events[session_id] = asyncio.Event()
        return NewSessionResponse(sessionId=session_id)

    async def prompt(
        self,
        prompt: list[Any],
        session_id: str,
        **kwargs: Any,
    ) -> PromptResponse:
        if self._prompt_handler is None:
            raise RuntimeError(
                "ChannelAgent: no prompt handler registered. Use @agent.on_prompt before agent.run()."
            )

        cancel_event = self._cancel_events.setdefault(session_id, asyncio.Event())
        ctx = PromptContext(
            client=_get_client(self),
            session_id=session_id,
            cancel_event=cancel_event,
        )
        try:
            result = await self._prompt_handler(
                _build_prompt_request(prompt=prompt, session_id=session_id),
                ctx,
            )
        finally:
            ctx._deactivate()
            # Review fix #10: drop the cancel event once the handler has
            # resolved. The Event only matters DURING a prompt; keeping a
            # stale entry forever (or recreating one for a "next prompt"
            # that may never come) is the leak. A subsequent `prompt` on
            # the same `session_id` recreates the entry just-in-time via
            # the `setdefault(...)` above.
            self._cancel_events.pop(session_id, None)

        if isinstance(result, PromptResponse):
            return result
        if isinstance(result, dict):
            stop_reason = result.get("stop_reason") or result.get("stopReason") or "end_turn"
            # StopReason in the upstream schema is a `Literal` alias — pass
            # the bare string and let pydantic validate.
            return PromptResponse(stopReason=stop_reason)  # type: ignore[arg-type]
        raise TypeError(
            "ChannelAgent: on_prompt handler must return PromptResponse or "
            "{'stop_reason': '...'}"
        )

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        event = self._cancel_events.get(session_id)
        if event is not None:
            event.set()
        if self._cancel_handler is not None:
            from acp import CancelNotification
            notification = CancelNotification(sessionId=session_id)
            maybe_awaitable = self._cancel_handler(notification)
            # Review fix #18: `asyncio.iscoroutine` returns False for Task,
            # Future, and other awaitables. If a user's `on_cancel` returns
            # a Task (e.g. `asyncio.create_task(do_work())`), `iscoroutine`
            # silently drops it. `inspect.isawaitable` catches the broader
            # protocol used by `await`.
            if inspect.isawaitable(maybe_awaitable):
                await maybe_awaitable

    # The upstream acp Protocol requires `authenticate` to satisfy the
    # interface. v0.1 of brv-agent doesn't surface auth to user code — agents
    # that need an out-of-band login flow should raise an `AUTH_REQUIRED`
    # error from `initialize()` instead (§15.6).
    async def authenticate(self, method_id: str, **kwargs: Any) -> None:
        raise RuntimeError(
            "ChannelAgent: authenticate is not supported in v0.1. "
            "Surface AUTH_REQUIRED from initialize() instead."
        )

    # `on_connect` is called by acp.run_agent with the Client object so we
    # can call back into it (session_update, request_permission). We stash
    # it for PromptContext to use.
    def on_connect(self, client: acp.Client) -> None:
        self._client = client


# Internal helpers (separated for testability).

def _get_client(agent: "ChannelAgent") -> acp.Client:
    client = getattr(agent, "_client", None)
    if client is None:
        raise RuntimeError(
            "ChannelAgent.prompt() called before on_connect — did you call agent.run()?"
        )
    return client


def _build_prompt_request(*, prompt: list[Any], session_id: str) -> Any:
    """Wrap the raw prompt block list into a small adapter object the
    handler can pattern-match on. Mirrors the TS SDK's
    `PromptRequest` shape so the docs read identically across languages.
    """
    class _Req:
        def __init__(self) -> None:
            self.prompt = prompt
            self.session_id = session_id

    return _Req()

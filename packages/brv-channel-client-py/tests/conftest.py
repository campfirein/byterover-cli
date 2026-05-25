"""Shared pytest fixtures + in-process mock-daemon rig for Slice 7.−1b.

We boot a real ``socketio.AsyncServer`` on an ephemeral port (mounted
on ``aiohttp.web.Application``) so the auth handshake + ack envelope
serialisation are exercised end-to-end. This mirrors the TS client's
``test/helpers/mock-daemon.ts`` approach.
"""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
import socketio
from aiohttp import web


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


Handler = Callable[[Any, Callable[[Any], Awaitable[None]] | None], Awaitable[None]]


@dataclass
class MockDaemon:
    daemon_url: str
    auth_token: str
    data_dir: Path
    sio: socketio.AsyncServer
    runner: web.AppRunner
    received_auth_tokens: list[str] = field(default_factory=list)
    last_cwd: str | None = None
    handlers: dict[str, Handler] = field(default_factory=dict)
    joined_rooms: dict[str, list[str]] = field(default_factory=dict)

    def handle(self, event: str, handler: Handler) -> None:
        """Override the default ack handler for ``event``."""
        self.handlers[event] = handler

    async def emit(self, event: str, payload: Any) -> None:
        """Broadcast ``payload`` to all connected sockets."""
        await self.sio.emit(event, payload)

    async def stop(self) -> None:
        await self.runner.cleanup()


@pytest_asyncio.fixture
async def daemon(tmp_path: Path) -> AsyncIterator[MockDaemon]:
    auth_token = "test-token-" + tmp_path.name
    port = _free_port()
    data_dir = tmp_path / "brv-data"
    state_dir = data_dir / "state"
    state_dir.mkdir(parents=True)
    (data_dir / "daemon.json").write_text(json.dumps({"port": port}))
    (state_dir / "daemon-auth-token").write_text(auth_token)

    sio = socketio.AsyncServer(
        async_mode="aiohttp",
        cors_allowed_origins="*",
    )
    app = web.Application()
    sio.attach(app)

    rig = MockDaemon(
        daemon_url=f"http://127.0.0.1:{port}",
        auth_token=auth_token,
        data_dir=data_dir,
        sio=sio,
        runner=web.AppRunner(app),
    )

    @sio.event
    async def connect(sid: str, environ: dict[str, Any], auth: dict[str, Any] | None) -> None:
        token = (auth or {}).get("token")
        if token != auth_token:
            raise socketio.exceptions.ConnectionRefusedError("AUTH_REQUIRED")
        rig.received_auth_tokens.append(token)
        query = environ.get("QUERY_STRING", "")
        for pair in query.split("&"):
            if pair.startswith("cwd="):
                rig.last_cwd = pair[len("cwd="):]

    @sio.on("room:join")
    async def room_join(sid: str, room: str) -> dict[str, Any]:
        await sio.enter_room(sid, room)
        rig.joined_rooms.setdefault(sid, []).append(room)
        return {"success": True}

    @sio.on("room:leave")
    async def room_leave(sid: str, room: str) -> dict[str, Any]:
        await sio.leave_room(sid, room)
        return {"success": True}

    _hooked: set[str] = set()

    def _hook(event: str) -> None:
        if event in _hooked:
            return
        _hooked.add(event)

        @sio.on(event)
        async def _on_event(sid: str, data: Any) -> Any:  # noqa: ANN001
            handler = rig.handlers.get(event)
            if handler is None:
                # No handler registered — leave the request unacked so the
                # client surfaces a CHANNEL_REQUEST_TIMEOUT.
                forever: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
                return await forever

            ack_future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

            async def ack(payload: Any) -> None:
                if not ack_future.done():
                    ack_future.set_result(payload)

            await handler(data, ack)
            # If the user handler skipped `ack()`, never return — the
            # client's per-request timeout must fire.
            return await ack_future

    original_handle = rig.handle

    def handle(event: str, handler: Handler) -> None:
        original_handle(event, handler)
        _hook(event)

    rig.handle = handle  # type: ignore[assignment]

    await rig.runner.setup()
    site = web.TCPSite(rig.runner, "127.0.0.1", port)
    await site.start()

    try:
        yield rig
    finally:
        await rig.stop()


@pytest.fixture
def channel_client_factory(daemon: MockDaemon) -> Callable[[], Awaitable[Any]]:
    """Convenience factory that returns a connected ChannelClient."""
    from brv_channel_client import ChannelClient

    async def _connect() -> ChannelClient:
        return await ChannelClient.connect(data_dir=daemon.data_dir)

    return _connect

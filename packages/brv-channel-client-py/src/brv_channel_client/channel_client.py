"""ChannelClient — async Python client for the brv channel-protocol.

Mirrors ``packages/channel-client`` (TypeScript). Use it from any
asyncio host to drive ``channel:*`` requests and subscribe to broadcasts.

The client does NOT spawn the brv daemon — it expects one to be
running already. Run ``brv channel list`` once on first use to boot it.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator
from typing import Any

import socketio

from .discovery import discover_daemon
from .errors import CHANNEL_CLIENT_ERROR_CODE, ChannelClientError

TurnEvent = dict[str, Any]

# Sentinel pushed into every listener queue when the underlying socket
# disconnects, so parked iterators wake up and exit cleanly rather than
# hanging on `queue.get()` forever.
_DISCONNECTED = object()


def _resolve_default_request_timeout(override: float | None) -> float:
    if override is not None and override > 0:
        return override
    raw = os.environ.get("BRV_CHANNEL_REQUEST_TIMEOUT_MS")
    if not raw:
        return 60.0
    try:
        parsed = int(raw)
    except ValueError:
        return 60.0
    if parsed <= 0:
        return 60.0
    return parsed / 1000.0


def _is_ack_envelope(value: Any) -> bool:
    return isinstance(value, dict) and "success" in value


class ChannelClient:
    """Async client for the brv channel-protocol wire surface.

    Construct via :meth:`connect` (regular call) or :meth:`open` (async
    context manager). The client owns a single :class:`socketio.AsyncClient`
    connection and a per-event listener map for broadcasts.
    """

    def __init__(
        self,
        sio: socketio.AsyncClient,
        request_timeout: float,
    ) -> None:
        self._sio = sio
        self._default_request_timeout = request_timeout
        self._closed = False
        # event-name → list of async queues fed by the broadcast handler.
        self._listeners: dict[str, list[asyncio.Queue[Any]]] = {}

    @classmethod
    async def connect(
        cls,
        *,
        daemon_url: str | None = None,
        auth_token: str | None = None,
        data_dir: str | os.PathLike[str] | None = None,
        cwd: str | None = None,
        max_connect_attempts: int = 30,
        connect_attempt_delay: float = 0.1,
        request_timeout: float | None = None,
    ) -> ChannelClient:
        """Connect to a running brv daemon.

        Auto-discovers ``daemon_url`` + ``auth_token`` from
        ``<data_dir>/daemon.json`` + ``<data_dir>/state/daemon-auth-token``
        unless explicit overrides are supplied (useful for tests).

        Raises :class:`ChannelClientError` with code
        ``BRV_DAEMON_NOT_INITIALISED`` (daemon never booted) or
        ``BRV_CHANNEL_CONNECT_FAILED`` (Socket.IO handshake refused).
        """
        if daemon_url is None or auth_token is None:
            discovered = discover_daemon(data_dir)
            daemon_url = daemon_url or discovered.daemon_url
            auth_token = auth_token or discovered.auth_token

        sio = socketio.AsyncClient(reconnection=False)
        effective_cwd = cwd if cwd is not None else os.getcwd()
        url_with_query = f"{daemon_url}?cwd={effective_cwd}"
        # auth + transports mirror the TS client's handshake.

        last_error: Exception | None = None
        for attempt in range(1, max_connect_attempts + 1):
            try:
                await sio.connect(
                    url_with_query,
                    auth={"token": auth_token},
                    transports=["websocket"],
                    wait=True,
                    wait_timeout=5,
                )
                last_error = None
                break
            except Exception as exc:  # socketio.exceptions.ConnectionError + friends.
                last_error = exc
                if attempt < max_connect_attempts:
                    await asyncio.sleep(connect_attempt_delay)

        if last_error is not None:
            with contextlib.suppress(Exception):
                await sio.disconnect()
            raise ChannelClientError(
                CHANNEL_CLIENT_ERROR_CODE.CONNECT_FAILED,
                (
                    f"Failed to connect to the brv daemon at {daemon_url} after "
                    f"{max_connect_attempts} attempts: {last_error}"
                ),
            )

        client = cls(sio, _resolve_default_request_timeout(request_timeout))
        client._install_broadcast_router()
        return client

    @property
    def connected(self) -> bool:
        return not self._closed and self._sio.connected

    async def close(self) -> None:
        """Disconnect and release the socket. Idempotent."""
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            await self._sio.disconnect()

    async def __aenter__(self) -> ChannelClient:
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    async def request(
        self,
        event: str,
        data: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> Any:
        """Emit a ``channel:*`` request and await the daemon's ack.

        Returns the ack envelope's ``data`` field on ``{success: true}``.
        Raises :class:`ChannelClientError` carrying ``code``, ``message``,
        and ``details`` on ``{success: false}``.
        """
        if self._closed:
            raise ChannelClientError(
                CHANNEL_CLIENT_ERROR_CODE.CONNECT_FAILED,
                f"ChannelClient is closed; cannot request {event!r}.",
            )

        effective_timeout = timeout if timeout is not None and timeout > 0 else self._default_request_timeout
        try:
            response = await self._sio.call(event, data, timeout=effective_timeout)
        except (asyncio.TimeoutError, socketio.exceptions.TimeoutError) as exc:
            raise ChannelClientError(
                CHANNEL_CLIENT_ERROR_CODE.REQUEST_TIMEOUT,
                (
                    f"Channel request {event!r} did not receive a response within "
                    f"{int(effective_timeout * 1000)}ms"
                ),
            ) from exc

        if not _is_ack_envelope(response):
            raise ChannelClientError(
                CHANNEL_CLIENT_ERROR_CODE.MALFORMED_RESPONSE,
                f"Malformed response from daemon for {event}",
            )

        if response.get("success") is True:
            return response.get("data")

        raise ChannelClientError(
            response.get("code") or CHANNEL_CLIENT_ERROR_CODE.MALFORMED_RESPONSE,
            response.get("error") or "Channel request failed",
            response.get("details"),
        )

    async def mention(
        self,
        channel_id: str,
        prompt: str,
        *,
        mode: str = "stream",
        suppress_thoughts: bool = False,
        timeout: float | None = None,
    ) -> Any:
        """Slice 8.0 — ergonomic ``channel:mention`` wrapper.

        - ``mode="stream"`` (default): returns the ``ChannelTurnAcceptedResponse``
          dispatch dict (``{"deliveries": [...], "turn": {...}}``); turn events
          flow via :meth:`subscribe_turn` / :meth:`subscribe_channel`.
        - ``mode="sync"``: daemon buffers the turn and returns the assembled
          ``ChannelMentionSyncResponse`` dict (``{"finalAnswer", "endedState",
          "durationMs", "toolCalls", "turnId", "channelId"}``) when terminal.

        ``suppress_thoughts=True`` drops ``agent_thought_chunk`` events on the
        wire and the disk. ``timeout`` is the per-request socket-call timeout
        in seconds; for sync mode the daemon also enforces its own timeout.
        """
        payload: dict[str, Any] = {"channelId": channel_id, "prompt": prompt}
        if mode != "stream":
            payload["mode"] = mode
        if suppress_thoughts:
            payload["suppressThoughts"] = True
        if timeout is not None:
            # Convert client-side seconds to daemon-side milliseconds.
            payload["timeout"] = int(timeout * 1000)
        return await self.request("channel:mention", payload, timeout=timeout)

    async def subscribe(self, channel_id: str) -> None:
        """Join the Socket.IO room for ``channel_id`` so broadcasts reach
        this client.  Returns when the daemon acks the join.
        """
        await self._room_emit("room:join", channel_id)

    async def unsubscribe(self, channel_id: str) -> None:
        """Leave the channel's Socket.IO room."""
        await self._room_emit("room:leave", channel_id)

    async def subscribe_channel(self, channel_id: str) -> AsyncIterator[dict[str, Any]]:
        """Yield every broadcast for ``channel_id`` (turn-events, member
        updates, state changes). Caller filters by ``kind`` / event type.
        """
        queue = self._register_listener("channel:turn-event")
        await self.subscribe(channel_id)
        try:
            while True:
                payload = await queue.get()
                if payload is _DISCONNECTED:
                    return
                if not isinstance(payload, dict):
                    continue
                if payload.get("channelId") != channel_id:
                    continue
                yield payload
        finally:
            self._unregister_listener("channel:turn-event", queue)
            if self.connected:
                with contextlib.suppress(Exception):
                    await self.unsubscribe(channel_id)

    async def subscribe_turn(
        self,
        channel_id: str,
        turn_id: str,
    ) -> AsyncIterator[TurnEvent]:
        """Yield each ``channel:turn-event`` for ``turn_id`` in ``seq`` order.

        Ends when a terminal ``turn_state_change`` arrives
        (``to`` ∈ ``{"completed", "cancelled"}``). Joins the channel room
        on entry, leaves on exit.
        """
        queue = self._register_listener("channel:turn-event")
        await self.subscribe(channel_id)
        try:
            while True:
                payload = await queue.get()
                if payload is _DISCONNECTED:
                    return
                if not isinstance(payload, dict):
                    continue
                if payload.get("channelId") != channel_id:
                    continue
                event = payload.get("event")
                if not isinstance(event, dict):
                    continue
                if event.get("turnId") != turn_id:
                    continue
                yield event
                if (
                    event.get("kind") == "turn_state_change"
                    and event.get("to") in ("completed", "cancelled")
                ):
                    return
        finally:
            self._unregister_listener("channel:turn-event", queue)
            # Only unsubscribe while the socket is alive — a dead socket
            # can't ack the leave call and we'd hang the cleanup path.
            if self.connected:
                with contextlib.suppress(Exception):
                    await self.unsubscribe(channel_id)

    # ------------------------------------------------------------------ internals

    def _install_broadcast_router(self) -> None:
        """Route every broadcast event we care about into per-event queues."""

        async def _route(event_name: str, data: Any) -> None:
            queues = self._listeners.get(event_name)
            if not queues:
                return
            for queue in queues:
                queue.put_nowait(data)

        # python-socketio uses on('*') for catch-all in async mode.
        @self._sio.on("channel:turn-event")
        async def _on_turn_event(data: Any) -> None:  # noqa: ANN001
            await _route("channel:turn-event", data)

        @self._sio.on("channel:member-update")
        async def _on_member_update(data: Any) -> None:  # noqa: ANN001
            await _route("channel:member-update", data)

        @self._sio.on("channel:state-change")
        async def _on_state_change(data: Any) -> None:  # noqa: ANN001
            await _route("channel:state-change", data)

        @self._sio.on("disconnect")
        async def _on_disconnect() -> None:
            # Wake every parked listener so async generators exit
            # promptly instead of blocking on a queue that will never
            # receive another item.
            for queues in list(self._listeners.values()):
                for queue in queues:
                    queue.put_nowait(_DISCONNECTED)

    def _register_listener(self, event_name: str) -> asyncio.Queue[Any]:
        queue: asyncio.Queue[Any] = asyncio.Queue()
        self._listeners.setdefault(event_name, []).append(queue)
        return queue

    def _unregister_listener(self, event_name: str, queue: asyncio.Queue[Any]) -> None:
        queues = self._listeners.get(event_name)
        if not queues:
            return
        with contextlib.suppress(ValueError):
            queues.remove(queue)
        if not queues:
            self._listeners.pop(event_name, None)

    async def _room_emit(self, event: str, channel_id: str) -> None:
        room = f"channel:{channel_id}"
        response = await self._sio.call(event, room, timeout=self._default_request_timeout)
        if (
            isinstance(response, dict)
            and response.get("success") is True
        ):
            return
        raise ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.CONNECT_FAILED,
            f"{event} for {room} failed: {response!r}",
        )

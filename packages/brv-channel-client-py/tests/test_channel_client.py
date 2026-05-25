"""Slice 7.−1b — Python channel-client unit tests, driven outside-in by
the kimi-cli slash-command shape (see IMPLEMENTATION_PHASE_7.md).

The tests use a real Socket.IO server on an ephemeral port — not a pure
in-memory fake — so we exercise the actual handshake auth path + ack
envelope serialisation.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest

from brv_channel_client import ChannelClient, ChannelClientError, discover_daemon


class TestDiscoverDaemon:
    def test_reads_daemon_url_and_auth_token_from_data_dir(self, daemon: Any) -> None:
        discovered = discover_daemon(daemon.data_dir)
        assert discovered.daemon_url == daemon.daemon_url
        assert discovered.auth_token == daemon.auth_token

    def test_throws_daemon_not_initialised_when_daemon_json_missing(self, tmp_path: Path) -> None:
        missing = tmp_path / "no-brv-here"
        with pytest.raises(ChannelClientError) as exc_info:
            discover_daemon(missing)
        assert exc_info.value.code == "BRV_DAEMON_NOT_INITIALISED"

    def test_env_var_overrides_default_home(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("BRV_DATA_DIR", str(empty))
        with pytest.raises(ChannelClientError) as exc_info:
            discover_daemon()
        assert exc_info.value.code == "BRV_DAEMON_NOT_INITIALISED"
        # Message must mention the env-supplied dir, not the user's $HOME.
        assert str(empty) in exc_info.value.message


class TestConnect:
    async def test_connects_to_discovered_url_with_auth_handshake(self, daemon: Any) -> None:
        client = await ChannelClient.connect(data_dir=daemon.data_dir)
        try:
            assert client.connected is True
            assert daemon.auth_token in daemon.received_auth_tokens
        finally:
            await client.close()
        assert client.connected is False

    async def test_honours_explicit_overrides(self, daemon: Any) -> None:
        client = await ChannelClient.connect(
            daemon_url=daemon.daemon_url,
            auth_token=daemon.auth_token,
        )
        try:
            assert client.connected is True
        finally:
            await client.close()

    async def test_rejects_with_connect_failed_on_wrong_auth(self, daemon: Any) -> None:
        with pytest.raises(ChannelClientError) as exc_info:
            await ChannelClient.connect(
                daemon_url=daemon.daemon_url,
                auth_token="wrong-token",
                connect_attempt_delay=0.005,
                max_connect_attempts=2,
            )
        assert exc_info.value.code == "BRV_CHANNEL_CONNECT_FAILED"


class TestRequest:
    async def test_resolves_with_data_on_success_ack(self, daemon: Any) -> None:
        async def list_handler(data: Any, ack: Any) -> None:
            await ack({"success": True, "data": {"channels": [{"channelId": "pi-test"}]}})

        daemon.handle("channel:list", list_handler)
        client = await ChannelClient.connect(data_dir=daemon.data_dir)
        try:
            result = await client.request("channel:list", {})
        finally:
            await client.close()

        assert isinstance(result, dict)
        assert result["channels"][0]["channelId"] == "pi-test"

    async def test_rejects_with_channel_client_error_on_failure_ack(self, daemon: Any) -> None:
        async def get_handler(data: Any, ack: Any) -> None:
            await ack({
                "success": False,
                "code": "CHANNEL_NOT_FOUND",
                "error": "Channel #ghost not found",
                "details": {"channelId": "ghost"},
            })

        daemon.handle("channel:get", get_handler)
        client = await ChannelClient.connect(data_dir=daemon.data_dir)
        try:
            with pytest.raises(ChannelClientError) as exc_info:
                await client.request("channel:get", {"channelId": "ghost"})
        finally:
            await client.close()

        err = exc_info.value
        assert err.code == "CHANNEL_NOT_FOUND"
        assert err.message == "Channel #ghost not found"
        assert err.details == {"channelId": "ghost"}

    async def test_rejects_with_timeout_when_daemon_never_acks(self, daemon: Any) -> None:
        async def stuck_handler(data: Any, ack: Any) -> None:
            return  # never acks.

        daemon.handle("channel:stuck", stuck_handler)
        client = await ChannelClient.connect(
            data_dir=daemon.data_dir,
            request_timeout=0.15,
        )
        try:
            with pytest.raises(ChannelClientError) as exc_info:
                await client.request("channel:stuck", {})
        finally:
            await client.close()

        assert exc_info.value.code == "CHANNEL_REQUEST_TIMEOUT"


class TestSubscribeTurn:
    async def test_yields_events_for_named_turn_ends_on_terminal(self, daemon: Any) -> None:
        channel_id = "pi-test"
        turn_id = "01HX-test"
        client = await ChannelClient.connect(data_dir=daemon.data_dir)

        async def collect() -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            async for event in client.subscribe_turn(channel_id, turn_id):
                out.append(event)
            return out

        collect_task = asyncio.create_task(collect())
        try:
            # Wait for subscribe()'s round-trip + listener registration.
            await asyncio.sleep(0.1)

            await daemon.emit(
                "channel:turn-event",
                {
                    "channelId": channel_id,
                    "event": {
                        "channelId": channel_id,
                        "deliveryId": "d1",
                        "emittedAt": "2026-05-13T00:00:00Z",
                        "kind": "agent_message_chunk",
                        "memberHandle": "@echo",
                        "seq": 1,
                        "turnId": turn_id,
                        "content": "hi",
                    },
                },
            )
            await daemon.emit(
                "channel:turn-event",
                {
                    "channelId": channel_id,
                    "event": {
                        "channelId": channel_id,
                        "deliveryId": "d1",
                        "emittedAt": "2026-05-13T00:00:01Z",
                        "from": "streaming",
                        "kind": "delivery_state_change",
                        "memberHandle": "@echo",
                        "seq": 2,
                        "to": "completed",
                        "turnId": turn_id,
                    },
                },
            )
            await daemon.emit(
                "channel:turn-event",
                {
                    "channelId": channel_id,
                    "event": {
                        "channelId": channel_id,
                        "deliveryId": None,
                        "emittedAt": "2026-05-13T00:00:02Z",
                        "from": "dispatched",
                        "kind": "turn_state_change",
                        "memberHandle": None,
                        "seq": 3,
                        "to": "completed",
                        "turnId": turn_id,
                    },
                },
            )

            collected = await asyncio.wait_for(collect_task, timeout=5.0)
        finally:
            await client.close()

        assert len(collected) == 3
        assert collected[0]["kind"] == "agent_message_chunk"
        assert collected[0]["content"] == "hi"
        assert collected[2]["kind"] == "turn_state_change"
        assert collected[2]["to"] == "completed"

    async def test_ends_iterator_on_socket_disconnect(self, daemon: Any) -> None:
        channel_id = "pi-test"
        turn_id = "01HX-disconnect"
        client = await ChannelClient.connect(data_dir=daemon.data_dir)

        async def collect() -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            async for event in client.subscribe_turn(channel_id, turn_id):
                out.append(event)
            return out

        collect_task = asyncio.create_task(collect())
        try:
            await asyncio.sleep(0.1)
            # Yank every connected socket from the daemon side —
            # simulates a daemon crash or network blip mid-turn. The
            # generator must wake from its queue.get() and exit.
            await daemon.sio.disconnect(next(iter(daemon.sio.manager.rooms["/"][None])))
            collected = await asyncio.wait_for(collect_task, timeout=2.0)
        finally:
            await client.close()

        assert collected == []

    async def test_does_not_yield_events_for_other_turns(self, daemon: Any) -> None:
        channel_id = "pi-test"
        wanted_turn = "01HX-wanted"
        other_turn = "01HX-other"
        client = await ChannelClient.connect(data_dir=daemon.data_dir)

        async def collect() -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            async for event in client.subscribe_turn(channel_id, wanted_turn):
                out.append(event)
            return out

        collect_task = asyncio.create_task(collect())
        try:
            await asyncio.sleep(0.1)
            # Noise: a chunk on another turn — must NOT be yielded.
            await daemon.emit(
                "channel:turn-event",
                {
                    "channelId": channel_id,
                    "event": {
                        "channelId": channel_id,
                        "deliveryId": "d",
                        "emittedAt": "t",
                        "kind": "agent_message_chunk",
                        "memberHandle": "@x",
                        "seq": 1,
                        "turnId": other_turn,
                        "content": "noise",
                    },
                },
            )
            await daemon.emit(
                "channel:turn-event",
                {
                    "channelId": channel_id,
                    "event": {
                        "channelId": channel_id,
                        "deliveryId": None,
                        "emittedAt": "t",
                        "from": "dispatched",
                        "kind": "turn_state_change",
                        "memberHandle": None,
                        "seq": 2,
                        "to": "completed",
                        "turnId": wanted_turn,
                    },
                },
            )

            collected = await asyncio.wait_for(collect_task, timeout=5.0)
        finally:
            await client.close()

        assert len(collected) == 1
        assert collected[0]["turnId"] == wanted_turn

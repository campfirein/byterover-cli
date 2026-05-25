"""Daemon discovery — locates ``daemon.json`` (URL + port) and
``state/daemon-auth-token`` for the running brv daemon.

Priority order for the data dir:
  1. Explicit ``data_dir`` argument (test override).
  2. ``BRV_DATA_DIR`` env var.
  3. ``~/.brv`` (matches the daemon's ``getGlobalDataDir()``).

The client does NOT spawn the daemon. If ``daemon.json`` is missing, we
fast-fail with ``BRV_DAEMON_NOT_INITIALISED`` so the host CLI can tell
the user to run ``brv`` once first.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .errors import CHANNEL_CLIENT_ERROR_CODE, ChannelClientError


@dataclass(frozen=True)
class DiscoveredDaemon:
    """Result of :func:`discover_daemon`."""

    daemon_url: str
    """Socket.IO endpoint, e.g. ``http://127.0.0.1:61420``."""

    data_dir: Path
    """Resolved data dir used to read the files."""

    daemon_json_path: Path
    """Path to ``daemon.json`` (for error messages)."""

    auth_token: str
    """Daemon-auth-token contents, stripped of trailing whitespace."""


def _resolve_data_dir(override: str | os.PathLike[str] | None) -> Path:
    if override is not None and str(override) != "":
        return Path(override)
    env = os.environ.get("BRV_DATA_DIR")
    if env:
        return Path(env)
    return Path.home() / ".brv"


def discover_daemon(data_dir: str | os.PathLike[str] | None = None) -> DiscoveredDaemon:
    """Read ``daemon.json`` + ``state/daemon-auth-token`` from disk."""
    resolved = _resolve_data_dir(data_dir)
    daemon_json_path = resolved / "daemon.json"
    token_path = resolved / "state" / "daemon-auth-token"

    try:
        raw = daemon_json_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
            (
                f"brv daemon not running: {daemon_json_path} not found. "
                "Start the daemon first (e.g. run `brv channel list` once)."
            ),
        ) from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
            f"{daemon_json_path} is not valid JSON: {exc}",
        ) from exc

    port = parsed.get("port") if isinstance(parsed, dict) else None
    if not isinstance(port, int) or port <= 0:
        raise ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
            f"{daemon_json_path} does not contain a valid `port` field.",
        )

    try:
        token_raw = token_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
            (
                f"Daemon auth token not found at {token_path}. "
                "The brv daemon must be started at least once."
            ),
        ) from exc

    auth_token = token_raw.strip()
    if auth_token == "":
        raise ChannelClientError(
            CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
            f"Daemon auth token at {token_path} is empty. Run `brv restart` to regenerate.",
        )

    return DiscoveredDaemon(
        auth_token=auth_token,
        daemon_json_path=daemon_json_path,
        daemon_url=f"http://127.0.0.1:{port}",
        data_dir=resolved,
    )

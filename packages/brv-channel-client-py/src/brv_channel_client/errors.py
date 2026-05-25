"""ChannelClientError + canonical error codes.

Mirrors `packages/channel-client/src/errors.ts` so the two language
clients surface the same wire-level conditions to host code.
"""

from __future__ import annotations

from typing import Any, Final


class CHANNEL_CLIENT_ERROR_CODE:  # noqa: N801 — intentional parity with TS const.
    """Error codes the client itself raises before/around the wire call.

    Daemon-supplied codes (e.g. `CHANNEL_NOT_FOUND`) flow through verbatim
    on `{success: false}` ack envelopes.
    """

    DAEMON_NOT_INITIALISED: Final = "BRV_DAEMON_NOT_INITIALISED"
    CONNECT_FAILED: Final = "BRV_CHANNEL_CONNECT_FAILED"
    REQUEST_TIMEOUT: Final = "CHANNEL_REQUEST_TIMEOUT"
    MALFORMED_RESPONSE: Final = "MALFORMED_RESPONSE"


class ChannelClientError(Exception):
    """A failure surfaced by the brv channel client.

    ``code`` is either one of :class:`CHANNEL_CLIENT_ERROR_CODE` (raised
    locally before/around the wire call) or a daemon-supplied error code
    propagated verbatim from a `{success: false}` ack envelope. ``details``
    is whatever structured detail the daemon attached; preserved so
    callers can render rich error UIs.
    """

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def __repr__(self) -> str:  # pragma: no cover — debug only.
        return f"ChannelClientError(code={self.code!r}, message={self.message!r})"

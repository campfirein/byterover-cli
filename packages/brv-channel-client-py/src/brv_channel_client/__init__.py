"""brv-channel-client — Python client for the brv channel-protocol wire
surface. Drives `channel:*` requests and subscribes to broadcasts from
any asyncio host (kimi-cli, custom CLIs, …).

See `CHANNEL_PROTOCOL.md` for the spec this client targets.
"""

from .channel_client import ChannelClient, TurnEvent
from .discovery import DiscoveredDaemon, discover_daemon
from .errors import CHANNEL_CLIENT_ERROR_CODE, ChannelClientError

__version__ = "0.1.0"

__all__ = [
    "CHANNEL_CLIENT_ERROR_CODE",
    "ChannelClient",
    "ChannelClientError",
    "DiscoveredDaemon",
    "TurnEvent",
    "__version__",
    "discover_daemon",
]

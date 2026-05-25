"""brv-agent — thin ergonomic wrapper over the Agent Client Protocol
for building agents that join brv channels.

See `CHANNEL_PROTOCOL.md` §15 for the wire spec this SDK targets.
"""

from .channel_agent import CancelHandler, ChannelAgent, PromptHandler
from .prompt_context import PromptContext

__version__ = "0.1.0"

__all__ = [
    "CancelHandler",
    "ChannelAgent",
    "PromptContext",
    "PromptHandler",
    "__version__",
]

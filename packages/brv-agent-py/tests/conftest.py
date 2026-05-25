"""Shared pytest fixtures + an in-memory paired-stream rig for Slice 5.3."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass


async def _make_reader(read_fd: int) -> asyncio.StreamReader:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1024 * 1024)
    pipe = os.fdopen(read_fd, "rb", buffering=0)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), pipe)
    return reader


async def _make_writer(write_fd: int) -> asyncio.StreamWriter:
    loop = asyncio.get_running_loop()
    pipe = os.fdopen(write_fd, "wb", buffering=0)
    transport, protocol = await loop.connect_write_pipe(
        asyncio.streams.FlowControlMixin, pipe
    )
    return asyncio.StreamWriter(transport, protocol, None, loop)


@dataclass
class PairedRig:
    """A pair of asyncio stream halves for in-memory agent↔client testing.

    NDJSON over two OS pipes:
      client_to_agent: write end (client_output) → read end (agent_input)
      agent_to_client: write end (agent_output)  → read end (client_input)
    """

    agent_input: asyncio.StreamReader
    agent_output: asyncio.StreamWriter
    client_input: asyncio.StreamReader
    client_output: asyncio.StreamWriter


async def create_paired_streams() -> PairedRig:
    """Build a fresh paired-stream rig. Call inside an async test."""
    c2a_read, c2a_write = os.pipe()
    a2c_read, a2c_write = os.pipe()

    agent_input = await _make_reader(c2a_read)
    agent_output = await _make_writer(a2c_write)
    client_input = await _make_reader(a2c_read)
    client_output = await _make_writer(c2a_write)

    return PairedRig(
        agent_input=agent_input,
        agent_output=agent_output,
        client_input=client_input,
        client_output=client_output,
    )

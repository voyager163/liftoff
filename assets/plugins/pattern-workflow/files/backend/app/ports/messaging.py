"""Messaging: how parts of the application hand work to each other.

``MessageBus`` is the boundary. ``InMemoryMessageBus`` keeps messages in this
process, so they are lost on restart and only workers in the same process see
them. For durable messaging, implement ``MessageBus`` over a broker such as
Azure Service Bus.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator
from typing import Protocol

Message = dict[str, str]


class MessageBus(Protocol):
    async def publish(self, topic: str, message: Message) -> None: ...

    def subscribe(self, topic: str) -> AsyncIterator[Message]: ...


class InMemoryMessageBus:
    """One queue per topic, in this process."""

    def __init__(self) -> None:
        self._queues: defaultdict[str, asyncio.Queue[Message]] = defaultdict(asyncio.Queue)

    async def publish(self, topic: str, message: Message) -> None:
        await self._queues[topic].put(message)

    async def subscribe(self, topic: str) -> AsyncIterator[Message]:
        queue = self._queues[topic]
        while True:
            yield await queue.get()

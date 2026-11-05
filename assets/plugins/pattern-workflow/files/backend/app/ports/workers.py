"""Workers: background work driven by messages.

``InProcessWorker`` handles each message of a topic on a task in the API's own
process, from startup to shutdown. A handler that fails is logged and the
worker carries on with the next message; nothing is retried. For work that
must survive restarts or scale apart from the API, run the same handler in a
separate worker service fed by a durable ``MessageBus``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress

from app.ports.messaging import Message, MessageBus

log = logging.getLogger(__name__)


class InProcessWorker:
    def __init__(
        self, bus: MessageBus, topic: str, handle: Callable[[Message], Awaitable[None]]
    ) -> None:
        self.bus = bus
        self.topic = topic
        self.handle = handle
        self._task: asyncio.Task[None] | None = None

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    async def _run(self) -> None:
        async for message in self.bus.subscribe(self.topic):
            try:
                await self.handle(message)
            except Exception:  # One bad message must not stop the worker.
                log.exception("worker on %s failed to handle a message", self.topic)

    @asynccontextmanager
    async def running(self) -> AsyncIterator[None]:
        self._task = asyncio.create_task(self._run())
        try:
            yield
        finally:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task

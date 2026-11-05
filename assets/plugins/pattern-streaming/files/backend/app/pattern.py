"""Streaming: answers sent as they are written.

``POST /v1/stream`` answers with server-sent events: a ``delta`` event for
each piece of text as the provider sends it, then ``done``, or ``error`` if the
model fails or runs out of time. Nothing is buffered: each piece goes out as
soon as it arrives.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack

from fastapi import APIRouter, FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.exceptions import AgentRunError
from pydantic_ai.models import Model

from app.config import Settings

log = logging.getLogger(__name__)


class StreamRequest(BaseModel):
    input: str = Field(min_length=1, max_length=20_000)


def event(name: str, data: dict[str, str]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def install(app: FastAPI, settings: Settings, model: Model) -> None:
    agent = Agent(model, instructions=settings.instructions)
    router = APIRouter(prefix="/v1", tags=["streaming"])

    async def events(prompt: str) -> AsyncIterator[str]:
        # The deadline covers each wait for the model, but not the time the
        # client takes to read what was already sent.
        deadline = asyncio.get_running_loop().time() + settings.model_timeout_seconds
        try:
            async with AsyncExitStack() as stack:
                async with asyncio.timeout_at(deadline):
                    result = await stack.enter_async_context(agent.run_stream(prompt))
                deltas = aiter(result.stream_text(delta=True, debounce_by=None))
                while True:
                    async with asyncio.timeout_at(deadline):
                        delta = await anext(deltas, None)
                    if delta is None:
                        break
                    yield event("delta", {"text": delta})
            yield event("done", {})
        except TimeoutError:
            log.warning("model timed out while streaming")
            yield event("error", {"detail": "The model did not answer in time."})
        except AgentRunError:
            log.warning("model failed while streaming", exc_info=True)
            yield event("error", {"detail": "The model failed to answer."})

    @router.post("/stream", response_class=StreamingResponse)
    async def stream(request: StreamRequest) -> StreamingResponse:
        return StreamingResponse(
            events(request.input),
            media_type="text/event-stream",
            # Proxies must pass each event on at once rather than buffer them.
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    app.include_router(router)

"""How model failures reach clients.

A slow model is a 504 and a failing provider a 502. The provider's own message
is logged, not returned, because it can contain details of the request.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic_ai.exceptions import AgentRunError

from app.ports.model import ModelTimeoutError

log = logging.getLogger(__name__)


def install(app: FastAPI) -> None:
    @app.exception_handler(ModelTimeoutError)
    async def timed_out(request: Request, error: ModelTimeoutError) -> JSONResponse:
        log.warning("model timed out on %s: %s", request.url.path, error)
        return JSONResponse(
            status_code=504, content={"detail": "The model did not answer in time."}
        )

    @app.exception_handler(AgentRunError)
    async def failed(request: Request, error: AgentRunError) -> JSONResponse:
        log.warning("model failed on %s", request.url.path, exc_info=error)
        return JSONResponse(status_code=502, content={"detail": "The model failed to answer."})

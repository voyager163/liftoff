"""Liveness and readiness.

``/health/live`` says the process is running and never touches dependencies.
``/health/ready`` checks each dependency the API needs to serve requests and
answers 503 when one is unavailable, so traffic is only sent when it can be
handled.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import Engine, text

router = APIRouter(prefix="/health", tags=["health"])
log = logging.getLogger(__name__)


@router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


def database_ready(engine: Engine) -> bool:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception:  # Any failure means not ready; the detail is logged, not returned.
        log.warning("database readiness check failed", exc_info=True)
        return False
    return True


@router.get("/ready", responses={503: {"description": "A dependency is unavailable"}})
def ready(request: Request) -> JSONResponse:
    checks = {"database": "ok" if database_ready(request.app.state.engine) else "unavailable"}
    healthy = all(state == "ok" for state in checks.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ready" if healthy else "not-ready", "checks": checks},
    )

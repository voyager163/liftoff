"""Liveness and readiness.

``/health/live`` says the process is running and never touches dependencies.
``/health/ready`` answers 503 while something the pattern needs, such as its
documents or its worker, is unavailable. It does not call the model: that
would cost money on every probe. A model that cannot be configured stops the
API at startup instead.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/health", tags=["health"])

# What each pattern registers: a name and a check that is True when ready.
Checks = dict[str, Callable[[], bool]]


@router.get("/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready", responses={503: {"description": "A dependency is unavailable"}})
def ready(request: Request) -> JSONResponse:
    registered: Checks = request.app.state.readiness
    checks = {name: "ok" if check() else "unavailable" for name, check in registered.items()}
    healthy = all(state == "ok" for state in checks.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ready" if healthy else "not-ready", "checks": checks},
    )

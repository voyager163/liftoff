"""Application factory. Run it with: uv run python -m app"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic_ai.models import Model
from scalar_fastapi import get_scalar_api_reference

from app import errors, health, pattern
from app.config import Settings, load_settings
from app.ports.model import build_model
from app.ports.tracing import start_tracing


def create_app(settings: Settings | None = None, model: Model | None = None) -> FastAPI:
    settings = settings or load_settings()
    model = model or build_model(settings.model)
    tracing = start_tracing(settings.tracing)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            for hook in app.state.lifespan_hooks:
                await stack.enter_async_context(hook())
            yield
        tracing.flush()

    app = FastAPI(
        title="{{liftoff.name}} API",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    # What the pattern adds: readiness checks and work that runs while the API does.
    app.state.readiness = {}
    app.state.lifespan_hooks = []
    app.include_router(health.router)
    errors.install(app)
    pattern.install(app, settings, model)

    if settings.docs_enabled:

        @app.get("/docs", include_in_schema=False)
        def docs() -> HTMLResponse:
            return get_scalar_api_reference(openapi_url="/openapi.json", title=app.title)

    return app

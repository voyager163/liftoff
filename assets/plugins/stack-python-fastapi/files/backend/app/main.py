"""Application factory. Run it with: uv run python -m app"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from scalar_fastapi import get_scalar_api_reference
from sqlalchemy import Engine
from sqlalchemy.orm import sessionmaker

from app import health, items
from app.config import Settings, load_settings
from app.database import make_engine


def create_app(settings: Settings | None = None, engine: Engine | None = None) -> FastAPI:
    settings = settings or load_settings()
    engine = engine or make_engine(settings.database_url, settings.database_timeout_seconds)
    app = FastAPI(
        title="{{liftoff.name}} API",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessions = sessionmaker(engine, expire_on_commit=False)
    app.include_router(health.router)
    app.include_router(items.router)

    if settings.docs_enabled:

        @app.get("/docs", include_in_schema=False)
        def docs() -> HTMLResponse:
            return get_scalar_api_reference(openapi_url="/openapi.json", title=app.title)

    return app

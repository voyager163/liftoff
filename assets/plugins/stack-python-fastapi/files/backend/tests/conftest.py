from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers the models)
from app.config import Settings
from app.database import Base
from app.main import create_app


@pytest.fixture
def engine() -> Iterator[Engine]:
    """An in-memory SQLite database, so unit tests need no server."""
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def client(engine: Engine) -> Iterator[TestClient]:
    settings = Settings(database_url="sqlite+pysqlite:///:memory:")
    with TestClient(create_app(settings=settings, engine=engine)) as test_client:
        yield test_client

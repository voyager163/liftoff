"""Tests against a real PostgreSQL database.

Run them with: APP_DATABASE_URL=... uv run pytest -m integration --no-cov
They fail, rather than skip, when no database is configured. Each test works
in a new schema that is dropped afterwards, so the tables and data already in
that database are never touched.
"""

import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text

from app.config import Settings
from app.database import make_engine
from app.main import create_app

pytestmark = pytest.mark.integration
BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def database_url() -> str:
    url = os.environ.get("APP_DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("integration tests need APP_DATABASE_URL pointing at PostgreSQL")
    return url


@pytest.fixture
def engine(database_url: str) -> Iterator[Engine]:
    """An engine whose connections only see a new, empty schema."""
    schema = f"test_{uuid.uuid4().hex}"
    admin = make_engine(database_url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    isolated = make_engine(database_url)

    @event.listens_for(isolated, "connect", insert=True)
    def use_schema(dbapi_connection: Any, _record: object) -> None:
        autocommit = dbapi_connection.autocommit
        dbapi_connection.autocommit = True
        with dbapi_connection.cursor() as cursor:
            cursor.execute(f'SET search_path TO "{schema}"')
        dbapi_connection.autocommit = autocommit

    try:
        yield isolated
    finally:
        isolated.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def test_migrations_and_api_against_postgresql(database_url: str, engine: Engine) -> None:
    config = Config(str(BACKEND / "alembic.ini"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
    app = create_app(settings=Settings(database_url=database_url), engine=engine)
    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200
        assert client.post("/items", json={"name": "from integration"}).status_code == 201
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, "base")

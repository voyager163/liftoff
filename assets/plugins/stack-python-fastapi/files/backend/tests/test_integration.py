"""Tests against a real PostgreSQL database.

Run them with: APP_DATABASE_URL=... uv run pytest -m integration --no-cov
They fail, rather than skip, when no database is configured.
"""

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

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


def test_migrations_and_api_against_postgresql(database_url: str) -> None:
    engine = make_engine(database_url)
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
    engine.dispose()

import socket
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app.config import Settings
from app.health import database_ready, probe_engine
from app.main import create_app


@pytest.fixture
def frozen_server() -> Iterator[int]:
    """A port that accepts connections and never answers, like a paused database."""
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        yield server.getsockname()[1]


def test_live_never_checks_dependencies(client: TestClient) -> None:
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_when_the_database_answers(client: TestClient) -> None:
    response = client.get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "checks": {"database": "ok"}}


def test_not_ready_when_the_database_is_unavailable() -> None:
    unreachable = create_engine("sqlite+pysqlite:////nonexistent-directory/app.db")
    with TestClient(create_app(settings=Settings(), engine=unreachable)) as client:
        response = client.get("/health/ready")
    unreachable.dispose()
    assert response.status_code == 503
    assert response.json() == {"status": "not-ready", "checks": {"database": "unavailable"}}


def test_readiness_gives_up_on_a_database_that_stopped_answering(frozen_server: int) -> None:
    engine = create_engine(f"postgresql+psycopg://app:unused@127.0.0.1:{frozen_server}/app")
    probe = probe_engine(engine, timeout_seconds=1)
    started = time.monotonic()
    assert database_ready(probe) is False
    assert time.monotonic() - started < 10
    engine.dispose()

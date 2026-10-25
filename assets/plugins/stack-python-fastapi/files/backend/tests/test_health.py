from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app.config import Settings
from app.main import create_app


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

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_live_never_checks_dependencies(client: TestClient) -> None:
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_reports_each_check_and_fails_while_one_is_unavailable() -> None:
    app = create_app(settings=Settings())
    state = {"up": True}
    app.state.readiness = {"dependency": lambda: state["up"]}
    with TestClient(app) as client:
        assert client.get("/health/ready").json() == {
            "status": "ready",
            "checks": {"dependency": "ok"},
        }
        state["up"] = False
        response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not-ready", "checks": {"dependency": "unavailable"}}

from fastapi.testclient import TestClient
from sqlalchemy import Engine

from app.config import Settings
from app.main import create_app


def test_openapi_and_scalar_docs(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    assert {"/health/live", "/health/ready", "/items"} <= set(schema["paths"])
    docs = client.get("/docs")
    assert docs.status_code == 200
    assert "scalar" in docs.text.lower()


def test_docs_can_be_turned_off(engine: Engine) -> None:
    app = create_app(settings=Settings(docs_enabled=False), engine=engine)
    with TestClient(app) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404

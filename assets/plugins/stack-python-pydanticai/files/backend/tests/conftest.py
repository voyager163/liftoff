from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests use the offline test model, whatever the shell running them sets."""
    for name in ("APP_CONFIG_FILE", "APP_MODEL", "APP_TRACING", "APP_PORT", "APP_ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(settings=Settings())) as test_client:
        yield test_client

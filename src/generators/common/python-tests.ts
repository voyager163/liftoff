export function withCurrentPythonTestSettings(source: string, current = false): string {
  if (!current) return source;
  return `import os as _liftoff_os
from pytest import fixture as _liftoff_fixture

${source}

@_liftoff_fixture(autouse=True)
def _liftoff_isolated_settings(monkeypatch, tmp_path):
    from backend.config import settings as configuration

    names = {name.casefold() for name in configuration.Settings.model_fields}
    names.add("liftoff_env_file")
    for name in list(_liftoff_os.environ):
        if name.casefold() in names:
            monkeypatch.delenv(name)
    monkeypatch.setenv("DATABASE_URL", "postgresql://127.0.0.1:1/liftoff-test")
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:1/0")
    monkeypatch.setattr(configuration, "PROJECT_ROOT", tmp_path)
    monkeypatch.setitem(configuration.Settings.model_config, "env_file", None)
    get_settings = configuration.get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
`;
}

export function renderCurrentPythonHealthTests(workload: 'standard' | 'genai'): string {
  const readiness = workload === 'standard' ? `

def test_ready(client):
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"
` : '';
  return `import pytest
from fastapi.testclient import TestClient

from backend.config import settings as configuration


@pytest.fixture
def client(monkeypatch):
    values = {
        name: field.default
        for name, field in configuration.Settings.model_fields.items()
        if not field.is_required()
    }
    values.update(
        database_url="postgresql://127.0.0.1:1/liftoff-test",
        redis_url="redis://127.0.0.1:1/0",
    )
    settings = configuration.Settings(_env_file=None, **values)
    monkeypatch.setattr(configuration, "get_settings", lambda: settings)
    from backend.apis.main import app

    return TestClient(app)


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
${readiness}

def test_cors_preflight_for_local_frontend(client):
    response = client.options(
        "${workload === 'standard' ? '/api' : '/health'}",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
`;
}

import pytest

from app import __main__ as entrypoint
from app import database


def test_postgresql_engines_get_a_connect_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}
    monkeypatch.setattr(
        database, "create_engine", lambda url, **kwargs: seen.update(url=url, **kwargs)
    )
    database.make_engine("postgresql+psycopg://user@localhost:5432/app", timeout_seconds=0.2)
    assert seen["connect_args"] == {"connect_timeout": 1}
    database.make_engine("sqlite+pysqlite:///:memory:")
    assert seen["connect_args"] == {}


def test_main_runs_uvicorn_with_the_configured_host_and_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setenv("APP_PORT", "8123")
    monkeypatch.setattr(
        entrypoint.uvicorn,
        "run",
        lambda target, **kwargs: calls.append({"target": target, **kwargs}),
    )
    entrypoint.main()
    assert calls == [
        {
            "target": "app.main:create_app",
            "factory": True,
            "host": "127.0.0.1",
            "port": 8123,
            "log_level": "info",
        }
    ]

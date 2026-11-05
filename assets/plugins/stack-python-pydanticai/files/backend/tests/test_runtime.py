import pytest

from app import __main__ as entrypoint


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

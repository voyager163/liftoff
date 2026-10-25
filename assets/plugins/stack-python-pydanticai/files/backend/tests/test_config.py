from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import ConfigFileError, load_settings


def test_defaults_use_the_offline_model_without_tracing() -> None:
    settings = load_settings()
    assert settings.port == 8000
    assert settings.model == "test"
    assert settings.tracing == "none"


def test_environment_overrides_the_file_which_overrides_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "app.toml"
    config.write_text('port = 9000\nmodel = "openai:gpt-5.1-mini"\n', encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_FILE", str(config))
    assert load_settings().model == "openai:gpt-5.1-mini"
    monkeypatch.setenv("APP_MODEL", "test")
    settings = load_settings()
    assert settings.model == "test"
    assert settings.port == 9000


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (None, "does not exist"),
        ("port = ", "is not valid TOML"),
        ("surprise = 1\n", "unknown settings: surprise"),
    ],
)
def test_a_named_file_that_cannot_be_used_is_an_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: str | None, message: str
) -> None:
    config = tmp_path / "app.toml"
    if content is not None:
        config.write_text(content, encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_FILE", str(config))
    with pytest.raises(ConfigFileError, match=message):
        load_settings()


@pytest.mark.parametrize(
    ("name", "value"), [("APP_TRACING", "zipkin"), ("APP_MODEL_TIMEOUT_SECONDS", "0")]
)
def test_invalid_values_are_refused(monkeypatch: pytest.MonkeyPatch, name: str, value: str) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError):
        load_settings()

from pathlib import Path

import pytest

from app.config import ConfigFileError, load_settings


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("APP_CONFIG_FILE", "APP_PORT", "APP_ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)


def test_defaults_without_a_file() -> None:
    settings = load_settings()
    assert settings.port == 8000
    assert settings.environment == "local"


def test_environment_overrides_the_file_which_overrides_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "app.toml"
    config.write_text('port = 9000\nenvironment = "staging"\n', encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_FILE", str(config))
    assert load_settings().port == 9000
    monkeypatch.setenv("APP_PORT", "9100")
    settings = load_settings()
    assert settings.port == 9100
    assert settings.environment == "staging"


def test_a_missing_file_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_CONFIG_FILE", str(tmp_path / "missing.toml"))
    with pytest.raises(ConfigFileError, match="does not exist"):
        load_settings()


def test_a_malformed_file_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = tmp_path / "app.toml"
    config.write_text("port = = 1\n", encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_FILE", str(config))
    with pytest.raises(ConfigFileError, match="not valid TOML"):
        load_settings()


def test_unknown_settings_are_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = tmp_path / "app.toml"
    config.write_text("prot = 1\n", encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_FILE", str(config))
    with pytest.raises(ConfigFileError, match="unknown settings: prot"):
        load_settings()

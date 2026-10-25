"""Runtime configuration.

Settings come from, in order of precedence:

1. process environment variables, prefixed ``APP_`` (for example ``APP_PORT``);
2. the TOML file named by ``APP_CONFIG_FILE``, when that variable is set;
3. the non-secret defaults below.

Naming a configuration file that is missing, malformed or contains unknown
settings is an error. It never falls back to the defaults silently.
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Any

from pydantic import Field
from pydantic.fields import FieldInfo
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

CONFIG_FILE_VARIABLE = "APP_CONFIG_FILE"


class ConfigFileError(RuntimeError):
    """The configuration file named by APP_CONFIG_FILE cannot be used."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", extra="forbid")

    environment: str = "local"
    host: str = "127.0.0.1"
    port: int = 8000
    # No password here: provide the full URL through APP_DATABASE_URL.
    database_url: str = "postgresql+psycopg://postgres@localhost:5432/app"
    # From a millisecond to a day.
    database_timeout_seconds: float = Field(default=2.0, ge=0.001, le=86400)
    docs_enabled: bool = True
    log_level: str = "info"

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return init_settings, env_settings, TomlFileSource(settings_cls)


class TomlFileSource(PydanticBaseSettingsSource):
    """Reads the TOML file named by APP_CONFIG_FILE, refusing anything unusable."""

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        name = os.environ.get(CONFIG_FILE_VARIABLE)
        if not name:
            return {}
        path = Path(name)
        if not path.is_file():
            raise ConfigFileError(f"{CONFIG_FILE_VARIABLE} names {name}, which does not exist")
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as error:
            raise ConfigFileError(f"{name} is not valid TOML: {error}") from error
        unknown = sorted(set(data) - set(self.settings_cls.model_fields))
        if unknown:
            raise ConfigFileError(f"{name} has unknown settings: {', '.join(unknown)}")
        return data


def load_settings() -> Settings:
    return Settings()

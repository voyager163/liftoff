"""Runtime configuration.

Settings come from, in order of precedence:

1. process environment variables, prefixed ``APP_`` (for example ``APP_MODEL``);
2. the TOML file named by ``APP_CONFIG_FILE``, when that variable is set;
3. the non-secret defaults below.

Naming a configuration file that is missing, malformed or contains unknown
settings is an error. It never falls back to the defaults silently. Model
credentials are never settings: each provider reads its own key, such as
``OPENAI_API_KEY``, from the environment.
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Any, Literal

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
    docs_enabled: bool = True
    log_level: str = "info"
    # "test" answers offline with a fixed text. Anything else is a PydanticAI
    # model name, such as "openai:gpt-5.1-mini", whose provider reads its key
    # from the environment.
    model: str = "test"
    # How long one request may wait for the model before it fails with 504.
    model_timeout_seconds: float = Field(default=60.0, gt=0, le=3600)
    instructions: str = "You are a helpful assistant. Answer briefly and accurately."
    # "langfuse" sends each model and tool call to Langfuse; see app/ports/tracing.py.
    tracing: Literal["none", "langfuse"] = "none"

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

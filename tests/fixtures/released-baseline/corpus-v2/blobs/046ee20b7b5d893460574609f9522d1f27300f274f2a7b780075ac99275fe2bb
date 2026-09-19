import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import { sourceString } from './values.js';
import { renderPythonDotenvValidation } from './dotenv-validation.js';

export function renderPythonRuntimeSettings(plan: ApiProjectPlan): string {
  const identity = plan.workload === 'genai'
    ? `    genai_pattern: str = "${plan.pattern.id}"`
    : '    api_stack: str = "python-fastapi"';
  const modelSettings = plan.workload === 'genai' ? `
    redis_stream_name: str = ""
    service_bus_queue_name: str = ""
    service_bus_auth_mode: str = "managed-identity"
    service_bus_connection_string: str = ""
    service_bus_fully_qualified_namespace: str = ""
    azure_client_id: str = ""
    pydantic_ai_model: str = ""
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    langfuse_host: str = ""
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
` : '';
  return `import os
import re
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8-sig",
        extra="ignore",
        frozen=True,
    )

    app_name: str = ${sourceString(plan.projectName)}
    app_env: str = "dev"
${identity}
    cloud_provider: str = "${plan.provider.id}"
    azure_region: str = "${plan.region.slug}"
    database_url: str
    redis_url: str
    messaging_transport: str = "redis-streams"
    blob_endpoint: str = ""
    cors_allowed_origins: str = "http://localhost:5173"
${modelSettings}

${renderPythonDotenvValidation()}

@lru_cache
def get_settings() -> Settings:
    selected_file = os.environ.get("LIFTOFF_ENV_FILE")
    path = Path(selected_file).expanduser() if selected_file is not None else PROJECT_ROOT / ".env"
    try:
        content = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError as error:
        if selected_file is not None:
            raise RuntimeError("LIFTOFF_ENV_FILE must select an existing configuration file.") from error
        return Settings(_env_file=None)
    except (OSError, UnicodeError) as error:
        raise RuntimeError("Unable to read runtime configuration file.") from error
    _validate_dotenv(content)
    return Settings(_env_file=path)
`;
}

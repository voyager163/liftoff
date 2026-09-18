import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = { python: Pick<ResolvedGeneratorContext['python'], 'genai'> };
import type { AddArtifact } from '../../template-types.js';
import { DEFAULT_FUNCTION_WORKER_QUEUE_NAME } from '../common/values.js';
import { genAiPattern } from '../common/values.js';
import type { GenAiProjectPlan } from '../../domain/project/contracts.js';
import { pyModule } from '../common/values.js';


import { sourceString } from '../common/values.js';
import { titleCase } from '../common/values.js';
import { renderPythonRuntimeSettings } from '../common/python-settings.js';

export function addBackendArtifacts(add: AddArtifact, plan: GenAiProjectPlan, context: GeneratorContext): void {
  const routeModule = pyModule(genAiPattern(plan).id);
  add('backend-pyproject', 'backend', ['backend', 'pyproject.toml'], renderBackendPyproject(plan, context));
  add('backend-uv-lock', 'backend', ['backend', 'uv.lock'], context.python["genai"].lock);
  add('backend-package', 'backend', ['backend', '__init__.py'], '');
  add('backend-api-package', 'backend', ['backend', 'apis', '__init__.py'], '');
  add('backend-main', 'backend', ['backend', 'apis', 'main.py'], renderFastApiMain(plan, routeModule));
  add('backend-health-routes', 'backend', ['backend', 'apis', 'routes', 'health.py'], renderHealthRoutes());
  add('backend-pattern-routes', 'backend', ['backend', 'apis', 'routes', `${routeModule}.py`], renderPatternRoutes(plan));
  add('backend-routes-package', 'backend', ['backend', 'apis', 'routes', '__init__.py'], '');
  add('backend-auth-dependency', 'backend', ['backend', 'apis', 'dependencies', 'auth.py'], renderAuthDependency());
  add('backend-config-package', 'backend', ['backend', 'config', '__init__.py'], '');
  add('backend-settings', 'backend', ['backend', 'config', 'settings.py'], renderSettings(plan));
  add('backend-orchestration-package', 'backend', ['backend', 'orchestration', '__init__.py'], '');
  add('backend-model-config', 'backend', ['backend', 'orchestration', 'model_config.py'], renderModelConfig(plan));
  add('backend-messaging-tool', 'backend', ['backend', 'orchestration', 'tools', 'messaging.py'], renderMessagingBoundary());
  add('backend-tools-package', 'backend', ['backend', 'orchestration', 'tools', '__init__.py'], '');
  add('backend-observability', 'backend', ['backend', 'observability', 'tracing.py'], renderTracing());
  add('backend-observability-package', 'backend', ['backend', 'observability', '__init__.py'], '');
  add('backend-test-health', 'backend-test', ['backend', 'tests', 'test_health.py'], renderBackendHealthTest());
  add('backend-test-messaging', 'backend-test', ['backend', 'tests', 'test_messaging.py'], renderMessagingTest());
  add('backend-test-tracing', 'backend-test', ['backend', 'tests', 'test_tracing.py'], renderTracingTest());
}

export function renderBackendPyproject(plan: GenAiProjectPlan, context: GeneratorContext): string {
  return context.python["genai"].project;
}

export function renderFastApiMain(plan: GenAiProjectPlan, routeModule: string): string {
  return `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from scalar_fastapi import get_scalar_api_reference
except ImportError:  # pragma: no cover - dependency is present in generated runtime
    get_scalar_api_reference = None

from backend.apis.routes import health, ${routeModule}
from backend.config.settings import get_settings


settings = get_settings()
app = FastAPI(title=settings.app_name, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in settings.cors_allowed_origins.split(",")
        if origin.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(${routeModule}.router)


@app.get("/scalar", include_in_schema=False)
def scalar_reference():
    if get_scalar_api_reference is None:
        return {"message": "Install scalar-fastapi to enable the Scalar developer portal."}
    return get_scalar_api_reference(openapi_url=app.openapi_url, title=f"{app.title} API")
`;
}

export function renderHealthRoutes(): string {
  return `from fastapi import APIRouter

router = APIRouter(tags=["operations"])


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/ready")
def ready():
    return {"status": "ready"}
`;
}

export function renderPatternRoutes(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  const moduleName = pyModule(pattern.id);
  const agentName = `${moduleName}_agent`;
  const prefix = pattern.routePrefix;
  if (pattern.id === 'streaming') {
    return `from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from backend.orchestration.agents.${agentName} import stream_response

router = APIRouter(prefix="${prefix}", tags=["${pattern.id}"])


@router.get("")
def stream(prompt: str):
    return StreamingResponse(stream_response(prompt), media_type="text/event-stream")
`;
  }

  if (pattern.id === 'rag') {
    return `from fastapi import APIRouter
from pydantic import BaseModel

from backend.orchestration.agents.${agentName} import answer_question, enqueue_ingestion

router = APIRouter(prefix="${prefix}", tags=["rag"])


class QueryRequest(BaseModel):
    question: str


class IngestionRequest(BaseModel):
    source_uri: str


@router.post("/query")
async def query(request: QueryRequest):
    return await answer_question(request.question)


@router.post("/ingest")
async def ingest(request: IngestionRequest):
    return await enqueue_ingestion(request.source_uri)
`;
  }

  const bodyClass = `${titleCase(pattern.id).replace(/\s/g, '')}Request`;
  return `from fastapi import APIRouter
from pydantic import BaseModel

from backend.orchestration.agents.${agentName} import run_${moduleName}

router = APIRouter(prefix="${prefix}", tags=["${pattern.id}"])


class ${bodyClass}(BaseModel):
    input: str


@router.post("/run")
async def run(request: ${bodyClass}):
    return await run_${moduleName}(request.input)
`;
}

export function renderAuthDependency(): string {
  return `from dataclasses import dataclass


@dataclass(frozen=True)
class CurrentUser:
    subject: str = "local-developer"


async def get_current_user() -> CurrentUser:
    return CurrentUser()
`;
}

export function renderSettings(plan: GenAiProjectPlan): string {
  return renderPythonRuntimeSettings(plan);
}

export function renderModelConfig(plan: GenAiProjectPlan): string {
  const pattern = genAiPattern(plan);
  return `from dataclasses import dataclass
from typing import Protocol

from backend.config.settings import Settings, get_settings


class ModelConfigurationError(RuntimeError):
    pass


class AgentRunner(Protocol):
    async def run(self, prompt: str) -> str:
        ...


@dataclass(frozen=True)
class ModelConfig:
    model_name: str
    pattern: str = "${pattern.id}"
    api_key: str = ""
    base_url: str = "https://api.openai.com/v1"

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> "ModelConfig":
        resolved = settings or get_settings()
        model_name = resolved.pydantic_ai_model.strip()
        if not model_name:
            raise ModelConfigurationError(
                "PYDANTIC_AI_MODEL is required before invoking production GenAI orchestration. "
                "Use a PydanticAI model name such as 'openai:gpt-4.1-mini'."
            )
        return cls(
            model_name=model_name,
            api_key=resolved.openai_api_key,
            base_url=resolved.openai_base_url,
        )


class PydanticAgentRunner:
    def __init__(self, config: ModelConfig):
        from pydantic_ai import Agent
        from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider

        provider_name, separator, model_name = config.model_name.partition(":")
        if not separator or not model_name or provider_name not in {
            "openai", "openai-chat", "openai-responses"
        }:
            raise ModelConfigurationError(
                "The locked starter supports openai:, openai-chat:, and openai-responses: models. "
                "Other providers require a reviewed dependency and configuration change."
            )
        if not config.api_key.strip():
            raise ModelConfigurationError("OPENAI_API_KEY is required for the selected model.")
        provider = OpenAIProvider(api_key=config.api_key, base_url=config.base_url)
        model_type = OpenAIChatModel if provider_name == "openai-chat" else OpenAIResponsesModel
        self._agent = Agent(model_type(model_name, provider=provider))

    async def run(self, prompt: str) -> str:
        result = await self._agent.run(prompt)
        output = getattr(result, "output", None)
        if output is None:
            output = getattr(result, "data", None)
        if output is None:
            raise RuntimeError("PydanticAI returned a result without output data.")
        return str(output)


def build_agent_runner(config: ModelConfig | None = None) -> AgentRunner:
    return PydanticAgentRunner(config or ModelConfig.from_settings())
`;
}

export function renderMessagingBoundary(): string {
  return `import json
from collections.abc import Callable
from typing import Any, Protocol

from backend.config.settings import Settings, get_settings


class MessagingConfigurationError(RuntimeError):
    pass


class MessagePublisher(Protocol):
    async def publish(self, topic: str, payload: dict) -> None:
        ...


class RedisStreamClient(Protocol):
    async def xadd(self, name: str, fields: dict[str, str]) -> Any:
        ...


class ServiceBusSender(Protocol):
    async def __aenter__(self) -> "ServiceBusSender":
        ...

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        ...

    async def send_messages(self, message: Any) -> None:
        ...


class ServiceBusClient(Protocol):
    def get_queue_sender(self, *, queue_name: str) -> ServiceBusSender:
        ...


def _serialize(topic: str, payload: dict) -> str:
    return json.dumps({"topic": topic, "payload": payload}, separators=(",", ":"), sort_keys=True)


class RedisStreamPublisher:
    def __init__(self, client: RedisStreamClient, stream_name: str):
        self._client = client
        self._stream_name = stream_name

    async def publish(self, topic: str, payload: dict) -> None:
        await self._client.xadd(
            self._stream_name,
            {"topic": topic, "payload": _serialize(topic, payload)},
        )


class AzureServiceBusPublisher:
    def __init__(
        self,
        client: ServiceBusClient,
        queue_name: str,
        message_factory: Callable[[str], Any] | None = None,
    ):
        self._client = client
        self._queue_name = queue_name
        self._message_factory = message_factory or self._default_message_factory

    @staticmethod
    def _default_message_factory(body: str) -> Any:
        from azure.servicebus import ServiceBusMessage

        return ServiceBusMessage(body)

    async def publish(self, topic: str, payload: dict) -> None:
        message = self._message_factory(_serialize(topic, payload))
        async with self._client.get_queue_sender(queue_name=self._queue_name) as sender:
            await sender.send_messages(message)


def build_message_publisher(
    transport: str | None = None,
    *,
    settings: Settings | None = None,
    redis_client: RedisStreamClient | None = None,
    service_bus_client: ServiceBusClient | None = None,
    message_factory: Callable[[str], Any] | None = None,
) -> MessagePublisher:
    resolved = settings or get_settings()
    transport = resolved.messaging_transport if transport is None else transport
    if transport == "redis-streams":
        stream_name = resolved.redis_stream_name.strip()
        if not stream_name:
            raise MessagingConfigurationError("REDIS_STREAM_NAME must not be empty.")
        redis_url = resolved.redis_url.strip()
        if not redis_url:
            raise MessagingConfigurationError("REDIS_URL is required for redis-streams messaging.")
        if redis_client is None:
            from redis.asyncio import Redis

            redis_client = Redis.from_url(redis_url, decode_responses=True)
        return RedisStreamPublisher(redis_client, stream_name)

    if transport == "azure-service-bus":
        queue_name = resolved.service_bus_queue_name.strip()
        if not queue_name:
            raise MessagingConfigurationError(
                "SERVICE_BUS_QUEUE_NAME is required for azure-service-bus messaging."
            )
        connection_string = resolved.service_bus_connection_string.strip()
        namespace = resolved.service_bus_fully_qualified_namespace.strip()
        client_id = resolved.azure_client_id.strip()
        auth_mode = resolved.service_bus_auth_mode
        if auth_mode == "connection-string":
            if not connection_string:
                raise MessagingConfigurationError(
                    "SERVICE_BUS_CONNECTION_STRING is required for connection-string authentication."
                )
        elif auth_mode == "managed-identity":
            if not namespace or not client_id:
                raise MessagingConfigurationError(
                    "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE and AZURE_CLIENT_ID are required "
                    "for managed-identity authentication."
                )
            if not namespace.endswith(".servicebus.windows.net") or "://" in namespace or "/" in namespace:
                raise MessagingConfigurationError("SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE must be a Service Bus hostname.")
        else:
            raise MessagingConfigurationError(
                "SERVICE_BUS_AUTH_MODE must be 'managed-identity' or 'connection-string'."
            )
        if service_bus_client is None:
            from azure.servicebus.aio import ServiceBusClient as AzureServiceBusClient

            if auth_mode == "connection-string":
                service_bus_client = AzureServiceBusClient.from_connection_string(connection_string)
            else:
                from azure.identity.aio import ManagedIdentityCredential

                credential = ManagedIdentityCredential(client_id=client_id)
                service_bus_client = AzureServiceBusClient(namespace, credential)
        return AzureServiceBusPublisher(service_bus_client, queue_name, message_factory)

    raise MessagingConfigurationError(
        f"Unsupported MESSAGING_TRANSPORT '{transport}'. "
        "Expected 'redis-streams' or 'azure-service-bus'."
    )
`;
}

export function renderTracing(): string {
  return `from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncContextManager, Protocol

from backend.config.settings import Settings, get_settings


class TracingConfigurationError(RuntimeError):
    pass


@dataclass
class TraceHandle:
    enabled: bool
    trace_id: str | None
    output: Any = None

    def set_output(self, output: Any) -> None:
        self.output = output


class Tracer(Protocol):
    def trace(self, name: str, input_data: Any = None) -> AsyncContextManager[TraceHandle]:
        ...


class DisabledTracer:
    @asynccontextmanager
    async def trace(self, name: str, input_data: Any = None):
        del name, input_data
        yield TraceHandle(enabled=False, trace_id=None)


class LangfuseTracer:
    def __init__(self, client: Any):
        self._client = client


    @asynccontextmanager
    async def trace(self, name: str, input_data: Any = None):
        remote_trace = self._client.start_observation(
            name=name,
            as_type="span",
            input=input_data,
        )
        remote_id = getattr(remote_trace, "trace_id", None)
        handle = TraceHandle(
            enabled=True,
            trace_id=str(remote_id) if remote_id is not None else None,
        )
        try:
            yield handle
        except Exception as error:
            remote_trace.update(level="ERROR", status_message=str(error))
            raise
        else:
            remote_trace.update(output=handle.output)
        finally:
            remote_trace.end()


def build_tracer(
    *,
    settings: Settings | None = None,
    client: Any = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    host: str | None = None,
) -> Tracer:
    if client is not None:
        return LangfuseTracer(client)

    resolved = settings or get_settings()
    resolved_public_key = resolved.langfuse_public_key.strip() if public_key is None else public_key
    resolved_secret_key = resolved.langfuse_secret_key.strip() if secret_key is None else secret_key
    if not resolved_public_key and not resolved_secret_key:
        return DisabledTracer()
    if not resolved_public_key or not resolved_secret_key:
        raise TracingConfigurationError(
            "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be configured together."
        )

    from langfuse import Langfuse

    resolved_host = (resolved.langfuse_host.strip() if host is None else host) or "https://cloud.langfuse.com"
    kwargs = {
        "public_key": resolved_public_key,
        "secret_key": resolved_secret_key,
        "host": resolved_host,
    }
    return LangfuseTracer(Langfuse(**kwargs))
`;
}

export function renderBackendHealthTest(): string {
  return `from fastapi.testclient import TestClient

from backend.apis.main import app


def test_health():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_cors_preflight_for_local_frontend():
    response = TestClient(app).options(
        "/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
`;
}

export function renderMessagingTest(): string {
  return `import asyncio
import json

from backend.orchestration.tools.messaging import build_message_publisher
from backend.config.settings import Settings


class FakeRedisClient:
    def __init__(self):
        self.calls = []

    async def xadd(self, name, fields):
        self.calls.append((name, fields))


class FakeSender:
    def __init__(self):
        self.messages = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def send_messages(self, message):
        self.messages.append(message)


class FakeServiceBusClient:
    def __init__(self, sender):
        self.sender = sender
        self.queue_names = []

    def get_queue_sender(self, *, queue_name):
        self.queue_names.append(queue_name)
        return self.sender


def test_redis_stream_publisher_uses_xadd():
    client = FakeRedisClient()
    settings = Settings(
        _env_file=None,
        database_url="postgresql://localhost/test",
        redis_url="redis://localhost:6379/0",
        redis_stream_name="orchestration-events",
    )
    publisher = build_message_publisher("redis-streams", settings=settings, redis_client=client)

    asyncio.run(publisher.publish("rag.ingest", {"source_uri": "az://document"}))

    stream_name, fields = client.calls[0]
    assert stream_name == "orchestration-events"
    assert fields["topic"] == "rag.ingest"
    assert json.loads(fields["payload"]) == {
        "payload": {"source_uri": "az://document"},
        "topic": "rag.ingest",
    }


def test_service_bus_publisher_uses_async_sender():
    sender = FakeSender()
    client = FakeServiceBusClient(sender)
    publisher = build_message_publisher(
        "azure-service-bus",
        settings=Settings(
            _env_file=None,
            database_url="postgresql://localhost/test",
            redis_url="redis://localhost:6379/0",
            service_bus_queue_name="orchestration-jobs",
            service_bus_auth_mode="managed-identity",
            service_bus_fully_qualified_namespace="offline.servicebus.windows.net",
            azure_client_id="00000000-0000-4000-8000-000000000001",
        ),
        service_bus_client=client,
        message_factory=lambda body: body,
    )

    asyncio.run(publisher.publish("workflow.run", {"job_id": "job-1"}))

    assert client.queue_names == ["orchestration-jobs"]
    assert json.loads(sender.messages[0]) == {
        "payload": {"job_id": "job-1"},
        "topic": "workflow.run",
    }
`;
}

export function renderTracingTest(): string {
  return `import asyncio

import pytest

from backend.observability.tracing import (
    TracingConfigurationError,
    build_tracer,
)
from backend.config.settings import get_settings


class FakeRemoteTrace:
    trace_id = "trace-123"

    def __init__(self):
        self.updates = []
        self.ended = False

    def update(self, **values):
        self.updates.append(values)

    def end(self):
        self.ended = True


class FakeLangfuse:
    def __init__(self):
        self.calls = []
        self.remote_trace = FakeRemoteTrace()

    def start_observation(self, **values):
        self.calls.append(values)
        return self.remote_trace


def test_unconfigured_tracing_is_explicitly_disabled(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "")
    get_settings.cache_clear()

    async def scenario():
        async with build_tracer().trace("offline") as trace:
            assert trace.enabled is False
            assert trace.trace_id is None

    asyncio.run(scenario())


def test_configured_tracing_updates_langfuse_operation():
    client = FakeLangfuse()

    async def scenario():
        async with build_tracer(client=client).trace(
            "agent.run",
            {"prompt": "hello"},
        ) as trace:
            assert trace.enabled is True
            assert trace.trace_id == "trace-123"
            trace.set_output({"answer": "world"})

    asyncio.run(scenario())
    assert client.calls == [
        {"name": "agent.run", "as_type": "span", "input": {"prompt": "hello"}}
    ]
    assert client.remote_trace.updates == [{"output": {"answer": "world"}}]
    assert client.remote_trace.ended is True


def test_partial_langfuse_configuration_fails(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "public")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(TracingConfigurationError, match="configured together"):
        build_tracer()
`;
}

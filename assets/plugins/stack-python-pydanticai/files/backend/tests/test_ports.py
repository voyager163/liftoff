import asyncio
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.models.test import TestModel

from app import errors
from app.config import Settings
from app.main import create_app
from app.ports import tracing
from app.ports.model import (
    OFFLINE_ANSWER,
    ModelConfigError,
    ModelTimeoutError,
    build_model,
    within,
)


def test_the_test_model_answers_offline() -> None:
    model = build_model("test")
    assert isinstance(model, TestModel)
    assert model.custom_output_text == OFFLINE_ANSWER


def test_a_model_that_cannot_be_used_is_a_configuration_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ModelConfigError, match="APP_MODEL=openai:gpt-5.1-mini cannot be used"):
        build_model("openai:gpt-5.1-mini")
    with pytest.raises(ModelConfigError, match="APP_MODEL=nonsense cannot be used"):
        build_model("nonsense")


def test_within_gives_up_after_the_limit() -> None:
    async def slow() -> str:
        await asyncio.sleep(1)
        return "late"

    async def fast() -> str:
        return "on time"

    assert asyncio.run(within(1, fast())) == "on time"
    with pytest.raises(ModelTimeoutError, match="no answer within 0.01 seconds"):
        asyncio.run(within(0.01, slow()))


def test_model_failures_become_502_and_504() -> None:
    app = FastAPI()
    errors.install(app)

    @app.get("/slow")
    def slow() -> None:
        raise ModelTimeoutError("no answer within 1 seconds")

    @app.get("/broken")
    def broken() -> None:
        raise UnexpectedModelBehavior("the provider sent nonsense")

    with TestClient(app) as client:
        assert client.get("/slow").status_code == 504
        response = client.get("/broken")
    assert response.status_code == 502
    assert "nonsense" not in response.text


def test_tracing_is_off_by_default() -> None:
    assert tracing.start_tracing("none").name == "none"


def test_langfuse_tracing_needs_its_extra(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "langfuse", None)
    with pytest.raises(tracing.TracingConfigError, match="uv sync --extra langfuse"):
        tracing.start_tracing("langfuse")


def test_langfuse_tracing_instruments_agents_and_flushes_on_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flushed: list[bool] = []
    client = SimpleNamespace(flush=lambda: flushed.append(True))
    monkeypatch.setitem(sys.modules, "langfuse", SimpleNamespace(get_client=lambda: client))
    instrumented: list[bool] = []
    monkeypatch.setattr(tracing.Agent, "instrument_all", lambda: instrumented.append(True))
    with TestClient(create_app(settings=Settings(tracing="langfuse"))) as test_client:
        assert test_client.get("/health/live").status_code == 200
    assert instrumented == [True]
    assert flushed == [True]

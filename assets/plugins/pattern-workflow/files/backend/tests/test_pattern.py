import asyncio
import time

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.config import Settings
from app.main import create_app
from app.ports.messaging import InMemoryMessageBus, Message
from app.ports.model import OFFLINE_ANSWER
from app.ports.workers import InProcessWorker


def finished(client: TestClient, workflow_id: str) -> dict[str, object]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        body = client.get(f"/v1/workflows/{workflow_id}").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.01)
    raise AssertionError("the workflow did not finish")


def test_runs_a_draft_then_a_review_in_the_background() -> None:
    def answer(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        step = "draft" if "first draft" in (info.instructions or "") else "final"
        return ModelResponse(parts=[TextPart(step)])

    with TestClient(create_app(settings=Settings(), model=FunctionModel(answer))) as client:
        started = client.post("/v1/workflows", json={"input": "A haiku about tides."})
        assert started.status_code == 202
        assert started.json()["status"] == "queued"
        body = finished(client, started.json()["id"])
        assert client.get("/health/ready").json()["checks"] == {"worker": "ok"}
    assert body["status"] == "succeeded"
    assert body["steps"] == {"draft": "draft", "review": "final"}
    assert body["result"] == "final"


def test_runs_offline(client: TestClient) -> None:
    body = finished(client, client.post("/v1/workflows", json={"input": "Hi"}).json()["id"])
    assert body["result"] == OFFLINE_ANSWER


def test_a_failing_step_fails_the_workflow_not_the_worker() -> None:
    def broken(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise RuntimeError("provider down")

    with TestClient(create_app(settings=Settings(), model=FunctionModel(broken))) as client:
        body = finished(client, client.post("/v1/workflows", json={"input": "Hi"}).json()["id"])
        assert client.get("/health/ready").status_code == 200
    assert body["status"] == "failed"
    assert body["error"] == "RuntimeError"


def test_unknown_workflows_are_not_found(client: TestClient) -> None:
    assert client.get("/v1/workflows/nope").status_code == 404


def test_the_worker_logs_a_failed_message_and_carries_on(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> list[str]:
        bus = InMemoryMessageBus()
        handled: list[str] = []

        async def handle(message: Message) -> None:
            if message["id"] == "bad":
                raise ValueError("bad message")
            handled.append(message["id"])

        worker = InProcessWorker(bus, "topic", handle)
        assert not worker.alive
        async with worker.running():
            assert worker.alive
            await bus.publish("topic", {"id": "bad"})
            await bus.publish("topic", {"id": "good"})
            while not handled:
                await asyncio.sleep(0.01)
        assert not worker.alive
        return handled

    assert asyncio.run(scenario()) == ["good"]
    assert "failed to handle a message" in caplog.text

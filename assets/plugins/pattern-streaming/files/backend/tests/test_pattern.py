import asyncio
import json
from collections.abc import AsyncIterator

from fastapi.testclient import TestClient
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.config import Settings
from app.main import create_app
from app.ports.model import OFFLINE_ANSWER


def events(client: TestClient) -> list[tuple[str, dict[str, str]]]:
    response = client.post("/v1/stream", json={"input": "Hello"})
    assert response.headers["content-type"].startswith("text/event-stream")
    parsed = []
    for block in response.text.strip().split("\n\n"):
        name, data = block.split("\n")
        parsed.append((name.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
    return parsed


def streaming(*pieces: str, delay: float = 0, fail: bool = False) -> FunctionModel:
    async def stream(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        for piece in pieces:
            await asyncio.sleep(delay)
            yield piece
        if fail:
            raise UnexpectedModelBehavior("the provider broke off")

    return FunctionModel(stream_function=stream)


def test_streams_each_piece_as_it_arrives_then_done() -> None:
    with TestClient(create_app(settings=Settings(), model=streaming("Good ", "morning"))) as client:
        assert events(client) == [
            ("delta", {"text": "Good "}),
            ("delta", {"text": "morning"}),
            ("done", {}),
        ]


def test_streams_offline(client: TestClient) -> None:
    received = events(client)
    assert "".join(data["text"] for name, data in received if name == "delta") == OFFLINE_ANSWER
    assert received[-1] == ("done", {})


def test_ends_with_an_error_when_the_model_fails() -> None:
    with TestClient(create_app(settings=Settings(), model=streaming("Hi", fail=True))) as client:
        received = events(client)
    assert received[-1] == ("error", {"detail": "The model failed to answer."})


def test_ends_with_an_error_when_the_model_is_too_slow() -> None:
    settings = Settings(model_timeout_seconds=0.05)
    with TestClient(create_app(settings=settings, model=streaming("Hi", delay=1))) as client:
        assert events(client) == [("error", {"detail": "The model did not answer in time."})]

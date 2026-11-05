from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.config import Settings
from app.main import create_app
from app.ports.model import OFFLINE_ANSWER


def test_run_answers_with_the_offline_model(client: TestClient) -> None:
    response = client.post("/v1/run", json={"input": "Hello"})
    assert response.status_code == 200
    assert response.json() == {"output": OFFLINE_ANSWER}


def test_run_sends_the_input_and_the_instructions() -> None:
    seen: list[tuple[str, str | None]] = []

    def answer(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append((str(messages[-1]), info.instructions))
        return ModelResponse(parts=[TextPart("Hi.")])

    app = create_app(settings=Settings(instructions="Be terse."), model=FunctionModel(answer))
    with TestClient(app) as client:
        assert client.post("/v1/run", json={"input": "Hello"}).json() == {"output": "Hi."}
    [(request, instructions)] = seen
    assert "Hello" in request
    assert instructions == "Be terse."


def test_an_empty_input_is_refused(client: TestClient) -> None:
    assert client.post("/v1/run", json={"input": ""}).status_code == 422

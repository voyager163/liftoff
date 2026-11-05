from pathlib import Path

from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.config import Settings
from app.main import create_app
from app.pattern import load_prompts
from app.ports.model import OFFLINE_ANSWER


def test_lists_the_prompts_with_their_variables(client: TestClient) -> None:
    assert client.get("/v1/prompts").json() == [
        {"name": "summarize", "variables": ["sentences", "text"]},
        {"name": "translate", "variables": ["language", "text"]},
    ]
    assert client.get("/health/ready").json()["checks"] == {"prompts": "ok"}


def test_runs_a_prompt_with_its_variables_filled_in() -> None:
    prompts: list[str] = []

    def answer(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        prompts.append(str(messages[-1]))
        return ModelResponse(parts=[TextPart("Bonjour.")])

    with TestClient(create_app(settings=Settings(), model=FunctionModel(answer))) as client:
        response = client.post(
            "/v1/prompts/translate", json={"variables": {"language": "French", "text": "Hello."}}
        )
    assert response.json() == {"output": "Bonjour."}
    assert "into French" in prompts[0]
    assert "Hello." in prompts[0]


def test_runs_offline(client: TestClient) -> None:
    response = client.post(
        "/v1/prompts/summarize", json={"variables": {"sentences": "2", "text": "Long text."}}
    )
    assert response.json() == {"output": OFFLINE_ANSWER}


def test_refuses_unknown_prompts_and_wrong_variables(client: TestClient) -> None:
    assert client.post("/v1/prompts/poem", json={"variables": {}}).status_code == 404
    response = client.post(
        "/v1/prompts/translate", json={"variables": {"text": "Hi.", "tone": "warm"}}
    )
    assert response.status_code == 422
    assert response.json() == {"detail": {"missing": ["language"], "unknown": ["tone"]}}


def test_only_well_named_files_are_prompts(tmp_path: Path) -> None:
    (tmp_path / "greet.md").write_text("Greet $name.", encoding="utf-8")
    (tmp_path / "Not A Prompt.md").write_text("Ignored.", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("Ignored.", encoding="utf-8")
    assert list(load_prompts(tmp_path)) == ["greet"]

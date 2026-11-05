from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from app import pattern
from app.config import Settings
from app.main import create_app
from app.pattern import NOT_FOUND, KeywordRetriever, Passage
from app.ports.model import OFFLINE_ANSWER


def test_answers_from_the_best_passages_and_lists_them() -> None:
    prompts: list[str] = []

    def answer(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        prompts.append(str(messages[-1]))
        return ModelResponse(parts=[TextPart("It checks the documents [1].")])

    with TestClient(create_app(settings=Settings(), model=FunctionModel(answer))) as client:
        response = client.post("/v1/ask", json={"question": "What does readiness check?"})
    body = response.json()
    assert body["answer"] == "It checks the documents [1]."
    assert body["sources"][0]["document"] == "operations.md"
    assert "readiness" in body["sources"][0]["excerpt"]
    assert "using only the passages below" in prompts[0]
    assert "Question: What does readiness check?" in prompts[0]


def test_says_so_without_the_model_when_nothing_matches() -> None:
    def never(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise AssertionError("the model must not be called")

    with TestClient(create_app(settings=Settings(), model=FunctionModel(never))) as client:
        response = client.post("/v1/ask", json={"question": "Quantum zebras?"})
    assert response.json() == {"answer": NOT_FOUND, "sources": []}


def test_answers_offline_and_is_ready_with_documents(client: TestClient) -> None:
    response = client.post("/v1/ask", json={"question": "Which key does the provider read?"})
    assert response.json()["answer"] == OFFLINE_ANSWER
    assert client.get("/health/ready").json()["checks"] == {"documents": "ok"}


def test_ranks_passages_by_shared_words(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("Cats purr.\n\nDogs bark loudly at cats.", encoding="utf-8")
    retriever = KeywordRetriever.from_directory(tmp_path)
    assert [p.text for p in retriever.search("Why do dogs bark at cats?", limit=2)] == [
        "Dogs bark loudly at cats.",
        "Cats purr.",
    ]
    assert retriever.search("the and of", limit=2) == []


def test_not_ready_without_documents() -> None:
    app = FastAPI()
    app.state.readiness = {}
    pattern.install(app, Settings(), TestModel(), KeywordRetriever([]))
    assert app.state.readiness["documents"]() is False
    pattern.install(app, Settings(), TestModel(), KeywordRetriever([Passage("a.md", "Text.")]))
    assert app.state.readiness["documents"]() is True

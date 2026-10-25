import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.models.test import TestModel

from app.config import Settings
from app.dataset import check, check_conversation, main
from app.main import create_app
from app.ports.model import OFFLINE_ANSWER

EXAMPLE = Path(__file__).parents[1] / "datasets" / "example.jsonl"


def line(*messages: tuple[str, str]) -> dict[str, object]:
    return {"messages": [{"role": role, "content": content} for role, content in messages]}


def test_serves_the_configured_model(client: TestClient) -> None:
    assert client.get("/v1/model").json() == {"model": "test"}
    assert client.post("/v1/run", json={"input": "Hi"}).json() == {"output": OFFLINE_ANSWER}


def test_names_the_fine_tuned_model() -> None:
    settings = Settings(model="openai:ft:gpt-5.1-mini:acme::abc123")
    with TestClient(create_app(settings=settings, model=TestModel())) as client:
        assert client.get("/v1/model").json() == {"model": settings.model}


def test_the_example_dataset_is_valid(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([str(EXAMPLE)]) == 0
    assert "3 conversations, no problems" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("value", "problem"),
    [
        ([], 'only "messages"'),
        ({"messages": []}, "non-empty list"),
        ({"messages": [{"role": "user"}]}, 'exactly "role" and "content"'),
        (line(("bot", "Hi")), "unknown role 'bot'"),
        (line(("user", " ")), "some text"),
        (line(("user", "Hi"), ("system", "Late"), ("assistant", "Hello")), "only come first"),
        (line(("user", "Hi")), "ends with the assistant's"),
    ],
)
def test_finds_what_is_wrong_with_a_conversation(value: object, problem: str) -> None:
    assert problem in (check_conversation(value) or "")


def test_reports_problems_by_line_and_fails(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    data = tmp_path / "bad.jsonl"
    good = json.dumps(line(("user", "Hi"), ("assistant", "Hello")))
    data.write_text(f"{good}\n\nnot json\n", encoding="utf-8")
    assert check(data.read_text(encoding="utf-8").splitlines()) == (
        2,
        ["line 3: not JSON: Expecting value"],
    )
    assert main([str(data)]) == 1
    assert "bad.jsonl: line 3" in capsys.readouterr().err
    assert check([]) == (0, ["no conversations"])
    assert main([]) == 2

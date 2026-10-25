import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.config import Settings
from app.main import create_app
from app.pattern import calculate, current_time


def test_the_agent_calls_a_tool_and_uses_its_result() -> None:
    def answer(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        returns = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
        if not returns:
            return ModelResponse(parts=[ToolCallPart("calculate", {"expression": "6 * 7"})])
        return ModelResponse(parts=[TextPart(f"The answer is {returns[0].content}.")])

    with TestClient(create_app(settings=Settings(), model=FunctionModel(answer))) as client:
        response = client.post("/v1/agent", json={"task": "What is six times seven?"})
    assert response.json() == {"output": "The answer is 42.", "tools_used": ["calculate"]}


def test_runs_offline_with_every_tool(client: TestClient) -> None:
    body = client.post("/v1/agent", json={"task": "Anything"}).json()
    assert sorted(body["tools_used"]) == ["calculate", "current_time"]


@pytest.mark.parametrize(
    ("expression", "result"),
    [("(2 + 3) * 4", "20"), ("-2 ** 2", "-4"), ("7 // 2 + 7 % 2", "4"), ("1 / 4", "0.25")],
)
def test_calculates(expression: str, result: str) -> None:
    assert calculate(expression) == result


@pytest.mark.parametrize(
    ("expression", "reason"),
    [
        ("__import__('os')", "only numbers"),
        ("2 ** 1000", "exponents above 100"),
        ("1 / 0", "division by zero"),
        ("2 +", "invalid syntax"),
        ("'a' * 3", "only numbers"),
    ],
)
def test_refuses_anything_but_arithmetic(expression: str, reason: str) -> None:
    message = calculate(expression)
    assert message.startswith("Could not calculate")
    assert reason in message


def test_tells_the_time_in_utc() -> None:
    assert current_time().endswith("+00:00")

from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.config import Settings
from app.main import create_app


def test_the_coordinator_delegates_research_then_writing() -> None:
    def answer(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        tools = {tool.name for tool in info.function_tools}
        if not tools:  # A specialist.
            return ModelResponse(parts=[TextPart(f"{info.instructions.split()[1]} done")])
        returns = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
        if len(returns) == 0:
            return ModelResponse(parts=[ToolCallPart("research", {"topic": "tides"})])
        if len(returns) == 1:
            return ModelResponse(parts=[ToolCallPart("write", {"facts": returns[0].content})])
        return ModelResponse(parts=[TextPart(returns[1].content)])

    with TestClient(create_app(settings=Settings(), model=FunctionModel(answer))) as client:
        response = client.post("/v1/team", json={"task": "Explain tides."})
    assert response.json() == {"output": "write done", "delegations": ["researcher", "writer"]}


def test_runs_offline(client: TestClient) -> None:
    body = client.post("/v1/team", json={"task": "Anything"}).json()
    assert sorted(body["delegations"]) == ["researcher", "writer"]

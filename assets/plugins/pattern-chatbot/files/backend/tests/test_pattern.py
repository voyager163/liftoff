from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.config import Settings
from app.main import create_app
from app.pattern import InMemoryConversations, trim
from app.ports.model import OFFLINE_ANSWER


def test_a_conversation_keeps_its_history() -> None:
    seen: list[int] = []

    def answer(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(len(messages))
        return ModelResponse(parts=[TextPart(f"reply {len(seen)}")])

    with TestClient(create_app(settings=Settings(), model=FunctionModel(answer))) as client:
        conversation = client.post("/v1/conversations").json()["id"]
        path = f"/v1/conversations/{conversation}"
        assert client.post(f"{path}/messages", json={"content": "Hi"}).json() == {
            "reply": "reply 1"
        }
        assert client.post(f"{path}/messages", json={"content": "Again"}).json() == {
            "reply": "reply 2"
        }
        assert client.get(path).json() == {
            "id": conversation,
            "messages": [
                {"role": "user", "content": "Hi"},
                {"role": "assistant", "content": "reply 1"},
                {"role": "user", "content": "Again"},
                {"role": "assistant", "content": "reply 2"},
            ],
        }
    # The second call sees the first exchange as well as the new message.
    assert seen == [1, 3]


def test_replies_offline(client: TestClient) -> None:
    conversation = client.post("/v1/conversations").json()["id"]
    response = client.post(f"/v1/conversations/{conversation}/messages", json={"content": "Hi"})
    assert response.json() == {"reply": OFFLINE_ANSWER}


def test_unknown_conversations_are_not_found(client: TestClient) -> None:
    assert client.get("/v1/conversations/nope").status_code == 404
    response = client.post("/v1/conversations/nope/messages", json={"content": "Hi"})
    assert response.status_code == 404


def test_the_store_forgets_the_oldest_conversations() -> None:
    store = InMemoryConversations(max_conversations=2)
    first = store.create()
    second = store.create()
    store.save(first, [])
    third = store.create()
    assert store.history(second) is None
    assert store.history(first) == []
    assert store.history(third) == []


def test_history_is_trimmed_to_start_with_a_request() -> None:
    request = ModelRequest.user_text_prompt("Hi")
    response = ModelResponse(parts=[TextPart("Hello")])
    assert trim([request, response, request, response], 3) == [request, response]
    assert trim([request, response], 10) == [request, response]

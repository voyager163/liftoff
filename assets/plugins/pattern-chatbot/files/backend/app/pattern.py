"""Chatbot: conversations that keep their message history.

``POST /v1/conversations`` starts a conversation, and
``POST /v1/conversations/{id}/messages`` sends a message and returns the
reply, with the conversation so far as context. History goes through the
``ConversationStore`` boundary. ``InMemoryConversations`` keeps it in this
process only, so it is lost on restart and not shared between replicas:
replace it with a database-backed store for that.
"""

from __future__ import annotations

from collections import OrderedDict
from threading import Lock
from typing import Literal, Protocol
from uuid import uuid4

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelRequest, TextPart, UserPromptPart
from pydantic_ai.models import Model

from app.config import Settings
from app.ports.model import within

MAX_CONVERSATIONS = 1000
MAX_MESSAGES = 40


class ConversationStore(Protocol):
    def create(self) -> str: ...

    def history(self, conversation_id: str) -> list[ModelMessage] | None: ...

    def save(self, conversation_id: str, messages: list[ModelMessage]) -> bool:
        """Stores the history; False if the conversation is gone, which is never recreated."""
        ...


def trim(messages: list[ModelMessage], limit: int) -> list[ModelMessage]:
    """The last ``limit`` messages at most, starting with a request so the history stays valid."""
    kept = messages[-limit:]
    while kept and not isinstance(kept[0], ModelRequest):
        kept = kept[1:]
    return kept


class InMemoryConversations:
    """Conversations in this process, forgetting the least recently used beyond a limit.

    FastAPI runs the synchronous endpoints on worker threads, so every change
    happens under one lock: a conversation cannot be forgotten between
    ``save`` checking that it exists and writing it.
    """

    def __init__(
        self, max_conversations: int = MAX_CONVERSATIONS, max_messages: int = MAX_MESSAGES
    ):
        self.max_conversations = max_conversations
        self.max_messages = max_messages
        self._conversations: OrderedDict[str, list[ModelMessage]] = OrderedDict()
        self._lock = Lock()

    def create(self) -> str:
        conversation_id = uuid4().hex
        with self._lock:
            self._conversations[conversation_id] = []
            while len(self._conversations) > self.max_conversations:
                self._conversations.popitem(last=False)
        return conversation_id

    def history(self, conversation_id: str) -> list[ModelMessage] | None:
        with self._lock:
            messages = self._conversations.get(conversation_id)
            return None if messages is None else list(messages)

    def save(self, conversation_id: str, messages: list[ModelMessage]) -> bool:
        # A conversation forgotten while its reply was written stays forgotten,
        # so the store never holds more than max_conversations.
        with self._lock:
            if conversation_id not in self._conversations:
                return False
            self._conversations[conversation_id] = trim(messages, self.max_messages)
            self._conversations.move_to_end(conversation_id)
            return True


class Conversation(BaseModel):
    id: str


class MessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)


class Reply(BaseModel):
    reply: str


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class Transcript(BaseModel):
    id: str
    messages: list[Message]


def transcript(messages: list[ModelMessage]) -> list[Message]:
    """What the user and the assistant said, without the model's internal parts."""
    said: list[Message] = []
    for message in messages:
        for part in message.parts:
            if isinstance(part, UserPromptPart) and isinstance(part.content, str):
                said.append(Message(role="user", content=part.content))
            elif isinstance(part, TextPart):
                said.append(Message(role="assistant", content=part.content))
    return said


def install(
    app: FastAPI,
    settings: Settings,
    model: Model,
    store: ConversationStore | None = None,
) -> None:
    conversations = store or InMemoryConversations()
    agent = Agent(model, instructions=settings.instructions)
    router = APIRouter(prefix="/v1/conversations", tags=["chatbot"])
    missing = {404: {"description": "No such conversation"}}

    def history(conversation_id: str) -> list[ModelMessage]:
        messages = conversations.history(conversation_id)
        if messages is None:
            raise HTTPException(404, "No conversation has that id.")
        return messages

    @router.post("", status_code=201)
    def start() -> Conversation:
        return Conversation(id=conversations.create())

    @router.get("/{conversation_id}", responses=missing)
    def read(conversation_id: str) -> Transcript:
        return Transcript(id=conversation_id, messages=transcript(history(conversation_id)))

    @router.post("/{conversation_id}/messages", responses=missing)
    async def send(conversation_id: str, request: MessageRequest) -> Reply:
        before = history(conversation_id)
        result = await within(
            settings.model_timeout_seconds, agent.run(request.content, message_history=before)
        )
        if not conversations.save(conversation_id, result.all_messages()):
            raise HTTPException(404, "The conversation was forgotten while the reply was written.")
        return Reply(reply=result.output)

    app.include_router(router)

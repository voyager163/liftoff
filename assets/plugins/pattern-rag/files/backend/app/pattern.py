"""RAG: answers grounded in the project's documents, with their sources.

At startup the Markdown files in ``app/documents`` are split into passages at
blank lines. ``POST /v1/ask`` retrieves the passages that best match the
question and asks the model to answer from them alone, returning the sources
it was given. When nothing matches it says so without calling the model.

Retrieval goes through the ``Retriever`` boundary. ``KeywordRetriever`` scores
passages by the words they share with the question: it needs no embeddings,
but it misses answers phrased differently. For semantic search, implement
``Retriever`` over embeddings and a vector store such as pgvector.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models import Model

from app.config import Settings
from app.ports.model import within

DOCUMENTS = Path(__file__).parent / "documents"
NOT_FOUND = "I could not find that in the documents."
WORD = re.compile(r"[a-z0-9]+")
# Words too common to say anything about a passage.
STOP_WORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "can",
        "do",
        "does",
        "for",
        "from",
        "how",
        "i",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "this",
        "to",
        "was",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "your",
    ]
)


def words(text: str) -> set[str]:
    return set(WORD.findall(text.lower())) - STOP_WORDS


@dataclass(frozen=True)
class Passage:
    document: str
    text: str


class Retriever(Protocol):
    def search(self, query: str, limit: int) -> list[Passage]: ...


class KeywordRetriever:
    """Ranks passages by how many of the question's words they contain."""

    def __init__(self, passages: list[Passage]):
        self.passages = passages

    @classmethod
    def from_directory(cls, directory: Path = DOCUMENTS) -> KeywordRetriever:
        passages = [
            Passage(document=path.name, text=chunk.strip())
            for path in sorted(directory.glob("*.md"))
            for chunk in re.split(r"\n\s*\n", path.read_text(encoding="utf-8"))
            if chunk.strip()
        ]
        return cls(passages)

    def search(self, query: str, limit: int) -> list[Passage]:
        terms = words(query)
        scored = [(len(terms & words(passage.text)), passage) for passage in self.passages]
        ranked = sorted((item for item in scored if item[0] > 0), key=lambda item: -item[0])
        return [passage for _, passage in ranked[:limit]]


class Question(BaseModel):
    question: str = Field(min_length=1, max_length=2_000)


class Source(BaseModel):
    document: str
    excerpt: str


class Answer(BaseModel):
    answer: str
    sources: list[Source]


def grounded_prompt(question: str, passages: list[Passage]) -> str:
    context = "\n\n".join(
        f"[{number}] ({passage.document})\n{passage.text}"
        for number, passage in enumerate(passages, start=1)
    )
    return (
        "Answer the question using only the passages below, and say which ones you used. "
        "If they do not contain the answer, say that you could not find it.\n\n"
        f"{context}\n\nQuestion: {question}"
    )


def install(
    app: FastAPI,
    settings: Settings,
    model: Model,
    retriever: KeywordRetriever | None = None,
) -> None:
    documents = retriever or KeywordRetriever.from_directory()
    agent = Agent(model, instructions=settings.instructions)
    router = APIRouter(prefix="/v1", tags=["rag"])
    app.state.readiness["documents"] = lambda: bool(documents.passages)

    @router.post("/ask")
    async def ask(request: Question) -> Answer:
        passages = documents.search(request.question, limit=3)
        if not passages:
            return Answer(answer=NOT_FOUND, sources=[])
        prompt = grounded_prompt(request.question, passages)
        result = await within(settings.model_timeout_seconds, agent.run(prompt))
        sources = [Source(document=p.document, excerpt=p.text[:300]) for p in passages]
        return Answer(answer=result.output, sources=sources)

    app.include_router(router)

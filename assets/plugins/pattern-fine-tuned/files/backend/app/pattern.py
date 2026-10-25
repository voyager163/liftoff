"""Fine-tuned: serving a fine-tuned model.

Fine-tuning happens with the model provider: train on data in
``datasets/`` (check it first with ``uv run python -m app.dataset``), then set
``APP_MODEL`` to the fine-tuned model's PydanticAI name, such as
``openai:ft:<base>:<org>::<id>``. ``POST /v1/run`` answers with that model and
``GET /v1/model`` says which model is serving.
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models import Model

from app.config import Settings
from app.ports.model import within


class RunRequest(BaseModel):
    input: str = Field(min_length=1, max_length=20_000)


class RunResponse(BaseModel):
    output: str


class ModelInfo(BaseModel):
    model: str


def install(app: FastAPI, settings: Settings, model: Model) -> None:
    agent = Agent(model, instructions=settings.instructions)
    router = APIRouter(prefix="/v1", tags=["fine-tuned"])

    @router.get("/model")
    def serving() -> ModelInfo:
        return ModelInfo(model=settings.model)

    @router.post("/run")
    async def run(request: RunRequest) -> RunResponse:
        result = await within(settings.model_timeout_seconds, agent.run(request.input))
        return RunResponse(output=result.output)

    app.include_router(router)

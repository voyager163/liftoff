"""Generic: one instruction-following agent behind one endpoint.

``POST /v1/run`` takes an input and returns the model's answer, following the
instructions in ``APP_INSTRUCTIONS``. It is the neutral starting point: add
tools, structured output or retrieval when the application needs them.
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


def install(app: FastAPI, settings: Settings, model: Model) -> None:
    agent = Agent(model, instructions=settings.instructions)
    router = APIRouter(prefix="/v1", tags=["generic"])

    @router.post("/run")
    async def run(request: RunRequest) -> RunResponse:
        result = await within(settings.model_timeout_seconds, agent.run(request.input))
        return RunResponse(output=result.output)

    app.include_router(router)

"""Multi-agent: a coordinator that delegates to specialist agents.

``POST /v1/team`` gives the coordinator a task. It delegates research to a
researcher agent and the answer to a writer agent through tools, then replies
with the result and the delegations it made. The specialists are fixed and
run one after another; their model usage counts towards the same request.
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext
from pydantic_ai.models import Model

from app.config import Settings
from app.ports.model import within


class Task(BaseModel):
    task: str = Field(min_length=1, max_length=20_000)


class Result(BaseModel):
    output: str
    delegations: list[str]


def install(app: FastAPI, settings: Settings, model: Model) -> None:
    researcher = Agent(
        model, instructions="You research a topic and list its key facts, one per line."
    )
    writer = Agent(model, instructions="You write a clear, brief answer from the facts you get.")
    coordinator = Agent(
        model,
        deps_type=list[str],
        instructions=(
            f"{settings.instructions} Delegate: ask the researcher for facts, "
            "then the writer for the answer."
        ),
    )

    @coordinator.tool
    async def research(ctx: RunContext[list[str]], topic: str) -> str:
        """Asks the researcher for the key facts about a topic."""
        ctx.deps.append("researcher")
        return (await researcher.run(topic, usage=ctx.usage)).output

    @coordinator.tool
    async def write(ctx: RunContext[list[str]], facts: str) -> str:
        """Asks the writer for an answer based on the facts."""
        ctx.deps.append("writer")
        return (await writer.run(facts, usage=ctx.usage)).output

    router = APIRouter(prefix="/v1", tags=["multi-agent"])

    @router.post("/team")
    async def run(request: Task) -> Result:
        delegations: list[str] = []
        result = await within(
            settings.model_timeout_seconds, coordinator.run(request.task, deps=delegations)
        )
        return Result(output=result.output, delegations=delegations)

    app.include_router(router)

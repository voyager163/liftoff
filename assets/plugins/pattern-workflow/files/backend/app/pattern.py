"""Workflow: multi-step work run in the background.

``POST /v1/workflows`` starts a workflow and answers at once with its id. A
worker picks it up through the message bus and runs its steps: a drafting
agent writes a draft, then a reviewing agent returns the final version.
``GET /v1/workflows/{id}`` reports the status, each step's output and the
result. Workflows and messages live in memory: see ``app/ports`` for the
boundaries to replace for durable, retried work. At most ``MAX_WORKFLOWS``
are kept: the oldest finished ones are forgotten first, and while every one
is still queued or running, new workflows are refused with 503 rather than
dropping work that was accepted.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models import Model

from app.config import Settings
from app.ports.messaging import InMemoryMessageBus, Message, MessageBus
from app.ports.model import within
from app.ports.workers import InProcessWorker

TOPIC = "workflow.started"
MAX_WORKFLOWS = 1000

Status = Literal["queued", "running", "succeeded", "failed"]
FINISHED: tuple[Status, ...] = ("succeeded", "failed")


class Workflow(BaseModel):
    id: str
    status: Status
    steps: dict[str, str] = Field(default_factory=dict)
    result: str | None = None
    error: str | None = None


class StartRequest(BaseModel):
    input: str = Field(min_length=1, max_length=20_000)


def install(app: FastAPI, settings: Settings, model: Model, bus: MessageBus | None = None) -> None:
    messages = bus or InMemoryMessageBus()
    workflows: OrderedDict[str, Workflow] = OrderedDict()
    inputs: dict[str, str] = {}
    drafter = Agent(model, instructions="You write a first draft of what is asked for.")
    reviewer = Agent(
        model, instructions="You review a draft and return an improved final version only."
    )

    async def handle(message: Message) -> None:
        workflow = workflows.get(message["id"])
        if workflow is None:  # Not a workflow this process started.
            return
        workflow.status = "running"
        request = inputs.pop(workflow.id, "")
        try:
            draft = await within(settings.model_timeout_seconds, drafter.run(request))
            workflow.steps["draft"] = draft.output
            review = await within(
                settings.model_timeout_seconds,
                reviewer.run(f"Request:\n{request}\n\nDraft:\n{draft.output}"),
            )
            workflow.steps["review"] = review.output
            workflow.result = review.output
            workflow.status = "succeeded"
        except Exception as error:  # Reported on the workflow; the worker carries on.
            workflow.status = "failed"
            workflow.error = type(error).__name__

    worker = InProcessWorker(messages, TOPIC, handle)
    app.state.lifespan_hooks.append(worker.running)
    app.state.readiness["worker"] = lambda: worker.alive
    router = APIRouter(prefix="/v1/workflows", tags=["workflow"])

    def make_room() -> bool:
        """Forgets the oldest finished workflows until one more fits; False if none has finished."""
        while len(workflows) >= MAX_WORKFLOWS:
            oldest = next((key for key, w in workflows.items() if w.status in FINISHED), None)
            if oldest is None:
                return False
            del workflows[oldest]
        return True

    @router.post("", status_code=202, responses={503: {"description": "Too much work in progress"}})
    async def start(request: StartRequest) -> Workflow:
        if not make_room():
            raise HTTPException(503, "Too many workflows are queued or running; try again later.")
        workflow = Workflow(id=uuid4().hex, status="queued")
        workflows[workflow.id] = workflow
        inputs[workflow.id] = request.input
        try:
            await messages.publish(TOPIC, {"id": workflow.id})
        except BaseException:
            # Never queued, so it would never finish: give its place back.
            del workflows[workflow.id]
            inputs.pop(workflow.id, None)
            raise
        return workflow

    @router.get("/{workflow_id}", responses={404: {"description": "No such workflow"}})
    def status(workflow_id: str) -> Workflow:
        workflow = workflows.get(workflow_id)
        if workflow is None:
            raise HTTPException(404, "No workflow has that id.")
        return workflow

    app.include_router(router)

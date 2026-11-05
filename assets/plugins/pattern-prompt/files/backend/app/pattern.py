"""Prompt: named prompt templates, versioned with the code.

Each Markdown file in ``app/prompts`` is a template whose ``$variables`` a
request fills in. ``GET /v1/prompts`` lists them with their variables, and
``POST /v1/prompts/{name}`` runs one. Prompts change through pull requests,
like the rest of the code.
"""

from __future__ import annotations

import re
from pathlib import Path
from string import Template

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models import Model

from app.config import Settings
from app.ports.model import within

PROMPTS = Path(__file__).parent / "prompts"
NAME = re.compile(r"[a-z0-9-]+")


class PromptInfo(BaseModel):
    name: str
    variables: list[str]


class PromptRequest(BaseModel):
    variables: dict[str, str] = Field(default_factory=dict)


class PromptResponse(BaseModel):
    output: str


def load_prompts(directory: Path = PROMPTS) -> dict[str, Template]:
    """Every template in the directory whose name is lowercase letters, digits and hyphens."""
    return {
        path.stem: Template(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("*.md"))
        if NAME.fullmatch(path.stem)
    }


def install(app: FastAPI, settings: Settings, model: Model) -> None:
    prompts = load_prompts()
    agent = Agent(model, instructions=settings.instructions)
    router = APIRouter(prefix="/v1", tags=["prompt"])
    app.state.readiness["prompts"] = lambda: bool(prompts)

    @router.get("/prompts")
    def list_prompts() -> list[PromptInfo]:
        return [
            PromptInfo(name=name, variables=sorted(template.get_identifiers()))
            for name, template in prompts.items()
        ]

    @router.post("/prompts/{name}", responses={404: {"description": "No such prompt"}})
    async def run_prompt(name: str, request: PromptRequest) -> PromptResponse:
        template = prompts.get(name)
        if template is None:
            raise HTTPException(404, f"No prompt is named {name}.")
        expected = set(template.get_identifiers())
        missing = sorted(expected - set(request.variables))
        unknown = sorted(set(request.variables) - expected)
        if missing or unknown:
            raise HTTPException(422, {"missing": missing, "unknown": unknown})
        prompt = template.substitute(request.variables)
        result = await within(settings.model_timeout_seconds, agent.run(prompt))
        return PromptResponse(output=result.output)

    app.include_router(router)

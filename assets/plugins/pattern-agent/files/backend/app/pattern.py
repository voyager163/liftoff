"""Agent: an agent that calls tools to complete a task.

``POST /v1/agent`` gives the agent a task; it decides which tools to call and
answers with the result and the tools it used. The two example tools only
read: the current time, and arithmetic evaluated from the expression's syntax
tree, never with ``eval``. Tools run in the API's process: give a tool that
changes anything a sandbox, an approval step and limits before adding it.
"""

from __future__ import annotations

import ast
import operator
from collections.abc import Callable
from datetime import UTC, datetime

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.models import Model

from app.config import Settings
from app.ports.model import within

OPERATORS: dict[type, Callable[..., float]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}
# Every number, including each intermediate result, stays within these
# limits, so no expression can make the API compute a huge number: the
# largest power that is ever computed is (10 ** 100) ** 100.
MAX_EXPONENT = 100
MAX_MAGNITUDE = 10**100
MAX_LENGTH = 200


def bounded(value: float) -> float:
    if isinstance(value, complex):
        raise ValueError("complex results are not supported")
    if abs(value) > MAX_MAGNITUDE:
        raise ValueError("numbers above 10 ** 100 are not allowed")
    return value


def evaluate(node: ast.AST) -> float:
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return bounded(node.value)
    if isinstance(node, ast.UnaryOp) and type(node.op) in OPERATORS:
        return bounded(OPERATORS[type(node.op)](evaluate(node.operand)))
    if isinstance(node, ast.BinOp) and type(node.op) in OPERATORS:
        left, right = evaluate(node.left), evaluate(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > MAX_EXPONENT:
            raise ValueError(f"exponents above {MAX_EXPONENT} are not allowed")
        return bounded(OPERATORS[type(node.op)](left, right))
    raise ValueError("only numbers, + - * / // % ** and parentheses are allowed")


def calculate(expression: str) -> str:
    """Evaluates an arithmetic expression, such as "(2 + 3) * 4"."""
    try:
        if len(expression) > MAX_LENGTH:
            raise ValueError(f"expressions longer than {MAX_LENGTH} characters are not allowed")
        return str(evaluate(ast.parse(expression, mode="eval").body))
    except (SyntaxError, ValueError, ZeroDivisionError, OverflowError) as error:
        # Reported to the model, which can correct the expression.
        return f"Could not calculate {expression!r}: {error}"


def current_time() -> str:
    """The current date and time in UTC, in ISO 8601."""
    return datetime.now(UTC).isoformat(timespec="seconds")


class Task(BaseModel):
    task: str = Field(min_length=1, max_length=20_000)


class Result(BaseModel):
    output: str
    tools_used: list[str]


def install(app: FastAPI, settings: Settings, model: Model) -> None:
    agent = Agent(
        model,
        instructions=f"{settings.instructions} Use the tools when they help.",
        tools=[current_time, calculate],
    )
    router = APIRouter(prefix="/v1", tags=["agent"])

    @router.post("/agent")
    async def run(request: Task) -> Result:
        result = await within(settings.model_timeout_seconds, agent.run(request.task))
        used = [
            part.tool_name
            for message in result.new_messages()
            for part in message.parts
            if isinstance(part, ToolCallPart)
        ]
        return Result(output=result.output, tools_used=used)

    app.include_router(router)

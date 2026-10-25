"""Tracing: off by default, with Langfuse as an option.

With ``APP_TRACING=langfuse``, PydanticAI sends each model and tool call to
Langfuse through OpenTelemetry. That needs the optional dependency
(``uv sync --extra langfuse``) and ``LANGFUSE_PUBLIC_KEY``,
``LANGFUSE_SECRET_KEY`` and ``LANGFUSE_HOST`` in the environment. Nothing else
in the API depends on Langfuse.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass, field

from pydantic_ai import Agent


class TracingConfigError(RuntimeError):
    """APP_TRACING asks for tracing that cannot be set up."""


@dataclass(frozen=True)
class Tracing:
    name: str
    flush: Callable[[], None] = field(default=lambda: None)


def start_tracing(kind: str) -> Tracing:
    if kind == "none":
        return Tracing("none")
    try:
        langfuse = importlib.import_module("langfuse")
    except ImportError as error:
        raise TracingConfigError(
            "APP_TRACING=langfuse needs the langfuse extra: uv sync --extra langfuse"
        ) from error
    client = langfuse.get_client()
    Agent.instrument_all()
    return Tracing("langfuse", flush=client.flush)

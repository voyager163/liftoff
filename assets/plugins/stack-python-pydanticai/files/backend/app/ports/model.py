"""The model the patterns run on.

Patterns talk to a PydanticAI ``Model``; which one is configuration. ``test``
is PydanticAI's offline test model, so the API runs and its tests pass with no
credentials. Any other name is a PydanticAI model name, and its provider reads
its key from the environment, so credentials stay with whoever deploys the API.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable

from pydantic_ai.models import Model, infer_model
from pydantic_ai.models.test import TestModel

OFFLINE_ANSWER = "This is the offline test model. Set APP_MODEL to use a real one."


class ModelConfigError(RuntimeError):
    """APP_MODEL names a model that cannot be used, for example without its key."""


class ModelTimeoutError(RuntimeError):
    """The model did not answer within APP_MODEL_TIMEOUT_SECONDS."""


def build_model(name: str) -> Model:
    if name == "test":
        return TestModel(custom_output_text=OFFLINE_ANSWER)
    try:
        return infer_model(name)
    except Exception as error:  # Unknown names and missing keys raise different errors.
        raise ModelConfigError(f"APP_MODEL={name} cannot be used: {error}") from error


async def within[T](timeout_seconds: float, call: Awaitable[T]) -> T:
    """Waits for a model call, failing with ModelTimeoutError after the limit."""
    try:
        async with asyncio.timeout(timeout_seconds):
            return await call
    except TimeoutError as error:
        raise ModelTimeoutError(f"no answer within {timeout_seconds:g} seconds") from error

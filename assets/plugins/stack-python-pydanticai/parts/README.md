# {{liftoff.name}}

A Python GenAI API built with FastAPI and
[PydanticAI](https://ai.pydantic.dev/), created with
[Liftoff](https://github.com/voyager163/liftoff). This file is yours to
edit.

## Quick start

You need [uv](https://docs.astral.sh/uv/). It installs the right Python and
the locked dependencies. The tests run offline, on PydanticAI's test model,
so they need no key:

```bash
cd backend
uv sync
uv run pytest
```

To run the API, with Docker or without:

```bash
docker compose up --build
# or: cd backend && uv run python -m app
```

The API then listens on `http://127.0.0.1:8000`, with the API reference at
`/docs` and the OpenAPI document at `/openapi.json`. Until you choose a model
it answers with a fixed offline text.

## The model

`APP_MODEL` names the model, for example `openai:gpt-5.1-mini` or
`anthropic:claude-sonnet-5-5`. Each provider reads its own key from the
environment, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`: keys are never
settings and never belong in a file in Git. The OpenAI and Anthropic
providers are installed; add other PydanticAI extras in
`backend/pyproject.toml`. A model that cannot be used, such as one without its
key, stops the API at startup with the reason. Each request waits at most
`APP_MODEL_TIMEOUT_SECONDS` for the model and then fails with `504`; a failing
provider gives `502`, with the details only in the logs.

## Health

- `GET /health/live` says the process is running.
- `GET /health/ready` checks what the pattern needs, such as its documents or
  its worker, and answers `503` while something is unavailable. It does not
  call the model, which would cost money on every probe.

## Configuration

Settings are read in this order, highest first:

1. environment variables prefixed `APP_`, such as `APP_MODEL`;
2. a TOML file named by `APP_CONFIG_FILE`, see
   [backend/config.example.toml](backend/config.example.toml);
3. the defaults in [backend/app/config.py](backend/app/config.py).

Naming a configuration file that is missing, malformed or has unknown
settings stops the API with an error.

## Tracing

Tracing is off by default. With `APP_TRACING=langfuse`, PydanticAI sends each
model and tool call to [Langfuse](https://langfuse.com/). It needs the
optional dependency (`uv sync --extra langfuse`) and `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY` and `LANGFUSE_HOST` in the environment. Nothing else
depends on Langfuse.

## Checks

| Command (in `backend/`) | What it checks |
| --- | --- |
| `uv run ruff check .` | Lint |
| `uv run ruff format --check .` | Formatting |
| `uv run pytest` | Tests, offline, with at least 80% line and branch coverage |

CI runs all of them on every pull request, builds the container image and
reviews new dependencies.

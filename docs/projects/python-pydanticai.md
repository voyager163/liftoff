# GenAI projects

`--workload genai` creates a GenAI API with FastAPI and
[PydanticAI](https://ai.pydantic.dev/), built around one pattern chosen with
`--pattern` (`generic` by default). See [GenAI patterns](genai-patterns.md)
for what each pattern does and does not do yet.

## The application

| Behavior | Details |
| --- | --- |
| Port | 8000 (`APP_PORT`); binds to `127.0.0.1` locally and `0.0.0.0` in the container |
| Model | `APP_MODEL`: `test`, the default, is PydanticAI's offline test model; otherwise a PydanticAI model name, such as `openai:gpt-5.1-mini`, whose provider reads its key from the environment |
| Model failures | a model that cannot be used stops the API at startup; a slow model is a `504` after `APP_MODEL_TIMEOUT_SECONDS`, and a failing provider a `502`, with details only in the logs |
| Liveness | `GET /health/live`: the process is up |
| Readiness | `GET /health/ready`: what the pattern needs, such as its documents or worker; it never calls the model |
| API reference | Scalar at `/docs`, OpenAPI at `/openapi.json`; `APP_DOCS_ENABLED=false` turns both off |
| Configuration | environment (`APP_*`) over a TOML file named by `APP_CONFIG_FILE` over non-secret defaults; model keys are never settings |
| Tracing | off by default; `APP_TRACING=langfuse` with the optional `langfuse` extra sends model and tool calls to Langfuse |
| Checks | Ruff lint and formatting; pytest with at least 80% line and branch coverage, run offline on the test model |
| Container | multi-stage Dockerfile on pinned base images, running as an unprivileged user |

The project has no database. The OpenAI and Anthropic providers are
installed; add other PydanticAI extras as needed. Nothing in the project
depends on Langfuse unless you turn it on, and API projects never get GenAI
dependencies. The Vue frontend and Azure infrastructure are not available for
GenAI projects in this release.

## Dependencies

Every dependency is locked in `backend/uv.lock`. Liftoff's
`npm run lock:python` resolves it to versions published at least 7 days
earlier, as for the Python API template.

## Layout

```text
demo/
  backend/
    app/main.py             the application factory
    app/pattern.py          the pattern's endpoints
    app/ports/              the model and tracing boundaries (and, for the
                            workflow pattern, messaging and workers)
    app/config.py, app/health.py, app/errors.py
    tests/                  offline tests
    pyproject.toml, uv.lock, .python-version, Dockerfile, config.example.toml
  compose.yaml              the API for local work
  .env.example              the model to use; copy to .env
  README.md, REVIEW.md
  .github/workflows/        lint, tests and image; CodeQL; review policy
```

Governance profiles, coding agents and file ownership work as for
[Python API projects](python-fastapi.md#who-owns-which-files).

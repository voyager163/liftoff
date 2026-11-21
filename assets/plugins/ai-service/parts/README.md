## The AI service

`ai-service/` is a Python service built with FastAPI and
[PydanticAI](https://ai.pydantic.dev/), around the {{liftoff.aiPattern}}
pattern. It is for the API to call, at `http://ai-service:8000` inside
Compose, which publishes none of its ports: the browser never calls it, and
model keys live only here. The generated API does not call it yet; add the
call where your API needs it.{{liftoff.maturity}}

Its tests run offline, on PydanticAI's test model, so they need no key. You
need [uv](https://docs.astral.sh/uv/):

```bash
cd ai-service
uv sync
uv run pytest
```

`APP_MODEL` names the model, for example `openai:gpt-5.1-mini` or
`anthropic:claude-sonnet-5-5`, and each provider reads its own key from the
environment, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Until you
choose a model it answers with a fixed offline text. Tracing to
[Langfuse](https://langfuse.com/) is off unless `APP_TRACING=langfuse`.

| Command (in `ai-service/`) | What it checks |
| --- | --- |
| `uv run ruff check .` | Lint |
| `uv run ruff format --check .` | Formatting |
| `uv run pytest` | Tests, offline, with at least 80% line and branch coverage |

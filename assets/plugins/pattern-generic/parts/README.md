## Pattern: generic

`POST /v1/run` with `{"input": "..."}` returns `{"output": "..."}`: one
agent that follows `APP_INSTRUCTIONS`. It is the neutral starting point; add
tools, structured output or retrieval as the application needs them. The code
is in `backend/app/pattern.py`.

{{liftoff.maturity}}

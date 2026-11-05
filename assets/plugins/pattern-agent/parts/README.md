## Pattern: agent

`POST /v1/agent` with `{"task": "..."}` lets the agent choose tools to
complete the task, and returns its `output` and the `tools_used`. The two
example tools in `backend/app/pattern.py` only read: the current time, and
arithmetic evaluated from the expression's syntax tree. Add your own tools to
the `tools` list.

{{liftoff.maturity}}

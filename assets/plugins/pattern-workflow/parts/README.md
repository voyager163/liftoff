## Pattern: workflow

`POST /v1/workflows` with `{"input": "..."}` starts a workflow and answers
at once with its `id`. A worker picks it up through the message bus and runs
its steps: a draft, then a review. `GET /v1/workflows/{id}` reports the
`status` (`queued`, `running`, `succeeded` or `failed`), each step's output
and the `result`. The messaging and worker boundaries are in
`backend/app/ports/`, and the steps in `backend/app/pattern.py`.

{{liftoff.maturity}}

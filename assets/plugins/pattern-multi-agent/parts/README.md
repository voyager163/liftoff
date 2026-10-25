## Pattern: multi-agent

`POST /v1/team` with `{"task": "..."}` gives the task to a coordinator agent,
which delegates research to a researcher agent and the answer to a writer
agent, then returns the `output` and the `delegations` it made. The agents
are defined in `backend/app/pattern.py`.

{{liftoff.maturity}}

## Pattern: streaming

`POST /v1/stream` with `{"input": "..."}` answers with server-sent events: a
`delta` event with each piece of text as the provider sends it, then `done`,
or `error` if the model fails or runs out of time. Try it with
`curl -N -X POST -H 'content-type: application/json' -d '{"input":"Hi"}' http://127.0.0.1:8000/v1/stream`.
The code is in `backend/app/pattern.py`.

{{liftoff.maturity}}

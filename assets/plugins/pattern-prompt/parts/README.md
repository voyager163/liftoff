## Pattern: prompt

Prompts are templates in `backend/app/prompts/`, versioned with the code.
`GET /v1/prompts` lists them with their variables, and
`POST /v1/prompts/{name}` with `{"variables": {...}}` fills one in and returns
the model's answer. Missing or unknown variables are refused with `422`. Add a
prompt by adding a Markdown file whose `$variables` a request fills in. The
code is in `backend/app/pattern.py`.

{{liftoff.maturity}}

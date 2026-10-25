## Pattern: rag

`POST /v1/ask` with `{"question": "..."}` returns an `answer` grounded in the
documents in `backend/app/documents/`, with the `sources` it was given. Each
Markdown file there is split into passages at blank lines when the API
starts; replace the examples with your own. When no passage matches, the API
says so without calling the model. Retrieval goes through the `Retriever`
boundary in `backend/app/pattern.py`.

{{liftoff.maturity}}

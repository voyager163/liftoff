## Pattern: chatbot

`POST /v1/conversations` starts a conversation and returns its `id`.
`POST /v1/conversations/{id}/messages` with `{"content": "..."}` returns the
reply, with the conversation so far as context, and
`GET /v1/conversations/{id}` returns what was said. History goes through the
`ConversationStore` boundary in `backend/app/pattern.py`; the in-memory store
keeps the 1,000 most recent conversations and the last 40 messages of each.

{{liftoff.maturity}}

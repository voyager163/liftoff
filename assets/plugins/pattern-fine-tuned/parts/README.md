## Pattern: fine-tuned

Fine-tuning happens with the model provider. Keep the training data in
`backend/datasets/` as chat-format JSON Lines and check it before uploading:

```bash
cd backend
uv run python -m app.dataset datasets/example.jsonl
```

Then set `APP_MODEL` to the fine-tuned model's PydanticAI name, such as
`openai:ft:<base>:<org>::<id>`. `POST /v1/run` with `{"input": "..."}` answers
with it, and `GET /v1/model` says which model is serving. The code is in
`backend/app/pattern.py` and `backend/app/dataset.py`.

{{liftoff.maturity}}

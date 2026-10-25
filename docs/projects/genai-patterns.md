# GenAI patterns

<!-- Generated from src/plugins/builtin/patterns.ts by scripts/render-pattern-matrix.ts. Do not edit. -->

`--workload genai --pattern <name>` generates a [GenAI project](python-pydanticai.md)
around one of these patterns; `generic` is the default. A **complete** pattern
does what its name says; a **foundation** is a working starting point whose
gaps are listed below and in the project's README, never presented as done.

| Pattern | Maturity | What it is |
| --- | --- | --- |
| `generic` | complete | One instruction-following agent behind one endpoint |
| `prompt` | complete | Named prompt templates, versioned with the code |
| `chatbot` | foundation | Conversations that keep their message history |
| `rag` | foundation | Answers grounded in the project's documents, with their sources |
| `agent` | foundation | An agent that calls tools to complete a task |
| `multi-agent` | foundation | A coordinator that delegates to specialist agents |
| `fine-tuned` | foundation | Serving a fine-tuned model, with checks for its training data |
| `streaming` | complete | Answers streamed as they are written |
| `workflow` | foundation | Multi-step work run in the background, through messaging and a worker |

## generic

One instruction-following agent behind one endpoint.

**Maturity: complete.** What it does:

- A single model call per request, following configurable instructions
- Timeouts and provider failures answered as 504 and 502

What it does not do yet:

- Tools, structured output, memory or retrieval: add them as needed

## prompt

Named prompt templates, versioned with the code.

**Maturity: complete.** What it does:

- Prompt templates as files in backend/app/prompts, listed with their variables
- Requests fill a template; missing or unknown variables are refused

What it does not do yet:

- A prompt registry, prompt versions served side by side, or A/B testing
- Evaluation of prompt changes

## chatbot

Conversations that keep their message history.

**Maturity: foundation.** What it does:

- Conversations with an id, each keeping its message history for the model
- A bounded number of conversations and messages

What it does not do yet:

- Persistent history: it lives in one process and is lost on restart
- Sharing conversations between replicas, users or authentication
- Ordering two messages sent to one conversation at the same time

## rag

Answers grounded in the project's documents, with their sources.

**Maturity: foundation.** What it does:

- Documents in backend/app/documents, split into passages at startup
- Keyword retrieval of the best passages, which the answer must rely on
- The sources of every answer, and no model call when nothing matches

What it does not do yet:

- Embeddings or a vector store such as pgvector: retrieval is lexical
- Ingestion of new documents while running, or document permissions
- Evaluation of answer quality

## agent

An agent that calls tools to complete a task.

**Maturity: foundation.** What it does:

- Tool calling, with two safe example tools: the time and arithmetic
- The tools each task used, returned with the answer

What it does not do yet:

- Sandboxing: tools run in the API's process
- Approval before tools with side effects, or limits per user

## multi-agent

A coordinator that delegates to specialist agents.

**Maturity: foundation.** What it does:

- A coordinator agent that delegates to a researcher and a writer
- The delegations each task made, returned with the answer

What it does not do yet:

- Dynamic planning or specialists chosen at run time
- Running specialists in parallel, or sharing memory between them

## fine-tuned

Serving a fine-tuned model, with checks for its training data.

**Maturity: foundation.** What it does:

- Serving any fine-tuned model the provider hosts, named by APP_MODEL
- A checker for chat-format training data in JSON Lines

What it does not do yet:

- Training or uploading the model: that happens with the provider
- Comparing the fine-tuned model with its base model

## streaming

Answers streamed as they are written.

**Maturity: complete.** What it does:

- Server-sent events with each piece of text as the provider sends it
- A final event when the answer is complete, and an error event if it fails

What it does not do yet:

- Streaming structured output or tool calls
- Resuming a broken stream

## workflow

Multi-step work run in the background, through messaging and a worker.

**Maturity: foundation.** What it does:

- Workflows started with one request and run by a worker: a draft, then a review
- Messaging and worker boundaries with in-process adapters
- Each workflow's status and result

What it does not do yet:

- Durability: messages and workflows live in memory and are lost on restart
- Retries, scheduling, or a worker outside the API's process

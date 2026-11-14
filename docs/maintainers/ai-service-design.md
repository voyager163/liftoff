# Design: an AI service beside an API project

Status: proposed, for review. Decided in
[#61](https://github.com/voyager163/liftoff/issues/61) on 2026-11-14.
Requirements in `docs/requirements/` and tests follow once this design is
agreed; nothing here is built yet.

## Problem

Liftoff has two kinds of project: an API project (`python-fastapi`,
`node-fastify` or `go-huma`), which carries no AI dependencies, and a GenAI
project (`python-pydanticai`), which has the nine patterns but no frontend.
A common real project is both: a Go or Node API, often with a Vue frontend,
that needs AI features. Today Liftoff can generate or adopt only one of the
two halves. A repository holding both a Go API and a PydanticAI service
stops adoption with "2 directories hold a backend".

## Decision

An API project can have **one AI service beside its backend**: a Python
FastAPI and PydanticAI application, the GenAI stack Liftoff already has,
which the backend calls over HTTP. It is the same for every API stack, so
the AI code is written once, in one language, and keeps the GenAI stack's
patterns, offline test model and optional tracing.

The browser never calls the AI service. The frontend keeps calling the API
at `/api` on its own origin (PROJ-013), and the API decides what reaches
the AI service. Model credentials live only in the AI service.

## How it looks

```text
my-project/
├── backend/            # the API: go-huma, node-fastify or python-fastapi
├── ai-service/         # FastAPI + PydanticAI, one GenAI pattern
├── frontend/           # optional Vue frontend, as today
├── compose.yaml        # PostgreSQL, migrations, API, AI service, frontend
└── liftoff.yaml        # ai: { pattern: rag }  (plus layout, if bound)
```

- `ai-service/` is the GenAI stack's backend as Liftoff generates it today
  (PROJ-017, PROJ-018): port 8000 inside its container, health, readiness,
  OpenAPI and Scalar docs, `APP_MODEL=test` by default, Langfuse only with
  `APP_TRACING=langfuse`, and the pattern's endpoints and offline tests.
- In Compose the AI service has no published port. The API reaches it as
  `http://ai-service:8000`, from the setting `AI_SERVICE_URL`, and starts
  only once the AI service is healthy.
- The backend gets a small client for the AI service in its own language:
  one function per pattern endpoint, a time limit, and its errors mapped to
  the API's (a slow AI service is a 504 and a failing one a 502, with
  details only in the logs). Its tests use a fake AI service, so they run
  offline. The API's readiness does not depend on the AI service, so the
  rest of the API keeps working when AI is down.
- The backend's starter gains one example endpoint that calls the AI
  service, so the path from browser to model works on day one.

## Commands

- **`liftoff init --ai [--ai-pattern <pattern>]`**: an API project with an
  AI service. `--ai-pattern` takes the nine GenAI patterns, `generic` by
  default. `--ai` with `--workload genai` is refused: a GenAI project is
  already an AI service.
- **`liftoff ai add [--ai-pattern <pattern>]`**: adds an AI service to an
  existing Liftoff API project, generated or adopted. Like `agents add`, it
  previews the change, asks with no as the default (or takes `--yes`),
  and applies it as a recoverable change (CHANGE-001 to CHANGE-003).
  - It creates `ai-service/` (or the directory given with `--layout`) only
    where nothing is, and adds its CI jobs, Dependabot entry, review-policy
    rules, CodeQL language and image scan.
  - In a generated project it also updates the Compose file and adds the
    backend's client and example endpoint, as `init --ai` makes them.
  - In an adopted project it changes none of the application's files
    (PROJ-026): the Compose service and the backend's client are listed as
    application changes for the team to make, with what to add.
- **`liftoff ai remove`** is not planned for the first version.

## Assess and adopt

- A repository with exactly one API backend and exactly one
  `python-pydanticai` application is proposed as an API project with an AI
  service, with no `--layout` needed. Today this blocks.
- `--layout ai-service=<directory>` binds it where it lives (PROJ-024), and
  `--ai none` leaves it out, so it stays the project's and unmanaged.
- The AI service's checks are the GenAI stack's: lock file, runtime
  version, tests with a coverage threshold, Dockerfile.
- A Vue frontend beside an API backend with an AI service is allowed, since
  the frontend talks only to the API.

## What changes in Liftoff

| Area | Change |
| --- | --- |
| Configuration | `liftoff.yaml` gains `ai: { pattern }`, and layout gains an `ai-service` part |
| Generators | The GenAI stack's backend is rendered into `ai-service/` for an API project; each API stack gets its AI client and example endpoint |
| Shared files | CI, Compose, Dependabot, CodeQL, review policy, `AGENTS.md`, README and the image scan include the AI service |
| Assess and adopt | Recognise the pair; the `ai-service` binding; `--ai none` |
| Commands | `init --ai`, `--ai-pattern`; `liftoff ai add` |
| CI matrix | Each API stack with an AI service (generic pattern), and go-huma with it and Vue; the full pattern set stays on the GenAI project |

## Rollout

1. **go-huma first.** Requirements, the `ai-service` part, `init --ai` and
   `--ai-pattern` for go-huma, assess and adopt recognising the pair, and
   CI for go-huma with an AI service, with and without Vue.
2. `liftoff ai add` for go-huma projects, generated and adopted.
3. node-fastify, then python-fastapi: their AI clients and matrix entries.

## Out of scope for the first version

- An AI service beside a GenAI project, or more than one AI service.
- Azure infrastructure for the AI service. Until it is designed, `--ai`
  with `--infrastructure azure` is refused, as GenAI projects are today.
- Shared persistence between the API and the AI service; the AI service
  keeps the GenAI stack's rule of no database it does not use.
- Streaming from the AI service through the API to the browser; the
  `streaming` pattern works between the API and the AI service only.

## Questions for review

1. Is `ai-service/` the right standard directory name?
2. Should the API's readiness ignore the AI service, as proposed, or report
   it as degraded?
3. Should the example endpoint in the backend's starter be included, or is
   the client alone enough?

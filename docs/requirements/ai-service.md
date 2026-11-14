# AI service

An API project can have one AI service beside its backend: the GenAI
stack's FastAPI and PydanticAI service, which only the API calls. The design
is [ai-service-design.md](../maintainers/ai-service-design.md).

## AISVC-001 An API project may have one AI service, beside a stack that supports it

`liftoff.yaml` may have `ai`, with an optional `pattern` naming one of the
nine GenAI patterns (PROJ-018). `liftoff init --ai` records it, with the
pattern `--ai-pattern` names or `generic`; `--ai-pattern` without `--ai` is a
usage error. An AI service is only for an `api` project: a GenAI project is
one already, and is refused. This release generates it beside `go-huma`;
beside another stack it is reported as not available yet (exit 6), and so
is an AI service with infrastructure, which does not deploy it yet. An
unknown pattern is refused.

- Given `--stack go-huma --ai`, when the project is planned, then
  `liftoff.yaml` has `ai: { pattern: generic }`.
- Given `--workload genai --ai`, when the project is planned, then it is
  refused.
- Given `--stack node-fastify --ai`, or `--ai --infrastructure azure`, when
  the project is planned, then it exits 6 and nothing is created.

Verification: test

## AISVC-002 The AI service is the GenAI stack, in its own directory

The AI service is in `ai-service/`: the GenAI stack's application, tests,
lock file, runtime version, configuration example and Dockerfile, and its
pattern's endpoints and offline tests, as a GenAI project has them in
`backend/` (PROJ-017). Nothing of it is written in `backend/`, and the
backend's files are unchanged by it. Its Compose service, `ai-service`,
publishes no port and takes the model and providers' keys from `.env`, which
`.env.example` documents; the API does not wait for it to start.

- Given `--stack go-huma --frontend vue --ai --ai-pattern rag`, when the
  project is generated, then `ai-service/` holds the GenAI stack and the rag
  pattern, and `backend/` is what it is without the AI service.
- Given that project, when its Compose file is read, then `ai-service`
  publishes no port and no service depends on it.

Verification: test

## AISVC-003 Liftoff's shared files cover the AI service

The CI workflow runs the AI service's lint, format, offline tests with
coverage and image build as jobs of their own, which `ci-gate` needs and
whose ids never collide with the backend's. CodeQL analyzes its Python,
Dependabot updates its uv and Docker dependencies, the review policy has
rules for its image, dependencies, model boundary and tests, `AGENTS.md`
names its directory and checks, the README has a section on it, and the
build and release workflows build, scan and release its image, named
`ai-service`.

- Given a project with an AI service, when its CI workflow is read, then
  `ci-gate` needs `ai-lint`, `ai-test` and `ai-image`, which run in
  `ai-service/`.
- Given that project, when its build workflow is read, then it builds the
  `ai-service` image from `ai-service/`.

Verification: test

# Go API projects

`--workload api --stack go-huma` creates a Go API with Huma v2 on Chi, pgx
and Goose, with its modules locked in a committed `go.mod` and `go.sum`.

## The application

| Behavior | Details |
| --- | --- |
| Port | 8000 (`APP_PORT`); binds to `127.0.0.1` locally and `0.0.0.0` in the container |
| Liveness | `GET /health/live`: the process is up; never checks dependencies |
| Readiness | `GET /health/ready`: checks PostgreSQL over a new connection; `503` with `"not-ready"` when it is unavailable or does not answer within `APP_DATABASE_TIMEOUT_SECONDS` |
| API reference | Scalar at `/docs`, OpenAPI 3.1 at `/openapi.json`; `APP_DOCS_ENABLED=false` turns both off |
| Database | PostgreSQL through a pgx pool; Goose SQL migrations built into the binary, with working down migrations |
| Configuration | environment (`APP_*`) over a JSON file named by `APP_CONFIG_FILE` over non-secret defaults |
| Checks | `gofmt`, `go vet`, and Go tests with at least 80% statement coverage, checked by `go run ./tools/coverage` |
| Tests | unit tests need no database; `go test -tags integration ./internal/integration` runs against a real PostgreSQL in a throwaway schema |
| Container | a static binary on a pinned distroless image, running as an unprivileged user; the binary also runs the migrations and the container health check |

Go reports statement coverage only, so the gate is on statements; the other
stacks gate statements, branches, functions and lines where their tools
measure them. Naming a configuration file that is missing, malformed or has
unknown settings stops the API with an error rather than falling back to
defaults. Ordinary API projects have no GenAI dependencies.

## Layout

```text
demo/
  liftoff.yaml              what the project is made of
  .liftoff/manifest.json    every generated file, its owner and hash
  backend/
    cmd/api/                the binary: api, api migrate, api healthcheck
    internal/config/        configuration
    internal/database/      the pgx pool and the Goose migrations
    internal/health/        liveness and readiness
    internal/items/         the example items API
    internal/server/        routes and API documentation
    internal/integration/   tests against PostgreSQL (build tag integration)
    tools/coverage/         the coverage gate
    go.mod, go.sum, Dockerfile, config.example.json
  compose.yaml              PostgreSQL, migrations and the API for local work
  .env.example              placeholders only; copy to .env
  README.md, REVIEW.md
  .github/
    workflows/01-pr-ci.yml          formatting and vet, tests, integration, image, dependency review, ci-gate
    workflows/02-codeql.yml         CodeQL for Go and workflows
    workflows/03-review-policy*.yml review tier and approvals on every pull request
    workflows/04-ai-review.yml      verified AI review, when enabled
    review-policy.yml               how much review each kind of change needs
    liftoff/                        bundled checks the workflows run
    dependabot.yml, PULL_REQUEST_TEMPLATE.md
```

Governance profiles, coding agents and file ownership work the same way as
for [Python API projects](python-fastapi.md#who-owns-which-files): the
application, tests, README, modules, Dockerfile, Compose file, review policy
and CI workflows are seeded and yours; the bundled checks, the review-policy
and AI review workflows, and the skills and agents are managed by Liftoff.

# Python API projects

`--workload api --stack python-fastapi` creates a Python API with FastAPI,
SQLAlchemy 2, Alembic and PostgreSQL, using [uv](https://docs.astral.sh/uv/)
for Python and the locked dependencies.

## The application

| Behavior | Details |
| --- | --- |
| Port | 8000 (`APP_PORT`); binds to `127.0.0.1` locally and `0.0.0.0` in the container |
| Liveness | `GET /health/live`: the process is up; never checks dependencies |
| Readiness | `GET /health/ready`: checks PostgreSQL; `503` with `"not-ready"` when it is unavailable |
| API reference | Scalar at `/docs`, OpenAPI at `/openapi.json`; `APP_DOCS_ENABLED=false` turns both off |
| Database | PostgreSQL through SQLAlchemy and psycopg 3; an initial Alembic migration with a working downgrade |
| Configuration | environment (`APP_*`) over a TOML file named by `APP_CONFIG_FILE` over non-secret defaults |
| Tests | pytest with at least 80% branch coverage; `-m integration` runs against a real PostgreSQL |
| Container | multi-stage Dockerfile on pinned base images, running as an unprivileged user |

Naming a configuration file that is missing, malformed or has unknown
settings stops the API with an error rather than falling back to defaults.
Ordinary API projects have no GenAI dependencies.

## Layout

```text
demo/
  liftoff.yaml              what the project is made of
  .liftoff/manifest.json    every generated file, its owner and hash
  backend/
    app/                    the FastAPI application
    migrations/             Alembic migrations
    tests/                  unit tests; -m integration needs PostgreSQL
    pyproject.toml, uv.lock, .python-version
    Dockerfile, alembic.ini, config.example.toml
  compose.yaml              PostgreSQL, migrations and the API for local work
  .env.example              placeholders only; copy to .env
  README.md, REVIEW.md
  .github/
    workflows/01-pr-ci.yml          lint, tests, integration, image, dependency review, ci-gate
    workflows/02-codeql.yml         CodeQL for Python and workflows
    workflows/03-review-policy*.yml review tier and approvals on every pull request
    workflows/04-ai-review.yml      verified AI review, when enabled
    review-policy.yml               how much review each kind of change needs
    liftoff/                        bundled checks the workflows run
    dependabot.yml, PULL_REQUEST_TEMPLATE.md
```

GitFlow governance profiles add `GOVERNANCE.md`, `.github/rulesets/` and a
governance drift workflow, and `--owners` adds `.github/CODEOWNERS`. Selected
coding agents add `AGENTS.md`, `CLAUDE.md` (Claude Code), review and setup
skills and a read-only verifier agent in each host's own directory.

## Who owns which files

Every file is listed in `.liftoff/manifest.json` as one of:

- **seeded**: written once and then yours. The application, tests, README,
  lockfile, Dockerfile, Compose file, review policy and CI workflows are
  seeded. Liftoff never overwrites them.
- **managed**: kept current by Liftoff. The bundled checks in
  `.github/liftoff/`, the review-policy and AI review workflows, and the
  skills and agents are managed. `liftoff validate` reports a managed file
  that was changed by hand.

## Review and governance

The generated review setup follows the layered model in
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/):

1. Skills (`liftoff-verify`, `liftoff-code-review`, `liftoff-pr` and others)
   for checking a change before the pull request.
2. CI, aggregated in one required `ci-gate` status.
3. The `review-policy` check, which sets the risk tier from what the change
   touches and checks the approvals that tier needs.
4. With a coding agent selected, the verified AI review: independent finder
   passes, separate verifier runs that vote, and only confirmed findings
   posted. It needs the selected host's secret (`COPILOT_GITHUB_TOKEN`,
   `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) and reports "not run" without it.

The rulesets in `.github/rulesets/` are not active until you apply them. Apply
them only after `ci-gate` and `review-policy` have run successfully on a pull
request; `GOVERNANCE.md` in the project shows how.

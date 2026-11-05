# Node.js API projects

`--workload api --stack node-fastify` creates a TypeScript API with Fastify,
Drizzle ORM and PostgreSQL. Node.js 26 runs the TypeScript directly, so there
is no build step, and the dependencies are locked in a committed
`package-lock.json`.

## The application

| Behavior | Details |
| --- | --- |
| Port | 8000 (`APP_PORT`); binds to `127.0.0.1` locally and `0.0.0.0` in the container |
| Liveness | `GET /health/live`: the process is up; never checks dependencies |
| Readiness | `GET /health/ready`: checks PostgreSQL over a new connection; `503` with `"not-ready"` when it is unavailable or does not answer within `APP_DATABASE_TIMEOUT_SECONDS` |
| API reference | Scalar at `/docs`, OpenAPI 3.1 at `/openapi.json`; `APP_DOCS_ENABLED=false` turns both off |
| Database | PostgreSQL through Drizzle ORM and node-postgres; an initial Drizzle migration, applied with `npm run migrate` |
| Configuration | environment (`APP_*`) over a JSON file named by `APP_CONFIG_FILE` over non-secret defaults |
| Checks | Biome lint and formatting, strict TypeScript, Vitest with at least 80% on every coverage metric |
| Tests | unit tests on PGlite, an in-process PostgreSQL, so they need no server; `npm run test:integration` runs against a real PostgreSQL in a throwaway schema |
| Container | multi-stage Dockerfile on pinned base images, running as an unprivileged user |

Naming a configuration file that is missing, malformed or has unknown
settings stops the API with an error rather than falling back to defaults.
Drizzle migrations only go forward: undo a change with a new migration.
Ordinary API projects have no GenAI dependencies.

## Dependencies

Every dependency is pinned exactly. Liftoff's `npm run lock:node` resolves the
template's lockfile to versions published at least 7 days earlier, then moves
any package with a known advisory to a fixed version its dependents accept.
Where a fix needs a version a dependent does not accept, `package.json` holds
a narrow override, explained in the project's README.

## Layout

```text
demo/
  liftoff.yaml              what the project is made of
  .liftoff/manifest.json    every generated file, its owner and hash
  backend/
    src/                    the Fastify application
    src/db/schema.ts        the tables; npm run db:generate writes migrations
    drizzle/                Drizzle migrations
    test/                   unit tests; test/integration/ needs PostgreSQL
    package.json, package-lock.json, .node-version
    tsconfig.json, biome.json, vitest.config.ts
    Dockerfile, config.example.json
  compose.yaml              PostgreSQL and the application for local work
  .env.example              placeholders only; copy to .env
  README.md, REVIEW.md
  .github/
    workflows/01-pr-ci.yml          lint and types, tests, integration, image, dependency review, ci-gate
    workflows/02-codeql.yml         CodeQL for TypeScript and workflows
    workflows/03-review-policy*.yml review tier and approvals on every pull request
    workflows/04-ai-review.yml      verified AI review, when enabled
    review-policy.yml               how much review each kind of change needs
    liftoff/                        bundled checks the workflows run
    dependabot.yml, PULL_REQUEST_TEMPLATE.md
```

Governance profiles, coding agents and file ownership work the same way as
for [Python API projects](python-fastapi.md#who-owns-which-files): the
application, tests, README, lockfile, Dockerfile, Compose file, review
policy and CI workflows are seeded and yours; the bundled checks, the
review-policy and AI review workflows, and the skills and agents are managed
by Liftoff.

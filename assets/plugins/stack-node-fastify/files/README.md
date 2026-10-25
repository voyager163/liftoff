# {{liftoff.name}}

A TypeScript API built with Fastify, Drizzle ORM and PostgreSQL, created with
[Liftoff](https://github.com/voyager163/liftoff). This file is yours to
edit.

## Quick start

You need [Node.js](https://nodejs.org/) 26 (see `backend/.node-version`).
Node.js runs the TypeScript directly, so there is no build step. The unit
tests use an in-process PostgreSQL and need no database server.

```bash
cd backend
npm ci
npm test
```

To run the API against a local PostgreSQL database you also need Docker:

```bash
cp .env.example .env    # then set POSTGRES_PASSWORD
docker compose up --build
```

The API then listens on `http://127.0.0.1:8000`, with the API reference at
`/docs` and the OpenAPI document at `/openapi.json`. To run it without
Docker, point `APP_DATABASE_URL` at a PostgreSQL database and run
`npm run migrate`, then `npm start`.

## Health

- `GET /health/live` says the process is running. It never checks
  dependencies, so a database outage does not restart the API.
- `GET /health/ready` checks the database over a new connection and answers
  `503` when it is unavailable or does not answer within
  `APP_DATABASE_TIMEOUT_SECONDS`, so traffic is only sent when requests can
  be served.

## Configuration

Settings are read in this order, highest first:

1. environment variables prefixed `APP_`, such as `APP_PORT` or
   `APP_DATABASE_URL`;
2. a JSON file named by `APP_CONFIG_FILE`, see
   [backend/config.example.json](backend/config.example.json);
3. the defaults in [backend/src/config.ts](backend/src/config.ts).

Naming a configuration file that is missing, malformed or has unknown
settings stops the API with an error. Keep secrets, such as the database
password, in the environment.

## Database migrations

Tables are defined in [backend/src/db/schema.ts](backend/src/db/schema.ts).
After changing them, generate a migration and commit it:

```bash
cd backend
npm run db:generate
APP_DATABASE_URL=postgresql://app:PASSWORD@127.0.0.1:5432/app npm run migrate
```

`docker compose up` runs the migrations before starting the API. Drizzle
migrations only go forward; undo a change with a new migration.

## Checks

| Command (in `backend/`) | What it checks |
| --- | --- |
| `npm run lint` | Lint and formatting (Biome) |
| `npm run typecheck` | TypeScript, strict |
| `npm test` | Tests, with at least 80% on every coverage metric |
| `npm run test:integration` | Integration tests; needs `APP_DATABASE_URL` pointing at PostgreSQL |

CI runs all of them on every pull request, builds the container image and
reviews new dependencies.

## Dependencies

Dependabot proposes updates weekly. `backend/package.json` has one override:
`@scalar/json-magic@0.16.0` gets `undici` 7.30.1, which fixes a
denial-of-service advisory (GHSA-xjj6-f33q-929c). The override stops applying
once the Scalar packages move past that version; remove it then.

## How changes are made

{{liftoff.changeProcess}}

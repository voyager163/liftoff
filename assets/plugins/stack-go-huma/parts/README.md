# {{liftoff.name}}

A Go API built with Huma, Chi, pgx and PostgreSQL, created with
[Liftoff](https://github.com/voyager163/liftoff). This file is yours to
edit.

## Quick start

You need [Go](https://go.dev/dl/) 1.27.3 or later (see `backend/go.mod`).
The unit tests need no database server.

```bash
cd backend
go test ./...
```

To run the API against a local PostgreSQL database you also need Docker:

```bash
cp .env.example .env    # then set POSTGRES_PASSWORD
docker compose up --build
```

The API then listens on `http://127.0.0.1:8000`, with the API reference at
`/docs` and the OpenAPI document at `/openapi.json`. To run it without
Docker, point `APP_DATABASE_URL` at a PostgreSQL database and run
`go run ./cmd/api migrate`, then `go run ./cmd/api`.

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
3. the defaults in
   [backend/internal/config/config.go](backend/internal/config/config.go).

Naming a configuration file that is missing, malformed or has unknown
settings stops the API with an error. Keep secrets, such as the database
password, in the environment.

## Database migrations

Migrations are SQL files in
[backend/internal/database/migrations/](backend/internal/database/migrations/),
built into the binary. Add a new numbered file with `-- +goose Up` and
`-- +goose Down` sections, then apply it:

```bash
cd backend
APP_DATABASE_URL=postgresql://app:PASSWORD@127.0.0.1:5432/app go run ./cmd/api migrate
```

`docker compose up` runs the migrations before starting the API.

## Checks

| Command (in `backend/`) | What it checks |
| --- | --- |
| `gofmt -l .` | Formatting; lists files that need `gofmt -w` |
| `go vet ./...` | Common mistakes |
| `go test -coverpkg=./cmd/...,./internal/... -coverprofile=cover.out ./...` | Tests |
| `go run ./tools/coverage cover.out 80` | At least 80% statement coverage |
| `go test -count=1 -tags integration ./internal/integration` | Integration tests; needs `APP_DATABASE_URL` pointing at PostgreSQL |

CI runs all of them on every pull request, builds the container image and
reviews new dependencies.

# {{liftoff.name}}

A Python API built with FastAPI, SQLAlchemy and Alembic, created with
[Liftoff](https://github.com/voyager163/liftoff). This file is yours to
edit.

## Quick start

You need [uv](https://docs.astral.sh/uv/). It installs the right Python and
the locked dependencies.

```bash
cd backend
uv sync
uv run pytest
```

To run the API against a local PostgreSQL database you also need Docker:

```bash
cp .env.example .env    # then set POSTGRES_PASSWORD
docker compose up --build
```

The API then listens on `http://127.0.0.1:8000`, with the API reference at
`/docs` and the OpenAPI document at `/openapi.json`.

## Health

- `GET /health/live` says the process is running. It never checks
  dependencies, so a database outage does not restart the API.
- `GET /health/ready` checks the database and answers `503` when it is
  unavailable, so traffic is only sent when requests can be served.

## Configuration

Settings are read in this order, highest first:

1. environment variables prefixed `APP_`, such as `APP_PORT` or
   `APP_DATABASE_URL`;
2. a TOML file named by `APP_CONFIG_FILE`, see
   [backend/config.example.toml](backend/config.example.toml);
3. the defaults in [backend/app/config.py](backend/app/config.py).

Naming a configuration file that is missing, malformed or has unknown
settings stops the API with an error. Keep secrets, such as the database
password, in the environment.

## Database migrations

```bash
cd backend
APP_DATABASE_URL=postgresql+psycopg://app:PASSWORD@127.0.0.1:5432/app uv run alembic upgrade head
uv run alembic revision -m "describe the change"
```

`docker compose up` runs `alembic upgrade head` before starting the API.

## Checks

| Command (in `backend/`) | What it checks |
| --- | --- |
| `uv run ruff check .` | Lint |
| `uv run ruff format --check .` | Formatting |
| `uv run pytest` | Tests, with at least 80% branch coverage |
| `uv run pytest -m integration --no-cov` | Integration tests; needs `APP_DATABASE_URL` pointing at PostgreSQL |

CI runs all of them on every pull request, builds the container image and
reviews new dependencies.

## How changes are made

{{liftoff.changeProcess}}

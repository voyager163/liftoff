import type { StackPlugin } from "../../contracts/project-plugin.ts";
import { filesFrom } from "../files.ts";

const ROOT = "plugins/stack-python-fastapi/files";

/** Python API: FastAPI, SQLAlchemy and Alembic, with a uv-locked environment. */
export const pythonFastapiStack: StackPlugin = {
  id: "stack/python-fastapi",
  kind: "stack",
  workload: "api",
  version: "1",
  summary: "Python API with FastAPI, SQLAlchemy, Alembic and uv",
  templateRoots: [ROOT],
  checks: [
    { name: "Lint", command: "uv run ruff check .", directory: "backend" },
    { name: "Format", command: "uv run ruff format --check .", directory: "backend" },
    { name: "Tests with coverage", command: "uv run pytest", directory: "backend" },
    {
      name: "Integration tests (needs PostgreSQL)",
      command: "uv run pytest -m integration --no-cov",
      directory: "backend",
    },
  ],
  tools: [
    {
      name: "uv",
      command: "uv",
      versionArgs: ["--version"],
      required: true,
      minimum: "0.9.0",
      purpose: "installs Python and the locked dependencies, and runs the checks",
      install: "https://docs.astral.sh/uv/getting-started/installation/",
    },
    {
      name: "Git",
      command: "git",
      versionArgs: ["--version"],
      required: true,
      minimum: "2.40.0",
      purpose: "version control and the review policy",
      install: "https://git-scm.com/downloads",
    },
    {
      name: "Docker",
      command: "docker",
      versionArgs: ["--version"],
      required: false,
      purpose: "runs PostgreSQL and the API locally with docker compose",
      install: "https://docs.docker.com/get-started/get-docker/",
    },
  ],
  reviewRules: [
    {
      paths: ["backend/migrations/**", "backend/app/models.py"],
      tier: "high",
      always_human: true,
      reason: "changes the database schema or its migrations",
    },
    {
      paths: ["backend/Dockerfile", "compose.yaml", "backend/pyproject.toml", "backend/uv.lock"],
      tier: "high",
      always_human: false,
      reason: "changes the shipped image or its dependencies",
    },
    {
      paths: ["backend/app/config.py", "backend/app/database.py"],
      tier: "high",
      always_human: false,
      reason: "changes configuration or database access",
    },
    {
      paths: ["backend/tests/**"],
      tier: "low",
      always_human: false,
      reason: "tests; coverage gates still apply",
    },
    { paths: ["docs/**", "*.md"], tier: "low", always_human: false, reason: "documentation" },
  ],
  layout: [
    { path: "backend/app/", purpose: "the FastAPI application" },
    { path: "backend/migrations/", purpose: "Alembic database migrations" },
    { path: "backend/tests/", purpose: "tests; `-m integration` needs PostgreSQL" },
    { path: "compose.yaml", purpose: "PostgreSQL, migrations and the API for local development" },
  ],
  artifacts: ({ templates, config, profile }) =>
    filesFrom(
      templates,
      ROOT,
      {
        name: config.name,
        changeProcess:
          profile === "none"
            ? "See [REVIEW.md](REVIEW.md) for what reviewers look for."
            : "Pull requests target `develop`. See [GOVERNANCE.md](GOVERNANCE.md) for the\nbranch model and [REVIEW.md](REVIEW.md) for what reviewers look for.",
      },
      "seeded",
    ),
};

import type { StackPlugin } from "../../contracts/project-plugin.ts";
import { filesFrom } from "../files.ts";
import { changeProcess, DOCKER_TOOL, DOCUMENTATION_RULE, GIT_TOOL } from "./shared.ts";

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
    GIT_TOOL,
    DOCKER_TOOL,
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
    DOCUMENTATION_RULE,
  ],
  quickStart: "cd backend && uv sync && uv run pytest",
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
      { name: config.name, changeProcess: changeProcess(profile) },
      "seeded",
    ),
};

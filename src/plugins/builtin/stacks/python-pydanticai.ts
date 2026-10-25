import type { StackPlugin } from "../../contracts/project-plugin.ts";
import { filesFrom } from "../files.ts";
import { DOCKER_TOOL, DOCUMENTATION_RULE, GIT_TOOL } from "./shared.ts";

const ROOT = "plugins/stack-python-pydanticai";

/**
 * Python GenAI API: FastAPI and PydanticAI, with a uv-locked environment.
 * The selected pattern supplies the endpoints; the stack supplies the model
 * and tracing boundaries, health, docs and configuration.
 */
export const pythonPydanticaiStack: StackPlugin = {
  id: "stack/python-pydanticai",
  kind: "stack",
  workload: "genai",
  version: "1",
  summary: "Python GenAI API with FastAPI, PydanticAI and uv",
  templateRoots: [`${ROOT}/files`, `${ROOT}/parts`],
  parts: `${ROOT}/parts`,
  image: { name: "api", context: "backend" },
  codeql: { language: "python", buildMode: "none", subject: "the Python code" },
  checks: [
    { name: "Lint", command: "uv run ruff check .", directory: "backend" },
    { name: "Format", command: "uv run ruff format --check .", directory: "backend" },
    { name: "Tests with coverage, offline", command: "uv run pytest", directory: "backend" },
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
      paths: ["backend/Dockerfile", "compose.yaml", "backend/pyproject.toml", "backend/uv.lock"],
      tier: "high",
      always_human: false,
      reason: "changes the shipped image or its dependencies",
    },
    {
      paths: ["backend/app/config.py", "backend/app/ports/**", "backend/app/errors.py"],
      tier: "high",
      always_human: false,
      reason: "changes configuration, how the model is called, or tracing",
    },
    {
      paths: ["backend/tests/**"],
      tier: "low",
      always_human: false,
      reason: "tests; coverage gates still apply",
    },
    DOCUMENTATION_RULE,
  ],
  quickStart: { directory: "backend", command: "uv sync && uv run pytest" },
  layout: [
    { path: "backend/app/", purpose: "the FastAPI application" },
    {
      path: "backend/app/ports/",
      purpose: "boundaries to the model and tracing, each with an offline adapter",
    },
    { path: "backend/tests/", purpose: "tests, which run offline on PydanticAI's test model" },
    { path: "compose.yaml", purpose: "the API, for local development" },
  ],
  artifacts: ({ templates, config }) =>
    filesFrom(templates, `${ROOT}/files`, { name: config.name }, "seeded"),
};

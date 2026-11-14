import { AI_SERVICE_DIRECTORY } from "../../domain/project/config.ts";
import type { ComponentPlugin, PatternPlugin } from "../contracts/project-plugin.ts";
import { filesFrom } from "./files.ts";
import { maturityMarkdown } from "./patterns.ts";
import { pythonPydanticaiStack } from "./stacks/python-pydanticai.ts";

const STACK = "plugins/stack-python-pydanticai/files";
const ROOT = "plugins/ai-service";
const AI = AI_SERVICE_DIRECTORY;

/** A path the GenAI stack writes under backend/, moved to the AI service's directory. */
const moved = (path: string): string =>
  path === "backend" || path.startsWith("backend/") ? `${AI}${path.slice("backend".length)}` : path;

/**
 * An API project's AI service (AISVC-002): the GenAI stack's FastAPI and
 * PydanticAI service and one pattern's endpoints, in `ai-service/` beside
 * the backend, which reaches it over HTTP. Its shared-file parts are its own,
 * so its CI jobs, Compose service and image never collide with the
 * backend's.
 */
export function aiServicePlugin(pattern: PatternPlugin | undefined): ComponentPlugin {
  const patternRoot = pattern === undefined ? undefined : `plugins/pattern-${pattern.name}/files`;
  return {
    id: "ai-service",
    kind: "ai-service",
    version: "1",
    summary: "AI service: FastAPI and PydanticAI beside the API",
    templateRoots: [STACK, ...(patternRoot === undefined ? [] : [patternRoot]), `${ROOT}/parts`],
    parts: `${ROOT}/parts`,
    image: { name: "ai-service", context: AI },
    codeql: pythonPydanticaiStack.codeql,
    checks: pythonPydanticaiStack.checks.map((check) => ({ ...check, directory: AI })),
    tools: pythonPydanticaiStack.tools,
    reviewRules: [
      {
        paths: [`${AI}/Dockerfile`, `${AI}/pyproject.toml`, `${AI}/uv.lock`],
        tier: "high",
        always_human: false,
        reason: "changes the AI service's image or its dependencies",
      },
      {
        paths: [`${AI}/app/config.py`, `${AI}/app/ports/**`, `${AI}/app/errors.py`],
        tier: "high",
        always_human: false,
        reason: "changes the AI service's configuration, how the model is called, or tracing",
      },
      {
        paths: [`${AI}/tests/**`],
        tier: "low",
        always_human: false,
        reason: "AI service tests; coverage gates still apply",
      },
    ],
    layout: [
      {
        path: `${AI}/`,
        purpose: `the AI service: FastAPI and PydanticAI${pattern === undefined ? "" : `, the ${pattern.name} pattern`}, called only by the API`,
      },
      {
        path: `${AI}/app/ports/`,
        purpose:
          "the AI service's boundaries to the model and tracing, each with an offline adapter",
      },
    ],
    readmeValues: () => ({
      aiPattern: pattern?.name ?? "its own",
      maturity: pattern === undefined ? "" : `\n\n${maturityMarkdown(pattern.maturity)}`,
    }),
    artifacts: ({ templates, config }) => [
      ...filesFrom(templates, STACK, { name: config.name }, "seeded", moved),
      ...(patternRoot === undefined
        ? []
        : filesFrom(templates, patternRoot, { name: config.name }, "seeded", moved)),
    ],
  };
}

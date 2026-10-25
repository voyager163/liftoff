import type { StackPlugin } from "../../contracts/project-plugin.ts";
import { filesFrom } from "../files.ts";
import { DOCKER_TOOL, DOCUMENTATION_RULE, GIT_TOOL } from "./shared.ts";

const ROOT = "plugins/stack-node-fastify";

/** Node.js API: TypeScript, Fastify and Drizzle ORM, with a committed npm lockfile. */
export const nodeFastifyStack: StackPlugin = {
  id: "stack/node-fastify",
  kind: "stack",
  workload: "api",
  version: "2",
  summary: "TypeScript API with Fastify, Drizzle ORM and npm",
  templateRoots: [`${ROOT}/files`, `${ROOT}/parts`],
  parts: `${ROOT}/parts`,
  codeql: { language: "javascript-typescript", buildMode: "none", subject: "the TypeScript code" },
  checks: [
    { name: "Lint", command: "npm run lint", directory: "backend" },
    { name: "Types", command: "npm run typecheck", directory: "backend" },
    { name: "Tests with coverage", command: "npm test", directory: "backend" },
    {
      name: "Integration tests (needs PostgreSQL)",
      command: "npm run test:integration",
      directory: "backend",
    },
  ],
  tools: [
    {
      name: "Node.js",
      command: "node",
      versionArgs: ["--version"],
      required: true,
      minimum: "26.12.1",
      purpose: "runs the API, its tests and the checks",
      install: "https://nodejs.org/en/download",
    },
    GIT_TOOL,
    DOCKER_TOOL,
  ],
  reviewRules: [
    {
      paths: ["backend/drizzle/**", "backend/src/db/schema.ts"],
      tier: "high",
      always_human: true,
      reason: "changes the database schema or its migrations",
    },
    {
      paths: [
        "backend/Dockerfile",
        "compose.yaml",
        "backend/package.json",
        "backend/package-lock.json",
      ],
      tier: "high",
      always_human: false,
      reason: "changes the shipped image or its dependencies",
    },
    {
      paths: ["backend/src/config.ts", "backend/src/db/database.ts"],
      tier: "high",
      always_human: false,
      reason: "changes configuration or database access",
    },
    {
      paths: ["backend/test/**"],
      tier: "low",
      always_human: false,
      reason: "tests; coverage gates still apply",
    },
    DOCUMENTATION_RULE,
  ],
  quickStart: { directory: "backend", command: "npm ci && npm test" },
  database: { migrateCommand: ["node", "src/migrate.ts"], urlScheme: "postgresql" },
  layout: [
    { path: "backend/src/", purpose: "the Fastify application" },
    { path: "backend/drizzle/", purpose: "Drizzle database migrations" },
    { path: "backend/test/", purpose: "tests; test/integration/ needs PostgreSQL" },
    { path: "compose.yaml", purpose: "PostgreSQL and the application, for local development" },
  ],
  artifacts: ({ templates, config }) =>
    filesFrom(templates, `${ROOT}/files`, { name: config.name }, "seeded"),
};

import type { StackPlugin } from "../../contracts/project-plugin.ts";
import { filesFrom } from "../files.ts";
import { changeProcess, DOCKER_TOOL, DOCUMENTATION_RULE, GIT_TOOL } from "./shared.ts";

const ROOT = "plugins/stack-go-huma/files";

/** Go API: Huma v2 on Chi, pgx and Goose, with go.mod and go.sum. */
export const goHumaStack: StackPlugin = {
  id: "stack/go-huma",
  kind: "stack",
  workload: "api",
  version: "1",
  summary: "Go API with Huma, Chi, pgx and Goose",
  templateRoots: [ROOT],
  checks: [
    { name: "Format", command: "gofmt -l .", directory: "backend" },
    { name: "Vet", command: "go vet ./...", directory: "backend" },
    {
      name: "Tests with coverage",
      command:
        "go test -coverpkg=./cmd/...,./internal/... -coverprofile=cover.out ./... && go run ./tools/coverage cover.out 80",
      directory: "backend",
    },
    {
      name: "Integration tests (needs PostgreSQL)",
      command: "go test -tags integration ./internal/integration",
      directory: "backend",
    },
  ],
  tools: [
    {
      name: "Go",
      command: "go",
      versionArgs: ["version"],
      required: true,
      minimum: "1.27.3",
      purpose: "builds and tests the API",
      install: "https://go.dev/dl/",
    },
    GIT_TOOL,
    DOCKER_TOOL,
  ],
  reviewRules: [
    {
      paths: ["backend/internal/database/migrations/**"],
      tier: "high",
      always_human: true,
      reason: "changes the database schema or its migrations",
    },
    {
      paths: ["backend/Dockerfile", "compose.yaml", "backend/go.mod", "backend/go.sum"],
      tier: "high",
      always_human: false,
      reason: "changes the shipped image or its dependencies",
    },
    {
      paths: ["backend/internal/config/**", "backend/internal/database/**"],
      tier: "high",
      always_human: false,
      reason: "changes configuration or database access",
    },
    {
      paths: ["backend/**/*_test.go"],
      tier: "low",
      always_human: false,
      reason: "tests; coverage gates still apply",
    },
    DOCUMENTATION_RULE,
  ],
  quickStart: "cd backend && go test ./...",
  layout: [
    { path: "backend/cmd/api/", purpose: "the API binary: serve, migrate and healthcheck" },
    { path: "backend/internal/", purpose: "configuration, database, health and the items API" },
    {
      path: "backend/internal/database/migrations/",
      purpose: "Goose database migrations, built into the binary",
    },
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

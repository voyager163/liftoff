import type { FrontendPlugin } from "../../contracts/project-plugin.ts";
import { filesFrom } from "../files.ts";

const ROOT = "plugins/frontend-vue";

/** Vue single-page application: Vite, Tailwind CSS and TypeScript, served by nginx. */
export const vueFrontend: FrontendPlugin = {
  id: "frontend/vue",
  kind: "frontend",
  version: "1",
  summary: "Vue frontend with Vite, Tailwind CSS and TypeScript",
  templateRoots: [`${ROOT}/files`, `${ROOT}/parts`],
  parts: `${ROOT}/parts`,
  codeql: {
    language: "javascript-typescript",
    buildMode: "none",
    subject: "the frontend's TypeScript and Vue code",
  },
  checks: [
    { name: "Frontend lint and formatting", command: "npm run lint", directory: "frontend" },
    { name: "Frontend types", command: "npm run typecheck", directory: "frontend" },
    { name: "Frontend tests with coverage", command: "npm test", directory: "frontend" },
    { name: "Frontend production build", command: "npm run build", directory: "frontend" },
    {
      name: "Browser tests (needs the application running in Docker Compose)",
      command: "npm run test:e2e",
      directory: "frontend",
    },
  ],
  tools: [
    {
      name: "Node.js",
      command: "node",
      versionArgs: ["--version"],
      required: true,
      minimum: "26.12.1",
      purpose: "builds and tests the frontend",
      install: "https://nodejs.org/en/download",
    },
  ],
  reviewRules: [
    {
      paths: [
        "frontend/Dockerfile",
        "frontend/nginx/**",
        "frontend/package.json",
        "frontend/package-lock.json",
      ],
      tier: "high",
      always_human: false,
      reason: "changes the frontend image, its web server or its dependencies",
    },
    {
      paths: ["frontend/src/__tests__/**", "frontend/e2e/**"],
      tier: "low",
      always_human: false,
      reason: "tests; coverage gates still apply",
    },
  ],
  quickStart: { directory: "frontend", command: "npm ci && npm test" },
  layout: [
    { path: "frontend/src/", purpose: "the Vue application and its unit tests" },
    {
      path: "frontend/e2e/",
      purpose: "Playwright browser tests, run against the application in Docker Compose",
    },
    { path: "frontend/nginx/", purpose: "the web server in the frontend's container" },
  ],
  artifacts: ({ templates, config }) =>
    filesFrom(templates, `${ROOT}/files`, { name: config.name }, "seeded"),
};

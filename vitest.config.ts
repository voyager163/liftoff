import { defineConfig } from "vitest/config";

// Coverage is measured over every file in src/, including files no test
// imports, and each metric must independently exceed 80%.
const threshold = 80.01;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      thresholds: {
        statements: threshold,
        branches: threshold,
        functions: threshold,
        lines: threshold,
      },
    },
  },
});

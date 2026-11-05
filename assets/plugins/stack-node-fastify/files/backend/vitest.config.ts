import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests need PostgreSQL: npm run test:integration
    exclude: ["test/integration/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});

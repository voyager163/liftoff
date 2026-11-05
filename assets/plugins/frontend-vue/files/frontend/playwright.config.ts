import { defineConfig, devices } from "@playwright/test";

// Browser tests run against the whole application, frontend, API and
// database, which `docker compose up` starts from the project root. Point
// them elsewhere with E2E_BASE_URL.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

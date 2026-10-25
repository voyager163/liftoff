import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/ci/review-metrics.ts";
import { computeMetrics } from "../../src/domain/ai-review/metrics.ts";

const DAY = 86_400_000;
const now = Date.parse("2026-10-25T00:00:00Z");

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("EVAL-003 review metrics", () => {
  it("computes percentiles, first-round passes and the revert guardrail", () => {
    const pr = (
      number: number,
      hours: number,
      approvals: number,
      aiRounds: number,
      title = "Change",
    ) => ({
      number,
      title,
      createdAt: now - hours * 3_600_000,
      mergedAt: now,
      humanApprovals: approvals,
      aiRounds,
    });
    const metrics = computeMetrics([
      pr(1, 2, 0, 1),
      pr(2, 4, 1, 2),
      pr(3, 10, 0, 0, 'Revert "Change"'),
      pr(4, 1, 2, 1),
    ]);
    expect(metrics).toEqual({
      merged: 4,
      hoursToMerge: { median: 2, p95: 10 },
      humanApprovals: { median: 0, p95: 2 },
      passedFirstRound: 66.7,
      meanAiRounds: 1.3,
      reverts: 1,
      revertRate: 25,
    });
    expect(computeMetrics([])).toMatchObject({
      merged: 0,
      passedFirstRound: undefined,
      revertRate: 0,
    });
  });

  it("reads merged pull requests and their reviews", async () => {
    const instance = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      res.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/repos/o/r/pulls") {
        res.end(
          JSON.stringify([
            {
              number: 1,
              title: "A",
              created_at: new Date(now - 5 * DAY).toISOString(),
              merged_at: new Date(now - DAY).toISOString(),
            },
            {
              number: 2,
              title: "Old",
              created_at: new Date(now - 90 * DAY).toISOString(),
              merged_at: new Date(now - 60 * DAY).toISOString(),
            },
            {
              number: 3,
              title: "Closed",
              created_at: new Date(now - DAY).toISOString(),
              merged_at: null,
            },
          ]),
        );
        return;
      }
      res.end(
        JSON.stringify([
          { user: { login: "bob", type: "User" }, state: "APPROVED", body: "" },
          { user: { login: "bob", type: "User" }, state: "APPROVED", body: "" },
          { user: { login: "dependabot[bot]", type: "Bot" }, state: "APPROVED", body: "" },
          {
            user: { login: "github-actions[bot]", type: "Bot" },
            state: "COMMENTED",
            body: "<!-- liftoff-ai-review round=1 head=a -->",
          },
        ]),
      );
    });
    server = instance;
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
    const logs: string[] = [];
    const code = await main({
      env: { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", GITHUB_API_URL: url },
      appendFile: () => undefined,
      log: (text) => logs.push(text),
      now: () => now,
    });
    expect(code).toBe(0);
    const text = logs.join("");
    expect(text).toContain("| Pull requests merged | 1 |");
    expect(text).toContain("| Human approvals per pull request (median / p95) | 1 / 1 |");
    expect(text).toContain("| Passed verified AI review in one round | 100% |");
  });

  it("fails without configuration", async () => {
    const logs: string[] = [];
    expect(
      await main({
        env: {},
        appendFile: () => undefined,
        log: (t) => logs.push(t),
        now: () => now,
      }),
    ).toBe(1);
    expect(logs.join("")).toContain("must be set");
  });
});

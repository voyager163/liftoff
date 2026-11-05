import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/ci/governance-drift-check.ts";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeRules(rules: Record<string, unknown[]>): Promise<string> {
  const instance = createServer((req, res) => {
    const match = /\/rules\/branches\/([^/?]+)/.exec(req.url ?? "");
    const branch = decodeURIComponent(match?.[1] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rules[branch] ?? []));
  });
  server = instance;
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}

const ruleset = JSON.stringify({
  name: "Protect develop",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/develop"], exclude: [] } },
  bypass_actors: [],
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
});

const run = (env: Record<string, string | undefined>, files = ["a.json"]) => {
  const logs: string[] = [];
  return main({
    env,
    listRulesetFiles: () => files,
    readFile: () => ruleset,
    appendFile: () => undefined,
    log: (text) => logs.push(text),
  }).then((code) => ({ code, log: logs.join("") }));
};

describe("REPO-002 the governance drift check", () => {
  it("passes when live rules match", async () => {
    const url = await fakeRules({ develop: [{ type: "deletion" }, { type: "non_fast_forward" }] });
    const { code, log } = await run({
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_API_URL: url,
    });
    expect(code).toBe(0);
    expect(log).toContain("✅ **Protect develop**");
    expect(log).toContain("Live branch rules match");
  });

  it("fails and lists each difference", async () => {
    const url = await fakeRules({ develop: [{ type: "deletion" }] });
    const { code, log } = await run({
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_API_URL: url,
    });
    expect(code).toBe(1);
    expect(log).toContain("`develop` non_fast_forward: missing");
    expect(log).toContain("1 difference.");
  });

  it("fails closed without configuration or rulesets", async () => {
    expect((await run({})).log).toContain("must be set");
    expect((await run({ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t" }, [])).log).toContain(
      "no desired rulesets",
    );
  });
});

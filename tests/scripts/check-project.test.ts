import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/adapters/process.ts";

const script = path.resolve(import.meta.dirname, "../../scripts/matrix/check-project.sh");

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-check-project-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

// Paths are relative to the working directory, so Git's bash on Windows reads them too.
const check = (project: string, env: Record<string, string> = {}) =>
  run("bash", [script, project], { cwd: work, env: { ...process.env, ...env } });

describe("PROJ-023 the nightly project check fails closed", () => {
  it("fails for a directory that does not exist", async () => {
    const result = await check("missing");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing is not a directory");
  });

  it("fails when there is no backend it knows, even with a frontend", async () => {
    mkdirSync(path.join(work, "empty"));
    expect((await check("empty")).stderr).toContain("has no Python, Node.js or Go backend");
    mkdirSync(path.join(work, "web/frontend"), { recursive: true });
    writeFileSync(path.join(work, "web/frontend/package.json"), "{}");
    const frontendOnly = await check("web");
    expect(frontendOnly.exitCode).toBe(1);
    expect(frontendOnly.stderr).toContain("has no Python, Node.js or Go backend");
  });
});

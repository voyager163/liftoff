import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("PROJ-023 each distinct workflow is linted as its own project", () => {
  it("writes the reusable workflows a workflow calls beside it, in a project of its own", {
    timeout: 120_000,
  }, () => {
    const out = mkdtempSync(path.join(tmpdir(), "liftoff-distinct-"));
    try {
      execFileSync(process.execPath, ["scripts/matrix/write-distinct.ts", out], { cwd: root });
      let callers = 0;
      for (const project of readdirSync(out)) {
        // actionlint takes a directory with .git and .github/workflows as a project.
        expect(existsSync(path.join(out, project, ".git")), project).toBe(true);
        const workflows = path.join(out, project, ".github/workflows");
        if (!existsSync(workflows)) continue;
        for (const name of readdirSync(workflows)) {
          const text = readFileSync(path.join(workflows, name), "utf8");
          for (const [, callee = ""] of text.matchAll(/uses: \.\/(\.github\/workflows\/\S+)/g)) {
            callers++;
            expect(existsSync(path.join(out, project, callee)), `${project}/${name}`).toBe(true);
          }
        }
      }
      // The deploy workflows call reusable-deploy.yml.
      expect(callers).toBeGreaterThan(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

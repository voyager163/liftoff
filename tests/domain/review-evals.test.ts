import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, type PipelineEnvironment } from "../../src/ci/ai-review.ts";
import { parseEvalCase, scoreEval } from "../../src/domain/ai-review/evals.ts";
import {
  type Finding,
  fingerprint,
  JSON_END,
  JSON_START,
} from "../../src/domain/ai-review/findings.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const casesRoot = path.join(repoRoot, "evals/review");

const seeded = parseEvalCase(
  JSON.stringify({
    kind: "seeded",
    patch: "p",
    description: "d",
    file: "src/a.ts",
    line: 50,
    summary: "s",
  }),
  "x",
);
const finding = (file: string, line: number, tag: Finding["tag"] = "important"): Finding => ({
  file,
  line,
  title: "t",
  scenario: "s",
  id: "c1",
  fingerprint: fingerprint(file, `t${line}`),
  tag,
  confirmations: 2,
  verifiers: 3,
});

describe("EVAL-001 review evaluation cases", () => {
  it("validates cases", () => {
    expect(() => parseEvalCase("{", "bad.json")).toThrow(/not valid JSON/);
    expect(() => parseEvalCase(JSON.stringify({ kind: "clean" }), "c.json")).toThrow(/patch/);
    expect(() =>
      parseEvalCase(
        JSON.stringify({ kind: "seeded", patch: "p", description: "d", summary: "s" }),
        "s.json",
      ),
    ).toThrow(/needs file and line/);
  });

  it("scores a caught defect within tolerance and counts unrelated Important findings", () => {
    expect(
      scoreEval(seeded, [
        finding("src/a.ts", 55),
        finding("src/b.ts", 1),
        finding("src/c.ts", 1, "nit"),
      ]),
    ).toEqual({
      kind: "seeded",
      caught: true,
      falsePositives: 1,
      findings: 3,
    });
    expect(scoreEval(seeded, [finding("src/a.ts", 70)]).caught).toBe(false);
    expect(scoreEval({ ...seeded, tolerance: 25 }, [finding("src/a.ts", 70)]).caught).toBe(true);
  });

  it("treats every Important finding on a clean case as a false positive", () => {
    const clean = parseEvalCase(
      JSON.stringify({ kind: "clean", patch: "p", description: "d", summary: "s" }),
      "c",
    );
    expect(scoreEval(clean, [finding("src/a.ts", 1), finding("src/a.ts", 2, "nit")])).toEqual({
      kind: "clean",
      caught: undefined,
      falsePositives: 1,
      findings: 2,
    });
  });

  it.each(
    readdirSync(casesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  )("committed case %s parses and its patch still applies", (name) => {
    const evalCase = parseEvalCase(
      readFileSync(path.join(casesRoot, name, "case.json"), "utf8"),
      name,
    );
    execFileSync("git", ["apply", "--check", path.join("evals/review", name, evalCase.patch)], {
      cwd: repoRoot,
    });
  });
});

describe("EVAL-002 the eval runner", () => {
  const block = (value: unknown) => `${JSON_START}${JSON.stringify(value)}${JSON_END}`;
  const harness = (env: Record<string, string>) => {
    const files = new Map<string, string>([
      [
        "evals/review/x/case.json",
        JSON.stringify({
          kind: "seeded",
          patch: "p",
          description: "Tidy up.",
          file: "src/a.ts",
          line: 5,
          summary: "Planted bug",
        }),
      ],
    ]);
    const logs: string[] = [];
    const context: PipelineEnvironment = {
      env: { LIFTOFF_EVAL_CASE: "evals/review/x", ...env },
      readFile: (p) => {
        const text = files.get(p);
        if (text === undefined) throw new Error(`ENOENT ${p}`);
        return text;
      },
      writeFile: (p, text) => files.set(p, text),
      listFiles: (dir) =>
        [...files.keys()]
          .filter((p) => p.startsWith(`${dir}/`))
          .map((p) => p.slice(dir.length + 1)),
      appendFile: (p, text) => files.set(p, (files.get(p) ?? "") + text),
      log: (text) => logs.push(text),
      git: async (args) =>
        args[1]?.endsWith("SKILL.md") ? "---\nname: a\n---\nMethod." : undefined,
      removeFile: () => undefined,
    };
    return { context, files, logs };
  };

  it("prepares finder prompts from the case description, without the defect", async () => {
    const { context, files } = harness({});
    expect(await main("eval-prepare", context)).toBe(0);
    const prompt = files.get("ai-review/finder-0.md") ?? "";
    expect(prompt).toContain("git diff HEAD~1..HEAD");
    expect(prompt).toContain("Tidy up.");
    expect(prompt).not.toContain("Planted bug");
    expect(files.has("ai-review/finder-1.md")).toBe(true);
  });

  it("scores a run and reports all cases", async () => {
    const { context, files, logs } = harness({});
    files.set(
      "ai-review/finders/finder-0.txt",
      block({ candidates: [{ file: "src/a.ts", line: 6, title: "Bug", scenario: "s" }] }),
    );
    for (const run of [0, 1]) {
      files.set(
        `ai-review/verifiers/verifier-${run}.txt`,
        block({ verdicts: [{ id: "c1", verdict: "confirmed", tag: "important" }] }),
      );
    }
    files.set("ai-review/verifiers/verifier-2.txt", "no json");
    expect(await main("eval-score", context)).toBe(0);
    expect(JSON.parse(files.get("ai-review/score.json") ?? "{}")).toMatchObject({
      caught: true,
      falsePositives: 0,
    });

    files.set("eval-results/x.json", files.get("ai-review/score.json") ?? "");
    expect(await main("eval-report", context)).toBe(0);
    expect(logs.join("")).toContain(
      "Caught 1 of 1 known defects; 0 Important false positive(s) across 1 case(s).",
    );
  });

  it("fails the report when a case produced no score", async () => {
    const { context, logs } = harness({ LIFTOFF_EVAL_EXPECTED: "2" });
    expect(await main("eval-report", context)).toBe(1);
    expect(logs.join("")).toContain("2 case(s) did not produce a score");
  });

  it("needs a case directory", async () => {
    const { context, logs } = harness({ LIFTOFF_EVAL_CASE: "" });
    expect(await main("eval-score", context)).toBe(1);
    expect(logs.join("")).toContain("LIFTOFF_EVAL_CASE must name a case directory");
  });
});

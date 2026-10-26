import { describe, expect, it } from "vitest";
import {
  type FileNow,
  JournalError,
  journalFor,
  parseJournal,
  recoverySteps,
  serializeJournal,
} from "../../src/domain/change/journal.ts";
import {
  type FileChange,
  orderChanges,
  parseChangePlan,
  sealChangePlan,
  type UnsignedChangePlan,
} from "../../src/domain/plan/change-plan.ts";
import {
  canonicalJson,
  PLAN_SCHEMA,
  PlanError,
  parsePlan,
  sha256Hex,
} from "../../src/domain/plan/plan.ts";

const A = sha256Hex("a");
const B = sha256Hex("b");

const kept = (path: string, before: string | null, after: string): FileChange => ({
  path,
  before,
  after,
  ownership: "managed",
  executable: false,
});

const unsigned = (changes: FileChange[]): UnsignedChangePlan => ({
  schema: PLAN_SCHEMA,
  operation: "update",
  liftoff: "1.0.0",
  target: "/work/demo",
  config: { name: "demo" },
  effects: ["modify-files"],
  changes,
});

describe("CHANGE-001 a change plan names every file it changes, before and after", () => {
  it("seals and parses a plan, refusing an edited one", () => {
    const plan = sealChangePlan(
      unsigned([kept("README.md", A, B), { path: "old.txt", before: A, after: null }]),
    );
    expect(parseChangePlan(JSON.stringify(plan))).toEqual(plan);
    const edited = { ...plan, changes: plan.changes.slice(1) };
    expect(() => parseChangePlan(JSON.stringify(edited))).toThrow(/changed after it was made/);
    expect(() => parseChangePlan("{")).toThrow(PlanError);
    expect(() => parseChangePlan(JSON.stringify({ ...plan, effects: ["write-files"] }))).toThrow(
      /the plan is invalid/,
    );
  });

  it("refuses each kind of plan where the other is expected", () => {
    const plan = sealChangePlan(unsigned([kept("README.md", A, B)]));
    expect(() => parsePlan(JSON.stringify(plan))).toThrow(
      "this plan changes an existing project (update), not one that creates a project",
    );
    expect(() => parseChangePlan(JSON.stringify({ ...plan, operation: "init" }))).toThrow(
      "this plan creates a project; apply it with liftoff init --plan",
    );
  });

  it.each([
    ["/etc/passwd", "is not a repository-relative path"],
    ["C:/Windows/x", "is not a repository-relative path"],
    ["a\\b", "is not a repository-relative path"],
    ["a/../b", "is not a repository-relative path"],
    ["a//b", "is not a repository-relative path"],
    ["", "is not a repository-relative path"],
    [".git/config", "is inside a .git directory"],
    [".GIT/hooks/pre-commit", "is inside a .git directory"],
    ["vendor/lib/.git/config", "is inside a .git directory"],
    [".g\u0131t/config", "is inside a .git directory"],
    [".git\u200c/hooks/pre-commit", "has an invisible character macOS leaves out"],
    ["vendor/.g\u200cit/config", "has an invisible character macOS leaves out"],
    ["src/\ufeffREADME.md", "has an invisible character macOS leaves out"],
    ["conin$", "has a name Windows would read as another file"],
    ["logs/CONOUT$.txt", "has a name Windows would read as another file"],
    ["nul .txt", "has a name Windows would read as another file"],
    ["src/a\u0000b", "has a character Git or Windows cannot hold"],
    ["src/a|b", "has a character Git or Windows cannot hold"],
    ["services/COM\u00b9", "has a name Windows would read as another file"],
    [".liftoff/change-journal.json", "is not a file a change may touch"],
    ["GIT~1/config", "has a name Windows would read as another file"],
    [".git./config", "has a name Windows would read as another file"],
    ["src/a.txt ", "has a name Windows would read as another file"],
    ["README.md:secret", "has a name Windows would read as another file"],
    ["nul.txt", "has a name Windows would read as another file"],
    ["src/CON", "has a name Windows would read as another file"],
  ])("refuses the path %j", (path, problem) => {
    expect(() => sealChangePlan(unsigned([kept(path, A, B)]))).toThrow(problem);
  });

  it("refuses a path named twice, a change that changes nothing, and a missing owner", () => {
    expect(() =>
      sealChangePlan(unsigned([kept("README.md", A, B), kept("readme.md", null, A)])),
    ).toThrow("readme.md is listed twice");
    expect(() =>
      sealChangePlan(
        unsigned([kept("\u00e9t\u00e9.md", A, B), kept("e\u0301te\u0301.md", null, A)]),
      ),
    ).toThrow("is listed twice");
    expect(() =>
      sealChangePlan(unsigned([kept("\u03a3/file", A, B), kept("\u03c2/file", null, A)])),
    ).toThrow("is listed twice");
    expect(() =>
      sealChangePlan(unsigned([kept("stra\u00dfe/file", A, B), kept("STRA\u1e9eE/file", null, A)])),
    ).toThrow("is listed twice");
    expect(() => sealChangePlan(unsigned([kept("README.md", A, A)]))).toThrow("does not change");
    expect(() => sealChangePlan(unsigned([{ path: "README.md", before: A, after: B }]))).toThrow(
      "must say who owns it",
    );
    expect(() =>
      sealChangePlan(
        unsigned([
          { path: "gone", before: A, after: null, ownership: "managed", executable: false },
        ]),
      ),
    ).toThrow("must say who owns it");
    const plan = sealChangePlan(unsigned([kept("README.md", A, B)]));
    const doubled = { ...plan, changes: [...plan.changes, ...plan.changes] };
    const { hash: _hash, ...rest } = doubled;
    expect(() => parseChangePlan(JSON.stringify(sealUnchecked(rest)))).toThrow("listed twice");
  });
});

/** Seals without the plan's own checks, as an edited plan would be. */
const sealUnchecked = (plan: UnsignedChangePlan) => ({
  ...plan,
  hash: sha256Hex(canonicalJson(plan)),
});

describe("CHANGE-004 files change one at a time, the manifest last", () => {
  it("orders the project's files, then liftoff.yaml, then the manifest", () => {
    const order = orderChanges([
      { path: ".liftoff/manifest.json" },
      { path: "liftoff.yaml" },
      { path: "src/b.py" },
      { path: ".github/x.yml" },
    ]).map((change) => change.path);
    expect(order).toEqual([".github/x.yml", "src/b.py", "liftoff.yaml", ".liftoff/manifest.json"]);
    const plan = sealChangePlan(
      unsigned([kept(".liftoff/manifest.json", A, B), kept("a.txt", null, A)]),
    );
    expect(plan.changes.map((change) => change.path)).toEqual(["a.txt", ".liftoff/manifest.json"]);
  });
});

describe("CHANGE-003 a change that stops part way can be finished or undone", () => {
  const plan = sealChangePlan(
    unsigned([
      kept("changed.txt", A, B),
      kept("added.txt", null, A),
      { path: "removed.txt", before: A, after: null },
    ]),
  );
  const journal = journalFor(plan, ".demo.liftoff-staging-abc123", "2026-10-26T12:00:00Z");

  it("writes and reads a journal, refusing one that points outside the project", () => {
    expect(parseJournal(serializeJournal(journal))).toEqual(journal);
    for (const staging of ["../elsewhere", "/tmp/x", ".demo.liftoff-staging-a/b", "demo"]) {
      expect(() => parseJournal(JSON.stringify({ ...journal, staging }))).toThrow(JournalError);
    }
    const outside = { ...journal, changes: [{ path: "../x", before: A, after: B }] };
    expect(() => parseJournal(JSON.stringify(outside))).toThrow("not a repository-relative path");
    expect(() => parseJournal("nope")).toThrow("not valid JSON");
  });

  const file = (sha: string): FileNow => ({ kind: "file", sha256: sha });
  const absent: FileNow = { kind: "absent" };
  const steps = (now: Record<string, FileNow>, mode: "finish" | "undo") =>
    recoverySteps(journal, new Map(Object.entries(now)), mode).map(({ path, step }) => [
      path,
      step,
    ]);

  it("decides each file from what is there now", () => {
    // The change stopped after the first file.
    const stopped = { "changed.txt": file(B), "added.txt": absent, "removed.txt": file(A) };
    expect(steps(stopped, "finish")).toEqual([
      ["added.txt", "change"],
      ["changed.txt", "done"],
      ["removed.txt", "change"],
    ]);
    expect(steps(stopped, "undo")).toEqual([
      ["added.txt", "done"],
      ["changed.txt", "restore"],
      ["removed.txt", "done"],
    ]);
  });

  it("never takes a file something else changed for one to replace", () => {
    const edited = {
      "changed.txt": file(sha256Hex("edited")),
      "added.txt": file(sha256Hex("mine")),
      "removed.txt": { kind: "other" as const },
    };
    for (const mode of ["finish", "undo"] as const) {
      expect(steps(edited, mode).map(([, step]) => step)).toEqual([
        "conflict",
        "conflict",
        "conflict",
      ]);
    }
  });
});

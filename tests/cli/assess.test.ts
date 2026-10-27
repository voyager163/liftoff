import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { GitHubApiPort } from "../../src/application/ports.ts";
import type { ProjectAssessment } from "../../src/application/project/assess-project.ts";
import { makeAssessCommand, renderProjectAssessment } from "../../src/cli/commands/assess.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { runCli } from "../../src/cli/run.ts";
import {
  FakeGitHubApi,
  FakeGitHubError,
  type FakeRepository,
  fakeRepository,
} from "../helpers/fake-github-api.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { captureIo } from "../helpers/io.ts";

let work: string;
let repo: FakeRepository;
let github: GitHubApiPort;
beforeEach(async () => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-assess-cli-"));
  repo = fakeRepository();
  github = new FakeGitHubApi(repo);
  const init = makeInitCommand((cwd) => ({
    ...defaultProjectPorts(cwd),
    initializer: new FakeInitializer(),
  }));
  await runCli(
    ["init", "--name", "demo", "--workflow", "manual", "--agents", "claude", "--yes"],
    captureIo(work),
    [init],
    "1.0.0",
  );
  mkdirSync(path.join(work, "demo/.git"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const exec = async (argv: string[], options: { answer?: boolean; home?: string } = {}) => {
  const command = makeAssessCommand(
    () => ({ fs: new LocalProjectFs(), github }),
    options.home ?? path.join(work, "home"),
  );
  const io = captureIo(path.join(work, "demo"), options.answer);
  const code = await runCli(["assess", ...argv], io, [command], "1.0.0");
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

describe("ASSESS-004 the report and its exit code", () => {
  it("exits 0 for a project that meets the standard, with a versioned report", async () => {
    const { code, out } = await exec(["--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as Record<string, unknown> & ProjectAssessment;
    expect(report).toMatchObject({
      schema: "liftoff.assessment/v1",
      outcome: "success",
      standard: "1.0.0",
      git: true,
      liftoff: "project",
      workflows: ["manual"],
      agents: ["claude"],
    });
    expect(report.summary.compliant).toBe(report.findings.length);
    expect(report.gaps).toContainEqual(expect.objectContaining({ kind: "not-checked" }));
  });

  it("exits 3 and says what to do when something differs", async () => {
    rmSync(path.join(work, "demo/README.md"));
    const { code, out } = await exec([]);
    expect(code).toBe(3);
    expect(out).toContain("against Liftoff 1.0.0's standard");
    expect(out).toContain("A Git repository; a Liftoff project.");
    expect(out).toContain("Parts: backend python-fastapi at backend.");
    expect(out).toContain("  noncompliant docs.readme: no README.md");
    expect(out).toContain("Next:\n  project      Add a README.md. [docs.readme]");
    expect(out).toMatch(
      /\d+ compliant, 2 noncompliant, 0 unknown, 0 unsupported, 0 inaccessible\.\n$/,
    );
  });

  it("escapes what would change how a terminal shows a line", () => {
    const text = renderProjectAssessment(
      {
        directory: "/work/a\u001b[2Jb\u202ec",
        git: false,
        liftoff: "none",
        parts: [],
        workflows: ["manual"],
        agents: [],
        findings: [],
        gaps: Array.from({ length: 25 }, (_, index) => ({
          kind: "skipped" as const,
          path: `node_modules/${index}`,
          detail: "dependencies",
        })),
        next: [],
        summary: { compliant: 0, noncompliant: 0, unknown: 0, unsupported: 0, inaccessible: 0 },
        walked: { directories: 0, files: 0, read: 0 },
        limits: { entries: 1, directoryEntries: 1, depth: 1, reads: 1, bytes: 1 },
      },
      "1.0.0",
    );
    expect(text).toContain("/work/a\\u001b[2Jb\\u202ec");
    expect(text).toContain("Not the root of a Git repository; not a Liftoff project.");
    expect(text).toContain("Parts: none found.");
    expect(text).toContain("Agents: none.");
    expect(text).toContain("… and 5 more in the --json report");
  });
});

describe("ASSESS-001 what is assessed", () => {
  it("needs --dir for a directory that is not a Git repository, and refuses the home directory", async () => {
    rmSync(path.join(work, "demo/.git"), { recursive: true });
    const unnamed = await exec([]);
    expect(unnamed.code).toBe(2);
    expect(unnamed.err).toContain("is not the root of a Git repository; name it with --dir");
    const named = await exec(["--dir", ".", "--json"]);
    expect(JSON.parse(named.out)).toMatchObject({ git: false });
    const home = await exec(["--dir", "."], { home: path.join(work, "demo") });
    expect(home.code).toBe(2);
    expect(home.err).toContain("is not a project; assess a repository instead");
  });
});

describe("ASSESS-005 live assessment reads GitHub only when asked and allowed", () => {
  it("refuses GitHub options without --live", async () => {
    const { code, err } = await exec(["--repo", "octo/demo"]);
    expect(code).toBe(2);
    expect(err).toContain("--repo and --use-gh go with --live");
    expect((await exec(["--use-gh"])).code).toBe(2);
  });

  it("asks before reading GitHub, and reads nothing if refused", async () => {
    const fake = github as FakeGitHubApi;
    const refused = await exec(["--live"], { answer: false });
    expect(refused.questions).toEqual(["Use your GitHub CLI login to read octo/demo on GitHub?"]);
    expect(refused.code).toBe(2);
    expect(fake.calls).toEqual([]);
    const scripted = await exec(["--live"]);
    expect(scripted.err).toContain("pass --use-gh");
    expect(fake.calls).toEqual([]);
  });

  it("adds each governance checkpoint as a finding", async () => {
    const { code, out } = await exec(["--live", "--use-gh", "--json"]);
    expect(code).toBe(3);
    const report = JSON.parse(out) as ProjectAssessment;
    const github = report.findings.filter((finding) => finding.area === "github");
    expect(github.map((finding) => finding.check)).toContain("github.branches");
    expect(github[0]?.evidence).toEqual([{ path: "octo/demo", how: "github" }]);
    expect(report.gaps.map((gap) => gap.kind)).not.toContain("not-checked");
    expect(report.next).toContainEqual(
      expect.objectContaining({ category: "liftoff", command: "liftoff governance apply-next" }),
    );
  });

  it("reports a repository GitHub will not show as inaccessible, and still assesses the rest", async () => {
    const refusing: GitHubApiPort = Object.assign(Object.create(github) as GitHubApiPort, {
      get: async () => {
        throw new FakeGitHubError(404, "Not Found");
      },
    });
    github = refusing;
    const { code, out } = await exec(["--live", "--use-gh", "--repo", "octo/other", "--json"]);
    expect(code).toBe(3);
    const report = JSON.parse(out) as ProjectAssessment;
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        check: "github.repository",
        status: "inaccessible",
        message: "could not read octo/other on GitHub: HTTP 404: Not Found",
      }),
    );
    expect(report.findings.some((finding) => finding.check === "docs.readme")).toBe(true);
  });

  it("reports any other failure to read GitHub as unknown", async () => {
    writeFileSync(path.join(work, "demo/.github/rulesets/broken.json"), "{");
    const { out } = await exec(["--live", "--use-gh", "--json"]);
    const report = JSON.parse(out) as ProjectAssessment;
    expect(report.findings).toContainEqual(
      expect.objectContaining({ check: "github.repository", status: "unknown" }),
    );
  });
});

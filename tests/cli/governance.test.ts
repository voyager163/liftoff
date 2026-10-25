import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { CommandSpec } from "../../src/cli/command.ts";
import {
  makeGovernanceApplyNextCommand,
  makeGovernanceAssessCommand,
  makeGovernancePlanCommand,
  makeGovernanceResumeCommand,
  makeGovernanceStatusCommand,
  makeGovernanceVerifyCommand,
} from "../../src/cli/commands/governance.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { runCli } from "../../src/cli/run.ts";
import { FakeGitHubApi, type FakeRepository, fakeRepository } from "../helpers/fake-github-api.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { captureIo } from "../helpers/io.ts";

let work: string;
let repo: FakeRepository;
let github: FakeGitHubApi;
beforeEach(async () => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-governance-cli-"));
  repo = fakeRepository();
  github = new FakeGitHubApi(repo);
  const init = makeInitCommand((cwd) => ({
    ...defaultProjectPorts(cwd),
    initializer: new FakeInitializer(),
  }));
  const io = captureIo(work);
  await runCli(["init", "--name", "demo", "--workflow", "manual", "--yes"], io, [init], "1.0.0");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const ports = () => ({ fs: new LocalProjectFs(), github });
const REGISTRY: CommandSpec[] = [
  makeGovernanceStatusCommand(ports),
  makeGovernanceAssessCommand(ports),
  makeGovernancePlanCommand(ports),
  makeGovernanceApplyNextCommand(ports),
  makeGovernanceResumeCommand(ports),
  makeGovernanceVerifyCommand(ports),
];
const exec = async (argv: string[], answer?: boolean) => {
  const io = captureIo(work, answer);
  const code = await runCli(["governance", ...argv, "--dir", "demo"], io, REGISTRY, "1.0.0");
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

describe("GOV-001 reaching GitHub only with consent", () => {
  it("asks before using the GitHub CLI login, and reads nothing if refused", async () => {
    const refused = await exec(["assess"], false);
    expect(refused.questions).toEqual(["Use your GitHub CLI login to read octo/demo on GitHub?"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("GitHub was not read");
    expect(github.calls).toEqual([]);
    const scripted = await exec(["assess"]);
    expect(scripted.code).toBe(2);
    expect(scripted.err).toContain("pass --use-gh");
  });

  it("takes the repository from the origin remote, or --repo", async () => {
    const named = await exec(["assess", "--repo", "Bad Repo", "--use-gh"]);
    expect(named.err).toContain('--repo must be owner/name, not "Bad Repo"');
    delete repo.origin;
    const none = await exec(["assess", "--use-gh"]);
    expect(none.err).toContain("name the repository with --repo");
  });

  it("lists every checkpoint and the next step", async () => {
    const { code, out } = await exec(["assess", "--use-gh"]);
    expect(code).toBe(3);
    expect(out).toContain("Governance of octo/demo (repository 7)");
    expect(out).toContain("  done   1. The governance files in the project are valid");
    expect(out).toContain("  next   2. develop and main exist");
    expect(out).toContain("  later  5. The rulesets are applied and active");
    expect(out).toContain(
      "Next: create develop from main at 111111111111. liftoff governance apply-next does it after you agree.",
    );
    const json = JSON.parse((await exec(["assess", "--use-gh", "--json"])).out);
    expect(json).toMatchObject({ repository: "octo/demo", repositoryId: 7, ready: false });
  });
});

describe("GOV-002 the plan, and taking its next step", () => {
  it("saves a plan that apply-next then follows", async () => {
    const plan = await exec(["plan", "--use-gh", "--out", "governance.plan.json"]);
    expect(plan.code).toBe(3);
    expect(plan.out).toContain("Liftoff, with apply-next: create develop from main");
    expect(plan.out).toContain("you: push the generated files to develop");
    const saved = JSON.parse(readFileSync(path.join(work, "governance.plan.json"), "utf8"));
    expect(saved.next).toEqual({ kind: "create-develop", from: "1".repeat(40) });

    const applied = await exec([
      "apply-next",
      "--use-gh",
      "--plan",
      "governance.plan.json",
      "--yes",
    ]);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Done: create develop from main");
    // The plan's step is taken, so it no longer matches the repository.
    const stale = await exec(["apply-next", "--use-gh", "--plan", "governance.plan.json", "--yes"]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("make a new plan");
  });

  it("refuses a plan for another repository, by GitHub's id rather than its name", async () => {
    const plan = (repository: unknown) =>
      writeFileSync(
        path.join(work, "other.json"),
        JSON.stringify({
          schema: "liftoff.governance-plan/v1",
          repository,
          next: { kind: "create-develop", from: repo.branches.main },
        }),
      );
    const run = () => exec(["apply-next", "--use-gh", "--plan", "other.json", "--yes"]);
    // The same name for a repository that was replaced.
    plan({ id: 8, fullName: "octo/demo" });
    const replaced = await run();
    expect(replaced.code).toBe(1);
    expect(replaced.err).toContain("the plan is for repository 8, but octo/demo is repository 7");
    plan({ fullName: "octo/demo" });
    expect((await run()).err).toContain("is not a governance plan");
    expect(github.writes()).toEqual([]);
    // The same repository, its name spelled as GitHub spells it.
    plan({ id: 7, fullName: "Octo/Demo" });
    expect((await run()).code).toBe(0);
    expect(repo.branches.develop).toBe(repo.branches.main);
  });

  it("asks before each step, and changes nothing without a yes", async () => {
    const declined = await exec(["apply-next", "--use-gh"], false);
    expect(declined.code).toBe(4);
    expect(declined.questions).toEqual(["create develop from main at 111111111111 on octo/demo?"]);
    expect(github.writes()).toEqual([]);
    const scripted = await exec(["apply-next", "--use-gh"]);
    expect(scripted.code).toBe(2);
    expect(scripted.err).toContain("pass --yes");
  });

  it("says when the next step is the person's", async () => {
    repo.branches.develop = repo.branches.main ?? "";
    repo.defaultBranch = "develop";
    const { code, out } = await exec(["apply-next", "--use-gh", "--yes"]);
    expect(code).toBe(3);
    expect(out).toContain("The next step is yours: push the generated files to develop.");
  });
});

describe("GOV-003 status and resume", () => {
  it("shows what is recorded, and an interrupted step", async () => {
    expect((await exec(["status"])).out).toContain("Nothing is recorded yet.");
    await exec(["apply-next", "--use-gh", "--yes"]);
    const recorded = await exec(["status"]);
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain("  done  branches: create-develop");
    const file = path.join(work, "demo/.liftoff/governance.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.actions.push({ checkpoint: "branches", kind: "set-default-branch", startedAt: "x" });
    writeFileSync(file, JSON.stringify(state));
    const interrupted = await exec(["status"]);
    expect(interrupted.code).toBe(3);
    expect(interrupted.out).toContain("liftoff governance resume");
    const resumed = await exec(["resume", "--use-gh"]);
    expect(resumed.code).toBe(3);
    expect(resumed.out).toContain("The interrupted set-default-branch step did not happen");
    expect((await exec(["resume", "--use-gh"])).out).toContain("Nothing was interrupted.");
  });
});

describe("GOV-004 verify", () => {
  it("reads back, and proves only with agreement", async () => {
    const readback = await exec(["verify", "--use-gh"]);
    expect(readback.code).toBe(3);
    expect(readback.out).toContain("GitHub does not enforce the committed rulesets yet");
    const scripted = await exec(["verify", "--use-gh", "--prove"]);
    expect(scripted.code).toBe(2);
    expect(scripted.err).toContain("pass --yes");
    expect(existsSync(path.join(work, "demo/.liftoff/governance.json"))).toBe(false);
  });
});

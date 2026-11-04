import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { makeGovernanceProfileSetCommand } from "../../src/cli/commands/profile.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { makeRepairCommand } from "../../src/cli/commands/repair.ts";
import { makeUpdateCommand } from "../../src/cli/commands/update.ts";
import { makeValidateCommand } from "../../src/cli/commands/validate-doctor.ts";
import { runCli } from "../../src/cli/run.ts";
import { CHANGE_JOURNAL_FILE } from "../../src/domain/plan/change-plan.ts";
import { CONFIG_FILE, parseConfig } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE, parseManifest } from "../../src/domain/project/manifest.ts";
import { captureIo } from "../helpers/io.ts";
import { projectFiles } from "../helpers/older-project.ts";

let work: string;
const fs = new LocalProjectFs();
beforeEach(async () => {
  work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-profile-")));
  const io = captureIo(work);
  const argv = ["init", "--name", "demo", "--workflow", "manual", "--agents", "claude", "--yes"];
  expect(await runCli(argv, io, [makeInitCommand(ports())], "1.0.0")).toBe(0);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const root = () => path.join(work, "demo");
const { at, read, write, snapshot } = projectFiles(root);

function ports(port: ProjectFsPort = fs) {
  return (cwd: string) => ({ ...defaultProjectPorts(cwd), fs: port });
}

const liftoff = async (
  argv: string[],
  options: { answer?: boolean; port?: ProjectFsPort } = {},
) => {
  const io = captureIo(root(), options.answer);
  const commands = [
    makeGovernanceProfileSetCommand(ports(options.port)),
    makeValidateCommand(ports(options.port)),
    makeUpdateCommand(ports(options.port)),
    makeRepairCommand(ports(options.port)),
  ];
  const code = await runCli(argv, io, commands, "1.0.0");
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

const clean = async () => {
  expect((await liftoff(["validate"])).code).toBe(0);
  expect((await liftoff(["update", "--check"])).code).toBe(0);
  expect((await liftoff(["repair", "--check"])).code).toBe(0);
};

describe("PROFILE-001 switching the governance profile is a reviewed change of its own", () => {
  it("checks, asks with no as the default, and switches with --yes", async () => {
    const before = snapshot();
    const check = await liftoff(["governance", "profile", "set", "team-gitflow", "--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain(
      `Switch ${root()} from single-maintainer-gitflow to team-gitflow:\n`,
    );
    for (const file of [
      ".github/review-policy.yml",
      ".github/rulesets/develop.json",
      "GOVERNANCE.md",
      "liftoff.yaml",
    ]) {
      expect(check.out).toContain(`  rewrite ${file}\n`);
    }
    const declined = await liftoff(["governance", "profile", "set", "team-gitflow"], {
      answer: false,
    });
    expect(declined.code).toBe(4);
    expect(declined.questions).toEqual([`Switch ${root()} to team-gitflow?`]);
    expect((await liftoff(["governance", "profile", "set", "team-gitflow"])).code).toBe(2);
    expect(snapshot()).toEqual(before);

    const switched = await liftoff(["governance", "profile", "set", "team-gitflow", "--yes"]);
    expect(switched.code).toBe(0);
    expect(parseConfig(read(CONFIG_FILE)).governance).toBe("team-gitflow");
    const manifest = parseManifest(read(MANIFEST_FILE));
    expect(manifest.history.map((entry) => entry.operation)).toEqual(["init", "profile-set"]);
    expect(manifest.plugins.map((plugin) => plugin.id)).toContain("governance/team-gitflow");
    await clean();
    const same = await liftoff(["governance", "profile", "set", "team-gitflow"]);
    expect(same.out).toContain("already uses team-gitflow");
  });

  it("removes what none has no use for, and adds it back", async () => {
    const before = snapshot();
    const none = await liftoff(["governance", "profile", "set", "none", "--yes"]);
    expect(none.code).toBe(0);
    expect(existsSync(at(".github/workflows/20-release.yml"))).toBe(false);
    expect(existsSync(at(".github/rulesets/main.json"))).toBe(false);
    expect(existsSync(at("GOVERNANCE.md"))).toBe(false);
    await clean();
    const back = await liftoff([
      "governance",
      "profile",
      "set",
      "single-maintainer-gitflow",
      "--yes",
    ]);
    expect(back.code).toBe(0);
    await clean();
    // Byte for byte as init made it, but for the history the manifest keeps.
    const after = snapshot();
    for (const file of Object.keys(before).filter((name) => name !== MANIFEST_FILE)) {
      expect(after[file], file).toBe(before[file]);
    }
  });

  it("leaves files changed since Liftoff wrote them, and names each", async () => {
    write("GOVERNANCE.md", "# Our own rules\n");
    write(".github/workflows/20-release.yml", "name: ours\n");
    const run = await liftoff(["governance", "profile", "set", "none", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.err).toContain(
      "  left .github/workflows/20-release.yml: changed since Liftoff wrote it, and the new governance profile has none; it stays the project's own\n",
    );
    expect(read("GOVERNANCE.md")).toBe("# Our own rules\n");
    expect(read(".github/workflows/20-release.yml")).toBe("name: ours\n");
    const manifest = parseManifest(read(MANIFEST_FILE));
    expect(manifest.files.map((file) => file.path)).not.toContain(
      ".github/workflows/20-release.yml",
    );
    expect((await liftoff(["validate"])).code).toBe(0);
  });

  it("refuses what it cannot switch, changing nothing", async () => {
    const before = snapshot();
    const unknown = await liftoff(["governance", "profile", "set", "anarchy"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown governance profile "anarchy"');
    expect((await liftoff(["governance", "profile", "set"])).code).toBe(2);
    expect(snapshot()).toEqual(before);
    write(CONFIG_FILE, read(CONFIG_FILE).replace("single-maintainer-gitflow", "team-gitflow"));
    const edited = await liftoff(["governance", "profile", "set", "team-gitflow", "--yes"]);
    expect(edited.code).toBe(1);
    expect(edited.err).toContain("changed since Liftoff last wrote it");
  });

  it("stops part way recoverably, and undoes the switch", async () => {
    const before = snapshot();
    let moves = 0;
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        if (++moves === 2) throw new Error("no space left on the disk");
        return fs.moveFile(from, to);
      },
    });
    const stopped = await liftoff(["governance", "profile", "set", "none", "--yes"], {
      port: failing,
    });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("The profile switch stopped part way");
    expect(existsSync(at(CHANGE_JOURNAL_FILE))).toBe(true);
    expect(
      (await liftoff(["governance", "profile", "set", "--recover", "undo", "--yes"])).code,
    ).toBe(0);
    expect(snapshot()).toEqual(before);
  });
});

describe("PROFILE-002 switching the profile changes nothing on GitHub", () => {
  it("says GitHub stays as it is, and that fewer approvals leave its protection in place", async () => {
    const team = await liftoff(["governance", "profile", "set", "team-gitflow", "--yes"]);
    expect(team.out).toContain(
      "Nothing on GitHub changes: the rulesets already applied there stay as they are.",
    );
    expect(team.out).not.toContain("requires fewer approvals");
    const relaxed = await liftoff([
      "governance",
      "profile",
      "set",
      "single-maintainer-gitflow",
      "--check",
    ]);
    expect(relaxed.out).toContain(
      "single-maintainer-gitflow requires fewer approvals than team-gitflow; until the rulesets on GitHub are changed, they still require what team-gitflow does.",
    );
  });
});

describe("PROFILE-001 a round trip with files the person changed", () => {
  it("keeps them the project's own, so switching back and updating leave them be", async () => {
    write("GOVERNANCE.md", "# Our own rules\n");
    write(".github/workflows/20-release.yml", "name: ours\n");
    expect((await liftoff(["governance", "profile", "set", "none", "--yes"])).code).toBe(0);
    expect(parseManifest(read(MANIFEST_FILE)).kept).toEqual(
      expect.arrayContaining(["GOVERNANCE.md", ".github/workflows/20-release.yml"]),
    );
    expect(
      (await liftoff(["governance", "profile", "set", "single-maintainer-gitflow", "--yes"])).code,
    ).toBe(0);
    expect(read("GOVERNANCE.md")).toBe("# Our own rules\n");
    await clean();
  });

  it("warns that GitHub's protection stays when switching to none, even from no approvals", async () => {
    const none = await liftoff(["governance", "profile", "set", "none", "--check"]);
    expect(none.out).toContain(
      "remove them there, in the repository's rules settings, or they still protect the project as single-maintainer-gitflow does.",
    );
  });

  it("says nothing of a file that is neither Liftoff's nor there", async () => {
    write("GOVERNANCE.md", "# Our own rules\n");
    expect((await liftoff(["governance", "profile", "set", "none", "--yes"])).code).toBe(0);
    expect((await liftoff(["governance", "profile", "set", "team-gitflow", "--yes"])).code).toBe(0);
    rmSync(at("GOVERNANCE.md"));
    const check = await liftoff(["governance", "profile", "set", "none", "--check"]);
    expect(check.out).not.toContain("GOVERNANCE.md: something is already there");
  });
});

describe("PROFILE-001 what is left in place keeps working", () => {
  it("keeps a script that an edited workflow left in place still runs", async () => {
    write(".github/workflows/01-pr-ci.yml", `${read(".github/workflows/01-pr-ci.yml")}# ours\n`);
    write(
      ".github/workflows/20-release.yml",
      `${read(".github/workflows/20-release.yml")}# ours\n`,
    );
    const run = await liftoff(["governance", "profile", "set", "none", "--yes"]);
    expect(run.code).toBe(0);
    expect(existsSync(at(".github/liftoff/branch-policy.mjs"))).toBe(true);
    expect(existsSync(at(".github/liftoff/release.mjs"))).toBe(true);
    expect(run.err).toContain(
      "  left .github/liftoff/branch-policy.mjs: .github/workflows/01-pr-ci.yml, which is left as it is, still uses it, so it stays the project's own\n",
    );
    // A file nothing uses still goes.
    expect(existsSync(at(".github/workflows/90-governance-drift.yml"))).toBe(false);
    expect(parseManifest(read(MANIFEST_FILE)).kept).toContain(".github/liftoff/branch-policy.mjs");
    expect((await liftoff(["validate"])).code).toBe(0);
  });
});

describe("PROFILE-002 the notice, every time", () => {
  it("says GitHub may still differ when the profile is already set", async () => {
    expect((await liftoff(["governance", "profile", "set", "none", "--yes"])).code).toBe(0);
    const again = await liftoff(["governance", "profile", "set", "none"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already uses none; nothing in the project to change.");
    expect(again.out).toContain("Nothing on GitHub changes");
    expect(again.out).toContain("does not show those left on GitHub");
  });
});

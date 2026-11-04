import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { LocalProjectFs } from "../../src/adapters/project-fs.ts";
import { generate } from "../../src/application/init/generation.ts";
import type { ProjectFsPort } from "../../src/application/ports.ts";
import { makeAgentsAddCommand } from "../../src/cli/commands/agents.ts";
import { makeInitCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { makeUpdateCommand } from "../../src/cli/commands/update.ts";
import { makeValidateCommand } from "../../src/cli/commands/validate-doctor.ts";
import { runCli } from "../../src/cli/run.ts";
import { CHANGE_JOURNAL_FILE } from "../../src/domain/plan/change-plan.ts";
import { CONFIG_FILE, parseConfig, validateConfig } from "../../src/domain/project/config.ts";
import { MANIFEST_FILE, parseManifest } from "../../src/domain/project/manifest.ts";
import { pathKey } from "../../src/domain/project/paths.ts";
import type { InitializerStep } from "../../src/plugins/contracts/project-plugin.ts";
import { FakeInitializer, type FakeStep } from "../helpers/initializer.ts";
import { captureIo } from "../helpers/io.ts";
import { projectFiles } from "../helpers/older-project.ts";

let work: string;
const fs = new LocalProjectFs();
const REGISTRY = ".specify/integration.json";
/** What Spec Kit writes, here without downloading anything: its files, then each integration's. */
const specKit = (step: InitializerStep, directory: string): FakeStep => {
  const host = step.args.at(step.args[step.args.length - 1] === "--force" ? -2 : -1) ?? "";
  if (step.args.includes("init")) {
    return {
      files: {
        ".specify/memory/constitution.md": "# Constitution\n",
        [REGISTRY]: `{"default":"${host}","installed":["${host}"]}\n`,
        [`.${host}/speckit-plan.md`]: `plan for ${host}\n`,
      },
    };
  }
  const registry = JSON.parse(
    readdirSync(path.join(directory, ".specify")).includes("integration.json")
      ? readFileSync(path.join(directory, REGISTRY), "utf8")
      : "{}",
  ) as { default: string; installed: string[] };
  return {
    files: {
      [REGISTRY]: `{"default":"${registry.default}","installed":${JSON.stringify([...registry.installed, host])}}\n`,
      [`.${host}/speckit-plan.md`]: `plan for ${host}\n`,
    },
  };
};
/** What OpenSpec writes: its files, and a command for each tool it is given. */
const openSpec = (step: InitializerStep): FakeStep => {
  const tools = step.args[step.args.indexOf("--tools") + 1]?.split(",") ?? [];
  return {
    files: {
      "openspec/project.md": "# Project\n",
      ...Object.fromEntries(tools.map((tool) => [`.${tool}/opsx/propose.md`, `propose ${tool}\n`])),
    },
    directories: ["openspec/specs"],
  };
};
let initializer: FakeInitializer;
beforeEach(async () => {
  work = await realpath(mkdtempSync(path.join(tmpdir(), "liftoff-agents-")));
  initializer = new FakeInitializer((step, directory) =>
    step.command === "uvx" ? specKit(step, directory) : openSpec(step),
  );
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const root = () => path.join(work, "demo");
const { at, read, write, snapshot } = projectFiles(root);

const ports =
  (port: ProjectFsPort = fs) =>
  (cwd: string) => ({ ...defaultProjectPorts(cwd), fs: port, initializer });

async function init(workflow: string, agents = "claude"): Promise<void> {
  const io = captureIo(work);
  const argv = ["init", "--name", "demo", "--workflow", workflow, "--agents", agents, "--yes"];
  expect(await runCli(argv, io, [makeInitCommand(ports())], "1.0.0")).toBe(0);
}

const agentsAdd = async (
  argv: string[],
  options: { answer?: boolean; port?: ProjectFsPort } = {},
) => {
  const io = captureIo(root(), options.answer);
  const commands = [
    makeAgentsAddCommand(ports(options.port)),
    makeValidateCommand(ports(options.port)),
    makeUpdateCommand(ports(options.port)),
  ];
  const code = await runCli(argv, io, commands, "1.0.0");
  return { code, out: io.out.join(""), err: io.err.join(""), questions: io.questions };
};

const manifest = () => parseManifest(read(MANIFEST_FILE));
const under = (files: Record<string, string>, prefix: string) =>
  Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith(prefix)));

describe("AGENT-001 adding a coding agent is additive, as a reviewed change of its own", () => {
  it("checks, asks with no as the default, and adds with --yes, touching nothing else", async () => {
    await init("manual");
    write(".cursor/rules/team.md", "# Our rules\n");
    const before = snapshot();
    const check = await agentsAdd(["agents", "add", "codex", "--check"]);
    expect(check.code).toBe(0);
    expect(check.out).toContain(`Add codex to ${root()}, beside claude:\n`);
    expect(check.out).toContain("  add .agents/skills/liftoff-code-review/SKILL.md\n");
    expect(check.out).toContain("  rewrite liftoff.yaml\n");
    expect(check.out).not.toContain("  remove ");
    const declined = await agentsAdd(["agents", "add", "codex"], { answer: false });
    expect(declined.code).toBe(4);
    expect(declined.questions).toEqual([`Add codex to ${root()}?`]);
    expect((await agentsAdd(["agents", "add", "codex"])).code).toBe(2);
    expect(snapshot()).toEqual(before);

    const added = await agentsAdd(["agents", "add", "codex", "--yes", "--json"]);
    expect(added.code).toBe(0);
    const report = JSON.parse(added.out) as Record<string, unknown>;
    expect(report).toMatchObject({ from: ["claude"], to: ["claude", "codex"], added: ["codex"] });
    expect(parseConfig(read(CONFIG_FILE)).agents).toEqual(["claude", "codex"]);
    const after = snapshot();
    // Every file it had stays, and only Liftoff's own are written.
    expect(read(".cursor/rules/team.md")).toBe("# Our rules\n");
    expect(after[".cursor/rules/team.md"]).toBe(before[".cursor/rules/team.md"]);
    expect(under(after, ".claude/")).toEqual(under(before, ".claude/"));
    for (const file of Object.keys(before)) expect(after, file).toHaveProperty([file]);
    expect(after).toHaveProperty([".agents/skills/liftoff-code-review/SKILL.md"]);
    expect(manifest().history.map((entry) => entry.operation)).toEqual(["init", "agents-add"]);
    expect(initializer.runs).toEqual([]);
    // The project is as this release makes one with both agents.
    expect((await agentsAdd(["validate"])).code).toBe(0);
    expect((await agentsAdd(["update", "--check"])).code).toBe(0);
    const same = await agentsAdd(["agents", "add", "claude,codex", "--json"]);
    expect(same.code).toBe(0);
    expect(JSON.parse(same.out)).toMatchObject({ changed: false, to: ["claude", "codex"] });
    expect((await agentsAdd(["agents", "add", "codex"])).out).toContain("already has codex");
  });

  it("adds several at once, after those the project has, and leaves a file changed since Liftoff wrote it", async () => {
    await init("manual", "codex");
    write("REVIEW.md", "# Our review rules\n");
    write(".github/workflows/04-ai-review.yml", "# ours\n");
    const run = await agentsAdd(["agents", "add", "claude, copilot", "--yes"]);
    expect(run.code).toBe(0);
    expect(parseConfig(read(CONFIG_FILE)).agents).toEqual(["codex", "claude", "copilot"]);
    expect(run.err).toContain(
      "  left .github/workflows/04-ai-review.yml: changed since Liftoff wrote it, so it still describes codex; bring it up to date by hand\n",
    );
    expect(read(".github/workflows/04-ai-review.yml")).toBe("# ours\n");
    expect(read("REVIEW.md")).toBe("# Our review rules\n");
  });

  it("moves a Copilot-only project's skills to the new agent's directory, which Copilot reads too", async () => {
    await init("manual", "copilot");
    write(".github/skills/liftoff-pr/SKILL.md", "# Our PR skill\n");
    const run = await agentsAdd(["agents", "add", "codex", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.err).toContain("  remove .github/skills/liftoff-verify/SKILL.md\n");
    expect(run.err).toContain("  add .agents/skills/liftoff-verify/SKILL.md\n");
    expect(run.err).toContain(
      "  left .github/skills/liftoff-pr/SKILL.md: changed since Liftoff wrote it, and the new coding agents have none; it stays the project's own\n",
    );
    expect(existsSync(at(".github/skills/liftoff-verify/SKILL.md"))).toBe(false);
    expect(read(".github/skills/liftoff-pr/SKILL.md")).toBe("# Our PR skill\n");
    expect(manifest().kept).toContain(".github/skills/liftoff-pr/SKILL.md");
    expect((await agentsAdd(["validate"])).code).toBe(0);
  });

  it("refuses what it cannot add, changing nothing", async () => {
    await init("manual");
    const before = snapshot();
    const unknown = await agentsAdd(["agents", "add", "cursor"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown agent "cursor"; available: copilot, codex, claude');
    expect((await agentsAdd(["agents", "add", ","])).code).toBe(2);
    expect((await agentsAdd(["agents", "add"])).err).toContain("name the agents to add");
    expect((await agentsAdd(["agents", "add", "codex", "--check", "--yes"])).code).toBe(2);
    expect((await agentsAdd(["agents", "add", "codex", "--recover", "undo"])).code).toBe(2);
    write(CONFIG_FILE, `${read(CONFIG_FILE)}# edited\n`);
    const edited = await agentsAdd(["agents", "add", "codex", "--yes"]);
    expect(edited.code).toBe(1);
    expect(edited.err).toContain(
      "liftoff.yaml changed since Liftoff last wrote it, and the coding agents are changed only from a configuration Liftoff wrote",
    );
    const after = snapshot();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it("stops part way recoverably, and undoes the addition", async () => {
    await init("manual");
    const before = snapshot();
    let moves = 0;
    const failing = Object.assign(Object.create(fs) as ProjectFsPort, {
      moveFile: async (from: string, to: string) => {
        if (++moves === 2) throw new Error("no space left on the disk");
        return fs.moveFile(from, to);
      },
    });
    const stopped = await agentsAdd(["agents", "add", "copilot", "--yes"], { port: failing });
    expect(stopped.code).toBe(5);
    expect(stopped.out).toContain("The agent addition stopped part way");
    expect(existsSync(at(CHANGE_JOURNAL_FILE))).toBe(true);
    const undone = await agentsAdd(["agents", "add", "--recover", "undo", "--yes"]);
    expect(undone.code).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("never removes a file this release writes, whichever agents are added", async () => {
    const assets = new PackageAssets(
      path.resolve(import.meta.dirname, "../../assets"),
      path.resolve(import.meta.dirname, "../../.github/liftoff"),
    );
    const config = (agents: string[], workflow: string) =>
      validateConfig({
        schema: "liftoff.config/v1",
        name: "demo",
        workload: "api",
        stack: "python-fastapi",
        pattern: "none",
        frontend: "none",
        infrastructure: "none",
        environments: [],
        workflow,
        governance: "single-maintainer-gitflow",
        review: { ai: agents.length > 0 },
        owners: [],
        layout: {},
        agents,
      });
    const files = async (agents: string[], workflow: string) =>
      (await generate(assets, config(agents, workflow), "1.0.0")).files.map((file) =>
        pathKey(file.path),
      );
    const hosts = ["copilot", "codex", "claude"];
    for (const workflow of ["manual", "openspec"]) {
      for (const first of [[], ...hosts.map((host) => [host])]) {
        const had = await files(first, workflow);
        for (const host of hosts.filter((host) => !first.includes(host))) {
          const now = new Set(await files([...first, host], workflow));
          // Only a Copilot-only project's skills move, to the new agent's
          // directory, which Copilot reads too.
          const moved = had.filter((file) => !now.has(file));
          const skills = moved.filter((file) => file.startsWith(".github/skills/"));
          expect(moved, `${first} + ${host}`).toEqual(first[0] === "copilot" ? skills : []);
          const to = host === "codex" ? ".agents/skills/" : ".claude/skills/";
          for (const file of skills) expect(now).toContain(file.replace(".github/skills/", to));
        }
      }
    }
  });
});

describe("AGENT-002 in a framework's project, the framework sets the new agent up itself", () => {
  it("runs Spec Kit's integration install on a copy of its files, keeping its default", async () => {
    await init("spec-kit");
    const before = snapshot();
    const check = await agentsAdd(["agents", "add", "copilot", "--check"]);
    expect(check.out).toContain("Once approved, it runs Spec Kit 1.2.1's own command");
    expect(check.out).toContain(" integration install copilot --force\n");
    expect(initializer.runs).toHaveLength(1);
    const declined = await agentsAdd(["agents", "add", "copilot"], { answer: false });
    expect(declined.questions).toEqual([
      `Add copilot to ${root()}, running and downloading Spec Kit's command first?`,
    ]);
    expect(snapshot()).toEqual(before);

    const run = await agentsAdd(["agents", "add", "copilot", "--yes"]);
    expect(run.code).toBe(0);
    const [, install] = initializer.runs;
    expect(install?.step.args.slice(-3)).toEqual(["install", "copilot", "--force"]);
    expect(install?.step.args).not.toContain("init");
    // On a copy, apart from the project, and gone afterwards.
    expect(path.dirname(install?.directory ?? "")).toBe(work);
    expect(readdirSync(work)).toEqual(["demo"]);
    expect(JSON.parse(read(REGISTRY))).toEqual({
      default: "claude",
      installed: ["claude", "copilot"],
    });
    expect(read(".copilot/speckit-plan.md")).toBe("plan for copilot\n");
    expect(read(".claude/speckit-plan.md")).toBe("plan for claude\n");
    const framework = manifest()
      .files.filter((file) => file.ownership === "framework")
      .map((file) => file.path);
    expect(framework).toContain(".copilot/speckit-plan.md");
    expect(parseConfig(read(CONFIG_FILE)).agents).toEqual(["claude", "copilot"]);
    expect((await agentsAdd(["validate"])).code).toBe(0);
  });

  it("runs OpenSpec's initializer again with every agent, and makes its empty directories", async () => {
    await init("openspec");
    rmSync(at("openspec/specs"), { recursive: true });
    const run = await agentsAdd(["agents", "add", "codex", "--yes"]);
    expect(run.code).toBe(0);
    const [, again] = initializer.runs;
    expect(again?.step.args).toContain("claude,codex");
    expect(read(".codex/opsx/propose.md")).toBe("propose codex\n");
    expect(statSync(at("openspec/specs")).isDirectory()).toBe(true);
  });

  it("changes nothing when the framework's command rewrites a file changed since it wrote it", async () => {
    await init("spec-kit");
    write(REGISTRY, '{"default":"claude","installed":["claude"],"ours":true}\n');
    const before = snapshot();
    const run = await agentsAdd(["agents", "add", "codex", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain(
      `Spec Kit's command rewrites ${REGISTRY}, which changed since Spec Kit wrote it, so nothing was changed`,
    );
    expect(snapshot()).toEqual(before);
    expect(readdirSync(work)).toEqual(["demo"]);
  });

  it("changes nothing when something is where the framework adds a file, or it removes one", async () => {
    await init("spec-kit");
    write(".codex/speckit-plan.md", "ours\n");
    const before = snapshot();
    const collision = await agentsAdd(["agents", "add", "codex", "--yes"]);
    expect(collision.code).toBe(1);
    expect(collision.err).toContain(
      "Spec Kit's initializer writes .codex/speckit-plan.md, where the project already has something",
    );
    expect(snapshot()).toEqual(before);
    initializer = new FakeInitializer((_step, directory) => {
      rmSync(path.join(directory, ".specify/memory/constitution.md"));
      return {};
    });
    const removing = await agentsAdd(["agents", "add", "codex", "--yes"]);
    expect(removing.code).toBe(1);
    expect(removing.err).toContain(
      "Spec Kit's command removed .specify/memory/constitution.md, and adding an agent removes nothing",
    );
    expect(snapshot()).toEqual(before);
  });

  it("does not add back a framework file the project no longer has, and says so", async () => {
    await init("spec-kit");
    rmSync(at(".specify/memory/constitution.md"));
    initializer = new FakeInitializer((step, directory) => {
      const result = specKit(step, directory);
      return {
        files: { ...result.files, ".specify/memory/constitution.md": "# Constitution\n" },
      };
    });
    const run = await agentsAdd(["agents", "add", "codex", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(
      "Not added back: .specify/memory/constitution.md, Spec Kit's file the project no longer has.",
    );
    expect(existsSync(at(".specify/memory/constitution.md"))).toBe(false);
  });

  it("keeps whether a file it adds runs, and refuses one that is not UTF-8 text", async () => {
    await init("spec-kit");
    initializer = new FakeInitializer((step, directory) => {
      const result = specKit(step, directory);
      const script = path.join(directory, ".specify/scripts/check.py");
      mkdirSync(path.dirname(script), { recursive: true });
      writeFileSync(script, "print('ok')\n");
      chmodSync(script, 0o755);
      return result;
    });
    expect((await agentsAdd(["agents", "add", "codex", "--yes"])).code).toBe(0);
    if (process.platform !== "win32") {
      expect(statSync(at(".specify/scripts/check.py")).mode & 0o111).not.toBe(0);
    }
    const before = snapshot();
    initializer = new FakeInitializer((_step, directory) => {
      writeFileSync(path.join(directory, "logo.bin"), Buffer.from([0xff, 0xfe, 0x00]));
      return {};
    });
    const binary = await agentsAdd(["agents", "add", "copilot", "--yes"]);
    expect(binary.code).toBe(1);
    expect(binary.err).toContain("logo.bin, which is not UTF-8 text");
    expect(snapshot()).toEqual(before);
  });
});

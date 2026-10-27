import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { agentFilesFor, loadAgentSources } from "../../src/application/agents/agent-files.ts";
import { commandName } from "../../src/cli/command.ts";
import { REGISTRY } from "../../src/cli/registry.ts";
import {
  parseAgent,
  parseSkill,
  renderAgentIntegration,
  SkillSourceError,
  skillDirectoriesFor,
} from "../../src/generators/skills.ts";
import { AGENT_HOSTS, codexHost } from "../../src/plugins/builtin/agents/hosts.ts";
import type { AgentHostId } from "../../src/plugins/contracts/agent-host.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const assets = new PackageAssets(path.join(repoRoot, "assets"));

const skillText = (name = "demo", extra = "") =>
  `---\nname: ${name}\ndescription: Does a thing.${extra}\n---\n\nBody\n<!-- include: shared -->\n`;

describe("SKILL-001 canonical skill sources", () => {
  it("parses a skill and expands includes", () => {
    const skill = parseSkill("demo", skillText(), { shared: "Shared text\n" });
    expect(skill).toEqual({
      name: "demo",
      description: "Does a thing.",
      body: "Body\nShared text",
    });
  });

  it.each([
    ["no frontmatter", "demo", "# just markdown\n", "missing YAML frontmatter"],
    ["a list as frontmatter", "demo", "---\n- a\n---\nx", "must be a mapping"],
    ["a mismatched name", "other", skillText("demo"), 'must match "other"'],
    ["a bad name", "Bad_Name", skillText("Bad_Name"), "lowercase words"],
    ["unknown keys", "demo", skillText("demo", "\nlicense: MIT"), "unknown frontmatter license"],
    ["an empty description", "demo", "---\nname: demo\ndescription: ''\n---\nx", "1 to 1024"],
    ["an unknown include", "demo", skillText(), 'unknown include "shared"'],
  ])("rejects %s", (_label, directory, text, message) => {
    expect(() => parseSkill(directory, text)).toThrow(message);
  });

  it("accepts Windows line endings", () => {
    const skill = parseSkill("demo", skillText().replace(/\n/g, "\r\n"), { shared: "S" });
    expect(skill.body).toContain("Body");
  });

  it("parses and validates agents", () => {
    const agent = parseAgent(
      "checker",
      "---\nname: checker\ndescription: Checks.\ncapabilities: [read, search]\n---\nDo it.\n",
    );
    expect(agent).toEqual({
      name: "checker",
      description: "Checks.",
      capabilities: ["read", "search"],
      instructions: "Do it.",
    });
    expect(() =>
      parseAgent("checker", "---\nname: checker\ndescription: x\ncapabilities: [write]\n---\n"),
    ).toThrow(/capabilities must list/);
    expect(() => parseAgent("checker", "---\nname: checker\ndescription: x\n---\n")).toThrow(
      SkillSourceError,
    );
  });
});

describe("SKILL-002 skill placement per host combination", () => {
  it.each<[AgentHostId[], string[]]>([
    [["copilot"], [".github/skills"]],
    [["codex"], [".agents/skills"]],
    [["claude"], [".claude/skills"]],
    [["copilot", "codex"], [".agents/skills"]],
    [["copilot", "claude"], [".claude/skills"]],
    [
      ["codex", "claude"],
      [".agents/skills", ".claude/skills"],
    ],
    [
      ["copilot", "codex", "claude"],
      [".agents/skills", ".claude/skills"],
    ],
    [[], []],
  ])("%j reads skills from %j", (hosts, expected) => {
    expect(skillDirectoriesFor(hosts)).toEqual(expected);
    // Every selected host can read at least one chosen directory.
    for (const host of hosts) {
      expect(AGENT_HOSTS[host].skillDirectories.some((dir) => expected.includes(dir))).toBe(true);
    }
  });

  it("writes each skill once per directory and agents once per host, sorted", async () => {
    const files = await agentFilesFor(assets, ["claude", "copilot", "codex", "claude"]);
    const paths = files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => p.endsWith("/SKILL.md"))).toHaveLength(16);
    expect(paths).toContain(".codex/agents/liftoff-verifier.toml");
    expect(paths).toContain(".github/agents/liftoff-verifier.agent.md");
    expect(paths).toContain(".claude/agents/liftoff-verifier.md");
  });

  it("rejects two sources that render to the same path", () => {
    const skill = { name: "same", description: "d", body: "b" };
    expect(() =>
      renderAgentIntegration({ hosts: ["claude"], skills: [skill, skill], agents: [] }),
    ).toThrow(/share the path/);
  });
});

describe("SKILL-003 verifier agents are read-only in every host", () => {
  it("renders host-native agent files", async () => {
    const files = await agentFilesFor(assets, ["claude", "copilot", "codex"]);
    const content = (p: string) => files.find((file) => file.path === p)?.content ?? "";
    expect(content(".claude/agents/liftoff-verifier.md")).toContain(
      "tools: Read, Grep, Glob, Bash\ndisallowedTools: Edit, Write, NotebookEdit",
    );
    expect(content(".github/agents/liftoff-verifier.agent.md")).toContain(
      'tools: ["read", "search", "execute"]',
    );
    const toml = content(".codex/agents/liftoff-verifier.toml");
    expect(toml).toContain('sandbox_mode = "read-only"');
    expect(toml).toMatch(/developer_instructions = '''\nYou verify one candidate/);
  });

  it("refuses instructions that would break the TOML string", () => {
    expect(() =>
      codexHost.renderAgent({
        name: "x",
        description: "d",
        capabilities: ["read"],
        instructions: "a ''' b",
      }),
    ).toThrow(/cannot contain/);
  });
});

describe("SKILL-004 the shipped skills cover the review model", () => {
  it("ships exactly the eight review skills and the verifier", async () => {
    const sources = await loadAgentSources(assets);
    expect(sources.skills.map((s) => s.name)).toEqual([
      "liftoff-address-review",
      "liftoff-code-review",
      "liftoff-pr",
      "liftoff-review-eval",
      "liftoff-risk",
      "liftoff-security-review",
      "liftoff-simplify",
      "liftoff-verify",
    ]);
    expect(sources.agents.map((a) => a.name)).toEqual(["liftoff-verifier"]);
    for (const skill of sources.skills) expect(skill.body).not.toContain("<!-- include:");
  });

  it("encodes the article's rules in the code review skill", async () => {
    const { skills } = await loadAgentSources(assets);
    const review = skills.find((s) => s.name === "liftoff-code-review")?.body ?? "";
    for (const rule of [
      "Important",
      "Nit",
      "Pre-existing",
      "Start with the count",
      "three rounds",
      "fresh context",
    ]) {
      expect(review).toContain(rule);
    }
  });
});

describe("SKILL-005 skills only mention real commands", () => {
  it("every liftoff command in a skill is registered", async () => {
    const { skills } = await loadAgentSources(assets, { projectSkills: true });
    const known = new Set(REGISTRY.map(commandName));
    const mentioned = new Set<string>();
    for (const skill of skills) {
      for (const match of skill.body.matchAll(/`liftoff ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)) {
        const words = (match[1] ?? "").split(" ");
        const name = known.has(words.join(" ")) ? words.join(" ") : (words[0] ?? "");
        mentioned.add(name);
      }
    }
    expect([...mentioned].filter((name) => !known.has(name))).toEqual([]);
    expect(mentioned).toContain("review classify");
    expect(mentioned).toContain("doctor");
    expect(mentioned).toContain("validate");
    expect(mentioned).toContain("assess");
    expect(mentioned).toContain("governance apply-next");
  });

  it("every skill that calls Liftoff negotiates capabilities first", async () => {
    const { skills } = await loadAgentSources(assets, { projectSkills: true });
    for (const skill of skills.filter((s) => s.body.includes("`liftoff "))) {
      expect(skill.body, skill.name).toContain("liftoff capabilities --json");
    }
  });
});

describe("SKILL-007 skills to assess a project and its governance", () => {
  it("ships them to generated projects only, and they change nothing", async () => {
    const own = (await loadAgentSources(assets)).skills.map((skill) => skill.name);
    expect(own).not.toContain("liftoff-assess");
    const { skills } = await loadAgentSources(assets, { projectSkills: true });
    const body = (name: string) => skills.find((skill) => skill.name === name)?.body ?? "";
    expect(skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["liftoff-assess", "liftoff-governance-assess", "liftoff-setup"]),
    );
    expect(body("liftoff-assess")).toContain("liftoff assess --json");
    expect(body("liftoff-assess")).toContain("without changing anything");
    expect(body("liftoff-assess")).toContain("Never call an unknown");
    expect(body("liftoff-governance-assess")).toContain("liftoff governance assess --json");
    expect(body("liftoff-governance-assess")).toContain("Do not run it on");
    for (const name of ["liftoff-assess", "liftoff-governance-assess"]) {
      expect(body(name)).toContain("liftoff capabilities --json");
      expect(body(name)).not.toContain("<!-- include:");
    }
  });
});

describe("SKILL-008 a skill to repair a project with the person's approval", () => {
  it("ships to generated projects, and leaves every change to liftoff repair and the person", async () => {
    const own = (await loadAgentSources(assets)).skills.map((skill) => skill.name);
    expect(own).not.toContain("liftoff-repair");
    const { skills } = await loadAgentSources(assets, { projectSkills: true });
    const body = skills.find((skill) => skill.name === "liftoff-repair")?.body ?? "";
    for (const text of [
      "liftoff repair --check --json",
      "liftoff repair --restore <paths>",
      "liftoff repair --patch <diff> --paths <paths>",
      "never in the project itself",
      "git diff --no-renames",
      "Never edit, create or delete a file in the project yourself",
      "never answer Liftoff's question for the person",
      "liftoff capabilities --json",
    ]) {
      expect(body).toContain(text);
    }
    expect(body).not.toContain("<!-- include:");
  });
});

describe("SKILL-006 Liftoff's own rendered skills are current", () => {
  it("passes the drift check", () => {
    const output = execFileSync(process.execPath, ["scripts/render-own-files.ts", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(output).toContain("are up to date");
  });
});

describe("assets stay inside the asset root", () => {
  it("refuses escaping paths", async () => {
    await expect(assets.readText("../package.json")).rejects.toThrow(/escapes the asset root/);
    await expect(assets.list("../")).rejects.toThrow(/escapes the asset root/);
  });
});

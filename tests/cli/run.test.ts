import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../../src/cli/command.ts";
import { capabilitiesCommand } from "../../src/cli/commands/capabilities.ts";
import { makeReviewClassifyCommand } from "../../src/cli/commands/review-classify.ts";
import { renderCommandHelp } from "../../src/cli/help.ts";
import { UnsupportedError } from "../../src/cli/outcome.ts";
import { REGISTRY } from "../../src/cli/registry.ts";
import { runCli } from "../../src/cli/run.ts";
import { captureIo } from "../helpers/io.ts";

const POLICY = `
version: 1
profile: team-gitflow
trusted_authors: [alice]
rules:
  - paths: ["docs/**"]
    tier: low
    reason: docs
`;

const fakeReview = (
  files = [{ path: "docs/a.md", additions: 2, deletions: 1 }],
  basePolicy: string | undefined = POLICY,
) =>
  makeReviewClassifyCommand(() => ({
    git: {
      resolveCommit: async (ref) =>
        ref === "HEAD" || ref === "origin/develop" ? `${ref}-sha` : undefined,
      mergeBase: async () => "merge-sha",
      changedFiles: async () => files,
      showFile: async () => basePolicy,
    },
    workspace: { readText: async () => POLICY },
  }));

const registry = (...extra: CommandSpec[]): CommandSpec[] => [
  capabilitiesCommand,
  fakeReview(),
  ...extra,
];

const exec = async (argv: string[], commands: CommandSpec[] = registry()) => {
  const io = captureIo();
  const code = await runCli(argv, io, commands, "1.2.3");
  return { code, out: io.out.join(""), err: io.err.join(""), io };
};

describe("CLI-001 one registry drives every command", () => {
  it("prints root help with every registered command", async () => {
    const { code, out } = await exec([]);
    expect(code).toBe(0);
    expect(out).toContain("Liftoff 1.2.3");
    expect(out).toContain("capabilities");
    expect(out).toContain("review classify");
    expect((await exec(["--help"])).out).toBe(out);
    expect((await exec(["help"])).out).toBe(out);
  });

  it("registers the real commands", () => {
    expect(REGISTRY.map((spec) => spec.path.join(" "))).toEqual([
      "capabilities",
      "plan",
      "init",
      "validate",
      "doctor",
      "assess",
      "update",
      "repair",
      "review classify",
      "governance status",
      "governance assess",
      "governance plan",
      "governance apply-next",
      "governance resume",
      "governance verify",
    ]);
  });

  it("shows command help through --help and the help command", async () => {
    const viaFlag = await exec(["review", "classify", "--help"]);
    const viaCommand = await exec(["help", "review", "classify"]);
    expect(viaFlag.code).toBe(0);
    expect(viaFlag.out).toBe(viaCommand.out);
    expect(viaFlag.out).toContain("--base <branch>");
    expect(viaFlag.out).toContain("default: develop");
    expect(viaFlag.out).toContain("This command is read-only.");
  });

  it("shows group help", async () => {
    const asked = await exec(["review", "--help"]);
    expect(asked.code).toBe(0);
    expect(asked.out).toContain("review classify");
    const bare = await exec(["review"]);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("review classify");
    expect((await exec(["help", "review"])).out).toContain("review classify");
  });

  it("documents choices and examples", () => {
    const spec: CommandSpec = {
      ...capabilitiesCommand,
      options: {
        mode: { type: "string", valueName: "mode", description: "Mode.", choices: ["a", "b"] },
        all: { type: "boolean", short: "a", description: "All." },
      },
      positionals: [{ name: "path", description: "Where." }],
    };
    const help = renderCommandHelp(spec);
    expect(help).toContain("--mode <mode>");
    expect(help).toContain("one of: a, b");
    expect(help).toContain("-a, --all");
    expect(help).toContain("Arguments:");
    expect(help).toContain("liftoff capabilities --json");
  });
});

describe("CLI-002 strict arguments and exit codes", () => {
  it("prints the version", async () => {
    expect(await exec(["--version"])).toMatchObject({ code: 0, out: "1.2.3\n" });
    const json = await exec(["--version", "--json"]);
    expect(JSON.parse(json.out)).toEqual({ schema: "liftoff.version/v1", version: "1.2.3" });
    expect((await exec(["--version", "extra"])).code).toBe(2);
  });

  it.each([
    [["review", "classify", "--bogus"], "unknown option '--bogus'"],
    [["review", "classify", "stray"], "unexpected argument"],
    [["review", "classify", "--base"], "argument missing"],
    [["review", "classify", "--base", ""], "--base needs a value"],
    [["revew", "classify"], 'did you mean "review classify"'],
    [["review", "clasify"], 'unknown command "review clasify"'],
    [["--frobnicate"], 'unknown option "--frobnicate"'],
    [["help", "review", "classify", "--x"], "help takes only a command name"],
  ])("rejects %j with exit 2", async (argv, message) => {
    const { code, err } = await exec(argv);
    expect(code).toBe(2);
    expect(err).toContain(message);
  });

  it("rejects an option given twice and a value outside its choices", async () => {
    const spec: CommandSpec = {
      ...capabilitiesCommand,
      path: ["pick"],
      options: { mode: { type: "string", valueName: "m", description: "", choices: ["a", "b"] } },
    };
    expect((await exec(["pick", "--mode", "c"], registry(spec))).err).toContain(
      "must be one of a, b",
    );
    expect((await exec(["pick", "--mode", "a", "--mode", "b"], registry(spec))).code).toBe(0);
  });

  it("writes exactly one JSON object even for errors", async () => {
    const { code, out, err } = await exec(["review", "classify", "--bogus", "--json"]);
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ schema: "liftoff.error/v1", outcome: "usage" });
    expect(err).toContain("unknown option");
  });

  it("maps failures, unsupported requests and cancellation to their exit codes", async () => {
    const failing = (error: Error): CommandSpec => ({
      ...capabilitiesCommand,
      path: ["boom"],
      run: async () => {
        throw error;
      },
    });
    expect((await exec(["boom"], registry(failing(new Error("broken"))))).code).toBe(1);
    expect((await exec(["boom"], registry(failing(new UnsupportedError("later"))))).code).toBe(6);

    const io = captureIo();
    io.controller.abort();
    const code = await runCli(["boom"], io, registry(failing(new Error("interrupted"))), "1");
    expect(code).toBe(4);

    const thrownString: CommandSpec = {
      ...capabilitiesCommand,
      path: ["odd"],
      run: async () => {
        throw "plain string";
      },
    };
    const odd = await exec(["odd"], registry(thrownString));
    expect(odd.code).toBe(1);
    expect(odd.err).toContain("plain string");
  });
});

describe("CLI-003 capabilities", () => {
  it("lists commands, options, exit codes and profiles as JSON", async () => {
    const { code, out } = await exec(["capabilities", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report).toMatchObject({
      schema: "liftoff.capabilities/v1",
      outcome: "success",
      cliVersion: "1.2.3",
    });
    expect(report.exitCodes.attention).toBe(3);
    const review = report.commands.find((c: { name: string }) => c.name === "review classify");
    expect(review.readOnly).toBe(true);
    expect(review.options.map((o: { name: string }) => o.name)).toEqual([
      "--base",
      "--author",
      "--committed",
      "--json",
      "--help",
    ]);
    expect(report.governanceProfiles.map((p: { id: string }) => p.id)).toContain(
      "risk-tiered-gitflow",
    );
    expect(report.infrastructure).toEqual([
      {
        id: "azure",
        summary: "Azure infrastructure as OpenTofu code, with a root per environment",
      },
    ]);
    expect(report.environments).toEqual(["dev", "staging", "prod"]);
    expect(report.workloads).toEqual(["api", "genai"]);
    expect(report.patterns).toHaveLength(9);
    expect(report.patterns[0]).toEqual({
      id: "generic",
      summary: "One instruction-following agent behind one endpoint",
      maturity: "complete",
    });
    expect(report.frontends).toEqual([
      { id: "vue", summary: "Vue frontend with Vite, Tailwind CSS and TypeScript" },
    ]);
  });

  it("prints a readable list without --json", async () => {
    const { out } = await exec(["capabilities"]);
    expect(out).toContain("review classify (read-only)");
  });
});

describe("REVIEW-007 review classify from the command line", () => {
  it("reports tier, approvals and reasons", async () => {
    const { code, out } = await exec(["review", "classify", "--author", "alice"]);
    expect(code).toBe(0);
    expect(out).toContain("Tier: low (review depth: quick)");
    expect(out).toContain("Required human approvals: 1 under team-gitflow");
    expect(out).toContain("low    docs (docs/a.md)");
    expect(out).not.toContain("trusted author was assumed");
  });

  it("explains assumptions and unverified policies", async () => {
    const commands = [
      makeReviewClassifyCommand(() => ({
        git: {
          resolveCommit: async (ref) => (ref === "develop" || ref === "HEAD" ? "sha" : undefined),
          mergeBase: async () => "m",
          changedFiles: async () =>
            Array.from({ length: 5 }, (_, i) => ({
              path: `.github/workflows/w${i}.yml`,
              additions: 1,
              deletions: 0,
            })),
          showFile: async () => undefined,
        },
        workspace: { readText: async () => POLICY },
      })),
    ];
    const { out } = await exec(["review", "classify", "--committed"], commands);
    expect(out).toContain("Always needs a person:");
    expect(out).toContain("and 2 more");
    expect(out).toContain("Unverified: develop has no review policy");
    expect(out).toContain("trusted author was assumed");
  });

  it("emits the classification as JSON", async () => {
    const { out } = await exec(["review", "classify", "--json", "--author", "alice"]);
    const report = JSON.parse(out);
    expect(report).toMatchObject({
      schema: "liftoff.review-classification/v1",
      outcome: "success",
      tier: "low",
      requiredApprovals: 1,
      verified: true,
      policySource: "base",
      fileCount: 1,
      changedLines: 3,
    });
  });

  it("fails with exit 1 on an invalid policy", async () => {
    const { code, err } = await exec(
      ["review", "classify"],
      [fakeReview(undefined, "version: 9\n")],
    );
    expect(code).toBe(1);
    expect(err).toContain("review policy is invalid");
  });
});

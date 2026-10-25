import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/adapters/process.ts";
import type { CommandSpec } from "../../src/cli/command.ts";
import { makeInitCommand, makePlanCommand } from "../../src/cli/commands/plan-init.ts";
import { defaultProjectPorts } from "../../src/cli/commands/project-ports.ts";
import { CancelledError } from "../../src/cli/outcome.ts";
import { runCli } from "../../src/cli/run.ts";
import { answered, inquirerChoices, terminalPrompts } from "../../src/cli/terminal.ts";
import { askProjectOptions, equivalentCommand } from "../../src/cli/wizard.ts";
import { FakeInitializer } from "../helpers/initializer.ts";
import { type Answers, captureIo } from "../helpers/io.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-wizard-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const initializer = new FakeInitializer(() => ({
  files: { "openspec/config.yaml": "schema: spec-driven\n" },
}));
const ports = (cwd: string) => ({ ...defaultProjectPorts(cwd), initializer });
const REGISTRY: readonly CommandSpec[] = [makeInitCommand(ports), makePlanCommand(ports)];

/** Runs the CLI as a person at a terminal who gives these answers, and `confirm` to init. */
const exec = async (argv: string[], answers: Answers, confirm = true) => {
  const io = captureIo(work, confirm, answers);
  const code = await runCli(argv, io, REGISTRY, "1.0.0");
  return { code, io, out: io.out.join(""), err: io.err.join("") };
};
const flags = (io: { asked: { flag: string }[] }) => io.asked.map((question) => question.flag);
/** The printed command's arguments, as either shell reads them (single quotes, '' or '\\''). */
const words = (command: string) =>
  [...command.matchAll(/'(?:[^']|'')*'|\S+/g)].map(([word]) =>
    word.startsWith("'") ? word.slice(1, -1).replaceAll("''", "'") : word,
  );
/** What the equivalent command prints on this machine. */
const owners = process.platform === "win32" ? "--owners 'alice,bob'" : "--owners alice,bob";

describe("INIT-006 init asks for each option in a terminal", () => {
  it("asks one question per option, says the equivalent command, then creates the project", async () => {
    const { code, io, err } = await exec(["init"], {
      name: "demo",
      agents: ["claude"],
      workflow: "manual",
    });
    expect(code).toBe(0);
    expect(flags(io)).toEqual([
      "name",
      "dir",
      "workload",
      "stack",
      "frontend",
      "infrastructure",
      "agents",
      "workflow",
      "ai-review",
      "governance",
      "owners",
    ]);
    expect(err).toContain(
      "The same project without questions:\n  liftoff init --name demo --stack python-fastapi --workflow manual --agents claude\n",
    );
    expect(io.questions[0]).toMatch(/^Create \d+ files in /);
    const config = readFileSync(path.join(work, "demo/liftoff.yaml"), "utf8");
    expect(config).toContain("workflow: manual");
    expect(config).toContain("- claude");
  });

  it("offers only what the earlier answers allow", async () => {
    const genai = await exec(["init"], { name: "demo", workload: "genai", pattern: "rag" }, false);
    expect(flags(genai.io)).not.toContain("frontend");
    expect(flags(genai.io)).not.toContain("infrastructure");
    expect(flags(genai.io)).not.toContain("stack");
    expect(flags(genai.io)).not.toContain("ai-review");
    const pattern = genai.io.asked.find((question) => question.flag === "pattern");
    expect(pattern?.choices).toContainEqual(
      expect.objectContaining({
        value: "rag",
        description: expect.stringMatching(/^foundation: /),
      }),
    );
    const workflow = genai.io.asked.find((question) => question.flag === "workflow");
    expect(workflow?.choices).toContainEqual(
      expect.objectContaining({ value: "spec-kit", disabled: "needs a coding agent" }),
    );
    expect(genai.code).toBe(4);

    const azure = await exec(
      ["init"],
      { name: "cloud", infrastructure: "azure", agents: ["copilot", "codex"], workflow: "manual" },
      false,
    );
    expect(azure.io.asked.find((question) => question.flag === "environments")?.default).toEqual([
      "dev",
      "staging",
      "prod",
    ]);
    expect(flags(azure.io)).toContain("review-engine");
  });

  it("gives the same plan as the equivalent command", async () => {
    const answers = {
      name: "same",
      dir: "elsewhere/same",
      stack: "node-fastify",
      frontend: "vue",
      agents: ["copilot", "claude"],
      "review-engine": "claude",
      governance: "team-gitflow",
      owners: "alice, bob",
    };
    const wizard = await exec(["init", "--json"], answers, false);
    expect(wizard.code).toBe(4);
    const command = /\n {2}liftoff init (.*)\n/.exec(wizard.err)?.[1] ?? "";
    expect(command).toContain(owners);
    expect(command).not.toContain("--workflow");
    const planned = await exec(["plan", ...words(command), "--json"], {});
    expect(JSON.parse(planned.out).plan.hash).toBe(JSON.parse(wizard.out).plan);
  });

  it("keeps an answer that differs from what the options would choose", async () => {
    const { code, err } = await exec(["init"], {
      name: "quiet",
      agents: ["codex"],
      "ai-review": "off",
      workflow: "manual",
    });
    expect(code).toBe(0);
    expect(err).toContain("--agents codex --ai-review off\n");
    expect(readFileSync(path.join(work, "quiet/liftoff.yaml"), "utf8")).toContain("ai: false");
  });

  it("never asks without a terminal, or when options are given", async () => {
    const io = captureIo(work);
    expect(await runCli(["init"], io, REGISTRY, "1.0.0")).toBe(2);
    expect(io.err.join("")).toContain("--name is required");
    expect(io.asked).toEqual([]);
    const flagged = await exec(["init", "--name", "demo", "--workflow", "manual"], {});
    expect(flagged.code).toBe(0);
    expect(flagged.io.asked).toEqual([]);
    expect(existsSync(path.join(work, "demo/liftoff.yaml"))).toBe(true);
  });

  it("refuses names and logins the options would refuse", async () => {
    const io = captureIo(work, true, { name: "Bad Name" });
    await expect(askProjectOptions(io.prompts)).rejects.toThrow(
      /refused name: A project name must be 2 to 50 lowercase letters/,
    );
    const owners = captureIo(work, true, { name: "demo", owners: "alice, not a login" });
    await expect(askProjectOptions(owners.prompts)).rejects.toThrow(
      /refused owners: not a login is not a GitHub login/,
    );
  });

  it("stops as cancelled when a question is interrupted", async () => {
    const io = captureIo(work, true);
    const stopped = {
      ...io,
      prompts: { ...io.prompts, text: () => Promise.reject(new CancelledError("stopped")) },
    };
    expect(await runCli(["init"], stopped, REGISTRY, "1.0.0")).toBe(4);
  });

  it("quotes answers the shell would split", () => {
    expect(equivalentCommand({ name: "demo", dir: "my projects/demo", pattern: "none" })).toBe(
      "liftoff init --name demo --dir 'my projects/demo'",
    );
    expect(equivalentCommand({ name: "demo", dir: "it's" })).toBe(
      "liftoff init --name demo --dir 'it'\\''s'",
    );
  });

  it("prints values the macOS shells pass on unchanged", async () => {
    const tricky = ["=ls", "~home", "it's", "my demo", "--demo", "a,b", "$HOME", "*", "x#y"];
    for (const dir of tricky) {
      expect(equivalentCommand({ name: "demo", dir })).not.toMatch(/--dir[ =][=~$*]/);
    }
    if (process.platform === "win32") return;
    for (const shell of ["sh", "zsh"]) {
      for (const dir of tricky) {
        const printed = equivalentCommand({ name: "demo", dir }).replace(/^liftoff init /, "");
        const { stdout } = await run(shell, ["-c", `printf '%s\\n' ${printed}`], { cwd: work });
        const args = stdout.trimEnd().split("\n");
        const value = args.includes("--dir")
          ? args[args.indexOf("--dir") + 1]
          : args.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length);
        expect([shell, value]).toEqual([shell, dir]);
      }
    }
  });

  it("quotes for PowerShell on Windows, where commas and apostrophes differ", () => {
    expect(
      equivalentCommand(
        { name: "demo", dir: "C:\\projects\\it's demo", agents: "copilot,claude" },
        "powershell",
      ),
    ).toBe("liftoff init --name demo --dir 'C:\\projects\\it''s demo' --agents 'copilot,claude'");
  });

  it("joins a value that starts with a hyphen to its option, so it parses back", async () => {
    expect(equivalentCommand({ name: "demo", dir: "--demo" })).toBe(
      "liftoff init --name demo --dir=--demo",
    );
    expect(equivalentCommand({ name: "demo", dir: "-my demo" }, "powershell")).toBe(
      "liftoff init --name demo '--dir=-my demo'",
    );
    const wizard = await exec(["init", "--json"], { name: "demo", dir: "--demo" }, false);
    const command = /\n {2}liftoff init (.*)\n/.exec(wizard.err)?.[1] ?? "";
    expect(command).toBe("--name demo --dir=--demo --stack python-fastapi");
    const planned = await exec(["plan", ...words(command), "--json"], {});
    expect(JSON.parse(planned.out).plan.hash).toBe(JSON.parse(wizard.out).plan);
  });
});

describe("INIT-006 questions in the terminal", () => {
  it("turns Ctrl+C and cancellation into a cancelled command", async () => {
    for (const name of ["ExitPromptError", "AbortPromptError"]) {
      const error = Object.assign(new Error("closed"), { name });
      await expect(answered(Promise.reject(error))).rejects.toThrow(CancelledError);
    }
    await expect(answered(Promise.reject(new Error("other")))).rejects.toThrow("other");
    await expect(answered(Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("says why a choice cannot be chosen", () => {
    expect(
      inquirerChoices([
        { value: "a" },
        { value: "b", description: "B", disabled: "needs a coding agent" },
      ]),
    ).toEqual([{ value: "a" }, { value: "b", description: "B", disabled: "needs a coding agent" }]);
  });

  it("writes questions to the given stream, never to stdout", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
      written += String(chunk);
    });
    const stdout = process.stdout.write;
    const leaked: string[] = [];
    process.stdout.write = ((chunk: string) => {
      leaked.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const { prompts } = terminalPrompts(new AbortController().signal, { input, output });
      const answer = prompts.text({ flag: "name", message: "Project name", default: "demo" });
      setTimeout(() => input.write("\n"), 50);
      expect(await answer).toBe("demo");
    } finally {
      process.stdout.write = stdout;
    }
    expect(written).toContain("Project name");
    expect(leaked.join("")).not.toContain("Project name");
  });

  it("stops every question once the command is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { confirm, prompts } = terminalPrompts(controller.signal);
    const question = { flag: "x", message: "x" };
    await expect(confirm("Sure?")).rejects.toThrow(CancelledError);
    await expect(prompts.text(question)).rejects.toThrow(CancelledError);
    await expect(prompts.select({ ...question, choices: [{ value: "a" }] })).rejects.toThrow(
      CancelledError,
    );
    await expect(prompts.checkbox({ ...question, choices: [{ value: "a" }] })).rejects.toThrow(
      CancelledError,
    );
  });
});

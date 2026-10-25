import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyInit, InitTargetError, planInit } from "../../application/init/init-project.ts";
import { type Plan, PlanError, parsePlan } from "../../domain/plan/plan.ts";
import { validateConfig } from "../../domain/project/config.ts";
import { resolveSelection, SelectionError } from "../../plugins/registry.ts";
import type { CommandResult, CommandSpec } from "../command.ts";
import { UnsupportedError, UsageError } from "../outcome.ts";
import { hasProjectOptions, PROJECT_OPTIONS, projectFromOptions } from "../project-options.ts";
import { defaultProjectPorts, type ProjectPorts } from "./project-ports.ts";

/** Turns a selection problem into the right exit code: unsupported or a usage error. */
function selectionToCli(error: unknown): never {
  if (error instanceof SelectionError) {
    throw error.unsupported ? new UnsupportedError(error.message) : new UsageError(error.message);
  }
  throw error;
}

function summarize(plan: Plan): string[] {
  const managed = plan.files.filter((file) => file.ownership === "managed").length;
  const seeded = plan.files.length - managed;
  const top = [...new Set(plan.files.map((file) => file.path.split("/")[0]))].sort();
  const config = plan.config as {
    name: string;
    stack: string;
    workflow: string;
    agents: string[];
    governance: string;
  };
  return [
    `Project ${config.name} in ${plan.target}`,
    `  stack ${config.stack}, workflow ${config.workflow}, governance ${config.governance}`,
    `  agents ${config.agents.length === 0 ? "none" : config.agents.join(", ")}`,
    `${plan.files.length} files: ${seeded} for the project to own, ${managed} kept current by Liftoff`,
    `  ${top.join("  ")}`,
    `Effects: ${plan.effects.join(", ")} (nothing is installed, run or sent anywhere)`,
    `Plan ${plan.hash.slice(0, 12)}`,
  ];
}

export function makePlanCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["plan"],
    summary: "Preview the project Liftoff would create, without creating it.",
    description:
      "Works out every file a new project would get, who owns each one and what creating it would do, and changes nothing. With --out it saves the plan so `liftoff init --plan` can create exactly that project.",
    readOnly: true,
    reportSchema: "liftoff.plan-report/v1",
    options: {
      ...PROJECT_OPTIONS,
      out: {
        type: "string",
        valueName: "file",
        description: "Save the plan to this file for `liftoff init --plan`.",
      },
    },
    examples: [
      "liftoff plan --name demo --workflow manual",
      "liftoff plan --name demo --workflow manual --agents copilot,claude --out demo.plan.json",
    ],
    async run(args, { io, version }) {
      const { config, target } = projectFromOptions(args, io.cwd);
      const plan = await planInit(portsFor(io.cwd), {
        config,
        target,
        liftoffVersion: version,
        cwd: io.cwd,
      }).catch(selectionToCli);
      const out = args.options.out as string | undefined;
      const lines = summarize(plan);
      if (out !== undefined) {
        const file = path.resolve(io.cwd, out);
        await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
        lines.push(
          "",
          `Saved the plan to ${file}.`,
          `Create the project with: liftoff init --plan ${out}`,
        );
      } else {
        lines.push("", "Create it with the same options: liftoff init ...");
      }
      return { outcome: "success", report: { plan }, text: `${lines.join("\n")}\n` };
    },
  };
}

export function makeInitCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["init"],
    summary: "Create a new project.",
    description:
      "Creates a new project in a new or empty directory, from a saved plan (--plan) or from the same options as `liftoff plan`. It shows what it will create and asks before writing anything; the default answer is no. In scripts, pass --yes. Nothing is installed, run or sent anywhere: the project is written in one step, or not at all.",
    readOnly: false,
    reportSchema: "liftoff.init-report/v1",
    options: {
      ...PROJECT_OPTIONS,
      plan: {
        type: "string",
        valueName: "file",
        description: "Create exactly the project in this saved plan.",
      },
      yes: { type: "boolean", short: "y", description: "Create it without asking." },
    },
    examples: [
      "liftoff init --plan demo.plan.json",
      "liftoff init --name demo --workflow manual --agents claude --yes",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const planFile = args.options.plan as string | undefined;
      let plan: Plan;
      if (planFile !== undefined) {
        if (hasProjectOptions(args))
          throw new UsageError("use either --plan or project options, not both");
        const text = await readFile(path.resolve(io.cwd, planFile), "utf8").catch(() => {
          throw new UsageError(`cannot read the plan ${planFile}`);
        });
        plan = parsePlan(text);
      } else {
        const { config, target } = projectFromOptions(args, io.cwd);
        plan = await planInit(ports, {
          config,
          target,
          liftoffVersion: version,
          cwd: io.cwd,
        }).catch(selectionToCli);
      }

      io.stderr(`${summarize(plan).join("\n")}\n`);
      if (args.options.yes !== true) {
        if (!io.interactive) {
          throw new UsageError(
            "init writes files; pass --yes to confirm when no one can answer a prompt",
          );
        }
        if (!(await io.confirm(`Create ${plan.files.length} files in ${plan.target}?`))) {
          return {
            outcome: "cancelled",
            report: { created: false, plan: plan.hash },
            text: "Nothing was created.\n",
          };
        }
      }

      try {
        const result = await applyInit(ports, plan, version, { cwd: io.cwd, signal: io.signal });
        const relative = path.relative(io.cwd, result.target) || ".";
        // Each component starts in its own directory; after the first, the
        // shell is still in the previous one.
        let here = ".";
        const quickStart = resolveSelection(validateConfig(plan.config)).components.map(
          ({ quickStart: { directory, command } }) => {
            const cd = path.posix.relative(here, directory);
            here = directory;
            return `  cd ${cd} && ${command}`;
          },
        );
        return {
          outcome: "success",
          report: { created: true, target: result.target, files: result.files, plan: plan.hash },
          text: [
            `Created ${result.files} files in ${result.target}.`,
            "",
            "Next:",
            `  cd ${relative}`,
            "  git init --initial-branch=develop",
            "  liftoff doctor",
            ...quickStart,
            "",
          ].join("\n"),
        };
      } catch (error) {
        if (error instanceof SelectionError) selectionToCli(error);
        if (error instanceof PlanError || error instanceof InitTargetError) throw error;
        throw error;
      }
    },
  };
}

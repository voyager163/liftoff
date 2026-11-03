import {
  completeWorkflowSet,
  planWorkflowSet,
  WorkflowOptionError,
  type WorkflowPlan,
} from "../../application/workflow/workflow-set.ts";
import { WORKFLOWS } from "../../plugins/registry.ts";
import type { CommandResult, CommandSpec } from "../command.ts";
import { UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import { applyApproved, changeSummary, leftBehind, recoverChange, toCli } from "./changing.ts";
import { defaultProjectPorts, type ProjectPorts, projectDirectory } from "./project-ports.ts";

const STEPS = {
  change: "rewrite",
  add: "add",
  remove: "remove",
} as const;

/** The switch, in the words the text shows it. */
export function renderWorkflowSet(workflow: WorkflowPlan): string[] {
  const title = (id: string) => WORKFLOWS[id]?.title ?? id;
  const lines = [
    `Switch ${workflow.directory} from ${title(workflow.from)} to ${title(workflow.to)}:`,
  ];
  for (const file of workflow.files) {
    lines.push(
      file.step === "left"
        ? `  left ${file.path}: ${file.reason ?? ""}`
        : `  ${STEPS[file.step]} ${file.path}`,
    );
  }
  if (workflow.released.length > 0) {
    lines.push(
      `${title(workflow.from)}'s ${workflow.released.length} files stay as they are, as the project's own, and nothing is uninstalled.`,
    );
  }
  if (workflow.initializer !== undefined) {
    const { name, version, steps } = workflow.initializer;
    lines.push(
      `Once approved, it runs ${name} ${version}'s own initializer, which downloads it, in an empty directory beside the project, with a temporary home and configuration directories, and adds what it writes as ${name}'s files, each only where the project has nothing:`,
      ...steps.map((step) => `    ${[step.command, ...step.args].join(" ")}`),
    );
  }
  // Paths and reasons come from the project, so every line is escaped.
  return lines.map(shown);
}

const reported = (workflow: WorkflowPlan) => ({
  directory: workflow.directory,
  from: workflow.from,
  to: workflow.to,
  files: workflow.files,
  released: workflow.released,
  ...(workflow.initializer === undefined ? {} : { initializer: workflow.initializer }),
});

export function makeWorkflowSetCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["workflow", "set"],
    summary: "Switch a Liftoff project's development workflow.",
    description:
      "Switches the project to manual development, OpenSpec or Spec Kit, as a reviewed change of its own: liftoff.yaml and the manifest are rewritten, and the files Liftoff writes differently for the new workflow, such as AGENTS.md and README.md, change only while they are as Liftoff wrote them. Leaving a framework keeps its files byte for byte, as the project's own, and uninstalls nothing. Entering one runs its own initializer at a pinned version, once approved, in an empty directory beside the project with a temporary home, and adds what it writes only where the project has nothing. It shows the change and asks first; the default answer is no. In scripts, pass --yes. A switch that stops part way can be finished or undone with --recover.",
    readOnly: false,
    reportSchema: "liftoff.workflow-set/v1",
    positionals: [
      {
        name: "workflow",
        description: `The workflow to switch to: ${Object.keys(WORKFLOWS).join(", ")}.`,
      },
    ],
    options: {
      dir: { type: "string", valueName: "path", default: ".", description: "Project directory." },
      check: {
        type: "boolean",
        description: "Change nothing and run nothing; show what switching would do.",
      },
      recover: {
        type: "string",
        valueName: "mode",
        choices: ["finish", "undo"],
        description: "Finish or undo a switch that stopped part way.",
      },
      yes: { type: "boolean", short: "y", description: "Switch without asking." },
    },
    examples: [
      "liftoff workflow set manual --check",
      "liftoff workflow set openspec",
      "liftoff workflow set --recover undo",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const recover = args.options.recover as "finish" | "undo" | undefined;
      const [target] = args.positionals;
      if (recover !== undefined) {
        if (target !== undefined || args.options.check === true) {
          throw new UsageError(
            "--recover goes only with --dir and --yes, not a workflow or --check",
          );
        }
        return recoverChange(io, ports, args, recover, "workflow-set");
      }
      if (target === undefined) {
        throw new UsageError(
          `name the workflow to switch to: ${Object.keys(WORKFLOWS).join(", ")}`,
        );
      }
      if (args.options.check === true && args.options.yes === true) {
        throw new UsageError("--check changes nothing, so --yes has nothing to confirm");
      }
      const directory = await projectDirectory(io.cwd, args.options.dir as string);
      let workflow: WorkflowPlan;
      try {
        workflow = await planWorkflowSet(ports, directory, version, target);
      } catch (error) {
        if (error instanceof WorkflowOptionError) throw new UsageError(error.message);
        return toCli(error);
      }
      io.signal.throwIfAborted();
      if (workflow.from === workflow.to) {
        return {
          outcome: "success",
          report: { ...reported(workflow), changed: false },
          text: `${shown(`${directory} already uses ${workflow.to}; nothing to change.`)}\n`,
        };
      }
      const lines = renderWorkflowSet(workflow);
      if (args.options.check === true) {
        return {
          outcome: "success",
          report: { ...reported(workflow), changed: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      io.stderr(`${lines.join("\n")}\n`);
      if (args.options.yes !== true) {
        if (!io.interactive) {
          throw new UsageError(
            "workflow set changes files; pass --yes to confirm when no one can answer a prompt",
          );
        }
        const running =
          workflow.initializer === undefined
            ? ""
            : `, running and downloading ${workflow.initializer.name}'s initializer first`;
        if (!(await io.confirm(`Switch ${shown(directory)} to ${workflow.to}${running}?`))) {
          return {
            outcome: "cancelled",
            report: { ...reported(workflow), changed: false },
            text: "Nothing was changed.\n",
          };
        }
      }
      // The framework's files are known only once its initializer has run.
      const change =
        workflow.plan !== undefined
          ? { plan: workflow.plan, contents: workflow.contents }
          : await completeWorkflowSet(ports, workflow, version, { signal: io.signal });
      const result = await applyApproved(
        io,
        ports,
        { directory, plan: change.plan, contents: change.contents },
        "workflow-set",
        { yes: true, report: reported(workflow) },
      );
      if ("outcome" in result) return result;
      const done = [
        `Switched ${directory} to ${workflow.to}: changed ${changeSummary(change.plan)}.`,
        ...leftBehind(result.leftovers),
      ];
      return {
        outcome: result.leftovers.length > 0 ? "attention" : "success",
        report: { ...reported(workflow), changed: true, leftovers: result.leftovers },
        text: `${done.map(shown).join("\n")}\n`,
      };
    },
  };
}

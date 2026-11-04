import {
  type AgentsPlan,
  completeAgentsAdd,
  planAgentsAdd,
} from "../../application/agents/agents-add.ts";
import { TransitionOptionError } from "../../application/change/config-transition.ts";
import {
  makeFrameworkDirectories,
  removeMadeDirectories,
} from "../../application/workflow/workflow-set.ts";
import { AGENT_HOSTS } from "../../plugins/builtin/agents/hosts.ts";
import type { CommandResult, CommandSpec } from "../command.ts";
import { UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import { applyApproved, changeSummary, leftBehind, recoverChange, toCli } from "./changing.ts";
import { defaultProjectPorts, type ProjectPorts, projectDirectory } from "./project-ports.ts";

const STEPS = { change: "rewrite", add: "add", remove: "remove" } as const;
const HOSTS = Object.keys(AGENT_HOSTS).join(", ");

/** Adding the agents, in the words the text shows it. */
export function renderAgentsAdd(agents: AgentsPlan): string[] {
  const lines = [
    `Add ${agents.added.join(", ")} to ${agents.directory}, beside ${agents.from.join(", ") || "no coding agent"}:`,
  ];
  for (const file of agents.files) {
    lines.push(
      file.step === "left"
        ? `  left ${file.path}: ${file.reason ?? ""}`
        : `  ${STEPS[file.step]} ${file.path}`,
    );
  }
  if (agents.initializer !== undefined) {
    const { name, version, steps } = agents.initializer;
    lines.push(
      `Once approved, it runs ${name} ${version}'s own command, which downloads it, on a copy of ${name}'s files in an empty directory beside the project, with a temporary home and configuration directories. What it adds becomes ${name}'s, each only where the project has nothing, and ${name}'s files it rewrites change only while as ${name} wrote them:`,
      ...steps.map((step) => `    ${[step.command, ...step.args].join(" ")}`),
    );
  }
  // Paths and reasons come from the project, so every line is escaped.
  return lines.map(shown);
}

const reported = (agents: AgentsPlan) => ({
  directory: agents.directory,
  from: agents.from,
  to: agents.to,
  added: agents.added,
  files: agents.files,
  ...(agents.initializer === undefined ? {} : { initializer: agents.initializer }),
});

export function makeAgentsAddCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["agents", "add"],
    summary: "Add coding agents to a Liftoff project.",
    description:
      "Adds GitHub Copilot, Codex or Claude Code to the project as a reviewed change of its own, keeping the agents it has: liftoff.yaml and the manifest are rewritten, Liftoff's skills and instructions for the new agents are added where nothing is, and the files Liftoff writes differently with them, such as the AI review workflow, change only while they are as Liftoff wrote them. Nothing is removed but a Copilot-only project's skills in .github/skills, which move to the new agent's skill directory, which Copilot reads too; nothing Liftoff did not write, such as another tool's integration, is touched. In an OpenSpec or Spec Kit project, the framework's own command sets the new agents up, at its pinned version, once approved, on a copy of its files beside the project; Spec Kit's default agent stays as it is. It shows the change and asks first; the default answer is no. In scripts, pass --yes. An addition that stops part way can be finished or undone with --recover.",
    readOnly: false,
    reportSchema: "liftoff.agents-add/v1",
    positionals: [
      {
        name: "agents",
        description: `The agents to add, separated by commas: ${HOSTS}.`,
      },
    ],
    options: {
      dir: { type: "string", valueName: "path", default: ".", description: "Project directory." },
      check: {
        type: "boolean",
        description: "Change nothing and run nothing; show what adding would do.",
      },
      recover: {
        type: "string",
        valueName: "mode",
        choices: ["finish", "undo"],
        description: "Finish or undo an addition that stopped part way.",
      },
      yes: { type: "boolean", short: "y", description: "Add without asking." },
    },
    examples: [
      "liftoff agents add codex --check",
      "liftoff agents add copilot,claude",
      "liftoff agents add --recover undo",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const recover = args.options.recover as "finish" | "undo" | undefined;
      const [target] = args.positionals;
      if (recover !== undefined) {
        if (target !== undefined || args.options.check === true) {
          throw new UsageError("--recover goes only with --dir and --yes, not agents or --check");
        }
        return recoverChange(io, ports, args, recover, "agents-add");
      }
      if (target === undefined) throw new UsageError(`name the agents to add: ${HOSTS}`);
      if (args.options.check === true && args.options.yes === true) {
        throw new UsageError("--check changes nothing, so --yes has nothing to confirm");
      }
      const names = target.split(",").map((name) => name.trim());
      const directory = await projectDirectory(io.cwd, args.options.dir as string);
      let agents: AgentsPlan;
      try {
        agents = await planAgentsAdd(ports, directory, version, names);
      } catch (error) {
        if (error instanceof TransitionOptionError) throw new UsageError(error.message);
        return toCli(error);
      }
      io.signal.throwIfAborted();
      if (agents.added.length === 0) {
        return {
          outcome: "success",
          report: { ...reported(agents), changed: false },
          text: `${shown(`${directory} already has ${names.join(", ")}; nothing to change.`)}\n`,
        };
      }
      const lines = renderAgentsAdd(agents);
      if (args.options.check === true) {
        return {
          outcome: "success",
          report: { ...reported(agents), changed: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      io.stderr(`${lines.join("\n")}\n`);
      if (args.options.yes !== true) {
        if (!io.interactive) {
          throw new UsageError(
            "agents add changes files; pass --yes to confirm when no one can answer a prompt",
          );
        }
        const running =
          agents.initializer === undefined
            ? ""
            : `, running and downloading ${agents.initializer.name}'s command first`;
        if (
          !(await io.confirm(`Add ${agents.added.join(", ")} to ${shown(directory)}${running}?`))
        ) {
          return {
            outcome: "cancelled",
            report: { ...reported(agents), changed: false },
            text: "Nothing was changed.\n",
          };
        }
      }
      // The framework's files for the new agents are known only once its command has run.
      const change =
        agents.plan !== undefined
          ? { plan: agents.plan, contents: agents.contents, directories: [], skipped: [] }
          : await completeAgentsAdd(ports, agents, version, { signal: io.signal });
      // Made under the change lock, once the project is checked to be as
      // planned and before any file, so a stale plan never makes them and a
      // change finished later has them too.
      const result = await applyApproved(
        io,
        ports,
        { directory, plan: change.plan, contents: change.contents },
        "agents-add",
        {
          yes: true,
          report: reported(agents),
          beforeFiles: async () => {
            const made = await makeFrameworkDirectories(ports.fs, directory, change.directories);
            return () => removeMadeDirectories(ports.fs, directory, made);
          },
        },
      );
      if ("outcome" in result) return result;
      const leftovers = result.leftovers;
      const done = [
        `Added ${agents.added.join(", ")} to ${directory}: changed ${changeSummary(change.plan)}.`,
        ...change.skipped.map(
          (file) =>
            `Not added back: ${file}, ${agents.initializer?.name}'s file the project no longer has.`,
        ),
        ...leftBehind(leftovers),
      ];
      return {
        outcome: leftovers.length > 0 ? "attention" : "success",
        report: { ...reported(agents), changed: true, skipped: change.skipped, leftovers },
        text: `${done.map(shown).join("\n")}\n`,
      };
    },
  };
}

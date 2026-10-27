import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyChanges,
  CHANGE_COMMANDS,
  ChangeError,
  type ChangePorts,
  ChangeStoppedError,
  readJournal,
  recoverChanges,
  UNREADABLE_JOURNAL_ADVICE,
} from "../../application/change/apply-changes.ts";
import {
  needsPerson,
  planFromSaved,
  planUpdate,
  type UpdateFile,
  type UpdatePlan,
  UpdateUnsupportedError,
  updateAvailable,
} from "../../application/update/update-project.ts";
import { JournalError } from "../../domain/change/journal.ts";
import { CHANGE_JOURNAL_FILE, parseChangePlan } from "../../domain/plan/change-plan.ts";
import { SelectionError } from "../../plugins/registry.ts";
import type { CommandResult, CommandSpec, Io, ParsedArgs } from "../command.ts";
import { UnsupportedError, UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import { defaultProjectPorts, type ProjectPorts, projectDirectory } from "./project-ports.ts";

const OWNED = {
  managed: "Liftoff keeps it current",
  seeded: "the project owns it",
  framework: "its framework owns it",
} as const;

/** What a plan changes: its files, then the manifest. */
function changed(update: UpdatePlan): string {
  const files = (update.plan?.changes.length ?? 1) - 1;
  return files === 0 ? "the manifest" : `${files} file${files === 1 ? "" : "s"}, then the manifest`;
}

/** The plan, in the words the text shows it. */
export function renderUpdate(update: UpdatePlan, version: string): string[] {
  const owned = (file: UpdateFile) => (file.ownership ? ` (${OWNED[file.ownership]})` : "");
  const of = (step: UpdateFile["step"]) => update.files.filter((file) => file.step === step);
  const changing = update.files.filter((file) =>
    ["update", "remove", "record", "add"].includes(file.step),
  );
  const lines: string[] = [];
  if (changing.length > 0 || update.plugins.length > 0) {
    lines.push(`Liftoff ${version} updates ${update.name} in ${update.directory}:`);
    for (const file of changing) {
      const note =
        file.step === "record" ? " (only the manifest changes: the file is already as wanted)" : "";
      lines.push(`  ${file.step.padEnd(7)} ${file.path}${owned(file)}${note}`);
    }
    for (const plugin of update.plugins) {
      lines.push(`  plugin  ${plugin.id} ${plugin.from} → ${plugin.to}`);
    }
  } else if (updateAvailable(update)) {
    lines.push(
      `Liftoff ${version} has nothing to change by itself in ${update.name} in ${update.directory}.`,
    );
  } else {
    lines.push(`${update.name} in ${update.directory} is up to date with Liftoff ${version}.`);
  }
  const offered = of("offer");
  if (offered.length > 0) {
    lines.push(
      "New files this release makes, added only if you choose them or name them with --add:",
      ...offered.map((file) => `  ${file.path}${owned(file)}`),
    );
  }
  const held = [...of("hold"), ...of("occupied")];
  if (held.length > 0) {
    lines.push("Left as they are:", ...held.map((file) => `  ${file.path}: ${file.reason ?? ""}`));
  }
  if (update.plan !== undefined) {
    lines.push(
      `Plan ${update.plan.hash.slice(0, 12)}: changes ${changed(update)}. Effects: modify-files (nothing is installed, run or sent anywhere).`,
    );
  }
  return lines.map(shown);
}

/** What the JSON report says about the plan. */
const reported = (update: UpdatePlan) => ({
  directory: update.directory,
  available: updateAvailable(update),
  files: update.files,
  plugins: update.plugins,
  ...(update.plan === undefined ? {} : { plan: update.plan.hash }),
});

/**
 * Turns a refusal into the right exit code. A configuration this release
 * cannot make came from liftoff.yaml, not the command line, so it is
 * unsupported here.
 */
function toCli(error: unknown): never {
  if (error instanceof UpdateUnsupportedError || error instanceof SelectionError) {
    throw new UnsupportedError(error.message);
  }
  throw error;
}

/** The new files named with --add, which must be ones the update offers. */
function named(args: ParsedArgs): Set<string> {
  const add = args.options.add as string | undefined;
  return new Set(
    (add ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
}

export function makeUpdateCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["update"],
    summary: "Bring the files Liftoff manages in a project to this release.",
    description:
      "Updates the files .liftoff/manifest.json lists as managed by Liftoff to what this release makes for the project's liftoff.yaml, and removes those it no longer makes. A managed file changed since Liftoff wrote it is left as it is and named. Files the project or a framework owns, such as its source, lock files, environment files, infrastructure and README, and liftoff.yaml itself, are never changed. Update never switches the workflow, governance profile, stack, pattern or agents, and refuses if liftoff.yaml was changed. New files this release makes are offered separately and added only if you choose them, or name them with --add, never over an existing file. It shows the plan and asks before changing anything; the default answer is no. In scripts, pass --yes. Each file is changed only if it is still as planned, and an update that stops part way can be finished or undone with --recover.",
    readOnly: false,
    reportSchema: "liftoff.update/v1",
    options: {
      dir: { type: "string", valueName: "path", default: ".", description: "Project directory." },
      check: {
        type: "boolean",
        description: "Change nothing; exit 3 when this release has an update for the project.",
      },
      out: {
        type: "string",
        valueName: "file",
        description: "Save the plan to this file and change nothing; apply it with --plan.",
      },
      plan: {
        type: "string",
        valueName: "file",
        description:
          "Apply exactly this saved plan, and refuse it if the project or Liftoff changed since.",
      },
      add: {
        type: "string",
        valueName: "paths",
        description: "Also add these new files, comma-separated, from those the update offers.",
      },
      recover: {
        type: "string",
        valueName: "mode",
        choices: ["finish", "undo"],
        description: "Finish or undo an update that stopped part way.",
      },
      yes: { type: "boolean", short: "y", description: "Change the files without asking." },
    },
    examples: [
      "liftoff update --check",
      "liftoff update",
      "liftoff update --add .claude/skills/liftoff-assess/SKILL.md --yes",
      "liftoff update --out update.plan.json",
      "liftoff update --plan update.plan.json --yes",
      "liftoff update --recover undo",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const changePorts: ChangePorts = {
        fs: ports.fs,
        processes: ports.processes,
        now: () => new Date().toISOString(),
      };
      const given = (...options: string[]) => options.filter((option) => args.given.has(option));
      const yes = args.options.yes === true;
      const recover = args.options.recover as "finish" | "undo" | undefined;
      if (recover !== undefined) {
        const others = given("check", "out", "plan", "add");
        if (others.length > 0) {
          throw new UsageError(`--recover goes only with --dir and --yes, not --${others[0]}`);
        }
        return recoverUpdate(io, changePorts, args, recover);
      }
      const planFile = args.options.plan as string | undefined;
      const out = args.options.out as string | undefined;
      const preview = args.options.check === true || out !== undefined;
      if (preview && yes)
        throw new UsageError("--check and --out change nothing, so --yes has nothing to confirm");

      let update: UpdatePlan;
      // Whether the plan was shown with the question about new files, and not changed since.
      let shownAlready = false;
      if (planFile !== undefined) {
        const others = given("dir", "add", "check", "out");
        if (others.length > 0) {
          throw new UsageError(
            `a saved plan names its project and files, so --plan goes without --${others[0]}`,
          );
        }
        const text = await readFile(path.resolve(io.cwd, planFile), "utf8").catch(() => {
          throw new UsageError(`cannot read the plan ${planFile}`);
        });
        update = await planFromSaved(ports, parseChangePlan(text), version).catch(toCli);
      } else {
        const directory = await projectDirectory(io.cwd, args.options.dir as string);
        const add = named(args);
        update = await planUpdate(ports, directory, version, { add }).catch(toCli);
        const offered = new Set(
          update.files
            .filter((file) => file.step === "add" || file.step === "offer")
            .map((file) => file.path),
        );
        const unknown = [...add].filter((file) => !offered.has(file));
        if (unknown.length > 0) {
          throw new UsageError(
            `--add names ${unknown.join(", ")}, which this update does not offer; liftoff update --check lists what it offers`,
          );
        }
        const offers = update.files.filter((file) => file.step === "offer");
        if (!preview && !yes && io.interactive && add.size === 0 && offers.length > 0) {
          io.stderr(`${renderUpdate(update, version).join("\n")}\n\n`);
          const chosen = await io.prompts.checkbox({
            flag: "add",
            message: "Add which new files? None are added unless you choose them.",
            choices: offers.map((file) => ({
              value: file.path,
              ...(file.ownership ? { description: OWNED[file.ownership] } : {}),
            })),
          });
          if (chosen.length > 0) {
            update = await planUpdate(ports, directory, version, { add: new Set(chosen) }).catch(
              toCli,
            );
          } else {
            shownAlready = true;
          }
        }
      }

      const lines = renderUpdate(update, version);
      if (preview) {
        if (out !== undefined) {
          if (update.plan === undefined) {
            lines.push("", "There is nothing to change, so no plan was saved.");
          } else {
            const file = path.resolve(io.cwd, out);
            await writeFile(file, `${JSON.stringify(update.plan, null, 2)}\n`);
            lines.push(
              "",
              `Saved the plan to ${shown(file)}.`,
              `Apply it with: liftoff update --plan ${shown(out)}`,
            );
          }
        }
        return {
          outcome: args.options.check === true && updateAvailable(update) ? "attention" : "success",
          report: { ...reported(update), changed: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      const held = needsPerson(update);
      if (update.plan === undefined) {
        return {
          outcome: held ? "attention" : "success",
          report: { ...reported(update), changed: false },
          // Shown already with the question, and nothing chosen.
          text: shownAlready ? "Nothing was changed.\n" : `${lines.join("\n")}\n`,
        };
      }

      if (!shownAlready) io.stderr(`${lines.join("\n")}\n`);
      if (!yes) {
        if (!io.interactive) {
          throw new UsageError(
            "update changes files; pass --yes to confirm when no one can answer a prompt",
          );
        }
        if (!(await io.confirm(`In ${shown(update.directory)}, change ${changed(update)}?`))) {
          return {
            outcome: "cancelled",
            report: { ...reported(update), changed: false },
            text: "Nothing was changed.\n",
          };
        }
      }
      try {
        await applyChanges(changePorts, update.plan, update.contents);
      } catch (error) {
        return stopped(error, ports, update);
      }
      const done = `Updated ${update.name}: changed ${changed(update)}.`;
      return {
        outcome: held ? "attention" : "success",
        report: {
          ...reported(update),
          // What --check would now find: files held back or not added, or new files offered.
          available: held || update.files.some((file) => file.step === "offer"),
          changed: true,
        },
        text: held
          ? `${done}\nSome files were left as they are; liftoff update --check lists them.\n`
          : `${done}\n`,
      };
    },
  };
}

/**
 * An update that stopped after its journal was written stopped part way,
 * whatever stopped it, and is reported as partial with how to recover.
 * Anything else changed nothing and is rethrown.
 */
async function stopped(
  error: unknown,
  ports: ProjectPorts,
  update: UpdatePlan,
): Promise<CommandResult> {
  const journal =
    error instanceof ChangeStoppedError || !(error instanceof ChangeError)
      ? await readJournal(ports.fs, update.directory).catch(() => undefined)
      : undefined;
  if (journal?.plan !== update.plan?.hash) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    outcome: "partial",
    report: { ...reported(update), changed: true, stopped: message },
    text: `${shown(`The update stopped part way: ${message}`)}\nFinish it with liftoff update --recover finish, or undo it with liftoff update --recover undo.\n`,
  };
}

/** Finishes or undoes an update that stopped part way, after asking. */
async function recoverUpdate(
  io: Io,
  ports: ChangePorts,
  args: ParsedArgs,
  mode: "finish" | "undo",
): Promise<CommandResult> {
  const directory = await projectDirectory(io.cwd, args.options.dir as string);
  const journal = await readJournal(ports.fs, directory).catch((error: unknown) => {
    if (!(error instanceof JournalError)) throw error;
    throw new ChangeError(`${error.message}; ${UNREADABLE_JOURNAL_ADVICE}`);
  });
  if (journal === undefined) {
    return {
      outcome: "success",
      report: { directory, recovered: false },
      text: `No update to ${shown(directory)} stopped part way; there is nothing to recover.\n`,
    };
  }
  if (journal.operation !== "update") {
    const command = CHANGE_COMMANDS[journal.operation];
    throw new UsageError(
      `the change that stopped was made by ${command}; recover it with ${command} --recover`,
    );
  }
  io.stderr(
    `${shown(`An update to ${directory} that began ${journal.started} stopped part way; it changes ${journal.changes.length} files, recorded in ${CHANGE_JOURNAL_FILE}.`)}\n`,
  );
  if (args.options.yes !== true) {
    if (!io.interactive) {
      throw new UsageError(
        "recovery changes files; pass --yes to confirm when no one can answer a prompt",
      );
    }
    if (!(await io.confirm(`${mode === "finish" ? "Finish" : "Undo"} it?`))) {
      return {
        outcome: "cancelled",
        report: { directory, recovered: false },
        text: "Nothing was changed.\n",
      };
    }
  }
  const result = await recoverChanges(ports, directory, mode);
  const list = (heading: string, files: readonly string[]) =>
    files.length === 0 ? [] : [heading, ...files.map((file) => `  ${file}`)];
  const lines = [
    result.complete
      ? `The update is ${mode === "finish" ? "finished" : "undone"}: ${result.changed.length} file${result.changed.length === 1 ? "" : "s"} changed.`
      : `The update is not yet ${mode === "finish" ? "finished" : "undone"}; ${CHANGE_JOURNAL_FILE} stays until it is.`,
    ...list("Changed:", result.changed),
    ...list(
      "Changed by something else meanwhile, so left as they are; put each back as it was, then run this again:",
      result.conflicts,
    ),
    ...list("Waiting until those are resolved:", result.waiting),
  ];
  return {
    outcome: result.complete ? "success" : "partial",
    report: { directory, recovered: result.complete, mode, ...result },
    text: `${lines.map(shown).join("\n")}\n`,
  };
}

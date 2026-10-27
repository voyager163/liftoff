import {
  needsPerson,
  planFromSaved,
  planUpdate,
  type UpdateFile,
  type UpdatePlan,
  updateAvailable,
} from "../../application/update/update-project.ts";
import type { CommandResult, CommandSpec } from "../command.ts";
import { UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import {
  applyApproved,
  changeSummary,
  checkPreview,
  leftBehind,
  listed,
  planLine,
  readSavedPlan,
  recoverChange,
  savePlan,
  toCli,
} from "./changing.ts";
import { defaultProjectPorts, type ProjectPorts, projectDirectory } from "./project-ports.ts";

const OWNED = {
  managed: "Liftoff keeps it current",
  seeded: "the project owns it",
  framework: "its framework owns it",
} as const;

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
    lines.push(planLine(update.plan));
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
        description:
          "Save the plan to this file and change nothing in the project; apply it with --plan.",
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
      const given = (...options: string[]) => options.filter((option) => args.given.has(option));
      const yes = args.options.yes === true;
      const recover = args.options.recover as "finish" | "undo" | undefined;
      if (recover !== undefined) {
        const others = given("check", "out", "plan", "add");
        if (others.length > 0) {
          throw new UsageError(`--recover goes only with --dir and --yes, not --${others[0]}`);
        }
        return recoverChange(io, ports, args, recover, "update");
      }
      const planFile = args.options.plan as string | undefined;
      const out = args.options.out as string | undefined;
      const { preview } = checkPreview(args);

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
        update = await planFromSaved(ports, await readSavedPlan(io, planFile), version).catch(
          toCli,
        );
      } else {
        const directory = await projectDirectory(io.cwd, args.options.dir as string);
        const add = listed(args.options.add as string | undefined);
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
        if (out !== undefined) lines.push(...(await savePlan(io, out, update.plan, "update")));
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
      const result = await applyApproved(io, ports, { ...update, plan: update.plan }, "update", {
        yes,
        report: reported(update),
      });
      if ("outcome" in result) return result;
      const updated = [
        `Updated ${update.name}: changed ${changeSummary(update.plan)}.`,
        ...(held ? ["Some files were left as they are; liftoff update --check lists them."] : []),
        ...leftBehind(result.leftovers),
      ];
      return {
        outcome: held || result.leftovers.length > 0 ? "attention" : "success",
        report: {
          ...reported(update),
          // What --check would now find: files held back or not added, or new files offered.
          available: held || update.files.some((file) => file.step === "offer"),
          changed: true,
          leftovers: result.leftovers,
        },
        text: `${updated.map(shown).join("\n")}\n`,
      };
    },
  };
}

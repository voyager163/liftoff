import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHECKLIST_FILE, COPY_DIRECTORY } from "../../application/migrate/checklist.ts";
import {
  applyMigrate,
  isBlocked,
  MigrateOptionError,
  type MigratePlan,
  planMigrate,
  planMigrateFromSaved,
  within,
} from "../../application/migrate/migrate-project.ts";
import { AssessError } from "../../application/project/assess-project.ts";
import { type Plan, parsePlan } from "../../domain/plan/plan.ts";
import { STACKS } from "../../plugins/registry.ts";
import type { CommandResult, CommandSpec } from "../command.ts";
import { UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import { checkPreview, toCli } from "./changing.ts";
import { CHOICE_OPTIONS, choicesFrom, proposalLines } from "./choosing.ts";
import {
  defaultProjectPorts,
  newDirectory,
  type ProjectPorts,
  projectDirectory,
} from "./project-ports.ts";

/** How many files left out of the copy the text lists; the JSON report has every one. */
const SHOWN_LEFT = 20;

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** What a plan creates, and what it may do. */
const planLine = (migration: MigratePlan, plan: Plan): string =>
  `Plan ${plan.hash.slice(0, 12)}: creates ${plan.files.length + 1 + migration.copies.length} files in ${plan.target}, ${migration.copies.length} of them copied from ${migration.source}. Effects: ${plan.effects.join(", ")} (nothing is installed, run or sent anywhere, and ${migration.source} is not changed).`;

/** The migration, in the words the text shows it. */
export function renderMigrate(migration: MigratePlan, version: string): string[] {
  const lines: string[] = [];
  const blocked = isBlocked(migration);
  if (migration.proposal.length > 0) {
    lines.push(
      `Liftoff ${version} ${blocked ? "would migrate" : "migrates"} ${migration.source} to ${migration.target} as:`,
      ...proposalLines(migration.proposal),
    );
  }
  if (blocked) {
    lines.push(
      `Liftoff cannot migrate ${migration.source} as it is; nothing was created:`,
      ...migration.blocked.map((reason) => `  - ${reason}`),
    );
  }
  const placed = migration.parts.filter((part) => part.note !== "");
  if (placed.length > 0) {
    lines.push(
      "Parts of the project, and where the new project keeps them:",
      ...placed.map(
        (part) =>
          `  ${part.component} on ${part.stack} in ${part.path}: ${part.to === undefined ? "nowhere" : `into ${part.to}/`}`,
      ),
    );
  }
  const bytes = migration.copies.reduce((total, copy) => total + copy.bytes, 0);
  lines.push(
    `It copies ${migration.copies.length} files (${size(bytes)}) into ${COPY_DIRECTORY}/${migration.left.length === 0 ? "." : ", leaving out:"}`,
    ...migration.left.slice(0, SHOWN_LEFT).map((item) => `  ${item.path}: ${item.why}`),
  );
  if (migration.left.length > SHOWN_LEFT) {
    lines.push(
      `  … and ${migration.left.length - SHOWN_LEFT} more, in ${CHECKLIST_FILE} and the --json report`,
    );
  }
  if (migration.plan !== undefined) {
    lines.push(
      `${CHECKLIST_FILE} in the new project lists what to move from ${COPY_DIRECTORY}/, and how to check the result.`,
      planLine(migration, migration.plan),
    );
  }
  // Paths, stacks and reasons come from the project, so every line is escaped.
  return lines.map(shown);
}

/** What the JSON report says about the migration. */
const reported = (migration: MigratePlan) => ({
  source: migration.source,
  target: migration.target,
  migratable: !isBlocked(migration),
  blocked: migration.blocked,
  proposal: migration.proposal,
  ...(migration.config === undefined ? {} : { config: migration.config }),
  parts: migration.parts,
  copied: migration.copies.length,
  bytes: migration.copies.reduce((total, copy) => total + copy.bytes, 0),
  left: migration.left,
  legacy: migration.legacy,
  ...(migration.plan === undefined ? {} : { plan: migration.plan.hash }),
});

/** The options that choose what the new project is, which a saved plan already names. */
const CHOSEN = Object.keys(CHOICE_OPTIONS);

export function makeMigrateCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
  home: string = os.homedir(),
): CommandSpec {
  return {
    path: ["migrate"],
    summary: "Make a new Liftoff project beside an existing one, with a copy of its files.",
    description: `Reads the project as liftoff assess does, running nothing, and proposes the new project from what it finds, as liftoff adopt does; options replace any part of the proposal. In a new or empty directory beside it, it makes the project liftoff init would make, starter application included, with a copy of the old project's files in ${COPY_DIRECTORY}/ and ${CHECKLIST_FILE}, a checklist of what to move and how to check it. The copy leaves out Git's data, installed dependencies, caches, build output, files that may hold secrets or state, and records from a Liftoff release before the rebuild, and names each. The old project is never changed. It shows the plan and asks before creating anything; the default answer is no. In scripts, pass --yes.`,
    readOnly: false,
    reportSchema: "liftoff.migrate/v1",
    options: {
      dir: {
        type: "string",
        valueName: "path",
        default: ".",
        description:
          "The project to migrate. Without it, the current directory must be the root of a Git repository.",
      },
      to: {
        type: "string",
        valueName: "path",
        description:
          "A new or empty directory for the new project. Defaults to the project's directory name followed by -liftoff, beside it.",
      },
      ...CHOICE_OPTIONS,
      stack: {
        type: "string",
        valueName: "stack",
        choices: Object.keys(STACKS),
        description:
          "The new project's backend stack. Defaults to the stack of the backend the project holds; name one to move the application to it.",
      },
      check: {
        type: "boolean",
        description:
          "Create nothing; show what migrating would do, and exit 3 when the project cannot be migrated as it is.",
      },
      out: {
        type: "string",
        valueName: "file",
        description:
          "Save the plan to this file, outside the project, and create nothing; apply it with --plan.",
      },
      plan: {
        type: "string",
        valueName: "file",
        description:
          "Apply exactly this saved plan, and refuse it if the project or Liftoff changed since.",
      },
      yes: { type: "boolean", short: "y", description: "Create the new project without asking." },
    },
    examples: [
      "liftoff migrate --check",
      "liftoff migrate --dir ../service --to ../service-next --stack node-fastify",
      "liftoff migrate --out ../migrate.plan.json",
      "liftoff migrate --plan ../migrate.plan.json --yes",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const given = (...options: string[]) => options.filter((option) => args.given.has(option));
      const planFile = args.options.plan as string | undefined;
      const out = args.options.out as string | undefined;
      const { preview } = checkPreview(args);
      const refused = [await projectDirectory(io.cwd, home)];

      let migration: MigratePlan;
      try {
        if (planFile !== undefined) {
          const others = given("dir", "to", "check", "out", ...CHOSEN);
          if (others.length > 0) {
            throw new UsageError(
              `a saved plan names its projects and configuration, so --plan goes without --${others[0]}`,
            );
          }
          const text = await readFile(path.resolve(io.cwd, planFile), "utf8").catch(() => {
            throw new UsageError(`cannot read the plan ${planFile}`);
          });
          migration = await planMigrateFromSaved(ports, parsePlan(text, "migrate"), version, {
            refused,
            cwd: io.cwd,
          });
        } else {
          const source = await projectDirectory(io.cwd, args.options.dir as string);
          const to = args.options.to as string | undefined;
          const target = await newDirectory(
            io.cwd,
            to ?? path.join(path.dirname(source), `${path.basename(source)}-liftoff`),
          );
          // The old project is never written to, and the new one's directory must stay empty.
          if (out !== undefined) {
            const file = await newDirectory(io.cwd, out);
            const inside = [source, target].find((directory) => within(file, directory));
            if (inside !== undefined) {
              throw new UsageError(
                `--out ${out} is in ${inside}, which migrating does not write to; save the plan elsewhere, such as ../migrate.plan.json`,
              );
            }
          }
          migration = await planMigrate(ports, source, target, version, choicesFrom(args), {
            named: args.given.has("dir"),
            refused,
            cwd: io.cwd,
          });
        }
      } catch (error) {
        if (error instanceof AssessError || error instanceof MigrateOptionError) {
          throw new UsageError(error.message);
        }
        return toCli(error);
      }

      const lines = renderMigrate(migration, version);
      if (isBlocked(migration)) {
        return {
          outcome: "attention",
          report: { ...reported(migration), created: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      const plan = migration.plan;
      if (plan === undefined) {
        throw new Error("a migration that is not blocked always has a plan");
      }
      if (preview) {
        if (out !== undefined) {
          const file = path.resolve(io.cwd, out);
          io.signal.throwIfAborted();
          await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
          lines.push(
            "",
            `Saved the plan to ${shown(file)}.`,
            `Apply it with: liftoff migrate --plan ${shown(out)}`,
          );
        }
        return {
          outcome: "success",
          report: { ...reported(migration), created: false },
          text: `${lines.join("\n")}\n`,
        };
      }

      io.stderr(`${lines.join("\n")}\n`);
      if (args.options.yes !== true) {
        if (!io.interactive) {
          throw new UsageError(
            "migrate writes files; pass --yes to confirm when no one can answer a prompt",
          );
        }
        if (!(await io.confirm(`Create the new project in ${shown(plan.target)}?`))) {
          return {
            outcome: "cancelled",
            report: { ...reported(migration), created: false },
            text: "Nothing was created.\n",
          };
        }
      }
      // A file of the old project that changed since the plan stops it, with nothing created.
      const result = await applyMigrate(ports.fs, migration, { cwd: io.cwd, signal: io.signal });
      const relative = path.relative(io.cwd, result.target) || ".";
      const text = [
        `Created ${result.files} files in ${result.target}, ${migration.copies.length} of them copied from ${migration.source}, which is unchanged.`,
        ...(result.differences.length === 0
          ? []
          : [
              "Reading the new project back found:",
              ...result.differences.map((difference) => `  - ${difference}`),
            ]),
        "",
        "Next:",
        `  cd ${relative}`,
        `  follow ${CHECKLIST_FILE}, which says what to move from ${COPY_DIRECTORY}/ and how to check it`,
        "",
      ];
      return {
        outcome: result.differences.length === 0 ? "success" : "attention",
        report: {
          ...reported(migration),
          created: true,
          files: result.files,
          differences: result.differences,
        },
        text: text.map(shown).join("\n"),
      };
    },
  };
}

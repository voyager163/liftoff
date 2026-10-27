import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  MAX_PATCH_BYTES,
  needsPerson,
  planPatch,
  planRepairFromSaved,
  planRestore,
  type RepairFile,
  type RepairPlan,
  repairNeeded,
} from "../../application/repair/repair-project.ts";
import type { CommandResult, CommandSpec, Io, ParsedArgs } from "../command.ts";
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
  project: "the project owns it",
} as const;

/** The repair, in the words the text shows it. */
export function renderRepair(repair: RepairPlan): string[] {
  const of = (step: RepairFile["step"]) => repair.files.filter((file) => file.step === step);
  const where = `${repair.name} in ${repair.directory}`;
  const patched = repair.files.filter((file) => ["change", "add", "remove"].includes(file.step));
  const lines: string[] = [];
  if (patched.length > 0) {
    lines.push(`The patch changes ${where}:`);
    for (const file of patched) {
      const owner = file.ownership ? ` (${OWNED[file.ownership]})` : "";
      lines.push(`  ${file.step.padEnd(7)} ${file.path}${owner}`);
    }
  } else if (repair.files.length === 0) {
    lines.push(`Every file Liftoff wrote in ${where} is as it should be.`);
  } else {
    const problems = repair.files.length;
    lines.push(
      `${problems === 1 ? "1 file" : `${problems} files`} Liftoff wrote in ${where} ${problems === 1 ? "is" : "are"} not as Liftoff left ${problems === 1 ? "it" : "them"}:`,
    );
  }
  const section = (heading: string, files: readonly RepairFile[], why = false) => {
    if (files.length === 0) return;
    lines.push(
      heading,
      ...files.map(
        (file) =>
          `  ${file.path}: ${file.problem ?? ""}${why && file.reason ? `; ${file.reason}` : ""}`,
      ),
    );
  };
  section("Put back as this release makes it:", of("restore"));
  section(
    "Repair can put these back, if you choose them or name them with --restore:",
    of("offer"),
  );
  section("No recipe fixes these:", of("cannot"), true);
  if (repair.plan !== undefined) lines.push(planLine(repair.plan));
  return lines.map(shown);
}

/** Whether the repair applies a patch, which looks only at the files it changes. */
const patching = (repair: RepairPlan) =>
  repair.files.some((file) => ["change", "add", "remove"].includes(file.step));

/**
 * What the JSON report says about the repair. Whether a Liftoff file needs
 * attention is said only when the files were looked at, not for a patch.
 */
const reported = (repair: RepairPlan) => ({
  directory: repair.directory,
  ...(patching(repair) ? {} : { needed: repairNeeded(repair) }),
  files: repair.files,
  ...(repair.plan === undefined ? {} : { plan: repair.plan.hash }),
});

/** A reviewed patch named with --patch, with the paths --paths lets it change. */
async function readPatch(
  io: Io,
  args: ParsedArgs,
): Promise<{ readonly text: string; readonly paths: readonly string[] } | undefined> {
  const file = args.options.patch as string | undefined;
  const paths = [...listed(args.options.paths as string | undefined)];
  if (file === undefined) {
    if (args.given.has("paths")) throw new UsageError("--paths goes with --patch");
    return undefined;
  }
  if (paths.length === 0) {
    throw new UsageError("--patch needs --paths: the files and directories the patch may change");
  }
  const bytes = await readBounded(path.resolve(io.cwd, file), MAX_PATCH_BYTES);
  if (bytes === undefined) throw new UsageError(`cannot read the patch ${file}`);
  if (bytes.length > MAX_PATCH_BYTES) {
    throw new UsageError(`the patch ${file} is over ${MAX_PATCH_BYTES / 1024 / 1024} MiB`);
  }
  // Read as it was reviewed: bytes that are not UTF-8 are refused, never replaced.
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), paths };
  } catch {
    throw new UsageError(`the patch ${file} is not UTF-8 text`);
  }
}

/**
 * A regular file's bytes, read through one handle so what is checked is what
 * is read, and never more than one byte past `limit`; undefined when it
 * cannot be opened or is not a regular file. It never waits on a FIFO.
 */
async function readBounded(file: string, limit: number): Promise<Buffer | undefined> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(
    () => undefined,
  );
  if (handle === undefined) return undefined;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export function makeRepairCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["repair"],
    summary: "Put back files Liftoff wrote, or apply a reviewed patch, with your approval.",
    description:
      "Finds the files Liftoff wrote that are not as they should be and puts back those you choose: a file Liftoff manages that is missing or was changed by hand, as this release makes it, or a missing file Liftoff wrote for the project, when this release would write it exactly as before. With --patch it applies a reviewed unified diff, such as one a coding agent prepared, to the project's own files within the paths named with --paths: every hunk must match exactly, and it never changes a file Liftoff manages, a framework's file, liftoff.yaml, .liftoff or .git. It shows the plan and asks before changing anything; the default answer is no. In scripts, pass --yes. Each file is changed only if it is still as planned, and a repair that stops part way can be finished or undone with --recover. Like update, it never switches what the project is made of.",
    readOnly: false,
    reportSchema: "liftoff.repair/v1",
    options: {
      dir: { type: "string", valueName: "path", default: ".", description: "Project directory." },
      check: {
        type: "boolean",
        description:
          "Change nothing; list the files Liftoff wrote that need attention, and exit 3 when there are any.",
      },
      restore: {
        type: "string",
        valueName: "paths",
        description: "Put back these files, comma-separated, from those repair lists.",
      },
      patch: {
        type: "string",
        valueName: "file",
        description:
          "Apply this reviewed unified diff (git diff --no-renames) to the project's own files.",
      },
      paths: {
        type: "string",
        valueName: "paths",
        description:
          "With --patch, the files and directories it may change, comma-separated; it is refused if it changes anything else.",
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
          "Apply exactly this saved plan, with the same --patch and --paths for a patch, and refuse it if anything changed since.",
      },
      recover: {
        type: "string",
        valueName: "mode",
        choices: ["finish", "undo"],
        description: "Finish or undo a repair that stopped part way.",
      },
      yes: { type: "boolean", short: "y", description: "Change the files without asking." },
    },
    examples: [
      "liftoff repair --check",
      "liftoff repair",
      "liftoff repair --restore .github/liftoff/review-policy.mjs --yes",
      "liftoff repair --patch fix.diff --paths backend/app",
      "liftoff repair --recover undo",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const given = (...options: string[]) => options.filter((option) => args.given.has(option));
      const yes = args.options.yes === true;
      const recover = args.options.recover as "finish" | "undo" | undefined;
      if (recover !== undefined) {
        const others = given("check", "out", "plan", "restore", "patch", "paths");
        if (others.length > 0) {
          throw new UsageError(`--recover goes only with --dir and --yes, not --${others[0]}`);
        }
        return recoverChange(io, ports, args, recover, "repair");
      }
      const { preview } = checkPreview(args);
      const check = args.options.check === true;
      const out = args.options.out as string | undefined;
      const planFile = args.options.plan as string | undefined;
      if (given("restore").length > 0 && given("patch").length > 0) {
        throw new UsageError("use --restore or --patch, not both");
      }
      if (check && given("restore", "patch").length > 0) {
        throw new UsageError(
          "--check lists what repair can put back; to see what --restore or --patch would change, use --out",
        );
      }
      const patch = await readPatch(io, args);

      let repair: RepairPlan;
      let shownAlready = false;
      if (planFile !== undefined) {
        const others = given("dir", "restore", "check", "out");
        if (others.length > 0) {
          throw new UsageError(
            `a saved plan names its project and files, so --plan goes without --${others[0]}`,
          );
        }
        repair = await planRepairFromSaved(
          ports,
          await readSavedPlan(io, planFile),
          version,
          patch,
        ).catch(toCli);
      } else {
        const directory = await projectDirectory(io.cwd, args.options.dir as string);
        if (patch !== undefined) {
          repair = await planPatch(ports, directory, version, patch).catch(toCli);
        } else {
          const restore = listed(args.options.restore as string | undefined);
          repair = await planRestore(ports, directory, version, { restore }).catch(toCli);
          const offered = new Set(
            repair.files
              .filter((file) => file.step === "restore" || file.step === "offer")
              .map((file) => file.path),
          );
          const unknown = [...restore].filter((file) => !offered.has(file));
          if (unknown.length > 0) {
            throw new UsageError(
              `--restore names ${unknown.join(", ")}, which repair cannot put back; liftoff repair --check lists what it can`,
            );
          }
          const offers = repair.files.filter((file) => file.step === "offer");
          if (!preview && !yes && io.interactive && restore.size === 0 && offers.length > 0) {
            io.stderr(`${renderRepair(repair).join("\n")}\n\n`);
            const chosen = await io.prompts.checkbox({
              flag: "restore",
              message: "Put back which files? None are put back unless you choose them.",
              choices: offers.map((file) => ({
                value: file.path,
                ...(file.problem ? { description: file.problem } : {}),
              })),
            });
            if (chosen.length > 0) {
              repair = await planRestore(ports, directory, version, {
                restore: new Set(chosen),
              }).catch(toCli);
            } else {
              shownAlready = true;
            }
          }
        }
      }

      const lines = renderRepair(repair);
      if (preview) {
        if (out !== undefined) {
          const again =
            patch === undefined ? "" : " --patch <the same patch> --paths <the same paths>";
          lines.push(...(await savePlan(io, out, repair.plan, "repair", again)));
        }
        return {
          outcome: check && repairNeeded(repair) ? "attention" : "success",
          report: { ...reported(repair), changed: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      if (repair.plan === undefined) {
        return {
          outcome: repairNeeded(repair) ? "attention" : "success",
          report: { ...reported(repair), changed: false },
          text: shownAlready ? "Nothing was changed.\n" : `${lines.join("\n")}\n`,
        };
      }

      if (!shownAlready) io.stderr(`${lines.join("\n")}\n`);
      const result = await applyApproved(io, ports, { ...repair, plan: repair.plan }, "repair", {
        yes,
        report: reported(repair),
      });
      if ("outcome" in result) return result;
      // What --check would now find: a managed file no recipe fixes, or one
      // not chosen. A patch looks at no other file, so it claims nothing.
      const left =
        needsPerson(repair) ||
        repair.files.some((file) => file.step === "offer" && file.ownership === "managed");
      const repaired = [
        `Repaired ${repair.name}: changed ${changeSummary(repair.plan)}.`,
        ...(left ? ["Some files still need attention; liftoff repair --check lists them."] : []),
        ...leftBehind(result.leftovers),
      ];
      return {
        outcome: left || result.leftovers.length > 0 ? "attention" : "success",
        report: {
          ...reported(repair),
          ...(patching(repair) ? {} : { needed: left }),
          changed: true,
          leftovers: result.leftovers,
        },
        text: `${repaired.map(shown).join("\n")}\n`,
      };
    },
  };
}

import path from "node:path";
import { readJournal } from "../../application/change/apply-changes.ts";
import {
  applyCleanup,
  type CleanupPlan,
  CleanupStoppedError,
  MissingCopiesError,
  planCleanup,
  removeEmptied,
  withoutCopies,
} from "../../application/migrate/cleanup.ts";
import { AssessError } from "../../application/project/assess-project.ts";
import type { CommandResult, Io, ParsedArgs } from "../command.ts";
import { UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import { changePortsFor, leftBehind, recoverChange, stopped, toCli } from "./changing.ts";
import { newDirectory, type ProjectPorts, projectDirectory } from "./project-ports.ts";

/** How many files each list in the text shows; the JSON report has every one. */
const SHOWN = 20;

const plural = (count: number, what: string) => `${count} ${what}${count === 1 ? "" : "s"}`;

const listOf = (items: readonly string[]) => [
  ...items.slice(0, SHOWN).map((item) => `  ${item}`),
  ...(items.length > SHOWN ? [`  … and ${items.length - SHOWN} more in the --json report`] : []),
];

/** The cleanup, in the words the text shows it. */
export function renderCleanup(cleanup: CleanupPlan, version: string): string[] {
  const lines = [`Liftoff ${version} cleans up ${cleanup.source}, migrated to ${cleanup.target}.`];
  if (cleanup.blocked.length > 0) {
    lines.push(
      `${cleanup.target} is not verified, so nothing is removed:`,
      ...cleanup.blocked.map((reason) => `  - ${reason}`),
    );
  }
  if (cleanup.removals.length > 0) {
    lines.push(
      `${cleanup.blocked.length > 0 ? "Once it is, it would remove" : "It removes"} ${plural(cleanup.removals.length, "file")} that the new project holds byte-for-byte copies of:`,
      ...listOf(cleanup.removals.map((removal) => `${removal.path} (copy: ${removal.copy})`)),
    );
  }
  if (cleanup.kept.length > 0) {
    lines.push(
      `${plural(cleanup.kept.length, "path")} stay in ${cleanup.source}:`,
      ...listOf(cleanup.kept.map((kept) => `${kept.path}: ${kept.why}`)),
    );
  }
  if (cleanup.plans.length > 0) {
    lines.push(
      `It removes them in ${cleanup.plans.length === 1 ? "1 change, which" : `${cleanup.plans.length} changes, each of which`} liftoff migrate --cleanup --recover finishes or undoes if it stops part way, and then the directories they leave empty. Nothing in ${cleanup.target} changes.`,
    );
  }
  // Paths and reasons come from the projects, so every line is escaped.
  return lines.map(shown);
}

/** What the JSON report says about the cleanup. */
const reported = (cleanup: CleanupPlan) => ({
  source: cleanup.source,
  target: cleanup.target,
  verified: cleanup.blocked.length === 0,
  blocked: cleanup.blocked,
  removals: cleanup.removals,
  kept: cleanup.kept,
  plans: cleanup.plans.map((plan) => plan.hash),
});

/** The two projects a cleanup names: the old one, and the new one, by default beside it. */
async function projectsOf(io: Io, args: ParsedArgs): Promise<{ source: string; target: string }> {
  const source = await projectDirectory(io.cwd, args.options.dir as string);
  const to = args.options.to as string | undefined;
  const target = await newDirectory(
    io.cwd,
    to ?? path.join(path.dirname(source), `${path.basename(source)}-liftoff`),
  );
  return { source, target };
}

/**
 * Finishes or undoes a cleanup change that stopped part way. Finishing
 * removes the rest of that change's files, so each must still have a copy
 * in the new project, as when the cleanup was planned; undoing puts back
 * what it removed, and needs nothing of the new project.
 */
export async function recoverCleanup(
  io: Io,
  ports: ProjectPorts,
  args: ParsedArgs,
  mode: "finish" | "undo",
): Promise<CommandResult> {
  const { source, target } = await projectsOf(io, args);
  const refused = (missing: readonly string[]): CommandResult => {
    const lines = [
      `${target} no longer holds a copy of every file the cleanup would still remove, so nothing was removed:`,
      ...listOf(missing),
      "Undo the cleanup instead with liftoff migrate --cleanup --recover undo, or name the new project with --to.",
    ];
    return {
      outcome: "attention",
      report: { directory: source, target, recovered: false, mode, missing },
      text: `${lines.map(shown).join("\n")}\n`,
    };
  };
  const journal = await readJournal(ports.fs, source).catch(() => undefined);
  const cleaning = journal?.operation === "migrate-cleanup";
  // Asked about once before the question, so a doomed finish is not offered,
  // and again under the lock once it is approved, before any file changes.
  const copies = async (changes: readonly { path: string; before: string | null }[]) => {
    const missing = await withoutCopies(ports.fs, source, target, changes);
    if (missing.length > 0) throw new MissingCopiesError(missing);
  };
  let result: CommandResult;
  try {
    if (mode === "finish" && cleaning && journal !== undefined) await copies(journal.changes);
    result = await recoverChange(
      io,
      ports,
      args,
      mode,
      "migrate-cleanup",
      mode === "finish" ? (recovering) => copies(recovering.changes) : undefined,
    );
  } catch (error) {
    if (error instanceof MissingCopiesError) return refused(error.missing);
    throw error;
  }
  if (result.outcome !== "success" || result.report.recovered !== true) return result;
  // Finishing removed the rest of the change's files; undoing put them back.
  const tidied = await removeEmptied(
    ports.fs,
    source,
    mode === "finish" && cleaning && journal !== undefined
      ? journal.changes.map((change) => change.path)
      : [],
  );
  const leftovers = [
    ...((result.report.leftovers as readonly string[] | undefined) ?? []),
    ...tidied.leftovers,
  ];
  return {
    ...result,
    outcome: leftovers.length > 0 ? "attention" : result.outcome,
    report: { ...result.report, directories: tidied.directories, leftovers },
    // The recovery's own text is shown as it is; it was escaped already.
    text: [
      result.text.trimEnd(),
      ...[
        ...leftBehind(tidied.leftovers),
        "A cleanup removes its files in changes, and any after this one did not run; liftoff migrate --cleanup --check shows what is left to remove.",
      ].map(shown),
      "",
    ].join("\n"),
  };
}

/**
 * Removes from the old project what the new one holds byte-for-byte copies
 * of, once the new project is verified and the person agrees (MIGRATE-004).
 */
export async function runCleanup(
  io: Io,
  ports: ProjectPorts,
  args: ParsedArgs,
  version: string,
  refused: readonly string[],
): Promise<CommandResult> {
  const { source, target } = await projectsOf(io, args);
  let cleanup: CleanupPlan;
  try {
    cleanup = await planCleanup(ports.fs, source, target, version, {
      named: args.given.has("dir"),
      refused,
      signal: io.signal,
    });
  } catch (error) {
    if (error instanceof AssessError) throw new UsageError(error.message);
    return toCli(error);
  }
  // Ctrl+C while planning, even for --check, cancels rather than reporting.
  io.signal.throwIfAborted();
  const lines = renderCleanup(cleanup, version);
  const report = reported(cleanup);
  if (cleanup.blocked.length > 0) {
    return {
      outcome: "attention",
      report: { ...report, removed: [] },
      text: `${lines.join("\n")}\n`,
    };
  }
  if (cleanup.removals.length === 0) {
    lines.push(`Nothing to remove: the new project holds no copy of any file that stays.`);
    return {
      outcome: "success",
      report: { ...report, removed: [] },
      text: `${lines.join("\n")}\n`,
    };
  }
  if (args.options.check === true) {
    return {
      outcome: "success",
      report: { ...report, removed: [] },
      text: `${lines.join("\n")}\n`,
    };
  }

  io.stderr(`${lines.join("\n")}\n`);
  if (args.options.yes !== true) {
    if (!io.interactive) {
      throw new UsageError(
        "migrate --cleanup removes files; pass --yes to confirm when no one can answer a prompt",
      );
    }
    const question = `In ${shown(source)}, remove ${plural(cleanup.removals.length, "file")} the new project holds copies of?`;
    if (!(await io.confirm(question))) {
      return {
        outcome: "cancelled",
        report: { ...report, removed: [] },
        text: "Nothing was removed.\n",
      };
    }
  }
  let result: Awaited<ReturnType<typeof applyCleanup>>;
  try {
    result = await applyCleanup(changePortsFor(ports), cleanup, { signal: io.signal });
  } catch (error) {
    const plan = error instanceof CleanupStoppedError ? error.plan : cleanup.plans[0];
    const removed = error instanceof CleanupStoppedError ? error.removed : [];
    const cause = error instanceof CleanupStoppedError ? error.cause : error;
    if (plan === undefined) throw cause;
    const partial = await stopped(
      cause,
      ports,
      { directory: source, plan, contents: new Map() },
      "migrate-cleanup",
      { ...report, removed },
    ).catch((thrown: unknown) => {
      // The change that stopped changed nothing; earlier ones removed theirs.
      if (removed.length === 0) throw thrown;
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return {
        outcome: "failure",
        report: { ...report, removed },
        text: `${shown(`Removed ${plural(removed.length, "file")}, then stopped: ${message}`)}\n`,
      } satisfies CommandResult;
    });
    return partial;
  }
  const done = [
    `Removed ${plural(result.removed.length, "file")} from ${source}${result.directories.length === 0 ? "" : `, and ${result.directories.length} ${result.directories.length === 1 ? "directory" : "directories"} they left empty`}.`,
    ...(result.cancelled
      ? [
          `Cancelled before the rest; ${plural(cleanup.removals.length - result.removed.length, "file")} stay. Run liftoff migrate --cleanup again to remove them.`,
        ]
      : []),
    ...leftBehind(result.leftovers),
  ];
  return {
    outcome: result.cancelled ? "cancelled" : result.leftovers.length > 0 ? "attention" : "success",
    report: {
      ...report,
      removed: result.removed,
      directories: result.directories,
      leftovers: result.leftovers,
    },
    text: `${done.map(shown).join("\n")}\n`,
  };
}

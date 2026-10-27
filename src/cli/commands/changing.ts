import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyChanges,
  CHANGE_COMMANDS,
  ChangeError,
  type ChangePorts,
  type ChangeResult,
  ChangeStoppedError,
  type NewContent,
  readJournal,
  recoverChanges,
  UNREADABLE_JOURNAL_ADVICE,
  type Unchanged,
} from "../../application/change/apply-changes.ts";
import { ProjectChangeUnsupportedError } from "../../application/change/project-change.ts";
import { JournalError } from "../../domain/change/journal.ts";
import {
  CHANGE_JOURNAL_FILE,
  type ChangePlan,
  parseChangePlan,
} from "../../domain/plan/change-plan.ts";
import { SelectionError } from "../../plugins/registry.ts";
import type { CommandResult, Io, ParsedArgs } from "../command.ts";
import { UnsupportedError, UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import { type ProjectPorts, projectDirectory } from "./project-ports.ts";

/** The commands that change an existing project file by file, with how each is named in text. */
const NAMES = {
  update: { a: "An update", the: "The update", no: "No update" },
  repair: { a: "A repair", the: "The repair", no: "No repair" },
} as const;
export type ChangeCommand = keyof typeof NAMES;

/** A planned change, ready to approve and apply. */
export interface Planned {
  readonly directory: string;
  readonly plan: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
  readonly unchanged: readonly Unchanged[];
}

export const changePortsFor = (ports: ProjectPorts): ChangePorts => ({
  fs: ports.fs,
  processes: ports.processes,
  now: () => new Date().toISOString(),
});

/**
 * Turns a refusal into the right exit code. A configuration this release
 * cannot make came from liftoff.yaml, not the command line, so it is
 * unsupported here.
 */
export function toCli(error: unknown): never {
  if (error instanceof ProjectChangeUnsupportedError || error instanceof SelectionError) {
    throw new UnsupportedError(error.message);
  }
  throw error;
}

/** Paths named in a comma-separated option. */
export function listed(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
}

/** What a plan changes: its files, then the manifest. */
export function changeSummary(plan: ChangePlan | undefined): string {
  const files = (plan?.changes.length ?? 1) - 1;
  return files === 0 ? "the manifest" : `${files} file${files === 1 ? "" : "s"}, then the manifest`;
}

/** The line that names a plan and what it may do. */
export const planLine = (plan: ChangePlan): string =>
  `Plan ${plan.hash.slice(0, 12)}: changes ${changeSummary(plan)}. Effects: modify-files (nothing is installed, run or sent anywhere).`;

/** What a change or recovery could not remove, for the person to delete. */
export const leftBehind = (leftovers: readonly string[], complete = true): string[] =>
  leftovers.length === 0
    ? []
    : [
        complete ? "Left behind once every file had changed:" : "Could not be removed:",
        ...leftovers.map((left) => `  ${left}`),
      ];

/**
 * Refuses option combinations every change command shares: --check writes
 * nothing, not even a plan, and neither it nor --out needs --yes.
 */
export function checkPreview(args: ParsedArgs): { readonly preview: boolean } {
  const check = args.options.check === true;
  const out = args.options.out !== undefined;
  if (check && out) throw new UsageError("--check writes nothing, so it goes without --out");
  if ((check || out) && args.options.yes === true) {
    throw new UsageError(
      "--check and --out change nothing in the project, so --yes has nothing to confirm",
    );
  }
  return { preview: check || out };
}

/** A saved change plan named on the command line. */
export async function readSavedPlan(io: Io, file: string): Promise<ChangePlan> {
  const text = await readFile(path.resolve(io.cwd, file), "utf8").catch(() => {
    throw new UsageError(`cannot read the plan ${file}`);
  });
  return parseChangePlan(text);
}

/** Saves a plan for --plan, or says there was nothing to save. */
export async function savePlan(
  io: Io,
  out: string,
  plan: ChangePlan | undefined,
  command: ChangeCommand,
  applyWith = "",
): Promise<string[]> {
  if (plan === undefined) return ["", "There is nothing to change, so no plan was saved."];
  const file = path.resolve(io.cwd, out);
  io.signal.throwIfAborted();
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
  return [
    "",
    `Saved the plan to ${shown(file)}.`,
    `Apply it with: liftoff ${command} --plan ${shown(out)}${applyWith}`,
  ];
}

/**
 * Asks before changing anything, unless --yes, then applies the change. It
 * returns the change's result, or what to report instead: that the person
 * said no, or that the change stopped part way.
 */
export async function applyApproved(
  io: Io,
  ports: ProjectPorts,
  planned: Planned,
  command: ChangeCommand,
  options: { readonly yes: boolean; readonly report: Readonly<Record<string, unknown>> },
): Promise<ChangeResult | CommandResult> {
  const { report } = options;
  if (!options.yes) {
    if (!io.interactive) {
      throw new UsageError(
        `${command} changes files; pass --yes to confirm when no one can answer a prompt`,
      );
    }
    const question = `In ${shown(planned.directory)}, change ${changeSummary(planned.plan)}?`;
    if (!(await io.confirm(question))) {
      return {
        outcome: "cancelled",
        report: { ...report, changed: false },
        text: "Nothing was changed.\n",
      };
    }
  }
  try {
    return await applyChanges(changePortsFor(ports), planned.plan, planned.contents, {
      unchanged: planned.unchanged,
      signal: io.signal,
    });
  } catch (error) {
    return stopped(error, ports, planned, command, report);
  }
}

/**
 * A change that stopped after its journal was written stopped part way,
 * whatever stopped it, and is reported as partial with how to recover.
 * Anything else changed nothing and is rethrown.
 */
async function stopped(
  error: unknown,
  ports: ProjectPorts,
  planned: Planned,
  command: ChangeCommand,
  report: Readonly<Record<string, unknown>>,
): Promise<CommandResult> {
  const journal =
    error instanceof ChangeStoppedError || !(error instanceof ChangeError)
      ? await readJournal(ports.fs, planned.directory).catch(() => undefined)
      : undefined;
  if (journal?.plan !== planned.plan.hash) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const recover = `${CHANGE_COMMANDS[command]} --recover`;
  return {
    outcome: "partial",
    report: { ...report, changed: true, stopped: message },
    text: `${shown(`${NAMES[command].the} stopped part way: ${message}`)}\nFinish it with ${recover} finish, or undo it with ${recover} undo.\n`,
  };
}

/** Finishes or undoes a change by this command that stopped part way, after asking. */
export async function recoverChange(
  io: Io,
  ports: ProjectPorts,
  args: ParsedArgs,
  mode: "finish" | "undo",
  command: ChangeCommand,
): Promise<CommandResult> {
  const names = NAMES[command];
  const directory = await projectDirectory(io.cwd, args.options.dir as string);
  const journal = await readJournal(ports.fs, directory).catch((error: unknown) => {
    if (!(error instanceof JournalError)) throw error;
    throw new ChangeError(`${error.message}; ${UNREADABLE_JOURNAL_ADVICE}`);
  });
  if (journal === undefined) {
    return {
      outcome: "success",
      report: { directory, recovered: false },
      text: `${names.no} to ${shown(directory)} stopped part way; there is nothing to recover.\n`,
    };
  }
  if (journal.operation !== command) {
    const other = CHANGE_COMMANDS[journal.operation];
    throw new UsageError(
      `the change that stopped was made by ${other}; recover it with ${other} --recover`,
    );
  }
  io.stderr(
    `${shown(`${names.a} to ${directory} that began ${journal.started} stopped part way; it changes ${journal.changes.length} files, recorded in ${CHANGE_JOURNAL_FILE}.`)}\n`,
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
  const done = mode === "finish" ? "finished" : "undone";
  let result: Awaited<ReturnType<typeof recoverChanges>>;
  try {
    // Only the change shown and approved, not one that stopped since.
    result = await recoverChanges(changePortsFor(ports), directory, mode, {
      plan: journal.plan,
      signal: io.signal,
    });
  } catch (error) {
    // A refusal, or the cancel recovery raises before any file changed,
    // changed nothing; anything else, even after Ctrl+C, may have stopped it
    // part way.
    const cancelled = io.signal.aborted && error === io.signal.reason;
    if (!(error instanceof ChangeStoppedError) && (error instanceof ChangeError || cancelled)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "partial",
      report: { directory, recovered: false, mode, stopped: message },
      text: `${shown(`Recovery stopped: ${message}`)}\n${names.the} is still not ${done}, and ${CHANGE_JOURNAL_FILE} stays; run ${CHANGE_COMMANDS[command]} --recover ${mode} again.\n`,
    };
  }
  const list = (heading: string, files: readonly string[]) =>
    files.length === 0 ? [] : [heading, ...files.map((file) => `  ${file}`)];
  const lines = [
    result.complete
      ? `${names.the} is ${done}: ${result.changed.length} file${result.changed.length === 1 ? "" : "s"} changed.`
      : `${names.the} is not yet ${done}; ${CHANGE_JOURNAL_FILE} stays until it is.`,
    ...list("Changed:", result.changed),
    ...list(
      "Changed by something else meanwhile, so left as they are; put each back as it was, then run this again:",
      result.conflicts,
    ),
    ...list("Waiting until those are resolved:", result.waiting),
    ...leftBehind(result.leftovers, result.complete),
  ];
  return {
    outcome: !result.complete ? "partial" : result.leftovers.length > 0 ? "attention" : "success",
    report: { directory, recovered: result.complete, mode, ...result },
    text: `${lines.map(shown).join("\n")}\n`,
  };
}

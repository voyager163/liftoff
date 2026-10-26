import path from "node:path";
import {
  type ChangeJournal,
  type FileNow,
  fileMatches,
  JournalError,
  journalFor,
  parseJournal,
  recoverySteps,
  serializeJournal,
} from "../../domain/change/journal.ts";
import {
  CHANGE_JOURNAL_FILE,
  type ChangeOperation,
  type ChangePlan,
} from "../../domain/plan/change-plan.ts";
import { PlanError, sha256Hex } from "../../domain/plan/plan.ts";
import type { ProjectFsPort } from "../ports.ts";

/** A file over this is never part of a change; no file Liftoff manages comes near it. */
export const MAX_CHANGED_BYTES = 64 * 1024 * 1024;

/** The command that makes, and recovers, each kind of change. */
export const CHANGE_COMMANDS: Record<ChangeOperation, string> = {
  update: "liftoff update",
  repair: "liftoff repair",
  adopt: "liftoff adopt",
  "workflow-set": "liftoff workflow set",
  "profile-set": "liftoff governance profile set",
  "agents-add": "liftoff agents add",
};

export class ChangeError extends Error {
  override readonly name: string = "ChangeError";
}

/** Files are not as the plan expects. Nothing was changed. */
export class ChangeConflictError extends ChangeError {
  override readonly name = "ChangeConflictError";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`nothing was changed: ${problems.join("; ")}; make a new plan`);
    this.problems = problems;
  }
}

export interface NewContent {
  readonly content: string;
  readonly executable: boolean;
}

/**
 * Makes a planned change to a project, file by file, never overwriting a
 * file that changed since the plan was made. `contents` holds each new
 * file's content, which must hash to what the plan says. Each file is
 * checked, its original kept byte for byte beside the project, and the
 * change recorded in a journal before the first file is replaced; each
 * file is checked again just before it is replaced in one step. If the
 * change stops part way, the journal stays so recoverChanges can finish or
 * undo it. A change across files is not atomic, and Liftoff does not claim
 * it is.
 */
export async function applyChanges(
  fs: ProjectFsPort,
  plan: ChangePlan,
  contents: ReadonlyMap<string, NewContent>,
  now: () => string,
): Promise<{ readonly changed: number }> {
  checkContents(plan, contents);
  const root = plan.target;
  if ((await fs.entry(path.join(root, ...CHANGE_JOURNAL_FILE.split("/")))).kind !== "missing") {
    throw new ChangeError(
      `a change to this project stopped part way (see ${CHANGE_JOURNAL_FILE}); finish or undo it before making another`,
    );
  }
  const problems: string[] = [];
  for (const change of plan.changes) {
    const current = await fileNow(fs, root, change.path);
    if (!fileMatches(current, change.before)) {
      problems.push(describe(change.path, current, change.before));
    }
  }
  if (problems.length > 0) throw new ChangeConflictError(problems);

  const staging = await fs.createStaging(root);
  try {
    for (const change of plan.changes) {
      const relative = change.path.split("/");
      const planned = contents.get(change.path);
      if (planned !== undefined) {
        await fs.writeFile(
          path.join(staging, "after", ...relative),
          planned.content,
          planned.executable,
        );
      }
      if (change.before !== null) {
        const kept = `before/${change.path}`;
        await fs.copyFile(path.join(root, ...relative), path.join(staging, ...kept.split("/")));
        // The copy must be exactly what was checked, or the original changed meanwhile.
        if (!fileMatches(await fileNow(fs, staging, kept), change.before)) {
          throw new ChangeConflictError([`${change.path} changed while it was being kept`]);
        }
      }
    }
  } catch (error) {
    await fs.remove(staging);
    throw error;
  }
  const journal = journalFor(plan, path.basename(staging), now());
  const journalPath = path.join(root, ...CHANGE_JOURNAL_FILE.split("/"));
  if (!(await fs.createExclusive(journalPath, serializeJournal(journal)))) {
    await fs.remove(staging);
    throw new ChangeError(
      "another change to this project began at the same time; nothing was changed",
    );
  }

  for (const change of plan.changes) {
    const target = path.join(root, ...change.path.split("/"));
    if (!fileMatches(await fileNow(fs, root, change.path), change.before)) {
      throw new ChangeError(
        `${change.path} changed while the change was being made, so it and the files after it were left alone; finish or undo the change with ${CHANGE_COMMANDS[plan.operation]} --recover`,
      );
    }
    if (change.after === null) {
      await fs.moveFile(target, path.join(staging, "removed", ...change.path.split("/")));
    } else {
      await fs.moveFile(path.join(staging, "after", ...change.path.split("/")), target);
    }
  }
  await fs.remove(journalPath);
  await fs.remove(staging);
  return { changed: plan.changes.length };
}

export interface RecoveryResult {
  readonly operation: ChangeOperation;
  /** Files recovery changed. */
  readonly changed: readonly string[];
  /** Files something else changed meanwhile, left as they are. */
  readonly conflicts: readonly string[];
  /** Whether the change is now finished or undone, and its journal removed. */
  readonly complete: boolean;
}

/**
 * Finishes or undoes a change that stopped part way. Each file's step comes
 * from what is there now: one already as wanted is left alone, one still as
 * the change found it (finishing) or as the change left it (undoing) is
 * replaced, and any other is a file something else changed, which is never
 * overwritten. While any such file remains, the journal stays.
 */
export async function recoverChanges(
  fs: ProjectFsPort,
  root: string,
  mode: "finish" | "undo",
): Promise<RecoveryResult> {
  const journal = await readJournal(fs, root);
  if (journal === undefined) throw new ChangeError("no change to this project stopped part way");
  const staging = path.join(path.dirname(root), journal.staging);
  const current = new Map<string, FileNow>();
  for (const change of journal.changes) {
    current.set(change.path, await fileNow(fs, root, change.path));
  }
  const changed: string[] = [];
  const conflicts: string[] = [];
  for (const step of recoverySteps(journal, current, mode)) {
    if (step.step === "done") continue;
    const change = journal.changes.find((entry) => entry.path === step.path);
    if (step.step === "conflict" || change === undefined) {
      conflicts.push(step.path);
      continue;
    }
    const from = mode === "finish" ? change.before : change.after;
    const relative = step.path.split("/");
    const target = path.join(root, ...relative);
    // Checked again just before, as when the change was made.
    if (!fileMatches(await fileNow(fs, root, step.path), from)) {
      conflicts.push(step.path);
      continue;
    }
    if (step.wanted === null) {
      await fs.moveFile(
        target,
        path.join(staging, mode === "finish" ? "removed" : "discarded", ...relative),
      );
    } else {
      const source = `${mode === "finish" ? "after" : "before"}/${step.path}`;
      if (!fileMatches(await fileNow(fs, staging, source), step.wanted)) {
        // What it should become is gone or altered, so it is left alone.
        conflicts.push(step.path);
        continue;
      }
      await fs.moveFile(path.join(staging, ...source.split("/")), target);
    }
    changed.push(step.path);
  }
  const complete = conflicts.length === 0;
  if (complete) {
    await fs.remove(path.join(root, ...CHANGE_JOURNAL_FILE.split("/")));
    await fs.remove(staging);
  }
  return { operation: journal.operation, changed, conflicts, complete };
}

/** The journal of a change that stopped part way, if there is one. */
export async function readJournal(
  fs: ProjectFsPort,
  root: string,
): Promise<ChangeJournal | undefined> {
  const read = await fs.readWithin(root, CHANGE_JOURNAL_FILE, 1024 * 1024);
  if (read.kind === "missing") return undefined;
  if (read.kind !== "file" || read.text === undefined) {
    throw new JournalError(`${CHANGE_JOURNAL_FILE} is not a regular file Liftoff can read`);
  }
  return parseJournal(read.text);
}

/** Every new file's content must be given, hash to the plan's, and be executable as planned. */
function checkContents(plan: ChangePlan, contents: ReadonlyMap<string, NewContent>): void {
  const expected = plan.changes.filter((change) => change.after !== null);
  if (contents.size !== expected.length) {
    throw new PlanError("the new files do not match the plan; make a new plan");
  }
  for (const change of expected) {
    const content = contents.get(change.path);
    if (
      content === undefined ||
      sha256Hex(content.content) !== change.after ||
      content.executable !== change.executable
    ) {
      throw new PlanError(
        `${change.path} would now differ from what the plan lists; make a new plan`,
      );
    }
  }
}

async function fileNow(fs: ProjectFsPort, root: string, relative: string): Promise<FileNow> {
  const hashed = await fs.hashWithin(root, relative, MAX_CHANGED_BYTES);
  if (hashed.kind === "missing") return { kind: "absent" };
  if (hashed.kind === "file" && hashed.sha256 !== undefined) {
    return { kind: "file", sha256: hashed.sha256 };
  }
  return { kind: "other" };
}

const describe = (relative: string, now: FileNow, before: string | null) =>
  now.kind === "other"
    ? `${relative} is not a regular file Liftoff can read`
    : now.kind === "absent"
      ? `${relative} is missing`
      : before === null
        ? `${relative} already exists`
        : `${relative} changed since the plan was made`;

import path from "node:path";
import {
  type ChangeJournal,
  type FileNow,
  fileMatches,
  JournalError,
  journalFor,
  parseJournal,
  parseStagingMarker,
  recoverySteps,
  STAGING_MARKER,
  serializeJournal,
  stagingMarker,
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
 * file's content, which must hash to what the plan says.
 *
 * The new files are staged beside the project with a marker binding them
 * to this project and plan, and the journal is created before anything is
 * checked: it is the lock, so a change that finished meanwhile is seen.
 * Every file must then be as planned, or nothing changes. Each file is
 * checked again, its original kept byte for byte, and replaced in one
 * step. If the change stops part way, the journal stays so recoverChanges
 * can finish or undo it. A change across files is not atomic, and Liftoff
 * does not claim it is.
 */
export async function applyChanges(
  fs: ProjectFsPort,
  plan: ChangePlan,
  contents: ReadonlyMap<string, NewContent>,
  now: () => string,
): Promise<{ readonly changed: number }> {
  checkContents(plan, contents);
  const root = plan.target;
  const journalPath = path.join(root, ...CHANGE_JOURNAL_FILE.split("/"));
  if ((await fs.entry(journalPath)).kind !== "missing") {
    throw new ChangeError(
      `a change to this project stopped part way (see ${CHANGE_JOURNAL_FILE}); finish or undo it before making another`,
    );
  }
  const project = await fs.directoryIdentity(root);
  if (project === undefined) throw new ChangeError(`${root} is not a directory Liftoff can change`);

  const staging = await fs.createStaging(root);
  let locked = false;
  try {
    for (const change of plan.changes) {
      const planned = contents.get(change.path);
      if (planned === undefined) continue;
      await fs.writeFile(
        path.join(staging, "after", ...change.path.split("/")),
        planned.content,
        planned.executable,
      );
    }
    await fs.writeFile(
      path.join(staging, STAGING_MARKER),
      `${JSON.stringify(stagingMarker(plan.hash, project))}\n`,
      false,
    );
    const journal = journalFor(plan, path.basename(staging), now());
    locked = await fs.createExclusive(journalPath, serializeJournal(journal));
  } finally {
    if (!locked) await fs.remove(staging);
  }
  if (!locked) {
    throw new ChangeError(
      "another change to this project began at the same time; nothing was changed",
    );
  }

  const problems: string[] = [];
  for (const change of plan.changes) {
    const current = await fileNow(fs, root, change.path);
    if (!fileMatches(current, change.before)) {
      problems.push(describe(change.path, current, change.before));
    }
  }
  if (problems.length > 0) {
    await fs.remove(journalPath);
    await fs.remove(staging);
    throw new ChangeConflictError(problems);
  }

  for (const change of plan.changes) {
    if (!fileMatches(await fileNow(fs, root, change.path), change.before)) {
      throw new ChangeError(
        `${change.path} changed while the change was being made, so it and the files after it were left alone; finish or undo the change with ${CHANGE_COMMANDS[plan.operation]} --recover`,
      );
    }
    if (!(await keep(fs, root, staging, change))) {
      throw new ChangeError(
        `${change.path} changed while it was being kept, so it and the files after it were left alone; finish or undo the change with ${CHANGE_COMMANDS[plan.operation]} --recover`,
      );
    }
    await put(fs, root, staging, change.path, change.after === null ? "removed" : "after");
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
 * Finishes or undoes a change that stopped part way, and can be run again
 * either way until it completes. The staging directory must be a real
 * directory whose marker names this project, not a copy of it, and this
 * plan. Each file's step comes from what is there now: one already as
 * wanted is left alone, one still as the change found it (finishing) or as
 * the change left it (undoing) is replaced, and any other is a file
 * something else changed, which is never overwritten. While any such file
 * remains, the journal stays. The kept files are copied into place, never
 * used up, so finishing and undoing can follow each other.
 */
export async function recoverChanges(
  fs: ProjectFsPort,
  root: string,
  mode: "finish" | "undo",
): Promise<RecoveryResult> {
  const journal = await readJournal(fs, root);
  if (journal === undefined) throw new ChangeError("no change to this project stopped part way");
  const staging = path.join(path.dirname(root), journal.staging);
  await checkStaging(fs, root, staging, journal.plan);
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
    // Checked again just before, as when the change was made.
    if (!fileMatches(await fileNow(fs, root, step.path), from)) {
      conflicts.push(step.path);
      continue;
    }
    const source = step.wanted === null ? undefined : mode === "finish" ? "after" : "before";
    if (
      (source !== undefined &&
        !fileMatches(await fileNow(fs, staging, `${source}/${step.path}`), step.wanted)) ||
      (mode === "finish" && !(await keep(fs, root, staging, change)))
    ) {
      // What it should become is gone or altered, or its original could not
      // be kept, so it is left alone.
      conflicts.push(step.path);
      continue;
    }
    await put(
      fs,
      root,
      staging,
      step.path,
      source ?? (mode === "finish" ? "removed" : "discarded"),
    );
    changed.push(step.path);
  }
  const complete = conflicts.length === 0;
  if (complete) {
    await fs.remove(path.join(root, ...CHANGE_JOURNAL_FILE.split("/")));
    await fs.remove(staging);
  }
  return { operation: journal.operation, changed, conflicts, complete };
}

/**
 * The staging directory a journal names must be a real directory beside
 * the project whose marker names this project and plan.
 */
async function checkStaging(
  fs: ProjectFsPort,
  root: string,
  staging: string,
  plan: string,
): Promise<void> {
  const where = `${path.basename(staging)} beside the project`;
  if ((await fs.directoryIdentity(staging)) === undefined) {
    throw new ChangeError(
      `the files this change kept, in ${where}, are missing or not a directory, so it cannot be recovered; restore the project from version control and delete ${CHANGE_JOURNAL_FILE}`,
    );
  }
  const read = await fs.readWithin(staging, STAGING_MARKER, 4096);
  const marker =
    read.kind === "file" && read.text !== undefined ? parseStagingMarker(read.text) : undefined;
  if (
    marker === undefined ||
    marker.plan !== plan ||
    marker.project !== (await fs.directoryIdentity(root))
  ) {
    throw new ChangeError(
      `${CHANGE_JOURNAL_FILE} belongs to another copy of this project or another change, so it is not recovered here; delete it if this copy was not being changed`,
    );
  }
}

/**
 * Keeps a byte-for-byte copy of a file's original before it is replaced or
 * removed, once; false if the original no longer matches the plan.
 */
async function keep(
  fs: ProjectFsPort,
  root: string,
  staging: string,
  change: { readonly path: string; readonly before: string | null },
): Promise<boolean> {
  if (change.before === null) return true;
  const kept = `before/${change.path}`;
  if (fileMatches(await fileNow(fs, staging, kept), change.before)) return true;
  const copy = path.join(staging, ...kept.split("/"));
  await fs.remove(copy);
  await fs.copyFile(path.join(root, ...change.path.split("/")), copy);
  return fileMatches(await fileNow(fs, staging, kept), change.before);
}

/**
 * Puts a file in its place in one step. A new or original file is copied
 * from staging first, so it stays there for recovery; "removed" and
 * "discarded" move the project's file into staging instead.
 */
async function put(
  fs: ProjectFsPort,
  root: string,
  staging: string,
  relative: string,
  source: "after" | "before" | "removed" | "discarded",
): Promise<void> {
  const parts = relative.split("/");
  const target = path.join(root, ...parts);
  if (source === "removed" || source === "discarded") {
    await fs.moveFile(target, path.join(staging, source, ...parts));
    return;
  }
  const placing = path.join(staging, "placing", ...parts);
  await fs.remove(placing);
  await fs.copyFile(path.join(staging, source, ...parts), placing);
  await fs.moveFile(placing, target);
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

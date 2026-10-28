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
import { CONFIG_FILE } from "../../domain/project/config.ts";
import { MANIFEST_FILE } from "../../domain/project/manifest.ts";
import type { ProcessesPort, ProjectFsPort } from "../ports.ts";

/** A file over this is never part of a change; no file Liftoff manages comes near it. */
export const MAX_CHANGED_BYTES = 64 * 1024 * 1024;

/** The largest journal a change may write, which is also the most recovery reads. */
export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

/**
 * Held by whichever Liftoff command is changing or recovering the project,
 * for as long as it runs. The journal outlives a command that stops part
 * way; the lock says whether one is still running.
 */
export const CHANGE_LOCK_FILE = ".liftoff/change.lock";

/** The command that makes, and recovers, each kind of change. */
export const CHANGE_COMMANDS: Record<ChangeOperation, string> = {
  update: "liftoff update",
  repair: "liftoff repair",
  adopt: "liftoff adopt",
  "migrate-cleanup": "liftoff migrate --cleanup",
  "workflow-set": "liftoff workflow set",
  "profile-set": "liftoff governance profile set",
  "agents-add": "liftoff agents add",
};

export interface ChangePorts {
  readonly fs: ProjectFsPort;
  readonly processes: ProcessesPort;
  /** The person's clock, for the journal and the lock. */
  readonly now: () => string;
}

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

/**
 * A change stopped part way: the files before the one named changed, and the
 * journal stays so the change can be finished or undone.
 */
export class ChangeStoppedError extends ChangeError {
  override readonly name = "ChangeStoppedError";
}

export interface NewContent {
  readonly content: string;
  readonly executable: boolean;
}

/**
 * Files a change does not touch but rests on, such as the configuration an
 * update was planned from, each with the sha256 it must still have, or null
 * when it must still be absent.
 */
export interface Unchanged {
  readonly path: string;
  readonly sha256: string | null;
}

export interface ChangeOptions {
  /**
   * Stops the change between files. Before the first, nothing changes;
   * after, it stops part way and can be recovered.
   */
  readonly signal?: AbortSignal;
}

export interface ChangeResult {
  readonly changed: number;
  /**
   * What could not be removed once every file had changed, such as the kept
   * copies or the lock, for the person to delete. The change is complete.
   */
  readonly leftovers: readonly string[];
}

/**
 * Makes a planned change to a project, file by file, never overwriting a
 * file that changed since the plan was made. `contents` holds each new
 * file's content, which must hash to what the plan says. Each file the
 * plan rests on without changing must still be as it was, too, or nothing
 * changes. A `signal` stops it between files.
 *
 * It holds the change lock throughout. The new files are staged beside the
 * project with a marker binding them to this project and plan, and the
 * journal is written. Every file must then be as planned, or nothing
 * changes. For each file in turn, its original is kept byte for byte, its
 * replacement prepared, and only then is it checked once more and replaced
 * in one step. If the change stops part way, the journal stays so
 * recoverChanges can finish or undo it. A change across files is not
 * atomic, and Liftoff does not claim it is.
 */
export async function applyChanges(
  ports: ChangePorts,
  plan: ChangePlan,
  contents: ReadonlyMap<string, NewContent>,
  options: ChangeOptions = {},
): Promise<ChangeResult> {
  const { fs, now } = ports;
  const { signal } = options;
  checkContents(plan, contents);
  signal?.throwIfAborted();
  const root = plan.target;
  // The staging directory's name has this length, so the size is exact.
  const named = `.${path.basename(root)}.liftoff-staging-XXXXXX`;
  if (Buffer.byteLength(serializeJournal(journalFor(plan, named, now()))) > MAX_JOURNAL_BYTES) {
    throw new PlanError(
      "the plan changes too many files to recover if it stopped part way; split it into smaller changes",
    );
  }
  const leftovers: string[] = [];
  const changed = await withChangeLock(ports, root, leftovers, async () => {
    const journalPath = path.join(root, ...CHANGE_JOURNAL_FILE.split("/"));
    if ((await fs.entry(journalPath)).kind !== "missing") {
      throw new ChangeError(
        `a change to this project stopped part way (see ${CHANGE_JOURNAL_FILE}); finish or undo it before making another`,
      );
    }
    const project = await fs.directoryIdentity(root);
    if (project === undefined) {
      throw new ChangeError(`${root} is not a directory Liftoff can change`);
    }
    // Private, as it holds copies of the project's files.
    const staging = await fs.createStaging(root, "private");
    let journaled = false;
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
      await checkRecordsDirectory(fs, root, false);
      // Written whole under another name, then renamed into place, so a
      // journal is never found half written. The lock keeps other changes out.
      await fs.replaceFile(journalPath, serializeJournal(journal));
      journaled = true;
    } finally {
      if (!journaled) await fs.remove(staging);
    }
    if (!journaled) {
      throw new ChangeError(
        `${CHANGE_JOURNAL_FILE} appeared while the change was being prepared; nothing was changed`,
      );
    }

    const problems: string[] = [];
    for (const { path: relative, before } of [
      ...plan.changes,
      ...plan.unchanged.map((file) => ({ path: file.path, before: file.sha256 })),
    ]) {
      const current = await fileNow(fs, root, relative);
      if (!fileMatches(current, before)) problems.push(describe(relative, current, before));
    }
    if (problems.length > 0) {
      await fs.remove(journalPath);
      await fs.remove(staging);
      throw new ChangeConflictError(problems);
    }

    for (const [index, change] of plan.changes.entries()) {
      if (signal?.aborted) {
        if (index === 0) {
          await fs.remove(journalPath);
          await fs.remove(staging);
          signal.throwIfAborted();
        }
        throw new ChangeStoppedError(
          `the change was cancelled after ${index} of ${plan.changes.length} files; finish or undo it with ${CHANGE_COMMANDS[plan.operation]} --recover`,
        );
      }
      const source = change.after === null ? "removed" : "after";
      if (!(await changeFile(fs, root, staging, change, change.before, source, true))) {
        throw new ChangeStoppedError(
          `${change.path} changed while the change was being made, so it and the files after it were left alone; finish or undo the change with ${CHANGE_COMMANDS[plan.operation]} --recover`,
        );
      }
    }
    // Once the journal is gone the change is complete, whatever is left.
    await fs.remove(journalPath);
    await tidy(
      fs,
      staging,
      `the kept copies in ${path.basename(staging)} beside the project`,
      leftovers,
    );
    return plan.changes.length;
  });
  return { changed, leftovers };
}

export interface RecoveryResult {
  readonly operation: ChangeOperation;
  /** Files recovery changed. */
  readonly changed: readonly string[];
  /** Files something else changed meanwhile, left as they are. */
  readonly conflicts: readonly string[];
  /** liftoff.yaml and the manifest, left until no other file conflicts. */
  readonly waiting: readonly string[];
  /** Whether the change is now finished or undone, and its journal removed. */
  readonly complete: boolean;
  /**
   * What could not be removed, for the person to delete: the kept copies
   * once it is complete, and the lock either way.
   */
  readonly leftovers: readonly string[];
}

/**
 * Finishes or undoes a change that stopped part way, and can be run again
 * either way until it completes. It holds the change lock, so it never
 * runs beside a change still being made or another recovery. The staging
 * directory must be a real directory whose marker names this project, not a
 * copy of it, and this plan. Each file's step comes from what is there now:
 * one already as wanted is left alone, one still as the change found it
 * (finishing) or as the change left it (undoing) is replaced, and any other
 * is a file something else changed, which is never overwritten.
 * liftoff.yaml and the manifest change only once every other file has, so
 * the manifest never describes files that are not there. While anything is
 * left, the journal stays. The kept files are copied into place, never
 * used up, so finishing and undoing can follow each other. With `plan`, it
 * recovers only the change with that plan, the one the person was shown,
 * and refuses any other found under the lock. A `signal` stops it between
 * files, leaving the journal for another run.
 */
export async function recoverChanges(
  ports: ChangePorts,
  root: string,
  mode: "finish" | "undo",
  options: {
    readonly plan?: string;
    readonly signal?: AbortSignal;
    /**
     * What else must hold before anything changes, checked under the lock
     * against the journal being recovered; it throws a ChangeError to refuse.
     */
    readonly check?: (journal: ChangeJournal) => Promise<void>;
  } = {},
): Promise<RecoveryResult> {
  const { fs } = ports;
  const { plan, signal, check } = options;
  const leftovers: string[] = [];
  const result = await withChangeLock(ports, root, leftovers, async () => {
    const journal = await readJournal(fs, root).catch((error: unknown) => {
      if (!(error instanceof JournalError)) throw error;
      throw new ChangeError(`${error.message}; ${UNREADABLE_JOURNAL_ADVICE}`);
    });
    if (journal === undefined) {
      throw new ChangeError("no change to this project stopped part way");
    }
    if (plan !== undefined && journal.plan !== plan) {
      throw new ChangeError(
        "the change that stopped is no longer the one shown, as another command changed the project meanwhile; nothing was changed, so run the recovery again to see it",
      );
    }
    const staging = path.join(path.dirname(root), journal.staging);
    await checkStaging(fs, root, staging, journal.plan);
    await check?.(journal);
    const current = new Map<string, FileNow>();
    for (const change of journal.changes) {
      current.set(change.path, await fileNow(fs, root, change.path));
    }
    const changed: string[] = [];
    const conflicts: string[] = [];
    const waiting: string[] = [];
    // Finishing rests on what the change rested on: if any of it changed,
    // nothing is finished, and the change can still be undone.
    if (mode === "finish") {
      for (const file of journal.unchanged) {
        if (!fileMatches(await fileNow(fs, root, file.path), file.sha256)) {
          conflicts.push(file.path);
        }
      }
    }
    const steps = recoverySteps(journal, current, mode);
    if (conflicts.length > 0) {
      waiting.push(...steps.filter((step) => step.step !== "done").map((step) => step.path));
    }
    // Checked before every step, whatever it is, and before tidying up.
    const stopIfCancelled = () => {
      if (!signal?.aborted) return;
      if (changed.length === 0) signal.throwIfAborted();
      throw new ChangeStoppedError(
        `recovery was cancelled after ${changed.length} file${changed.length === 1 ? "" : "s"}; run it again`,
      );
    };
    for (const step of conflicts.length > 0 ? [] : steps) {
      stopIfCancelled();
      if (step.step === "done") continue;
      const change = journal.changes.find((entry) => entry.path === step.path);
      // Changes are ordered with liftoff.yaml and the manifest last.
      if ((step.path === CONFIG_FILE || step.path === MANIFEST_FILE) && conflicts.length > 0) {
        waiting.push(step.path);
        continue;
      }
      if (step.step === "conflict" || change === undefined) {
        conflicts.push(step.path);
        continue;
      }
      const source =
        step.wanted === null
          ? mode === "finish"
            ? "removed"
            : "discarded"
          : mode === "finish"
            ? "after"
            : "before";
      const sourceIntact =
        (source !== "after" && source !== "before") ||
        fileMatches(await fileNow(fs, staging, `${source}/${step.path}`), step.wanted);
      const from = mode === "finish" ? change.before : change.after;
      if (
        sourceIntact &&
        (await changeFile(fs, root, staging, change, from, source, mode === "finish"))
      ) {
        changed.push(step.path);
      } else {
        // What it should become is gone or altered, or it changed meanwhile.
        conflicts.push(step.path);
      }
    }
    stopIfCancelled();
    const complete = conflicts.length === 0 && waiting.length === 0;
    if (complete) {
      await fs.remove(path.join(root, ...CHANGE_JOURNAL_FILE.split("/")));
      await tidy(
        fs,
        staging,
        `the kept copies in ${journal.staging} beside the project`,
        leftovers,
      );
    }
    return { operation: journal.operation, changed, conflicts, waiting, complete };
  });
  return { ...result, leftovers };
}

/** What to do about a journal that cannot be read. */
export const UNREADABLE_JOURNAL_ADVICE = `if it is empty, the change stopped before any file changed, so delete it; otherwise restore the project from version control, then delete ${CHANGE_JOURNAL_FILE}`;

/**
 * The journal of a change that has not finished, if there is one. A
 * journal is only ever written in a real .liftoff directory, so behind a
 * link, or in a directory Liftoff may not search, there is none.
 */
export async function readJournal(
  fs: ProjectFsPort,
  root: string,
): Promise<ChangeJournal | undefined> {
  const read = await fs.readWithin(root, CHANGE_JOURNAL_FILE, MAX_JOURNAL_BYTES);
  if (read.kind === "missing") return undefined;
  if ((read.kind === "other" || read.kind === "inaccessible") && read.via !== undefined) {
    return undefined;
  }
  if (read.kind !== "file" || read.text === undefined) {
    throw new JournalError(`${CHANGE_JOURNAL_FILE} is not a regular file Liftoff can read`);
  }
  return parseJournal(read.text);
}

/**
 * Runs `body` holding the change lock. A lock that is already there is
 * never taken over, even from a process that is no longer running, since
 * no step of taking it over could keep another process out meanwhile: it
 * is reported, saying whether its process is still running, for the person
 * to clear, as Git does with its own locks.
 */
async function withChangeLock<T>(
  ports: ChangePorts,
  root: string,
  leftovers: string[],
  body: () => Promise<T>,
): Promise<T> {
  const { fs, processes, now } = ports;
  const lock = path.join(root, ...CHANGE_LOCK_FILE.split("/"));
  const mine = `${JSON.stringify({ pid: processes.pid, host: processes.host, started: now() })}\n`;
  // Nothing is created for a project that is not there, such as one moved
  // since its plan was made.
  if ((await fs.directoryIdentity(root)) === undefined) {
    throw new ChangeError(`${root} is not a directory Liftoff can change`);
  }
  await checkRecordsDirectory(fs, root, true);
  await fs.makeDirectory(path.join(root, ".liftoff"));
  if (!(await fs.createExclusive(lock, mine))) {
    const read = await fs.readWithin(root, CHANGE_LOCK_FILE, 4096);
    const holder = parseLock(read.kind === "file" ? read.text : undefined);
    if (holder === undefined) {
      throw new ChangeError(
        `another liftoff command is changing this project; if none is, delete ${CHANGE_LOCK_FILE}`,
      );
    }
    const process = `process ${holder.pid} on ${holder.host}, which began at ${holder.started},`;
    if (holder.host === processes.host && !processes.isRunning(holder.pid)) {
      throw new ChangeError(
        `${process} stopped while changing this project; delete ${CHANGE_LOCK_FILE}, then try again`,
      );
    }
    throw new ChangeError(
      `${process} is changing this project; wait for it, or if it is not running, delete ${CHANGE_LOCK_FILE}`,
    );
  }
  let value: T;
  try {
    // It may have been swapped for a link while the lock was being made.
    await checkRecordsDirectory(fs, root, false);
    value = await body();
  } catch (error) {
    // What stopped it matters more; a lock left behind is reported next time.
    await fs.remove(lock).catch(() => undefined);
    throw error;
  }
  await tidy(fs, lock, CHANGE_LOCK_FILE, leftovers);
  return value;
}

/** Removes what a complete change no longer needs, or says what is left to delete. */
async function tidy(
  fs: ProjectFsPort,
  target: string,
  what: string,
  leftovers: string[],
): Promise<void> {
  try {
    await fs.remove(target);
  } catch (error) {
    leftovers.push(`${what} could not be removed (${(error as Error).message}); delete it`);
  }
}

/**
 * Liftoff's records for a change, its lock and journal, are kept only in a
 * real .liftoff directory in the project, never through a link to one
 * elsewhere. It may not exist yet when a change begins.
 */
async function checkRecordsDirectory(
  fs: ProjectFsPort,
  root: string,
  mayBeMissing: boolean,
): Promise<void> {
  const entry = await fs.entry(path.join(root, ".liftoff"));
  if (entry.kind === "directory" || (mayBeMissing && entry.kind === "missing")) return;
  throw new ChangeError(
    ".liftoff is a link, or not a directory; Liftoff keeps a change's lock and journal only in a real .liftoff directory in the project",
  );
}

function parseLock(
  text: string | undefined,
): { readonly pid: number; readonly host: string; readonly started: string } | undefined {
  try {
    const value = JSON.parse(text ?? "") as { pid?: unknown; host?: unknown; started?: unknown };
    return Number.isInteger(value.pid) &&
      typeof value.host === "string" &&
      typeof value.started === "string"
      ? { pid: value.pid as number, host: value.host, started: value.started }
      : undefined;
  } catch {
    return undefined;
  }
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
 * Changes one file that should now be `from`. Its original is kept first
 * when `keepOriginal`, and what replaces it is prepared in staging; only
 * then is it checked once more and replaced in one step, so nothing slow
 * comes between the last check and the change. False, changing nothing,
 * when it is not `from` or its original could not be kept. A new or
 * original file stays in staging for recovery; "removed" and "discarded"
 * move the project's file into staging instead.
 */
async function changeFile(
  fs: ProjectFsPort,
  root: string,
  staging: string,
  change: {
    readonly path: string;
    readonly before: string | null;
    readonly executable?: boolean | undefined;
  },
  from: string | null,
  source: "after" | "before" | "removed" | "discarded",
  keepOriginal: boolean,
): Promise<boolean> {
  if (keepOriginal && !(await keep(fs, root, staging, change))) return false;
  const parts = change.path.split("/");
  const target = path.join(root, ...parts);
  const placing = path.join(staging, "placing", ...parts);
  const replacing = source === "after" || source === "before";
  const destination = replacing ? target : path.join(staging, source, ...parts);
  if (replacing) {
    await fs.remove(placing);
    await fs.copyFile(path.join(staging, source, ...parts), placing);
    // A file that replaces another takes its permissions, so a private file
    // stays private; the kept original has them. Undoing copies it whole.
    if (source === "after" && change.before !== null) {
      await fs.matchPermissions(
        path.join(staging, "before", ...parts),
        placing,
        change.executable === true,
      );
    }
  }
  const made = replacing
    ? await makeDirectories(fs, root, change.path)
    : await makeDirectories(fs, staging, `${source}/${change.path}`);
  if (!made) {
    if (replacing) await fs.remove(placing);
    return false;
  }
  // The last check, of the file and every directory on the way to it; only
  // the rename comes after. Node has no rename relative to an open
  // directory, so a directory swapped for a link in the instant between the
  // two is the one case this cannot see.
  if (!fileMatches(await fileNow(fs, root, change.path), from)) {
    if (replacing) await fs.remove(placing);
    return false;
  }
  await fs.moveFile(replacing ? placing : target, destination);
  return true;
}

/**
 * Creates the directories a file at `relative` under `base` needs, one at a
 * time and never through a link; false, creating nothing more, when one on
 * the way is not a real directory.
 */
async function makeDirectories(
  fs: ProjectFsPort,
  base: string,
  relative: string,
): Promise<boolean> {
  const parts = relative.split("/").slice(0, -1);
  for (let depth = 1; depth <= parts.length; depth++) {
    const directory = path.join(base, ...parts.slice(0, depth));
    const entry = await fs.entry(directory);
    if (entry.kind === "directory") continue;
    if (entry.kind !== "missing") return false;
    await fs.makeDirectory(directory);
    if ((await fs.entry(directory)).kind !== "directory") return false;
  }
  return true;
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
  // Read as every file is: no link followed, never waiting, never past the limit.
  const copied = await fs.copyWithin(root, change.path, MAX_CHANGED_BYTES, copy);
  return copied.kind === "file" && copied.sha256 === change.before;
}

/**
 * Every new file's content must be given, hash to the plan's, be
 * executable as planned, and be no larger than a change can recover.
 */
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
    if (Buffer.byteLength(content.content) > MAX_CHANGED_BYTES) {
      throw new PlanError(
        `${change.path} would be larger than ${MAX_CHANGED_BYTES} bytes, more than a change can recover`,
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
    ? `${relative} is not a regular file of at most ${MAX_CHANGED_BYTES} bytes that Liftoff can read`
    : now.kind === "absent"
      ? `${relative} is missing`
      : before === null
        ? `${relative} already exists`
        : `${relative} changed since the plan was made`;

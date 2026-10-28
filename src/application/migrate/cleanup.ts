import path from "node:path";
import type { EntryKind } from "../../domain/assess/tree.ts";
import { type ChangePlan, sealChangePlan } from "../../domain/plan/change-plan.ts";
import { PLAN_SCHEMA } from "../../domain/plan/plan.ts";
import { MANIFEST_FILE, parseManifest } from "../../domain/project/manifest.ts";
import { pathKey } from "../../domain/project/paths.ts";
import { applyChanges, type ChangePorts } from "../change/apply-changes.ts";
import {
  MAX_RECORD_BYTES,
  ProjectChangeError,
  refuseUnfinishedChange,
} from "../change/project-change.ts";
import type { ProjectFsPort } from "../ports.ts";
import { type AssessOptions, assessProject } from "../project/assess-project.ts";
import { refuseLiftoffProject } from "../project/proposal.ts";
import { validateProject } from "../project/validate-project.ts";
import { copyList, MAX_COPIED_BYTES, within } from "./migrate-project.ts";

/**
 * The most files one change of a cleanup removes, so each change's journal
 * stays small enough to read back and recover.
 */
export const CLEANUP_BATCH = 2_000;

/** A file of the old project the cleanup removes, and the new project's file with the same bytes. */
export interface Removal {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The file in the new project that holds the same bytes. */
  readonly copy: string;
}

/** Something that stays in the old project, and why. */
export interface Kept {
  readonly path: string;
  readonly why: string;
}

export interface CleanupPlan {
  /** The old project, the one files are removed from. */
  readonly source: string;
  /** The new project, which is only read. */
  readonly target: string;
  /** Why the new project is not verified, or the old project cannot be cleaned up; empty when it can. */
  readonly blocked: readonly string[];
  /** Each file removed, sorted by path. */
  readonly removals: readonly Removal[];
  /** Everything that stays, sorted by path. */
  readonly kept: readonly Kept[];
  /** The changes that remove them, each at most CLEANUP_BATCH files; none when blocked. */
  readonly plans: readonly ChangePlan[];
}

export type CleanupWhere = Pick<AssessOptions, "named" | "refused"> & {
  /** Stops planning between files. */
  readonly signal?: AbortSignal;
  /** Files in each change other than CLEANUP_BATCH, for tests. */
  readonly batch?: number;
};

/** The cleanup stopped after some of its changes, each of which completed or stopped part way. */
export class CleanupStoppedError extends Error {
  override readonly name = "CleanupStoppedError";
  /** The change that was being made when it stopped. */
  readonly plan: ChangePlan;
  /** Files removed by the changes that finished before it. */
  readonly removed: readonly string[];
  constructor(message: string, plan: ChangePlan, removed: readonly string[], cause: unknown) {
    super(message, { cause });
    this.plan = plan;
    this.removed = removed;
  }
}

const NO_COPY = "the new project holds no copy of it";

/**
 * Plans removing from the old project each file that migrating would copy
 * and that the new project holds a byte-for-byte copy of, anywhere its walk
 * reaches. It only reads both projects. The new project must be verified:
 * made by liftoff migrate, and valid. What keeps the old project from being
 * cleaned up is returned in `blocked`, with no changes.
 */
export async function planCleanup(
  fs: ProjectFsPort,
  source: string,
  target: string,
  liftoffVersion: string,
  where: CleanupWhere,
): Promise<CleanupPlan> {
  const { signal, batch = CLEANUP_BATCH, ...assessWhere } = where;
  for (const [directory, which] of [
    [source, "--dir"],
    [target, "--to"],
  ] as const) {
    const real = await fs.realPath(directory);
    if (real !== undefined && pathKey(real) !== pathKey(directory)) {
      throw new ProjectChangeError(
        `${directory} leads to ${real} through a link; name the directories as they are`,
      );
    }
    if (real === undefined || (await fs.directoryIdentity(directory)) === undefined) {
      throw new ProjectChangeError(`${directory} is not a directory; name it with ${which}`);
    }
  }
  if (within(target, source) || within(source, target)) {
    throw new ProjectChangeError(
      `${target} and ${source} overlap; name the new project with --to and the old one with --dir`,
    );
  }
  await refuseUnfinishedChange(fs, source);
  await refuseLiftoffProject(fs, source);

  const blocked = await unverified(fs, target);
  signal?.throwIfAborted();
  const walked = new Map<string, EntryKind>();
  const assessment = await assessProject(fs, source, { ...assessWhere, walked });
  signal?.throwIfAborted();
  const { copies, left, closed } = await copyList(
    fs,
    source,
    walked,
    assessment.gaps,
    assessment.legacy?.records ?? [],
    signal,
    "cleaning up",
  );
  const held = await heldInTarget(fs, target, new Set(copies.map((copy) => copy.bytes)), signal);
  const removals: Removal[] = [];
  const kept: Kept[] = [
    ...left.map(({ path: file, why }) => ({ path: file, why })),
    ...closed.map((file) => ({ path: file, why: "closed to this user" })),
    // What the walk did not reach is never removed.
    ...assessment.gaps
      .filter(
        (gap) => gap.kind === "limit" || gap.kind === "inaccessible" || gap.kind === "changed",
      )
      .map((gap) => ({ path: gap.path ?? ".", why: `not walked: ${gap.detail}` })),
  ];
  for (const copy of copies) {
    const at = held.get(copy.sha256);
    if (at === undefined) kept.push({ path: copy.path, why: NO_COPY });
    else removals.push({ ...copy, copy: at });
  }
  kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (blocked.length > 0) return { source, target, blocked, removals, kept, plans: [] };

  const plans: ChangePlan[] = [];
  for (let start = 0; start < removals.length; start += batch) {
    plans.push(
      sealChangePlan({
        schema: PLAN_SCHEMA,
        operation: "migrate-cleanup",
        liftoff: liftoffVersion,
        target: source,
        // The new project the copies are in, which the plan rests on.
        config: { migratedTo: target },
        effects: ["modify-files"],
        changes: removals.slice(start, start + batch).map((removal) => ({
          path: removal.path,
          before: removal.sha256,
          after: null,
        })),
      }),
    );
  }
  return { source, target, blocked, removals, kept, plans };
}

/**
 * Why the new project is not verified yet: it must be a Liftoff project
 * whose manifest's history starts with migrate, and valid.
 */
async function unverified(fs: ProjectFsPort, target: string): Promise<string[]> {
  const blocked: string[] = [];
  const manifest = await fs.readWithin(target, MANIFEST_FILE, MAX_RECORD_BYTES);
  let first: string | undefined;
  if (manifest.kind === "file" && manifest.text !== undefined) {
    try {
      first = parseManifest(manifest.text).history[0]?.operation;
    } catch {
      // Reported by validate, below.
    }
  }
  if (first !== "migrate") {
    blocked.push(
      `${target} was not made by liftoff migrate${first === undefined ? "" : ` (its manifest's history starts with ${first})`}, so it is not a migration of this project to clean up after`,
    );
  }
  const validation = await validateProject(fs, target);
  for (const finding of validation.findings) {
    if (finding.severity === "error") {
      blocked.push(
        `the new project is not valid: ${finding.path === undefined ? "" : `${finding.path}: `}${finding.message}; fix it, as liftoff validate says, before cleaning up`,
      );
    }
  }
  return blocked;
}

/**
 * The files a stopped cleanup change would still remove whose bytes the new
 * project no longer holds anywhere its walk reaches, so finishing it must
 * not remove them. A file already removed, or one that changed since, is
 * left to recovery, which never removes a changed file.
 */
export async function withoutCopies(
  fs: ProjectFsPort,
  source: string,
  target: string,
  changes: readonly { readonly path: string; readonly before: string | null }[],
): Promise<string[]> {
  const remaining: { path: string; sha256: string; size: number }[] = [];
  for (const change of changes) {
    if (change.before === null) continue;
    const now = await fs.hashWithin(source, change.path, MAX_COPIED_BYTES);
    if (now.kind === "file" && now.sha256 === change.before) {
      remaining.push({ path: change.path, sha256: now.sha256, size: now.size });
    }
  }
  if (remaining.length === 0) return [];
  const real = await fs.realPath(target);
  const usable =
    real !== undefined &&
    pathKey(real) === pathKey(target) &&
    !within(target, source) &&
    !within(source, target) &&
    (await fs.directoryIdentity(target)) !== undefined;
  const held = usable
    ? await heldInTarget(fs, target, new Set(remaining.map((file) => file.size)), undefined)
    : new Map<string, string>();
  return remaining.filter((file) => !held.has(file.sha256)).map((file) => file.path);
}

/**
 * The files the walk of the new project reaches, by sha256, for the sizes
 * the old project's files have: the first such path, sorted. Files that may
 * hold secrets or state, and Liftoff's own records, are never read.
 */
async function heldInTarget(
  fs: ProjectFsPort,
  target: string,
  sizes: ReadonlySet<number>,
  signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
  const walked = new Map<string, EntryKind>();
  const assessment = await assessProject(fs, target, { named: true, refused: [], walked });
  const unread = new Set(
    assessment.gaps.filter((gap) => gap.kind === "not-read").map((gap) => gap.path),
  );
  const held = new Map<string, string>();
  const files = [...walked]
    .filter(([file, kind]) => kind === "file" && !unread.has(file) && !file.startsWith(".liftoff/"))
    .map(([file]) => file)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const file of files) {
    signal?.throwIfAborted();
    const entry = await fs.entry(path.join(target, ...file.split("/")));
    if (entry.kind !== "file" || !sizes.has(entry.size)) continue;
    const now = await fs.hashWithin(target, file, MAX_COPIED_BYTES);
    if (now.kind === "file" && now.sha256 !== undefined && !held.has(now.sha256)) {
      held.set(now.sha256, file);
    }
  }
  return held;
}

/**
 * Removes the old project's .liftoff once it is empty, as a cleanup, or a
 * recovery of one, leaves it when it made it for its lock and journal.
 */
export async function removeEmptyRecords(fs: ProjectFsPort, source: string): Promise<void> {
  await fs.removeEmptyDirectory(path.join(source, ".liftoff"));
}

export interface CleanupResult {
  /** Files removed from the old project. */
  readonly removed: readonly string[];
  /** Directories the cleanup left empty, removed. */
  readonly directories: readonly string[];
  /** What could not be removed once a change was complete, for the person to delete. */
  readonly leftovers: readonly string[];
  /** Whether Ctrl+C stopped it between changes, with the rest left as they were. */
  readonly cancelled: boolean;
}

/**
 * Removes the planned files, one change at a time, through the change
 * engine (CHANGE-002 to CHANGE-004). Before each change, every copy it
 * rests on in the new project is hashed again, and must still hold the
 * same bytes. Directories the cleanup leaves empty are removed afterwards,
 * one at a time and only while empty, never the old project's own.
 */
export async function applyCleanup(
  ports: ChangePorts,
  cleanup: CleanupPlan,
  options: { readonly signal?: AbortSignal } = {},
): Promise<CleanupResult> {
  const { fs } = ports;
  const { signal } = options;
  const byPath = new Map(cleanup.removals.map((removal) => [removal.path, removal]));
  const removed: string[] = [];
  const leftovers: string[] = [];
  let cancelled = false;
  for (const plan of cleanup.plans) {
    // Between changes, Ctrl+C stops with the finished ones as they are.
    if (removed.length > 0 && signal?.aborted) {
      cancelled = true;
      break;
    }
    try {
      for (const change of plan.changes) {
        signal?.throwIfAborted();
        const removal = byPath.get(change.path);
        const now =
          removal === undefined
            ? undefined
            : await fs.hashWithin(cleanup.target, removal.copy, MAX_COPIED_BYTES);
        if (now?.kind !== "file" || now.sha256 !== removal?.sha256) {
          throw new ProjectChangeError(
            `${removal?.copy ?? change.path} in the new project changed since the cleanup was planned, so its copy may not hold ${change.path} any more; nothing more was removed, so run the cleanup again`,
          );
        }
      }
      const result = await applyChanges(ports, plan, new Map(), signal ? { signal } : {});
      removed.push(...plan.changes.map((change) => change.path));
      leftovers.push(...result.leftovers);
    } catch (error) {
      if (removed.length === 0) throw error;
      // Ctrl+C before this change touched a file: the finished ones stand.
      if (signal?.aborted && error === signal.reason) {
        cancelled = true;
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CleanupStoppedError(message, plan, removed, error);
    }
  }
  const directories: string[] = [];
  const emptied = new Set<string>();
  for (const file of removed) {
    for (let at = path.posix.dirname(file); at !== "."; at = path.posix.dirname(at)) {
      emptied.add(at);
    }
  }
  // Deepest first, so a directory is looked at once what was in it is gone.
  const depth = (directory: string) => directory.split("/").length;
  for (const directory of [...emptied].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1))) {
    if (await fs.removeEmptyDirectory(path.join(cleanup.source, ...directory.split("/")))) {
      directories.push(directory);
    }
  }
  // The .liftoff a change keeps its lock and journal in, once nothing is in it.
  await removeEmptyRecords(fs, cleanup.source);
  return { removed, directories: directories.sort(), leftovers, cancelled };
}

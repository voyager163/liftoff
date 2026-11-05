import { applyFilePatch, type FilePatch, parsePatch } from "../../domain/change/patch.ts";
import type { ChangePlan, FileChange } from "../../domain/plan/change-plan.ts";
import { PlanError, sha256Hex } from "../../domain/plan/plan.ts";
import { MANIFEST_FILE, type ManifestFile, type Ownership } from "../../domain/project/manifest.ts";
import { pathKey, repositoryPathProblem } from "../../domain/project/paths.ts";
import { isExecutable, type ProjectFile } from "../../generators/project.ts";
import { CHANGE_COMMANDS, MAX_CHANGED_BYTES, type NewContent } from "../change/apply-changes.ts";
import {
  generateFor,
  ProjectChangeError,
  RECORDS,
  readProject,
  sealProjectChange,
} from "../change/project-change.ts";
import type { AssetPort, FileHash, ProjectFsPort } from "../ports.ts";

/** The largest patch, and the largest file a patch changes, that repair reads. */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;

/**
 * What a repair does with one file:
 * - restore: a Liftoff file that is missing or was changed by hand is put
 *   back as this release makes it, because the person chose it;
 * - offer: such a file, not chosen, so left as it is;
 * - cannot: a problem with a Liftoff file that no recipe fixes, with why;
 * - change, add, remove: what a reviewed patch does to the file.
 */
export type RepairStep = "restore" | "offer" | "cannot" | "change" | "add" | "remove";

export interface RepairFile {
  readonly path: string;
  readonly step: RepairStep;
  /** Who owns the file: a manifest ownership class, or "project" for one it does not list. */
  readonly ownership?: Ownership | "project";
  /** What is wrong with a Liftoff file. */
  readonly problem?: string;
  /** Why no recipe fixes it. */
  readonly reason?: string;
}

export interface RepairPlan {
  readonly directory: string;
  readonly name: string;
  /** Every file the repair found a problem with, or a patch changes, sorted by path. */
  readonly files: readonly RepairFile[];
  /** The change to make, or undefined when there is nothing to change. */
  readonly plan?: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
}

/** Whether any Liftoff file has a problem, fixable or not. */
/**
 * Whether a file Liftoff manages has a problem, fixable or not. A missing
 * file Liftoff wrote for the project is listed, but may have been removed
 * on purpose, so it does not count.
 */
export const repairNeeded = (repair: RepairPlan): boolean =>
  repair.files.some(
    (file) => file.ownership === "managed" && (file.step === "offer" || file.step === "cannot"),
  );

/**
 * Whether a file Liftoff manages has a problem no recipe fixes. A missing
 * file Liftoff wrote for the project is listed, but may have been removed
 * on purpose, so it needs no one.
 */
export const needsPerson = (repair: RepairPlan): boolean =>
  repair.files.some((file) => file.ownership === "managed" && file.step === "cannot");

const sorted = (files: RepairFile[]) => files.sort((a, b) => a.path.localeCompare(b.path));

/**
 * Finds the files Liftoff wrote that are not as they should be, and plans
 * putting back those named in `restore`. Nothing is written.
 *
 * A file Liftoff manages that is missing or was changed by hand can be put
 * back as this release makes it. A file Liftoff wrote for the project that
 * is missing can be put back only when this release makes it exactly as
 * Liftoff first wrote it. A file the project changed is the project's, and
 * framework files are the framework's. Nothing replaces a directory, a link
 * or a file that cannot be read. Like an update, it refuses a liftoff.yaml
 * changed since Liftoff wrote it and never switches a plugin.
 */
export async function planRestore(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  options: { readonly restore?: ReadonlySet<string> } = {},
): Promise<RepairPlan> {
  const { fs } = ports;
  const project = await readProject(fs, directory, "repair");
  const generated = await generateFor(ports.assets, project, liftoffVersion, "repair");
  const steps: RepairFile[] = [];
  const changes: FileChange[] = [];
  const contents = new Map<string, NewContent>();
  const entries = new Map(project.manifest.files.map((entry) => [entry.path, entry]));

  for (const entry of project.manifest.files) {
    if (entry.ownership === "framework" || RECORDS.has(pathKey(entry.path))) continue;
    const now = await fs.hashWithin(directory, entry.path, MAX_CHANGED_BYTES);
    if (now.kind === "file" && now.sha256 === entry.sha256) continue;
    // A file the project owns may change freely; only a missing one is a problem.
    if (entry.ownership === "seeded" && now.kind !== "missing") continue;
    const wanted = restorable(entry, now, generated.files.get(pathKey(entry.path)));
    // Already as this release makes it: recording that is update's work.
    const problem =
      wanted === ALREADY_CURRENT
        ? "a file Liftoff manages is already as this release makes it, but the manifest records another version"
        : problemWith(entry, now);
    if (typeof wanted === "string") {
      steps.push({
        path: entry.path,
        step: "cannot",
        ownership: entry.ownership,
        problem,
        reason: wanted,
      });
      continue;
    }
    if (options.restore?.has(entry.path) !== true) {
      steps.push({ path: entry.path, step: "offer", ownership: entry.ownership, problem });
      continue;
    }
    entries.set(entry.path, { ...entry, sha256: wanted.sha256, plugin: wanted.plugin });
    steps.push({ path: entry.path, step: "restore", ownership: entry.ownership, problem });
    const executable = isExecutable(entry.path);
    changes.push({
      path: entry.path,
      before: now.kind === "file" ? (now.sha256 ?? null) : null,
      after: wanted.sha256,
      ownership: entry.ownership,
      executable,
    });
    contents.set(entry.path, { content: wanted.content, executable });
  }

  const result = {
    directory,
    name: project.config.name,
    files: sorted(steps),
  };
  if (changes.length === 0) return { ...result, contents: new Map() };
  return {
    ...result,
    // Put back from liftoff.yaml as it was when the files were generated.
    ...sealProjectChange(
      project,
      "repair",
      liftoffVersion,
      changes,
      contents,
      { ...project.manifest, files: [...entries.values()] },
      [generated.config],
    ),
  };
}

/**
 * Plans applying a reviewed patch to the project's own files, within the
 * paths declared for it. Nothing is written.
 *
 * Every hunk must match the file exactly. The patch may change only files
 * the project owns: never a file Liftoff manages, a framework's file,
 * liftoff.yaml, anything in .liftoff or .git, or anything outside `paths`.
 * Each file it changes must be UTF-8 text of at most 4 MiB. The manifest
 * records the repair in its history, and is otherwise unchanged.
 */
export async function planPatch(
  ports: { readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  patch: { readonly text: string; readonly paths: readonly string[] },
): Promise<RepairPlan> {
  const { fs } = ports;
  const project = await readProject(fs, directory, "repair");
  if (Buffer.byteLength(patch.text) > MAX_PATCH_BYTES) {
    throw new ProjectChangeError(`the patch is over ${MAX_PATCH_BYTES / 1024 / 1024} MiB`);
  }
  const scope = declaredPaths(patch.paths);
  const listed = new Map(project.manifest.files.map((entry) => [pathKey(entry.path), entry]));
  const steps: RepairFile[] = [];
  const changes: FileChange[] = [];
  const contents = new Map<string, NewContent>();
  const seen = new Set<string>();
  const files = parsePatch(patch.text);
  // Every directory a changed file is in, to find a path that is also one.
  const directories = new Set(
    files.flatMap((file) => {
      const parts = pathKey(file.path).split("/");
      return parts.slice(1).map((_, depth) => parts.slice(0, depth + 1).join("/"));
    }),
  );
  for (const file of files) {
    const key = pathKey(file.path);
    if (seen.has(key)) throw new ProjectChangeError(`the patch changes ${file.path} twice`);
    seen.add(key);
    if (directories.has(key)) {
      throw new ProjectChangeError(
        `the patch makes ${file.path} both a file and a directory of other files`,
      );
    }
    const entry = listed.get(key);
    refusePath(file.path, entry, scope, patch.paths);
    const ownership = entry?.ownership === "seeded" ? "seeded" : "project";
    const before = await readForPatch(fs, directory, file);
    const after = applyFilePatch(before?.text ?? "", file);
    if (file.kind === "remove" && after !== "") {
      throw new ProjectChangeError(
        `the patch removes ${file.path} but leaves lines in it; make the patch against the project as it is now`,
      );
    }
    if (file.kind === "change" && after === before?.text) {
      throw new ProjectChangeError(`the patch does not change ${file.path}`);
    }
    if (file.kind === "remove") {
      changes.push({ path: file.path, before: before?.sha256 ?? null, after: null });
    } else {
      const executable = file.kind === "add" ? file.executable : (before?.executable ?? false);
      changes.push({
        path: file.path,
        before: before?.sha256 ?? null,
        after: sha256Hex(after),
        ownership,
        executable,
      });
      contents.set(file.path, { content: after, executable });
    }
    steps.push({ path: file.path, step: file.kind, ownership });
  }
  return {
    directory,
    name: project.config.name,
    files: sorted(steps),
    ...sealProjectChange(project, "repair", liftoffVersion, changes, contents, project.manifest),
  };
}

/**
 * Plans the repair a saved plan describes, with the same files restored or
 * the same patch, which must be given again, and refuses it unless it is
 * that plan exactly: made by this release, for a project still as it was.
 */
export async function planRepairFromSaved(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  saved: ChangePlan,
  liftoffVersion: string,
  patch?: { readonly text: string; readonly paths: readonly string[] },
): Promise<RepairPlan> {
  if (saved.operation !== "repair") {
    throw new PlanError(
      `this plan is for ${CHANGE_COMMANDS[saved.operation]}, not liftoff repair; apply it with that command`,
    );
  }
  if (saved.liftoff !== liftoffVersion) {
    throw new PlanError(
      `the plan was made by Liftoff ${saved.liftoff}, but this is ${liftoffVersion}; make a new plan`,
    );
  }
  // Only a patch removes a file, or changes one Liftoff does not manage that is there.
  const patched = saved.changes.some(
    (change) =>
      change.path !== MANIFEST_FILE &&
      (change.after === null ||
        change.ownership === "project" ||
        (change.ownership === "seeded" && change.before !== null)),
  );
  if (patch === undefined && patched) {
    throw new PlanError(
      "this plan applies a patch; give the same --patch and --paths again to apply it",
    );
  }
  const repair =
    patch === undefined
      ? await planRestore(ports, saved.target, liftoffVersion, {
          restore: new Set(
            saved.changes.map((change) => change.path).filter((path) => path !== MANIFEST_FILE),
          ),
        })
      : await planPatch(ports, saved.target, liftoffVersion, patch);
  if (repair.plan?.hash !== saved.hash) {
    throw new PlanError(
      `the project${patch === undefined ? "" : " or the patch"} changed since the plan was made, so the plan no longer says what repair would do; make a new plan`,
    );
  }
  return repair;
}

/** The paths a patch may change, each "." or a path in the project, by pathKey. */
function declaredPaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) {
    throw new ProjectChangeError("a patch needs the paths it may change");
  }
  return paths.map((declared) => {
    if (declared === ".") return ".";
    const problem = repositoryPathProblem(declared);
    if (problem !== undefined) {
      throw new ProjectChangeError(`${declared} cannot be a path a patch may change: ${problem}`);
    }
    return pathKey(declared);
  });
}

/** Refuses a file a patch may not change. */
function refusePath(
  path: string,
  entry: ManifestFile | undefined,
  scope: readonly string[],
  declared: readonly string[],
): void {
  const refuse = (why: string) => {
    throw new ProjectChangeError(`the patch changes ${path}, ${why}`);
  };
  const problem = repositoryPathProblem(path);
  if (problem !== undefined) refuse(`which is not a path in the project: ${problem}`);
  const key = pathKey(path);
  if (RECORDS.has(key) || key.split("/")[0] === ".liftoff") {
    refuse("which holds Liftoff's own records and is never patched");
  }
  if (entry?.ownership === "managed") {
    refuse("which Liftoff manages; put it back with liftoff repair --restore instead");
  }
  if (entry?.ownership === "framework") {
    refuse(`which ${entry.plugin} owns and Liftoff never changes`);
  }
  if (!scope.some((within) => within === "." || key === within || key.startsWith(`${within}/`))) {
    refuse(`outside the paths it may change (${declared.join(", ")})`);
  }
}

/**
 * The file a patch changes or removes, read whole as UTF-8 text without
 * following a link, or undefined for a file it adds, which must not exist.
 */
async function readForPatch(
  fs: ProjectFsPort,
  directory: string,
  file: FilePatch,
): Promise<{ text: string; sha256: string; executable: boolean } | undefined> {
  const hashed = await fs.hashWithin(directory, file.path, MAX_PATCH_BYTES);
  if (file.kind === "add") {
    if (hashed.kind === "missing") return undefined;
    throw new ProjectChangeError(`the patch adds ${file.path}, but something is already there`);
  }
  if (hashed.kind !== "file" || hashed.sha256 === undefined) {
    throw new ProjectChangeError(
      hashed.kind === "missing"
        ? `the patch changes ${file.path}, which is not there`
        : `the patch changes ${file.path}, which is not a regular file of at most ${MAX_PATCH_BYTES / 1024 / 1024} MiB that Liftoff can read`,
    );
  }
  const read = await fs.readWithin(directory, file.path, MAX_PATCH_BYTES);
  // Read as text, it must be the same bytes, so it is UTF-8 and has not changed.
  if (read.kind !== "file" || read.text === undefined || sha256Hex(read.text) !== hashed.sha256) {
    throw new ProjectChangeError(
      `the patch changes ${file.path}, which is not UTF-8 text, or changed as it was read`,
    );
  }
  return { text: read.text, sha256: hashed.sha256, executable: hashed.executable === true };
}

/** What is wrong with a file Liftoff wrote. */
function problemWith(entry: ManifestFile, now: FileHash): string {
  const whose =
    entry.ownership === "managed"
      ? "a file Liftoff manages"
      : "a file Liftoff wrote for the project";
  switch (now.kind) {
    case "missing":
      return entry.ownership === "managed"
        ? `${whose} is missing`
        : `${whose} is missing, which is fine if it was removed on purpose`;
    case "file":
      return now.sha256 === undefined
        ? `${whose} is over ${MAX_CHANGED_BYTES / 1024 / 1024} MiB, so it was not read`
        : `${whose} was changed by hand`;
    case "directory":
      return `a directory is where ${whose} should be`;
    case "inaccessible":
      return `${whose} cannot be read by this user`;
    default:
      return `${whose} is a link or another kind of file, or is reached through one`;
  }
}

/** Why a managed file already as this release makes it has nothing to put back. */
const ALREADY_CURRENT =
  "there is nothing to put back; liftoff update records this release's version in the manifest";

/** This release's version of a file Liftoff wrote, to put back, or why it cannot be. */
function restorable(
  entry: ManifestFile,
  now: FileHash,
  wanted: ProjectFile | undefined,
): ProjectFile | string {
  if (now.kind !== "missing" && !(now.kind === "file" && now.sha256 !== undefined)) {
    return "Liftoff never replaces a directory, a link, or a file it cannot read";
  }
  if (wanted === undefined) {
    return "this release no longer makes it, so there is nothing to put back; liftoff update removes it from the manifest";
  }
  if (wanted.path !== entry.path) {
    return `this release names it ${wanted.path}, in other letter case; rename it, then run liftoff update`;
  }
  if (wanted.ownership !== entry.ownership) {
    return "this release makes it with another owner, so repair does not put it back";
  }
  if (entry.ownership === "seeded" && wanted.sha256 !== entry.sha256) {
    return "this release would write it differently from what Liftoff first wrote, so restore it from version control";
  }
  if (now.kind === "file" && now.sha256 === wanted.sha256) return ALREADY_CURRENT;
  return wanted;
}

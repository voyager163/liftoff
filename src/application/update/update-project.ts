import type { ChangePlan, FileChange } from "../../domain/plan/change-plan.ts";
import { PlanError } from "../../domain/plan/plan.ts";
import type { ManifestFile, Ownership } from "../../domain/project/manifest.ts";
import { pathKey } from "../../domain/project/paths.ts";
import { isExecutable, type ProjectFile } from "../../generators/project.ts";
import {
  CHANGE_COMMANDS,
  MAX_CHANGED_BYTES,
  type NewContent,
  type Unchanged,
} from "../change/apply-changes.ts";
import {
  generateFor,
  nameOnDisk,
  RECORDS,
  readProject,
  sealProjectChange,
} from "../change/project-change.ts";
import type { AssetPort, FileHash, ProjectFsPort } from "../ports.ts";

/**
 * What an update does with one file:
 * - update: a managed file, as Liftoff last wrote it, is replaced with this
 *   release's version;
 * - remove: a managed file, as Liftoff last wrote it, that this release no
 *   longer makes is removed;
 * - record: a managed file already as this release makes it, or one it no
 *   longer makes that is already gone, changes only in the manifest;
 * - add: a file this release makes that the project does not have, added
 *   because the person approved it;
 * - offer: such a file, not approved, so not added;
 * - hold: a managed file this release changes, left as it is because it is
 *   not as Liftoff last wrote it;
 * - occupied: a file this release makes where something else already is,
 *   which is never replaced.
 */
export type UpdateStep = "update" | "remove" | "record" | "add" | "offer" | "hold" | "occupied";

export interface UpdateFile {
  readonly path: string;
  readonly step: UpdateStep;
  /** Who owns a new file once added. */
  readonly ownership?: Ownership;
  /** Why a file is held back or not added. */
  readonly reason?: string;
}

export interface UpdatePlan {
  readonly directory: string;
  readonly name: string;
  /** Every file the update would do something about, sorted by path. */
  readonly files: readonly UpdateFile[];
  /** Plugins this release has at another version. */
  readonly plugins: readonly { readonly id: string; readonly from: string; readonly to: string }[];
  /** The change to make, or undefined when there is nothing to change. */
  readonly plan?: ChangePlan;
  /** The new content of each file the plan writes. */
  readonly contents: ReadonlyMap<string, NewContent>;
  /**
   * Files the update rests on without changing them, which must still be as
   * planned when it applies: liftoff.yaml, and each file only its manifest
   * entry changes for, as it was seen or still absent.
   */
  readonly unchanged: readonly Unchanged[];
}

/**
 * Whether this release has anything for the project: a change, a new file
 * offered, or a file it could not change or add, which needs the person.
 */
export const updateAvailable = (update: UpdatePlan): boolean =>
  update.plan !== undefined ||
  update.files.some((file) => file.step === "offer") ||
  needsPerson(update);

/** Whether a file was held back, or a new file could not be added. */
export const needsPerson = (update: UpdatePlan): boolean =>
  update.files.some((file) => file.step === "hold" || file.step === "occupied");

/**
 * Plans bringing the files Liftoff manages in a project to what this release
 * makes for the configuration the project was made with. Nothing is written.
 *
 * Only files the manifest lists as managed are changed, and only those still
 * as Liftoff last wrote them; any other is held back and named. Files the
 * project or a framework owns, and liftoff.yaml, are never changed, and no
 * file changes owner. New files this release makes are only offered, and
 * added only when named in `add`, never over something already there. The
 * manifest is changed last, with an update in its history.
 *
 * It refuses a project with a change that has not finished, a liftoff.yaml
 * changed since Liftoff wrote it, or one this release would make from other
 * plugins, so it never switches the workflow, profile, stack, pattern,
 * agents or any other plugin.
 */
export async function planUpdate(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  options: { readonly add?: ReadonlySet<string> } = {},
): Promise<UpdatePlan> {
  const { fs } = ports;
  const project = await readProject(fs, directory, "update");
  const { config, manifest } = project;
  const {
    selection,
    files: generated,
    config: written,
  } = await generateFor(ports.assets, project, liftoffVersion, "update");
  const steps: UpdateFile[] = [];
  const changes: FileChange[] = [];
  const unchanged: Unchanged[] = [written];
  const contents = new Map<string, NewContent>();
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const replace = (file: ProjectFile, before: string | null) => {
    changes.push({
      path: file.path,
      before,
      after: file.sha256,
      ownership: file.ownership,
      executable: isExecutable(file.path),
    });
    contents.set(file.path, { content: file.content, executable: isExecutable(file.path) });
  };
  const entryFor = (file: ProjectFile, ownership: Ownership): ManifestFile => ({
    path: file.path,
    ownership,
    sha256: file.sha256,
    plugin: file.plugin,
  });

  for (const entry of manifest.files) {
    // liftoff.yaml and the manifest are never changed as other files are.
    if (entry.ownership !== "managed" || RECORDS.has(pathKey(entry.path))) continue;
    const wanted = generated.get(pathKey(entry.path));
    // No file changes owner, and one this release does not change is left.
    if (
      wanted !== undefined &&
      (wanted.ownership !== "managed" || wanted.sha256 === entry.sha256)
    ) {
      continue;
    }
    // A file this release names in other letter case is held back until it
    // is renamed on disk, then followed under its new name.
    let at = entry.path;
    if (wanted !== undefined && wanted.path !== entry.path) {
      if ((await nameOnDisk(fs, directory, entry.path)) !== wanted.path) {
        steps.push({
          path: entry.path,
          step: "hold",
          reason: `this release names it ${wanted.path}, in other letter case; rename it to that to take this release's version`,
        });
        continue;
      }
      at = wanted.path;
    }
    const now = await fs.hashWithin(directory, at, MAX_CHANGED_BYTES);
    const sha256 = now.kind === "file" ? now.sha256 : undefined;
    if (wanted === undefined && now.kind === "missing") {
      entries.delete(entry.path);
      unchanged.push({ path: at, sha256: null });
      steps.push({ path: at, step: "record" });
    } else if (wanted !== undefined && sha256 === wanted.sha256) {
      entries.delete(entry.path);
      entries.set(at, entryFor(wanted, "managed"));
      unchanged.push({ path: at, sha256: wanted.sha256 });
      steps.push({ path: at, step: "record" });
    } else if (sha256 !== entry.sha256) {
      steps.push({ path: at, step: "hold", reason: heldBecause(now, wanted === undefined) });
    } else if (wanted === undefined) {
      entries.delete(entry.path);
      changes.push({ path: at, before: entry.sha256, after: null });
      steps.push({ path: at, step: "remove" });
    } else {
      entries.delete(entry.path);
      entries.set(at, entryFor(wanted, "managed"));
      replace(wanted, entry.sha256);
      steps.push({ path: at, step: "update" });
    }
  }

  // Compared as macOS and Windows compare names, ignoring case.
  const listed = new Set(manifest.files.map((entry) => pathKey(entry.path)));
  for (const file of generated.values()) {
    if (listed.has(pathKey(file.path))) continue;
    const now = await fs.hashWithin(directory, file.path, MAX_CHANGED_BYTES);
    if (now.kind !== "missing") {
      steps.push({
        path: file.path,
        step: "occupied",
        ownership: file.ownership,
        reason: occupiedBecause(now),
      });
    } else if (options.add?.has(file.path) === true) {
      entries.set(file.path, entryFor(file, file.ownership));
      replace(file, null);
      steps.push({ path: file.path, step: "add", ownership: file.ownership });
    } else {
      steps.push({ path: file.path, step: "offer", ownership: file.ownership });
    }
  }

  const versions = new Map(selection.plugins.map((plugin) => [plugin.id, plugin.version]));
  const plugins = manifest.plugins
    .flatMap(({ id, version }) => {
      const to = versions.get(id) ?? version;
      return to === version ? [] : [{ id, from: version, to }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const result = {
    directory,
    name: config.name,
    unchanged,
    files: steps.sort((a, b) => a.path.localeCompare(b.path)),
    plugins,
  };
  const manifestChanges = steps.some(
    (step) => step.step !== "offer" && step.step !== "hold" && step.step !== "occupied",
  );
  if (!manifestChanges && plugins.length === 0) {
    return { ...result, contents: new Map() };
  }

  const sealed = sealProjectChange(project, "update", liftoffVersion, changes, contents, {
    ...manifest,
    plugins: selection.plugins.map(({ id, version }) => ({ id, version })),
    files: [...entries.values()],
  });
  return { ...result, ...sealed };
}

/**
 * Plans the update a saved plan describes, with the same new files added,
 * and refuses it unless it is that plan exactly: made by this release, for
 * a project still as it was when the plan was made.
 */
export async function planFromSaved(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  saved: ChangePlan,
  liftoffVersion: string,
): Promise<UpdatePlan> {
  if (saved.operation !== "update") {
    throw new PlanError(
      `this plan is for ${CHANGE_COMMANDS[saved.operation]}, not liftoff update; apply it with that command`,
    );
  }
  if (saved.liftoff !== liftoffVersion) {
    throw new PlanError(
      `the plan was made by Liftoff ${saved.liftoff}, but this is ${liftoffVersion}; make a new plan`,
    );
  }
  // Only a file the project does not have is ever added.
  const add = new Set(
    saved.changes.filter((change) => change.before === null).map((change) => change.path),
  );
  const update = await planUpdate(ports, saved.target, liftoffVersion, { add });
  if (update.plan?.hash !== saved.hash) {
    throw new PlanError(
      "the project changed since the plan was made, so the plan no longer says what update would do; make a new plan",
    );
  }
  return update;
}

/** Why a managed file this release changes or removes is left as it is. */
function heldBecause(now: FileHash, removing: boolean): string {
  switch (now.kind) {
    case "file":
      if (now.sha256 === undefined) {
        return `it is over ${MAX_CHANGED_BYTES / 1024 / 1024} MiB, so it was not read`;
      }
      return removing
        ? "this release no longer makes it, but it was changed since Liftoff wrote it, so it is the project's to remove"
        : "it was changed since Liftoff wrote it; to take this release's version, put it back with liftoff repair or restore it from version control";
    case "missing":
      return "it is missing; update does not put back a file that was removed, but liftoff repair can";
    case "directory":
      return "a directory is where the file should be";
    case "inaccessible":
      return "it cannot be read by this user";
    default:
      return "it is a link or another kind of file, or it is reached through one";
  }
}

/** Why a new file is not offered: something is, or may be, where it would go. */
function occupiedBecause(now: FileHash): string {
  switch (now.kind) {
    case "file":
    case "directory":
      return `a ${now.kind} is already there, and Liftoff never replaces what it did not write`;
    case "inaccessible":
      return "a directory on the way to it is closed to this user, so whether something is there cannot be told";
    default:
      return "a link or another kind of file is there or on the way to it, which Liftoff does not follow";
  }
}

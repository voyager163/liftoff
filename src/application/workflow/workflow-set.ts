import path from "node:path";
import type { ChangePlan, FileChange } from "../../domain/plan/change-plan.ts";
import { sha256Hex } from "../../domain/plan/plan.ts";
import type { ProjectConfig } from "../../domain/project/config.ts";
import type { Manifest } from "../../domain/project/manifest.ts";
import type { ProjectFile } from "../../generators/project.ts";
import { WORKFLOWS } from "../../plugins/registry.ts";
import { MAX_CHANGED_BYTES, type NewContent } from "../change/apply-changes.ts";
import {
  planTransition,
  type Transition,
  type TransitionFile,
  TransitionOptionError,
} from "../change/config-transition.ts";
import {
  ProjectChangeError,
  type ProjectRecords,
  sealProjectChange,
} from "../change/project-change.ts";
import {
  type ApplyOptions,
  frameworkFiles,
  type PlannedInitializer,
  plannedInitializer,
  runInitializer,
} from "../init/init-project.ts";
import type { AssetPort, InitializerPort, ProjectFsPort } from "../ports.ts";

/** What switching the workflow does with one of Liftoff's files. */
export type WorkflowFile = TransitionFile;

/** A workflow option this project cannot take. */
export class WorkflowOptionError extends ProjectChangeError {
  override readonly name = "WorkflowOptionError";
}

/** What the new framework's initializer wrote collides with the project, so nothing changed. */
export class FrameworkCollisionError extends ProjectChangeError {
  override readonly name = "FrameworkCollisionError";
  readonly paths: readonly string[];
  constructor(framework: string, paths: readonly string[]) {
    super(
      `${framework}'s initializer writes ${paths.join(", ")}, where the project already has something, so nothing was changed; move ${paths.length === 1 ? "it" : "them"} aside to switch`,
    );
    this.paths = paths;
  }
}

export interface WorkflowPlan {
  readonly directory: string;
  /** The workflow the project has. */
  readonly from: string;
  /** The workflow it is set to. */
  readonly to: string;
  /** Each of Liftoff's files the switch writes, or would, sorted by path. */
  readonly files: readonly WorkflowFile[];
  /** The old framework's files, which stay as they are and become the project's own. */
  readonly released: readonly string[];
  /** The new framework's initializer, which runs only once the switch is approved. */
  readonly initializer?: PlannedInitializer;
  /** The change, once nothing more is needed to make it: undefined while an initializer is still to run, or when nothing changes. */
  readonly plan?: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
  /** What the change is made of before the framework's files are added. */
  readonly pending?: Pending;
}

interface Pending {
  readonly project: ProjectRecords;
  readonly config: ProjectConfig;
  readonly generated: readonly ProjectFile[];
  readonly changes: readonly FileChange[];
  readonly contents: ReadonlyMap<string, NewContent>;
  readonly manifest: Omit<Manifest, "history">;
}

/**
 * Plans switching a Liftoff project's development workflow. It only reads,
 * and runs nothing: entering a framework needs its initializer, which runs
 * in completeWorkflowSet once the person approves.
 *
 * liftoff.yaml and the manifest are rewritten for the new workflow. Each
 * other file this release writes differently for it is changed only while
 * as Liftoff last wrote it, and added only where nothing is; anything else
 * is left and named. The old framework's files stay byte for byte, and the
 * manifest no longer lists them as the framework's.
 */
export async function planWorkflowSet(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  workflow: string,
): Promise<WorkflowPlan> {
  if (!Object.hasOwn(WORKFLOWS, workflow)) {
    throw new WorkflowOptionError(
      `unknown workflow "${workflow}"; available: ${Object.keys(WORKFLOWS).join(", ")}`,
    );
  }
  let transition: Transition | undefined;
  try {
    transition = await planTransition(ports, directory, liftoffVersion, "workflow-set", {
      name: "workflow",
      field: "workflow",
      to: workflow,
    });
  } catch (error) {
    if (error instanceof TransitionOptionError) throw new WorkflowOptionError(error.message);
    throw error;
  }
  const base = { directory, to: workflow, contents: new Map() };
  if (transition === undefined) return { ...base, from: workflow, files: [], released: [] };
  const { project, changes, contents, manifest, generated } = transition;
  const pending: Pending = {
    project,
    config: transition.config,
    generated: generated.files,
    changes,
    contents,
    manifest,
  };
  const planned = {
    ...base,
    from: project.config.workflow,
    files: transition.files,
    released: transition.released,
  };
  const initializer = plannedInitializer(generated.selection);
  if (initializer !== undefined) return { ...planned, initializer, pending };
  const sealed = sealProjectChange(
    project,
    "workflow-set",
    liftoffVersion,
    changes,
    contents,
    manifest,
  );
  return { ...planned, plan: sealed.plan, contents: sealed.contents, pending };
}

/**
 * Runs the new framework's pinned initializer, once the switch is approved,
 * in an empty directory beside the project, as init does: with telemetry
 * off and a temporary home and configuration directories. What it writes is
 * checked as init checks it, and becomes the framework's files in the
 * change, each only where the project has nothing; if it has something
 * where one goes, nothing changes. The directory is removed whatever
 * happens.
 */
export async function completeWorkflowSet(
  ports: { readonly fs: ProjectFsPort; readonly initializer: InitializerPort },
  workflow: WorkflowPlan,
  liftoffVersion: string,
  options: ApplyOptions = {},
): Promise<{
  readonly plan: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
  /** Empty directories the initializer made, to make once the change applies. */
  readonly directories: readonly string[];
}> {
  const { fs } = ports;
  const { pending, initializer } = workflow;
  const framework = WORKFLOWS[workflow.to];
  if (pending === undefined || initializer === undefined || framework?.initializer === undefined) {
    throw new Error("only a switch into a framework has an initializer to run");
  }
  options.signal?.throwIfAborted();
  const staging = await fs.createStaging(workflow.directory, "private");
  try {
    await runInitializer(ports.initializer, framework.initializer, initializer, staging, options);
    const written = await frameworkFiles(ports, staging, pending.generated, framework.initializer);
    const collisions: string[] = [];
    // A directory it made with nothing in it is the framework's too, such
    // as OpenSpec's specs/; nothing that is not a directory may stand in
    // its way.
    const directories = emptyDirectories(await fs.listTree(staging));
    for (const directory of directories) {
      if (!(await clearForDirectory(fs, workflow.directory, directory))) collisions.push(directory);
    }
    const unreadable: string[] = [];
    const changes = [...pending.changes];
    const contents = new Map(pending.contents);
    const files = [...pending.manifest.files];
    for (const file of written) {
      options.signal?.throwIfAborted();
      const there = await fs.hashWithin(workflow.directory, file.path, MAX_CHANGED_BYTES);
      if (there.kind !== "missing") {
        collisions.push(file.path);
        continue;
      }
      // Carried as the initializer wrote it: its exact text, and whether it
      // runs. A change holds text, so a file that is not UTF-8 is refused
      // rather than written back other than it was.
      const bytes = await fs.hashWithin(staging, file.path, MAX_CHANGED_BYTES);
      const content = (await fs.readText(path.join(staging, ...file.path.split("/")))) ?? "";
      if (bytes.kind !== "file" || bytes.sha256 !== sha256Hex(content)) {
        unreadable.push(file.path);
        continue;
      }
      const executable = bytes.executable === true;
      changes.push({
        path: file.path,
        before: null,
        after: sha256Hex(content),
        ownership: "framework",
        executable,
      });
      contents.set(file.path, { content, executable });
      files.push({
        path: file.path,
        ownership: "framework",
        sha256: sha256Hex(content),
        plugin: framework.id,
      });
    }
    if (collisions.length > 0)
      throw new FrameworkCollisionError(framework.title, collisions.sort());
    if (unreadable.length > 0) {
      throw new ProjectChangeError(
        `${framework.title}'s initializer wrote ${unreadable.sort().join(", ")}, which ${unreadable.length === 1 ? "is" : "are"} not UTF-8 text Liftoff can add as it was written, so nothing was changed`,
      );
    }
    const sealed = sealProjectChange(
      pending.project,
      "workflow-set",
      liftoffVersion,
      changes,
      contents,
      { ...pending.manifest, files },
    );
    return { ...sealed, directories };
  } finally {
    await fs.remove(staging);
  }
}

/** The directories of a tree with nothing in them, sorted. */
export function emptyDirectories(
  tree: readonly { readonly path: string; readonly kind: string }[],
): string[] {
  return tree
    .filter(
      (entry) =>
        entry.kind === "directory" &&
        !tree.some((other) => other.path.startsWith(`${entry.path}/`)),
    )
    .map((entry) => entry.path)
    .sort();
}

/** Whether every part of a directory's path is a directory, or missing, in the project: never a file or a link. */
export async function clearForDirectory(
  fs: ProjectFsPort,
  root: string,
  relative: string,
): Promise<boolean> {
  const parts = relative.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const entry = await fs.entry(path.join(root, ...parts.slice(0, depth)));
    if (entry.kind === "missing") return true;
    if (entry.kind !== "directory") return false;
  }
  return true;
}

/**
 * Makes the empty directories a framework's initializer made, before any
 * file of the change, one level at a time and never through a link, so a
 * change that stops part way and is finished later has them too. It
 * returns each directory it made, so they can be removed again if the
 * change is then refused. One that cannot be made refuses the switch, with
 * no file changed and those it made removed.
 */
export async function makeFrameworkDirectories(
  fs: ProjectFsPort,
  root: string,
  directories: readonly string[],
): Promise<string[]> {
  const made: string[] = [];
  for (const directory of directories) {
    const parts = directory.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const relative = parts.slice(0, depth).join("/");
      const at = path.join(root, ...parts.slice(0, depth));
      const entry = await fs.entry(at);
      try {
        if (entry.kind === "missing") {
          await fs.makeDirectory(at);
          made.push(relative);
        } else if (entry.kind !== "directory") throw new Error("something else is there");
      } catch (error) {
        await removeMadeDirectories(fs, root, made);
        throw new ProjectChangeError(
          `${directory}, an empty directory the framework's initializer made, could not be made (${(error as Error).message}), so no file was changed`,
        );
      }
    }
  }
  return made;
}

/** Removes directories makeFrameworkDirectories made, deepest first, each only while empty. */
export async function removeMadeDirectories(
  fs: ProjectFsPort,
  root: string,
  made: readonly string[],
): Promise<void> {
  const depth = (directory: string) => directory.split("/").length;
  for (const directory of [...made].sort((a, b) => depth(b) - depth(a))) {
    await fs.removeEmptyDirectory(root, directory).catch(() => false);
  }
}

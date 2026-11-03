import path from "node:path";
import type { ChangePlan, FileChange } from "../../domain/plan/change-plan.ts";
import { sha256Hex } from "../../domain/plan/plan.ts";
import {
  CONFIG_FILE,
  ConfigError,
  isStandardLayout,
  type ProjectConfig,
  validateConfig,
} from "../../domain/project/config.ts";
import type { Manifest, ManifestFile } from "../../domain/project/manifest.ts";
import { pathKey } from "../../domain/project/paths.ts";
import { isExecutable, type ProjectFile } from "../../generators/project.ts";
import { resolveSelection, SelectionError, WORKFLOWS } from "../../plugins/registry.ts";
import { MAX_CHANGED_BYTES, type NewContent } from "../change/apply-changes.ts";
import {
  isAdopted,
  ProjectChangeError,
  ProjectChangeUnsupportedError,
  type ProjectRecords,
  RECORDS,
  readProject,
  sealProjectChange,
} from "../change/project-change.ts";
import { generate } from "../init/generation.ts";
import {
  type ApplyOptions,
  frameworkFiles,
  type PlannedInitializer,
  plannedInitializer,
  runInitializer,
} from "../init/init-project.ts";
import type { AssetPort, InitializerPort, ProjectFsPort } from "../ports.ts";

/**
 * What switching the workflow does with one of Liftoff's files:
 * - change: as Liftoff last wrote it, so it is rewritten for the new workflow;
 * - add: one the new workflow has that the project does not, added;
 * - remove: one only the old workflow had, as Liftoff last wrote it, removed;
 * - left: one the new workflow writes differently, left as it is, with why.
 */
export interface WorkflowFile {
  readonly path: string;
  readonly step: "change" | "add" | "remove" | "left";
  readonly reason?: string;
}

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
  const { fs } = ports;
  if (!Object.hasOwn(WORKFLOWS, workflow)) {
    throw new WorkflowOptionError(
      `unknown workflow "${workflow}"; available: ${Object.keys(WORKFLOWS).join(", ")}`,
    );
  }
  const project = await readProject(fs, directory, "workflow-set");
  const { config, configText, manifest } = project;
  const base = { directory, from: config.workflow, to: workflow, contents: new Map() };
  if (config.workflow === workflow) return { ...base, files: [], released: [] };
  const written = manifest.files.find((file) => file.path === CONFIG_FILE);
  if (written?.sha256 !== sha256Hex(configText)) {
    throw new ProjectChangeError(
      `${CONFIG_FILE} changed since Liftoff last wrote it, and the workflow is switched only from a configuration Liftoff wrote; put it back as it was first`,
    );
  }
  let next: ProjectConfig;
  try {
    next = validateConfig({ ...config, workflow }, "the new workflow");
    resolveSelection(next);
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof SelectionError)) throw error;
    throw new WorkflowOptionError(error.message);
  }
  const application = !isAdopted(manifest);
  if (application && !isStandardLayout(config)) {
    throw new ProjectChangeUnsupportedError(
      "this release switches the workflow of a project it made only in the standard layout, but liftoff.yaml binds parts to other directories",
    );
  }
  const before = await generate(ports.assets, config, liftoffVersion, { application });
  const after = await generate(ports.assets, next, liftoffVersion, { application });
  const was = new Map(before.files.map((file) => [pathKey(file.path), file]));
  const now = new Map(after.files.map((file) => [pathKey(file.path), file]));
  const entries = new Map(manifest.files.map((entry) => [pathKey(entry.path), entry]));
  const kept = new Set(manifest.kept.map(pathKey));

  const files: WorkflowFile[] = [];
  const changes: FileChange[] = [];
  const contents = new Map<string, NewContent>();
  const recorded = new Map<string, ManifestFile>(
    manifest.files.map((entry) => [pathKey(entry.path), entry]),
  );
  const write = (file: ProjectFile, before: string | null) => {
    const executable = isExecutable(file.path);
    changes.push({
      path: file.path,
      before,
      after: file.sha256,
      ownership: file.ownership,
      executable,
    });
    contents.set(file.path, { content: file.content, executable });
    recorded.set(pathKey(file.path), {
      path: file.path,
      ownership: file.ownership,
      sha256: file.sha256,
      plugin: file.plugin,
    });
  };
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const old = was.get(key);
    const made = now.get(key);
    if (old?.sha256 === made?.sha256) continue;
    const relative = made?.path ?? old?.path ?? key;
    if (key === pathKey(CONFIG_FILE) && made !== undefined) {
      write(made, sha256Hex(configText));
      files.push({ path: relative, step: "change" });
      continue;
    }
    if (RECORDS.has(key)) continue;
    if (kept.has(key)) {
      files.push({
        path: relative,
        step: "left",
        reason: "the project's own, kept in place of Liftoff's",
      });
      continue;
    }
    const entry = entries.get(key);
    const disk = await fs.hashWithin(directory, relative, MAX_CHANGED_BYTES);
    const asWritten = entry !== undefined && disk.kind === "file" && disk.sha256 === entry.sha256;
    if (made !== undefined && entry === undefined && disk.kind === "missing") {
      write(made, null);
      files.push({ path: relative, step: "add" });
    } else if (made !== undefined && asWritten) {
      write(made, entry.sha256);
      files.push({ path: relative, step: "change" });
    } else if (made === undefined && asWritten) {
      changes.push({ path: relative, before: entry.sha256, after: null });
      recorded.delete(key);
      files.push({ path: relative, step: "remove" });
    } else {
      files.push({
        path: relative,
        step: "left",
        reason:
          entry === undefined
            ? "something is already there"
            : `changed since Liftoff wrote it, so it still describes ${config.workflow}; bring it up to date by hand`,
      });
    }
  }

  // The old framework's files stay, as the project's own.
  const oldPlugin = before.selection.workflow.id;
  const released = manifest.files
    .filter((entry) => entry.ownership === "framework" && entry.plugin === oldPlugin)
    .map((entry) => entry.path)
    .sort();
  for (const file of released) recorded.delete(pathKey(file));
  const plugins = [
    ...manifest.plugins.filter((plugin) => plugin.id !== oldPlugin),
    { id: after.selection.workflow.id, version: after.selection.workflow.version },
  ];
  const { history: _, ...rest } = manifest;
  const pending: Pending = {
    project,
    config: next,
    generated: after.files,
    changes,
    contents,
    manifest: { ...rest, plugins, files: [...recorded.values()] },
  };
  const initializer = plannedInitializer(after.selection);
  const planned = {
    ...base,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    released,
  };
  if (initializer !== undefined) return { ...planned, initializer, pending };
  const sealed = sealProjectChange(
    project,
    "workflow-set",
    liftoffVersion,
    changes,
    contents,
    pending.manifest,
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
): Promise<{ readonly plan: ChangePlan; readonly contents: ReadonlyMap<string, NewContent> }> {
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
      const content = (await fs.readText(path.join(staging, ...file.path.split("/")))) ?? "";
      const executable = isExecutable(file.path);
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
    return sealProjectChange(pending.project, "workflow-set", liftoffVersion, changes, contents, {
      ...pending.manifest,
      files,
    });
  } finally {
    await fs.remove(staging);
  }
}

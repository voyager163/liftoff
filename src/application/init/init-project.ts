import path from "node:path";
import {
  canonicalJson,
  PLAN_SCHEMA,
  type Plan,
  PlanError,
  sealPlan,
  sha256Hex,
} from "../../domain/plan/plan.ts";
import { type ProjectConfig, validateConfig } from "../../domain/project/config.ts";
import { MANIFEST_FILE, parseManifest, serializeManifest } from "../../domain/project/manifest.ts";
import { pathKey, repositoryPathProblem } from "../../domain/project/paths.ts";
import { isExecutable, type ProjectFile } from "../../generators/project.ts";
import type { WorkflowInitializer } from "../../plugins/contracts/project-plugin.ts";
import type { Selection } from "../../plugins/registry.ts";
import type { AssetPort, InitializerPort, ProjectFsPort } from "../ports.ts";
import { generate } from "./generation.ts";

export class InitTargetError extends Error {
  override readonly name = "InitTargetError";
}

/** A framework's initializer failed, or wrote something a project must not have. */
export class InitializerError extends Error {
  override readonly name = "InitializerError";
}

type PlannedInitializer = NonNullable<Plan["initializer"]>;

/** What a plan records about the workflow's initializer: exactly what will run. */
function plannedInitializer(selection: Selection): PlannedInitializer | undefined {
  const initializer = selection.workflow.initializer;
  if (!initializer) return undefined;
  return {
    name: initializer.name,
    version: initializer.version,
    steps: initializer
      .steps(selection.hosts)
      .map((step) => ({ command: step.command, args: [...step.args] })),
  };
}

const effectsFor = (initializer: PlannedInitializer | undefined): Plan["effects"] =>
  initializer ? ["write-files", "run-initializer"] : ["write-files"];

/**
 * Makes a plan to create a project: every file, its ownership and hash, and
 * the effects allowed: writing files into a new directory and, for a workflow
 * with its own initializer, running exactly the commands listed. Nothing is
 * written or run.
 */
export async function planInit(
  ports: { assets: AssetPort; fs: ProjectFsPort },
  request: { config: ProjectConfig; target: string; liftoffVersion: string; cwd?: string },
): Promise<Plan> {
  const target = path.resolve(request.target);
  await checkTarget(ports.fs, target, request.cwd);
  const { selection, files } = await generate(ports.assets, request.config, request.liftoffVersion);
  const initializer = plannedInitializer(selection);
  return sealPlan({
    schema: PLAN_SCHEMA,
    operation: "init",
    liftoff: request.liftoffVersion,
    target,
    config: { ...request.config },
    effects: effectsFor(initializer),
    ...(initializer ? { initializer } : {}),
    files: files.map((file) => ({
      path: file.path,
      ownership: file.ownership,
      sha256: file.sha256,
      bytes: Buffer.byteLength(file.content),
    })),
  });
}

export interface InitResult {
  readonly target: string;
  /** Files Liftoff wrote. */
  readonly files: number;
  /** Files the workflow's initializer wrote. */
  readonly frameworkFiles: number;
}

export interface ApplyOptions {
  /** The caller's working directory, which must not be the target or inside it. */
  readonly cwd?: string;
  /** Stops before publishing; the staged files are removed. */
  readonly signal?: AbortSignal;
  /** The clock the initializer's time limit is measured with, in milliseconds. */
  readonly now?: () => number;
}

/** How long a framework's initializer may take, all its steps together. */
export const INITIALIZER_TIME_LIMIT_MS = 10 * 60_000;

/**
 * Creates the project exactly as planned. Every file is regenerated and must
 * match the plan byte for byte, and the initializer must be the one planned.
 * The initializer runs first, alone in a staging directory beside the target;
 * what it wrote is checked and recorded in the manifest as owned by the
 * framework, which is why the manifest's hash then differs from the planned
 * one. Liftoff's files are added and everything is published with one
 * rename, so a failure leaves either the whole project or nothing.
 */
export async function applyInit(
  ports: { assets: AssetPort; fs: ProjectFsPort; initializer: InitializerPort },
  plan: Plan,
  liftoffVersion: string,
  options: ApplyOptions = {},
): Promise<InitResult> {
  if (plan.liftoff !== liftoffVersion) {
    throw new PlanError(
      `the plan was made by Liftoff ${plan.liftoff}, but this is ${liftoffVersion}; make a new plan`,
    );
  }
  const config = validateConfig(plan.config, "the plan's config");
  const { selection, files } = await generate(ports.assets, config, liftoffVersion);
  const planned = plan.files
    .map((file) => `${file.path} ${file.ownership} ${file.sha256}`)
    .join("\n");
  const actual = files.map((file) => `${file.path} ${file.ownership} ${file.sha256}`).join("\n");
  if (planned !== actual) {
    throw new PlanError(
      "this Liftoff would now generate different files than the plan lists; make a new plan",
    );
  }
  const initializer = plannedInitializer(selection);
  if (
    canonicalJson(plan.initializer) !== canonicalJson(initializer) ||
    canonicalJson(plan.effects) !== canonicalJson(effectsFor(initializer))
  ) {
    throw new PlanError(
      "this Liftoff would now run a different initializer than the plan lists; make a new plan",
    );
  }
  await checkTarget(ports.fs, plan.target, options.cwd);

  options.signal?.throwIfAborted();
  const staging = await ports.fs.createStaging(plan.target);
  try {
    let framework: { path: string; sha256: string }[] = [];
    const workflowInitializer = selection.workflow.initializer;
    if (initializer && workflowInitializer) {
      await runInitializer(ports.initializer, workflowInitializer, initializer, staging, options);
      framework = await frameworkFiles(ports, staging, files, workflowInitializer);
    }
    for (const file of files) {
      options.signal?.throwIfAborted();
      const content =
        file.path === MANIFEST_FILE && framework.length > 0
          ? withFrameworkFiles(file.content, framework, selection.workflow.id)
          : file.content;
      await ports.fs.writeFile(
        path.join(staging, ...file.path.split("/")),
        content,
        isExecutable(file.path),
      );
    }
    options.signal?.throwIfAborted();
    await ports.fs.publish(staging, plan.target);
    return { target: plan.target, files: files.length, frameworkFiles: framework.length };
  } catch (error) {
    await ports.fs.remove(staging);
    throw error;
  }
}

async function runInitializer(
  port: InitializerPort,
  workflow: WorkflowInitializer,
  planned: PlannedInitializer,
  directory: string,
  options: ApplyOptions,
): Promise<void> {
  const who = `${workflow.name} ${workflow.version}'s initializer`;
  const now = options.now ?? Date.now;
  // One limit for every step together, not a new one for each.
  const deadline = now() + INITIALIZER_TIME_LIMIT_MS;
  for (const step of planned.steps) {
    options.signal?.throwIfAborted();
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) throw new InitializerError(`${who} did not finish in time`);
    const outcome = await port.run(step, directory, {
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();
    if (!outcome.started) {
      throw new InitializerError(
        `${who} could not start (${outcome.output}); it needs ${workflow.needs}. Install it, or choose --workflow manual`,
      );
    }
    if (outcome.timedOut) throw new InitializerError(`${who} did not finish in time`);
    if (outcome.exitCode !== 0) {
      throw new InitializerError(
        `${who} failed with exit code ${outcome.exitCode}${outcome.output ? `:\n${outcome.output}` : ""}`,
      );
    }
  }
}

/** Machine paths shorter than this, such as "/" or "C:\", are too general to look for. */
const SHORTEST_MACHINE_PATH = 4;

/**
 * The files an initializer wrote, each checked: only regular files, no Git
 * repository, only paths every system can hold, nothing where Liftoff writes
 * a file of its own, and no path from this machine, since a project's files
 * must work on any machine.
 */
async function frameworkFiles(
  ports: { fs: ProjectFsPort; initializer: InitializerPort },
  staging: string,
  liftoff: readonly ProjectFile[],
  workflow: WorkflowInitializer,
): Promise<{ path: string; sha256: string }[]> {
  const who = `${workflow.name}'s initializer`;
  // macOS and Windows file systems usually ignore case, so neither does this.
  const ours = liftoff.map((file) => pathKey(file.path));
  // As written, with forward slashes, and with backslashes escaped as in JSON.
  const machinePaths = [staging, ...ports.initializer.machinePaths()]
    .filter((machinePath) => machinePath.length >= SHORTEST_MACHINE_PATH)
    .flatMap((machinePath) => [
      machinePath,
      machinePath.replaceAll("\\", "/"),
      machinePath.replaceAll("\\", "\\\\"),
    ]);
  const files: { path: string; sha256: string }[] = [];
  for (const entry of await ports.fs.listTree(staging)) {
    // At any depth, and in any case, since macOS and Windows ignore case.
    if (entry.path.split("/").some((part) => pathKey(part) === ".git")) {
      throw new InitializerError(
        `${who} created a Git repository; Liftoff leaves creating one to you`,
      );
    }
    // The manifest records the path, so it must be one every system can hold.
    const problem = repositoryPathProblem(entry.path);
    if (problem !== undefined) {
      throw new InitializerError(`${who} wrote a path not every system can hold: ${problem}`);
    }
    const key = pathKey(entry.path);
    if (entry.kind === "directory") {
      // Liftoff may add files inside the framework's directories, but a
      // directory cannot stand where Liftoff writes a file.
      if (ours.includes(key)) {
        throw new InitializerError(`${who} wrote ${entry.path}, where Liftoff writes its own file`);
      }
      continue;
    }
    if (entry.kind !== "file") {
      throw new InitializerError(`${who} created ${entry.path}, which is not a regular file`);
    }
    if (ours.some((own) => own === key || own.startsWith(`${key}/`) || key.startsWith(`${own}/`))) {
      throw new InitializerError(`${who} wrote ${entry.path}, where Liftoff writes its own file`);
    }
    const text = (await ports.fs.readText(path.join(staging, ...entry.path.split("/")))) ?? "";
    if (machinePaths.some((machinePath) => text.includes(machinePath))) {
      throw new InitializerError(
        `${who} wrote a path from this machine into ${entry.path}; a project's files must work on any machine`,
      );
    }
    files.push({ path: entry.path, sha256: sha256Hex(text) });
  }
  return files;
}

/** The manifest with the framework's files added, owned by the framework. */
function withFrameworkFiles(
  manifestText: string,
  framework: readonly { path: string; sha256: string }[],
  plugin: string,
): string {
  const manifest = parseManifest(manifestText);
  return serializeManifest({
    ...manifest,
    files: [
      ...manifest.files,
      ...framework.map((file) => ({ ...file, ownership: "framework" as const, plugin })),
    ],
  });
}

/**
 * A project is only ever created in a new or empty directory, and never in
 * the caller's working directory: publishing replaces the target directory,
 * which would leave the caller's shell in a deleted one.
 */
export async function checkTarget(fs: ProjectFsPort, target: string, cwd?: string): Promise<void> {
  if (cwd !== undefined) {
    const inside = path.relative(target, path.resolve(cwd));
    if (inside === "" || !(inside.startsWith("..") || path.isAbsolute(inside))) {
      throw new InitTargetError(
        `${target} is the current directory or contains it; run init from the directory that should hold the project`,
      );
    }
  }
  const state = await fs.state(target);
  if (state === "file") throw new InitTargetError(`${target} is a file`);
  if (state === "directory") {
    throw new InitTargetError(
      `${target} already has files; Liftoff creates new projects only in a new or empty directory`,
    );
  }
}

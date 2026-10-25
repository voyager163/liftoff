import path from "node:path";
import { PLAN_SCHEMA, type Plan, PlanError, sealPlan } from "../../domain/plan/plan.ts";
import { type ProjectConfig, validateConfig } from "../../domain/project/config.ts";
import type { ProjectFile } from "../../generators/project.ts";
import type { AssetPort, ProjectFsPort } from "../ports.ts";
import { generate } from "./generation.ts";

export class InitTargetError extends Error {
  override readonly name = "InitTargetError";
}

/** Files that need the executable bit. */
const isExecutable = (file: ProjectFile) => file.path.endsWith(".sh");

/**
 * Makes a plan to create a project: every file, its ownership and hash, and
 * the only effect allowed (writing files into a new directory). Nothing is
 * written.
 */
export async function planInit(
  ports: { assets: AssetPort; fs: ProjectFsPort },
  request: { config: ProjectConfig; target: string; liftoffVersion: string; cwd?: string },
): Promise<Plan> {
  const target = path.resolve(request.target);
  await checkTarget(ports.fs, target, request.cwd);
  const { files } = await generate(ports.assets, request.config, request.liftoffVersion);
  return sealPlan({
    schema: PLAN_SCHEMA,
    operation: "init",
    liftoff: request.liftoffVersion,
    target,
    config: { ...request.config },
    effects: ["write-files"],
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
  readonly files: number;
}

export interface ApplyOptions {
  /** The caller's working directory, which must not be the target or inside it. */
  readonly cwd?: string;
  /** Stops before publishing; the staged files are removed. */
  readonly signal?: AbortSignal;
}

/**
 * Creates the project exactly as planned. Every file is regenerated and must
 * match the plan byte for byte; then all of them are written into a staging
 * directory beside the target and published with one rename, so a failure
 * leaves either the whole project or nothing.
 */
export async function applyInit(
  ports: { assets: AssetPort; fs: ProjectFsPort },
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
  const { files } = await generate(ports.assets, config, liftoffVersion);
  const planned = plan.files
    .map((file) => `${file.path} ${file.ownership} ${file.sha256}`)
    .join("\n");
  const actual = files.map((file) => `${file.path} ${file.ownership} ${file.sha256}`).join("\n");
  if (planned !== actual) {
    throw new PlanError(
      "this Liftoff would now generate different files than the plan lists; make a new plan",
    );
  }
  await checkTarget(ports.fs, plan.target, options.cwd);

  options.signal?.throwIfAborted();
  const staging = await ports.fs.createStaging(plan.target);
  try {
    for (const file of files) {
      options.signal?.throwIfAborted();
      await ports.fs.writeFile(
        path.join(staging, ...file.path.split("/")),
        file.content,
        isExecutable(file),
      );
    }
    options.signal?.throwIfAborted();
    await ports.fs.publish(staging, plan.target);
  } catch (error) {
    await ports.fs.remove(staging);
    throw error;
  }
  return { target: plan.target, files: files.length };
}

/**
 * A project is only ever created in a new or empty directory, and never in
 * the caller's working directory: publishing replaces the target directory,
 * which would leave the caller's shell in a deleted one.
 */
async function checkTarget(fs: ProjectFsPort, target: string, cwd?: string): Promise<void> {
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

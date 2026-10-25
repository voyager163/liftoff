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
  request: { config: ProjectConfig; target: string; liftoffVersion: string },
): Promise<Plan> {
  const target = path.resolve(request.target);
  await checkTarget(ports.fs, target);
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
  await checkTarget(ports.fs, plan.target);

  const staging = await ports.fs.createStaging(plan.target);
  try {
    for (const file of files) {
      await ports.fs.writeFile(
        path.join(staging, ...file.path.split("/")),
        file.content,
        isExecutable(file),
      );
    }
    await ports.fs.publish(staging, plan.target);
  } catch (error) {
    await ports.fs.remove(staging);
    throw error;
  }
  return { target: plan.target, files: files.length };
}

/** A project is only ever created in a new or empty directory. */
async function checkTarget(fs: ProjectFsPort, target: string): Promise<void> {
  const state = await fs.state(target);
  if (state === "file") throw new InitTargetError(`${target} is a file`);
  if (state === "directory") {
    throw new InitTargetError(
      `${target} already has files; Liftoff creates new projects only in a new or empty directory`,
    );
  }
}

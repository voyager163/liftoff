import path from "node:path";
import { type Assessment, assess, type GitHubState } from "../../domain/assess/standard.ts";
import {
  type Declaration,
  type EntryKind,
  type Gap,
  holdsSecretsOrState,
  isDeclaration,
  isSkippedDirectory,
  LIMITS,
} from "../../domain/assess/tree.ts";
import type { LegacyInventory } from "../../domain/legacy/inventory.ts";
import type { ProjectFsPort } from "../ports.ts";
import { validateProject } from "./validate-project.ts";

export class AssessError extends Error {
  override readonly name = "AssessError";
}

export interface AssessOptions {
  /** Whether the person named the directory, rather than it being the current one. */
  readonly named: boolean;
  /** Directories never assessed, such as the home directory. */
  readonly refused: readonly string[];
  /** Reads the repository on GitHub, for --live, once the person has agreed. */
  readonly live?: () => Promise<GitHubState>;
  /** Bounds other than LIMITS, for tests. */
  readonly limits?: Limits;
}

type Limits = { readonly [Key in keyof typeof LIMITS]: number };

export interface ProjectAssessment extends Assessment {
  readonly directory: string;
  /** How much of the project was walked. */
  readonly walked: { readonly directories: number; readonly files: number; readonly read: number };
  readonly limits: Limits;
  /** What a Liftoff release before the rebuild left, when it did. */
  readonly legacy?: LegacyInventory;
}

const same = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Assesses a project against this release's standard. It only reads: it
 * walks the project within LIMITS, never following a link, reads only the
 * declarations it interprets, runs nothing, and reaches GitHub only through
 * `live`.
 */
export async function assessProject(
  fs: ProjectFsPort,
  directory: string,
  options: AssessOptions,
): Promise<ProjectAssessment> {
  const limits = options.limits ?? LIMITS;
  if (
    path.parse(directory).root === directory ||
    options.refused.some((refused) => same(refused, directory))
  ) {
    throw new AssessError(`${directory} is not a project; assess a repository instead`);
  }
  const top = await fs.entry(directory);
  if (top.kind === "missing") throw new AssessError(`${directory} does not exist`);
  if (top.kind === "inaccessible")
    throw new AssessError(`${directory} cannot be read by this user`);
  if (top.kind !== "directory") throw new AssessError(`${directory} is not a directory`);
  const git = ["file", "directory"].includes((await fs.entry(path.join(directory, ".git"))).kind);
  if (!git && !options.named) {
    throw new AssessError(
      `${directory} is not the root of a Git repository; name it with --dir to assess it anyway`,
    );
  }

  const entries = new Map<string, EntryKind>();
  const listed = new Set<string>();
  const gaps: Gap[] = [];
  const declarations: string[] = [];
  const queue: { readonly at: string; readonly depth: number }[] = [{ at: ".", depth: 0 }];
  let directories = 0;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const budget = limits.entries - entries.size;
    if (budget <= 0) {
      gaps.push({
        kind: "limit",
        path: ".",
        detail: `the walk stopped after ${limits.entries} entries`,
      });
      break;
    }
    const { at, depth } = next;
    const cap = Math.min(budget, limits.directoryEntries);
    const listing = await fs.listWithin(directory, at, cap);
    if (listing.kind === "inaccessible") {
      gaps.push({ kind: "inaccessible", path: listing.via ?? at, detail: "closed to this user" });
      continue;
    }
    if (listing.kind !== "directory") {
      gaps.push({
        kind: "changed",
        path: listing.kind === "other" ? (listing.via ?? at) : at,
        detail: "changed while it was being listed",
      });
      continue;
    }
    directories++;
    if (listing.complete) listed.add(at);
    else {
      gaps.push({
        kind: "limit",
        path: at,
        detail:
          cap < limits.directoryEntries
            ? `the walk stopped after ${limits.entries} entries`
            : `only its first ${cap} entries were listed`,
      });
    }
    for (const { name, kind } of listing.entries) {
      const file = at === "." ? name : `${at}/${name}`;
      entries.set(file, kind);
      if (kind === "other") {
        gaps.push({ kind: "link", path: file, detail: "a link or special file, never followed" });
      } else if (kind === "directory") {
        if (isSkippedDirectory(name)) {
          gaps.push({
            kind: "skipped",
            path: file,
            detail: name === ".git" ? "Git's own data" : "dependencies, caches or build output",
          });
        } else if (depth + 1 > limits.depth) {
          gaps.push({
            kind: "limit",
            path: file,
            detail: `deeper than ${limits.depth} directories`,
          });
        } else {
          queue.push({ at: file, depth: depth + 1 });
        }
      } else if (holdsSecretsOrState(file)) {
        gaps.push({
          kind: "not-read",
          path: file,
          detail: "may hold secrets or state, so only its name was seen",
        });
      } else if (isDeclaration(file)) {
        declarations.push(file);
      }
    }
  }

  const tooLarge = `over ${limits.bytes % 1024 === 0 ? `${limits.bytes / 1024} KiB` : `${limits.bytes} bytes`}, so not read`;
  const texts = new Map<string, Declaration>();
  for (const file of declarations.slice(0, limits.reads)) {
    const found = await fs.readWithin(directory, file, limits.bytes);
    if (found.kind === "file" && found.text !== undefined) {
      texts.set(file, { text: found.text });
    } else if (found.kind === "file") {
      texts.set(file, {
        status: "unknown",
        reason: tooLarge,
      });
      gaps.push({
        kind: "too-large",
        path: file,
        detail: tooLarge,
      });
    } else if (found.kind === "inaccessible") {
      texts.set(file, { status: "inaccessible", reason: "closed to this user" });
      gaps.push({ kind: "inaccessible", path: found.via ?? file, detail: "closed to this user" });
    } else {
      texts.set(file, { status: "unknown", reason: "changed while it was being read" });
      gaps.push({ kind: "changed", path: file, detail: "changed while it was being read" });
    }
  }
  const unread = declarations[limits.reads];
  if (unread !== undefined) {
    gaps.push({
      kind: "limit",
      path: unread,
      detail: `only the first ${limits.reads} declarations were read`,
    });
  }

  const validation = await validateProject(fs, directory);
  const findings = validation.findings;
  const liftoff = validation.legacy?.project
    ? { kind: "pre-rebuild" as const, inventory: validation.legacy, findings }
    : findings.some((finding) => finding.code === "not-a-liftoff-project")
      ? { kind: "none" as const, findings }
      : {
          kind: "project" as const,
          findings,
          ...(validation.config ? { governance: validation.config.governance } : {}),
        };
  const github: GitHubState = options.live ? await options.live() : { kind: "not-requested" };
  const assessment = assess(
    { entries, listed, declarations: texts, gaps },
    { git, liftoff, github },
  );
  return {
    directory,
    ...assessment,
    walked: {
      directories,
      files: [...entries.values()].filter((kind) => kind === "file").length,
      read: texts.size,
    },
    limits,
    ...(validation.legacy?.project ? { legacy: validation.legacy } : {}),
  };
}

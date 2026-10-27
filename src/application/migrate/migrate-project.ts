import path from "node:path";
import type { AssessmentFinding, Part } from "../../domain/assess/standard.ts";
import type { EntryKind, Gap } from "../../domain/assess/tree.ts";
import type { LegacyRecord } from "../../domain/legacy/inventory.ts";
import { PLAN_SCHEMA, type Plan, PlanError, sealPlan, sha256Hex } from "../../domain/plan/plan.ts";
import {
  COMPONENTS,
  CONFIG_SCHEMA,
  type Component,
  ConfigError,
  type ProjectConfig,
  STANDARD_LAYOUT,
  validateConfig,
} from "../../domain/project/config.ts";
import { MANIFEST_FILE, parseManifest, serializeManifest } from "../../domain/project/manifest.ts";
import { pathKey, repositoryPathProblem } from "../../domain/project/paths.ts";
import { isExecutable } from "../../generators/project.ts";
import { ENVIRONMENTS } from "../../plugins/contracts/project-plugin.ts";
import {
  DEFAULT_GOVERNANCE,
  DEFAULT_PATTERN,
  NO_FRONTEND,
  NO_INFRASTRUCTURE,
  NO_PATTERN,
  resolveSelection,
  SelectionError,
  STACKS,
} from "../../plugins/registry.ts";
import { MAX_CHANGED_BYTES } from "../change/apply-changes.ts";
import { ProjectChangeError, refuseUnfinishedChange } from "../change/project-change.ts";
import { generate } from "../init/generation.ts";
import { checkTarget, InitTargetError } from "../init/init-project.ts";
import type { AssetPort, ProjectFsPort } from "../ports.ts";
import { type AssessOptions, assessProject } from "../project/assess-project.ts";
import {
  choicesOf,
  legacyBlocks,
  noName,
  oldChoices,
  optionProblem,
  type ProjectChoices,
  type Proposal,
  proposeName,
  proposeSettings,
  refuseLiftoffProject,
} from "../project/proposal.ts";
import { validateProject } from "../project/validate-project.ts";
import {
  CHECKLIST_FILE,
  COPY_DIRECTORY,
  type LeftOut,
  type MigratedPart,
  renderChecklist,
} from "./checklist.ts";

/** The largest file the copy holds; a larger one is left out and named. */
export const MAX_COPIED_BYTES = MAX_CHANGED_BYTES;

/** The most the copy holds together. */
export const MAX_COPY_BYTES = 1024 * 1024 * 1024;

/** What the person named on the command line; the new project's layout is always the standard one. */
export type MigrateChoices = Omit<ProjectChoices, "layout">;

/** A file the migration copies, by its path in the old project. */
export interface CopiedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface MigratePlan {
  /** The old project, which migrating never changes. */
  readonly source: string;
  /** Where the new project goes. */
  readonly target: string;
  /** Each choice, with where it came from. */
  readonly proposal: readonly Proposal[];
  /** The new project's configuration, once Liftoff could tell. */
  readonly config?: ProjectConfig;
  /** Why the project cannot be migrated as it is; empty when it can. */
  readonly blocked: readonly string[];
  /** Each part found in the old project, and where the new project keeps it. */
  readonly parts: readonly MigratedPart[];
  /** Each file copied into the new project's legacy/, sorted by path. */
  readonly copies: readonly CopiedFile[];
  /** What the copy leaves out, and why. */
  readonly left: readonly LeftOut[];
  /** What a Liftoff release before the rebuild left in the old project. */
  readonly legacy: readonly LegacyRecord[];
  /** The plan to apply, or undefined when migrating is blocked. */
  readonly plan?: Plan;
  /** Every file it writes other than the copies, by path. */
  readonly contents: ReadonlyMap<
    string,
    { readonly content: string; readonly executable: boolean }
  >;
}

/** An option chose something this release cannot make the new project with. */
export class MigrateOptionError extends ProjectChangeError {
  override readonly name = "MigrateOptionError";
}

/** A file of the old project changed after the plan was made, so nothing was created. */
export class MigrateChangedError extends Error {
  override readonly name = "MigrateChangedError";
}

/** Whether a plan says the project cannot be migrated as it is. */
export const isBlocked = (migration: MigratePlan): boolean => migration.blocked.length > 0;

/** Where the assessment migrating rests on looks, and the caller's directory. */
export type MigrateWhere = Pick<AssessOptions, "named" | "refused" | "limits"> & {
  /** The caller's working directory, which must not be the new project's or inside it. */
  readonly cwd?: string;
};

const changedWhilePlanned = (file: string) =>
  `${file} changed while migrating was being planned; plan it again`;

/** Whether `inner` is `outer` or inside it, as macOS and Windows compare names. */
export function within(inner: string, outer: string): boolean {
  const relative = path.relative(pathKey(outer), pathKey(inner));
  return relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative));
}

/**
 * Refuses a target that is the old project, is inside it or holds it, as
 * macOS and Windows compare names, or whose directory is not there: the new
 * project goes in a directory that exists, so nothing is made on the way to
 * it, inside the old project or anywhere else. Links in both paths are
 * followed by the caller, once, before they are compared.
 */
async function checkMigrationTarget(
  fs: ProjectFsPort,
  source: string,
  target: string,
  cwd: string | undefined,
): Promise<void> {
  if (within(target, source) || within(source, target)) {
    throw new InitTargetError(
      `${target} overlaps the project it is made from; put the new project beside it, with --to`,
    );
  }
  const parent = path.dirname(target);
  if ((await fs.entry(parent)).kind !== "directory") {
    throw new InitTargetError(
      `${parent}, where the new project goes, is not a directory; make it first`,
    );
  }
  await checkTarget(fs, target, cwd, "migrate");
}

/**
 * Plans making a new Liftoff project from an existing one, in a new or
 * empty directory beside it. It only reads the old project: it assesses it
 * as `liftoff assess` does, proposes what the new project is from what it
 * holds and the person's choices, and lists every file it would copy into
 * the new project's legacy/, with its hash, and every one it leaves out.
 *
 * It refuses an old project that is not there, has a change that has not
 * finished or is Liftoff's already, and a target that is not new or empty
 * or overlaps the old project. Anything else that keeps the project from
 * being migrated as it is is returned in `blocked`, with no plan.
 */
export async function planMigrate(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  source: string,
  target: string,
  liftoffVersion: string,
  choices: MigrateChoices,
  where: MigrateWhere,
): Promise<MigratePlan> {
  const { fs } = ports;
  // An option's mistake is never hidden behind anything about the project.
  const problem = optionProblem(choices);
  if (problem !== undefined) throw new MigrateOptionError(problem);
  if ((await fs.directoryIdentity(source)) === undefined) {
    throw new ProjectChangeError(`${source} is not a directory Liftoff can migrate`);
  }
  await checkMigrationTarget(fs, source, target, where.cwd);
  await refuseUnfinishedChange(fs, source);
  await refuseLiftoffProject(fs, source);

  const read = new Map<string, string>();
  const walked = new Map<string, EntryKind>();
  const { cwd: _, ...assessWhere } = where;
  const assessment = await assessProject(fs, source, { ...assessWhere, read, walked });
  const legacy = assessment.legacy?.records ?? [];
  const blocked = legacyBlocks(legacy, "migrating");
  const old = await oldChoices(fs, source, legacy, read, changedWhilePlanned);
  // A part of the project the walk did not reach would be missing from the copy.
  for (const gap of assessment.gaps) {
    if (gap.kind === "limit" || gap.kind === "inaccessible" || gap.kind === "changed") {
      blocked.push(
        `part of the project was not walked (${gap.path ?? "."}: ${gap.detail}), so the copy would miss it`,
      );
    }
  }
  const { copies, left, closed, bytes } = await copyList(
    fs,
    source,
    walked,
    assessment.gaps,
    legacy,
  );
  for (const file of closed) {
    blocked.push(`${file} is closed to this user, so the copy would miss it`);
  }
  if (bytes > MAX_COPY_BYTES) {
    blocked.push(
      `the copy would hold ${Math.ceil(bytes / 1024 / 1024)} MiB, more than the ${MAX_COPY_BYTES / 1024 / 1024 / 1024} GiB Liftoff copies`,
    );
  }

  const chosen = chooseParts(assessment.parts, assessment.findings, choices);
  blocked.push(...chosen.blocked);
  const base = { source, target, copies, left, legacy, contents: new Map() };
  const proposal: Proposal[] = [];
  const stack = chosen.backend === undefined ? undefined : STACKS[chosen.backend.stack];
  if (chosen.backend === undefined || stack === undefined) {
    return { ...base, proposal, blocked, parts: describeParts(assessment.parts, undefined) };
  }
  const name = proposeName(proposal, choices, old, source);
  if (name === undefined) {
    blocked.push(noName(source));
    return { ...base, proposal, blocked, parts: describeParts(assessment.parts, undefined) };
  }
  for (const component of COMPONENTS) {
    const part = chosen[component];
    proposal.push(
      part === undefined
        ? { choice: component, value: "none", from: chosen.from[component] }
        : {
            choice: component,
            value: `${part.stack} in ${STANDARD_LAYOUT[component]}`,
            from: chosen.from[component],
            ...(part.evidence.length === 0 ? {} : { evidence: part.evidence }),
          },
    );
  }
  const frontend = chosen.frontend?.stack ?? NO_FRONTEND;
  const infrastructure = chosen.infrastructure?.stack ?? NO_INFRASTRUCTURE;
  const settings = proposeSettings(proposal, choices, old, {
    workload: stack.workload,
    infrastructure,
    agents: assessment.agents,
  });

  // What the parts alone make: a problem here is the project's, which only
  // leaving a part out resolves.
  try {
    resolveSelection(
      validateConfig(
        {
          schema: CONFIG_SCHEMA,
          name: "migrated",
          workload: stack.workload,
          stack: chosen.backend.stack,
          pattern: stack.workload === "genai" ? DEFAULT_PATTERN : NO_PATTERN,
          frontend,
          infrastructure,
          environments: infrastructure === NO_INFRASTRUCTURE ? [] : [...ENVIRONMENTS],
          workflow: "manual",
          agents: [],
          governance: DEFAULT_GOVERNANCE,
          review: { ai: false },
          owners: [],
          layout: {},
        },
        "the proposal",
      ),
    );
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof SelectionError)) throw error;
    blocked.push(
      error instanceof SelectionError && error.unsupported
        ? `${error.message}; leave that part out with --frontend none or --infrastructure none, and its copy stays in ${COPY_DIRECTORY}/`
        : error.message,
    );
    return { ...base, proposal, blocked, parts: describeParts(assessment.parts, undefined) };
  }
  // The parts make a project this release has, so anything else wrong is in
  // what the options chose.
  let config: ProjectConfig;
  try {
    config = validateConfig(
      {
        schema: CONFIG_SCHEMA,
        name,
        workload: stack.workload,
        stack: chosen.backend.stack,
        pattern: settings.pattern,
        frontend,
        infrastructure,
        environments: [...settings.environments],
        workflow: "manual",
        agents: [...settings.agents],
        governance: settings.governance,
        review: settings.review,
        owners: choices.owners ?? [],
        layout: {},
      },
      "an option",
    );
    resolveSelection(config);
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof SelectionError)) throw error;
    throw new MigrateOptionError(error.message);
  }
  const parts = describeParts(assessment.parts, config);
  if (blocked.length > 0) return { ...base, proposal, blocked, config, parts };

  // The project init would make, with the migration first in its history.
  const generation = await generate(ports.assets, config, liftoffVersion);
  const contents = new Map<string, { content: string; executable: boolean }>();
  const files: Plan["files"] = [];
  for (const file of generation.files) {
    if (
      pathKey(file.path) === pathKey(CHECKLIST_FILE) ||
      pathKey(file.path).startsWith(`${COPY_DIRECTORY}/`)
    ) {
      throw new Error(`${file.path} is where a migration puts its own files`);
    }
    const content =
      file.path === MANIFEST_FILE
        ? serializeManifest({
            ...parseManifest(file.content),
            history: [{ operation: "migrate", liftoff: liftoffVersion }],
          })
        : file.content;
    contents.set(file.path, { content, executable: isExecutable(file.path) });
    files.push({
      path: file.path,
      ownership: file.ownership,
      sha256: sha256Hex(content),
      bytes: Buffer.byteLength(content),
    });
  }
  const checklist = renderChecklist({
    liftoffVersion,
    source: path.basename(source),
    selection: generation.selection,
    parts,
    left,
    copied: copies.map((copy) => copy.path),
    records: legacy.length > 0,
    ...releaseOf(legacy),
  });
  contents.set(CHECKLIST_FILE, { content: checklist, executable: false });
  const plan = sealPlan({
    schema: PLAN_SCHEMA,
    operation: "migrate",
    liftoff: liftoffVersion,
    target,
    source,
    config: { ...config },
    effects: ["write-files", "copy-files"],
    files,
    copies: copies.map((copy) => ({ ...copy })),
    checklist: {
      path: CHECKLIST_FILE,
      sha256: sha256Hex(checklist),
      bytes: Buffer.byteLength(checklist),
    },
  });
  return { ...base, proposal, blocked, config, parts, plan, contents };
}

/**
 * Plans the migration a saved plan describes, from the configuration it
 * holds, and refuses it unless it is that plan exactly: made by this
 * release, for an old project still as it was when the plan was made.
 */
export async function planMigrateFromSaved(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  saved: Plan,
  liftoffVersion: string,
  where: Omit<MigrateWhere, "named">,
): Promise<MigratePlan> {
  if (saved.liftoff !== liftoffVersion) {
    throw new PlanError(
      `the plan was made by Liftoff ${saved.liftoff}, but this is ${liftoffVersion}; make a new plan`,
    );
  }
  if (saved.operation !== "migrate" || saved.source === undefined) {
    throw new PlanError("this plan does not migrate a project; apply it with liftoff init --plan");
  }
  let config: ProjectConfig;
  try {
    config = validateConfig(saved.config, "the plan's configuration");
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new PlanError(error.message);
  }
  const { layout: _, ...choices } = choicesOf(config);
  const migration = await planMigrate(ports, saved.source, saved.target, liftoffVersion, choices, {
    ...where,
    named: true,
  });
  if (migration.plan?.hash !== saved.hash) {
    throw new PlanError(
      "the project changed since the plan was made, so the plan no longer says what migrate would do; make a new plan",
    );
  }
  return migration;
}

export interface MigrateResult {
  readonly target: string;
  /** Files written, the copies included. */
  readonly files: number;
  /** What differs from the plan in the new project, or what validating it found; empty when nothing. */
  readonly differences: readonly string[];
}

/**
 * Makes the new project exactly as planned. Every file, Liftoff's, the
 * checklist and the copies, is written into a staging directory beside the
 * target; each copy must hash as the plan says, or nothing is created. The
 * whole project is then moved into place with one rename, read back and
 * validated. The old project is only read.
 */
export async function applyMigrate(
  fs: ProjectFsPort,
  migration: MigratePlan,
  options: { readonly cwd?: string; readonly signal?: AbortSignal } = {},
): Promise<MigrateResult> {
  const { plan } = migration;
  if (plan === undefined) throw new Error("a migration that is blocked has no plan to apply");
  await checkMigrationTarget(fs, migration.source, plan.target, options.cwd);
  options.signal?.throwIfAborted();
  const staging = await fs.createStaging(plan.target);
  try {
    for (const [file, { content, executable }] of migration.contents) {
      options.signal?.throwIfAborted();
      await fs.writeFile(path.join(staging, ...file.split("/")), content, executable);
    }
    for (const copy of migration.copies) {
      options.signal?.throwIfAborted();
      const copied = await fs.copyWithin(
        migration.source,
        copy.path,
        MAX_COPIED_BYTES,
        path.join(staging, COPY_DIRECTORY, ...copy.path.split("/")),
      );
      if (copied.kind !== "file" || copied.sha256 !== copy.sha256) {
        throw new MigrateChangedError(
          `${copy.path} changed since the migration was planned, so nothing was created; plan it again`,
        );
      }
    }
    options.signal?.throwIfAborted();
    await fs.publish(staging, plan.target);
  } catch (error) {
    await fs.remove(staging);
    throw error;
  }
  return {
    target: plan.target,
    files: migration.contents.size + migration.copies.length,
    differences: await verifyMigration(fs, migration),
  };
}

/**
 * Reads the new project back: each file must be as planned, and validating
 * it must find nothing wrong.
 */
async function verifyMigration(fs: ProjectFsPort, migration: MigratePlan): Promise<string[]> {
  const { plan } = migration;
  if (plan === undefined) return [];
  const expected = [
    ...plan.files.map((file) => [file.path, file.sha256] as const),
    ...(plan.checklist === undefined
      ? []
      : [[plan.checklist.path, plan.checklist.sha256] as const]),
    ...migration.copies.map((copy) => [`${COPY_DIRECTORY}/${copy.path}`, copy.sha256] as const),
  ];
  const differences: string[] = [];
  for (const [file, sha256] of expected) {
    const now = await fs.hashWithin(plan.target, file, MAX_COPIED_BYTES);
    if (now.kind !== "file" || now.sha256 !== sha256) {
      differences.push(`${file} is not as planned`);
    }
  }
  const validation = await validateProject(fs, plan.target);
  for (const finding of validation.findings) {
    if (finding.severity !== "info") {
      differences.push(
        `${finding.path === undefined ? "" : `${finding.path}: `}${finding.message}`,
      );
    }
  }
  return differences;
}

/** The release the old project's records are from, when one says. */
function releaseOf(legacy: readonly LegacyRecord[]): { readonly release?: string } {
  const release = legacy.find((record) => record.release !== undefined)?.release;
  return release === undefined ? {} : { release };
}

/**
 * Every regular file the walk reached that the copy holds, each hashed as
 * it is now, and what it leaves out: Git's data, dependencies, caches and
 * build output; files that may hold secrets or state; records from before
 * the rebuild; links; files over the size it copies; and paths not every
 * system can hold, or that another path takes on macOS and Windows.
 */
async function copyList(
  fs: ProjectFsPort,
  source: string,
  walked: ReadonlyMap<string, EntryKind>,
  gaps: readonly Gap[],
  legacy: readonly LegacyRecord[],
): Promise<{ copies: CopiedFile[]; left: LeftOut[]; closed: string[]; bytes: number }> {
  const records = new Set(legacy.map((record) => pathKey(record.path)));
  const left: LeftOut[] = [];
  const notRead = new Set<string>();
  for (const gap of gaps) {
    if (gap.path === undefined) continue;
    if (gap.kind === "skipped") {
      left.push({
        path: gap.path,
        kind: path.posix.basename(gap.path) === ".git" ? "git" : "dependencies",
        why: gap.detail,
      });
    } else if (gap.kind === "link") {
      left.push({ path: gap.path, kind: "link", why: gap.detail });
    } else if (gap.kind === "not-read") {
      notRead.add(gap.path);
      left.push({
        path: gap.path,
        kind: records.has(pathKey(gap.path)) ? "records" : "secrets",
        why: gap.detail,
      });
    }
  }
  const copies: CopiedFile[] = [];
  const closed: string[] = [];
  const taken = new Map<string, string>();
  let bytes = 0;
  const files = [...walked]
    .filter(([file, kind]) => kind === "file" && !notRead.has(file))
    .map(([file]) => file)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const file of files) {
    const key = pathKey(file);
    if (records.has(key)) {
      left.push({
        path: file,
        kind: "records",
        why: "kept by a Liftoff release before the rebuild, as the old project's history",
      });
      continue;
    }
    const problem = repositoryPathProblem(file);
    const other = taken.get(key);
    if (problem !== undefined || other !== undefined) {
      left.push({
        path: file,
        kind: "name",
        why: problem ?? `macOS and Windows take it for ${other}`,
      });
      continue;
    }
    taken.set(key, file);
    const now = await fs.hashWithin(source, file, MAX_COPIED_BYTES);
    if (now.kind === "inaccessible") {
      closed.push(now.via ?? file);
      continue;
    }
    if (now.kind !== "file") throw new ProjectChangeError(changedWhilePlanned(file));
    if (now.sha256 === undefined) {
      left.push({
        path: file,
        kind: "large",
        why: `over ${MAX_COPIED_BYTES / 1024 / 1024} MiB`,
      });
      continue;
    }
    copies.push({ path: file, sha256: now.sha256, bytes: now.size });
    bytes += now.size;
  }
  left.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { copies, left, closed: [...new Set(closed)], bytes };
}

/** Each kind of part the new project has, and where the choice came from. */
type Chosen = Partial<Record<Component, ChosenPart>> & {
  readonly from: Record<Component, Proposal["from"]>;
  readonly blocked: string[];
};

/** The stack the new project has for a part, and the files it was found from. */
interface ChosenPart {
  readonly stack: string;
  readonly evidence: readonly string[];
}

const described = (part: Part) => `${part.stack} in ${part.path}`;

/**
 * The stack the new project has for each kind of part: the one named with
 * an option, or the one this release supports that the old project's parts
 * of that kind are on. Parts on several stacks, or a backend on none this
 * release supports, block migrating until an option names one. So does a
 * directory Liftoff could not tell the contents of, unless every kind of
 * part is named.
 */
function chooseParts(
  parts: readonly Part[],
  findings: readonly AssessmentFinding[],
  choices: MigrateChoices,
): Chosen {
  const blocked: string[] = [];
  const from = {} as Record<Component, Proposal["from"]>;
  const chosen: Partial<Record<Component, ChosenPart>> = {};
  for (const component of COMPONENTS) {
    const option = component === "backend" ? choices.stack : choices[component];
    const flag = component === "backend" ? "--stack" : `--${component}`;
    const found = parts.filter((part) => part.component === component && part.supported);
    const evidence = (stack: string) =>
      found
        .filter((part) => part.stack === stack)
        .flatMap((part) => part.evidence.map((item) => item.path));
    if (option !== undefined) {
      from[component] = "option";
      if (option !== "none") chosen[component] = { stack: option, evidence: evidence(option) };
      continue;
    }
    from[component] = "found";
    const stacks = [...new Set(found.map((part) => part.stack))].sort();
    const [only] = stacks;
    if (stacks.length === 1 && only !== undefined) {
      chosen[component] = { stack: only, evidence: evidence(only) };
    } else if (stacks.length > 1) {
      blocked.push(
        `the project holds a ${component} on each of ${stacks.join(" and ")} (${found.map(described).join(", ")}); name the one the new project has with ${flag}`,
      );
    } else if (component === "backend") {
      const others = parts.filter((part) => part.component === "backend");
      blocked.push(
        others.length > 0
          ? `no backend this release supports was found: the project holds ${others.map(described).join(", ")}; name the stack to move it to with --stack`
          : "no backend this release supports was found; name the stack the new project has with --stack",
      );
    }
  }
  // What was not seen may hold a part, unless every kind of part is named.
  const named =
    choices.stack !== undefined &&
    choices.frontend !== undefined &&
    choices.infrastructure !== undefined;
  if (!named) {
    for (const finding of findings) {
      if (
        finding.check === "structure.part" &&
        finding.subject !== undefined &&
        (finding.status === "unknown" || finding.status === "inaccessible")
      ) {
        blocked.push(
          `${finding.message}, so a part may be there that Liftoff cannot see; name the new project's parts with --stack, --frontend and --infrastructure`,
        );
      }
    }
  }
  return { ...chosen, from, blocked };
}

/**
 * Each part found in the old project, backend first, and where the new
 * project keeps it: the new project has one part of each kind, in its
 * standard directory.
 */
function describeParts(found: readonly Part[], config: ProjectConfig | undefined): MigratedPart[] {
  const order = (part: Part) => COMPONENTS.indexOf(part.component as Component);
  const parts = [...found].sort((a, b) => order(a) - order(b));
  if (config === undefined) {
    return parts.map((part) => ({
      path: part.path,
      component: part.component as Component,
      stack: part.stack,
      note: "",
    }));
  }
  const stackOf: Record<Component, string> = {
    backend: config.stack,
    frontend: config.frontend,
    infrastructure: config.infrastructure,
  };
  return parts.map((part): MigratedPart => {
    const component = part.component as Component;
    const kind = parts.filter((other) => other.component === component);
    const stack = stackOf[component];
    if (stack === NO_FRONTEND || stack === NO_INFRASTRUCTURE) {
      return {
        path: part.path,
        component,
        stack: part.stack,
        note: `The new project has no ${component}: keep it apart as its own project, or leave it out.`,
      };
    }
    const notes = [
      ...(kind.length > 1
        ? [
            `The new project has one ${component}, and the old one holds ${kind.length}: move the one it should hold, and keep the others apart.`,
          ]
        : []),
      part.stack === stack
        ? "Where the starter and the old code do the same thing, keep the starter's configuration, health checks and tests, and move the rest."
        : `It is on ${part.stack}${part.supported ? "" : ", which this release has no standard for"}, and the new project's is on ${stack}: rewrite it there.`,
    ];
    return {
      path: part.path,
      component,
      stack: part.stack,
      to: STANDARD_LAYOUT[component],
      note: notes.join(" "),
    };
  });
}

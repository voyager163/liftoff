import path from "node:path";
import type { AssessmentFinding, Part, Status } from "../../domain/assess/standard.ts";
import type { LegacyRecord } from "../../domain/legacy/inventory.ts";
import { MAX_LEGACY_BYTES } from "../../domain/legacy/inventory.ts";
import { type ChangePlan, type FileChange, sealChangePlan } from "../../domain/plan/change-plan.ts";
import { PLAN_SCHEMA, PlanError, sha256Hex } from "../../domain/plan/plan.ts";
import {
  COMPONENTS,
  CONFIG_FILE,
  CONFIG_SCHEMA,
  type Component,
  ConfigError,
  layoutOf,
  type ProjectConfig,
  projectNameProblem,
  validateConfig,
} from "../../domain/project/config.ts";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  type Manifest,
  type Ownership,
  serializeManifest,
} from "../../domain/project/manifest.ts";
import { pathKey } from "../../domain/project/paths.ts";
import { isExecutable, type ProjectFile } from "../../generators/project.ts";
import { AGENT_HOSTS } from "../../plugins/builtin/agents/hosts.ts";
import { ENVIRONMENTS } from "../../plugins/contracts/project-plugin.ts";
import {
  DEFAULT_GOVERNANCE,
  DEFAULT_PATTERN,
  GOVERNANCE,
  NO_FRONTEND,
  NO_INFRASTRUCTURE,
  NO_PATTERN,
  PATTERNS,
  resolveSelection,
  SelectionError,
  STACKS,
} from "../../plugins/registry.ts";
import {
  CHANGE_COMMANDS,
  MAX_CHANGED_BYTES,
  type NewContent,
  type Unchanged,
} from "../change/apply-changes.ts";
import {
  MAX_RECORD_BYTES,
  nameOnDisk,
  ProjectChangeError,
  RECORDS,
  refuseUnfinishedChange,
} from "../change/project-change.ts";
import { generate } from "../init/generation.ts";
import type { AssetPort, FileHash, ProjectFsPort } from "../ports.ts";
import {
  type AssessOptions,
  assessProject,
  type ProjectAssessment,
} from "../project/assess-project.ts";

/** What the person named on the command line; anything not named is proposed. */
export interface AdoptChoices {
  readonly name?: string;
  readonly stack?: string;
  readonly pattern?: string;
  readonly frontend?: string;
  readonly infrastructure?: string;
  readonly environments?: readonly string[];
  readonly agents?: readonly string[];
  readonly governance?: string;
  readonly aiReview?: "auto" | "on" | "off";
  readonly reviewEngine?: string;
  readonly owners?: readonly string[];
  /** The directory each part lives in, "." for the repository root. */
  readonly layout?: Readonly<Partial<Record<Component, string>>>;
}

/** Where a proposed choice came from. */
export type ProposalSource =
  | "option"
  | "found"
  | "old configuration"
  | "directory name"
  | "default";

export interface Proposal {
  /** Which choice, such as "backend" or "agents". */
  readonly choice: string;
  readonly value: string;
  readonly from: ProposalSource;
  /** The files a choice that was found rests on. */
  readonly evidence?: readonly string[];
}

/** A part of the project adopting leaves as it is, the project's own, and why. */
export interface OtherPart {
  readonly path: string;
  readonly component: string;
  readonly stack: string;
  readonly reason: string;
}

/**
 * What adopting does with one of Liftoff's files:
 * - add: nothing is where it goes, so it is added;
 * - kept: something is there, or may be, so that stays the project's and
 *   Liftoff's is not added.
 */
export interface AdoptFile {
  readonly path: string;
  readonly step: "add" | "kept";
  readonly ownership: Ownership;
  readonly reason?: string;
}

/** A change the standard expects of the application, which adopting does not make. */
export interface ApplicationChange {
  readonly check: string;
  readonly status: Status;
  readonly subject?: string;
  readonly message: string;
  readonly next?: string;
}

export interface AdoptPlan {
  readonly directory: string;
  /** Each choice, with where it came from. */
  readonly proposal: readonly Proposal[];
  /** The configuration the project would have, once Liftoff could tell. */
  readonly config?: ProjectConfig;
  /** Why the project cannot be adopted as it is; empty when it can. */
  readonly blocked: readonly string[];
  /** Whether the project has no backend this release has a stack for. */
  readonly unsupported: boolean;
  /** Parts adopting leaves as they are. */
  readonly others: readonly OtherPart[];
  /** Each of Liftoff's files, added or kept, sorted by path. */
  readonly files: readonly AdoptFile[];
  /** What the standard expects of the application that it does not have. */
  readonly application: readonly ApplicationChange[];
  /** What a Liftoff release before the rebuild left, kept as it is. */
  readonly legacy: readonly LegacyRecord[];
  /** The change to make, or undefined when adopting is blocked. */
  readonly plan?: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
}

/** An option chose something this release cannot adopt the project with. */
export class AdoptOptionError extends ProjectChangeError {
  override readonly name = "AdoptOptionError";
}

const changedWhilePlanned = (file: string) =>
  `${file} changed while adopting was being planned, or is not UTF-8 text; plan it again`;

/** Whether a plan says the project cannot be adopted as it is. */
export const isBlocked = (adopt: AdoptPlan): boolean => adopt.blocked.length > 0;

/** Where the assessment adopting rests on looks: the options assess takes. */
export type AdoptWhere = Pick<AssessOptions, "named" | "refused" | "limits">;

/** Findings about what the application holds, which adopting never changes. */
const APPLICATION_AREAS: ReadonlySet<string> = new Set([
  "dependencies",
  "tests",
  "build",
  "data",
  "infrastructure",
  "docs",
]);

/**
 * Plans adopting an existing project into Liftoff. It only reads: it
 * assesses the project as `liftoff assess` does, proposes what the project
 * is from what it holds and the person's choices, and plans adding
 * liftoff.yaml, the manifest and Liftoff's own files for where the parts
 * live, never over anything the project has.
 *
 * It refuses a directory that is not there, a change that has not finished,
 * and a project Liftoff already has. A part it cannot place, and anything
 * else that keeps the project from being adopted as it is, is returned in
 * `blocked`, with no plan.
 */
export async function planAdopt(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  choices: AdoptChoices,
  where: AdoptWhere,
): Promise<AdoptPlan> {
  const { fs } = ports;
  if ((await fs.directoryIdentity(directory)) === undefined) {
    throw new ProjectChangeError(`${directory} is not a directory Liftoff can change`);
  }
  await refuseUnfinishedChange(fs, directory);
  for (const record of [CONFIG_FILE, MANIFEST_FILE]) {
    const found = await fs.hashWithin(directory, record, MAX_RECORD_BYTES);
    if (found.kind === "file" || found.kind === "directory") {
      throw new ProjectChangeError(
        `${record} is already here, so this is a Liftoff project, which liftoff update and liftoff repair change; liftoff validate checks it`,
      );
    }
  }

  // The hash of each declaration and old record, as the assessment read it.
  const read = new Map<string, string>();
  const assessment = await assessProject(fs, directory, { ...where, read });
  const blocked: string[] = [];
  const legacy = assessment.legacy?.records ?? [];
  for (const record of legacy) {
    if (record.blocks !== undefined) blocked.push(`${record.path}: ${record.blocks}`);
    else if (record.state === "unsupported") {
      blocked.push(
        `${record.path}, from a Liftoff release before the rebuild, is not a record adopting can rely on (${record.reason}); adopting does not guess past it`,
      );
    }
  }
  const old = await oldChoices(fs, directory, legacy, read);
  const parts = resolveParts(assessment, choices);
  blocked.push(...parts.blocked);

  const base = {
    directory,
    unsupported: parts.unsupported,
    others: parts.others,
    files: [],
    application: [],
    legacy,
    contents: new Map<string, NewContent>(),
  };
  const backend = parts.chosen.backend;
  const stack = backend === undefined ? undefined : STACKS[backend.stack];
  const proposal: Proposal[] = [];
  if (backend === undefined || stack === undefined) return { ...base, proposal, blocked };

  // Each choice is the first of: the option, what was found or the old
  // configuration said, and the default.
  const pick = <T>(
    choice: string,
    shown: (value: T) => string,
    sources: readonly (readonly [ProposalSource, T | undefined])[],
  ): T | undefined => {
    for (const [from, value] of sources) {
      if (value === undefined) continue;
      proposal.push({ choice, value: shown(value), from });
      return value;
    }
    return undefined;
  };
  const text = (value: string) => value;
  const list = (value: readonly string[]) => (value.length === 0 ? "none" : value.join(", "));
  const name = pick("name", text, [
    ["option", choices.name],
    ["old configuration", old.name],
    ["directory name", nameFrom(directory)],
  ]);
  if (name === undefined) {
    blocked.push(
      `the directory's name, ${path.basename(directory)}, does not make a project name; give one with --name`,
    );
    return { ...base, proposal, blocked };
  }
  for (const component of COMPONENTS) {
    const part = parts.chosen[component];
    const option = optionFor(choices, component);
    proposal.push(
      part === undefined
        ? { choice: component, value: "none", from: option === "none" ? "option" : "found" }
        : {
            choice: component,
            value: `${part.stack} in ${part.path}`,
            from: choices.layout?.[component] !== undefined ? "option" : "found",
            evidence: part.evidence.map((evidence) => evidence.path),
          },
    );
  }
  const pattern =
    stack.workload === "genai"
      ? (pick("pattern", text, [
          ["option", choices.pattern],
          ["old configuration", old.pattern],
          ["default", DEFAULT_PATTERN],
        ]) ?? DEFAULT_PATTERN)
      : (choices.pattern ?? NO_PATTERN);
  const infrastructure = parts.chosen.infrastructure?.stack ?? NO_INFRASTRUCTURE;
  const environments =
    infrastructure === NO_INFRASTRUCTURE
      ? (choices.environments ?? [])
      : (pick("environments", list, [
          ["option", choices.environments],
          ["old configuration", old.environments],
          ["default", ENVIRONMENTS],
        ]) ?? ENVIRONMENTS);
  // Adopting never switches the workflow: a framework's files stay the
  // project's, and no initializer runs.
  proposal.push({ choice: "workflow", value: "manual", from: "default" });
  const agents =
    pick("agents", list, [
      ["option", choices.agents],
      ["old configuration", old.agents],
      ["found", assessment.agents.length === 0 ? undefined : assessment.agents],
      ["default", []],
    ]) ?? [];
  const governance =
    pick("governance", text, [
      ["option", choices.governance],
      ["old configuration", old.governance],
      ["default", DEFAULT_GOVERNANCE],
    ]) ?? DEFAULT_GOVERNANCE;
  const mode = choices.aiReview ?? "auto";
  const review = {
    ai: mode === "on" || (mode === "auto" && agents.length > 0),
    ...(choices.reviewEngine === undefined ? {} : { engine: choices.reviewEngine }),
  };
  proposal.push({
    choice: "AI review",
    value: review.ai ? `on${review.engine === undefined ? "" : ` (${review.engine})`}` : "off",
    from: choices.aiReview === undefined || choices.aiReview === "auto" ? "default" : "option",
  });

  const layout = Object.fromEntries(
    COMPONENTS.flatMap((component) => {
      const part = parts.chosen[component];
      return part === undefined ? [] : [[component, part.path]];
    }),
  );
  const frontend = parts.chosen.frontend?.stack ?? NO_FRONTEND;
  // What the parts alone make: a problem here is the project's, which only
  // moving a part, or leaving one out, resolves.
  try {
    resolveSelection(
      validateConfig(
        {
          schema: CONFIG_SCHEMA,
          name: "adopted",
          workload: stack.workload,
          stack: backend.stack,
          pattern: stack.workload === "genai" ? DEFAULT_PATTERN : NO_PATTERN,
          frontend,
          infrastructure,
          environments: infrastructure === NO_INFRASTRUCTURE ? [] : [...ENVIRONMENTS],
          workflow: "manual",
          agents: [],
          governance: DEFAULT_GOVERNANCE,
          review: { ai: false },
          owners: [],
          layout,
        },
        "the proposal",
      ),
    );
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof SelectionError)) throw error;
    blocked.push(
      error instanceof SelectionError && error.unsupported
        ? `${error.message}; leave that part out with --frontend none or --infrastructure none, and it stays the project's own`
        : error.message,
    );
    return { ...base, proposal, blocked };
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
        stack: backend.stack,
        pattern,
        frontend,
        infrastructure,
        environments: [...environments],
        workflow: "manual",
        agents: [...agents],
        governance,
        review,
        owners: choices.owners ?? [],
        layout,
      },
      "an option",
    );
    resolveSelection(config);
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof SelectionError)) throw error;
    throw new AdoptOptionError(error.message);
  }
  if (blocked.length > 0) return { ...base, proposal, blocked, config };

  // Liftoff's own files, each added only where nothing is.
  const generation = await generate(ports.assets, config, liftoffVersion, { application: false });
  const files: AdoptFile[] = [];
  const added: ProjectFile[] = [];
  const kept: string[] = [];
  const changes: FileChange[] = [];
  const contents = new Map<string, NewContent>();
  for (const file of generation.files) {
    if (file.path === MANIFEST_FILE) continue;
    const why = await occupant(fs, directory, file.path);
    if (why !== undefined) {
      if (RECORDS.has(pathKey(file.path))) blocked.push(`${file.path} cannot be added: ${why}`);
      files.push({ path: file.path, step: "kept", ownership: file.ownership, reason: why });
      kept.push(file.path);
      continue;
    }
    files.push({ path: file.path, step: "add", ownership: file.ownership });
    added.push(file);
    const executable = isExecutable(file.path);
    changes.push({
      path: file.path,
      before: null,
      after: file.sha256,
      ownership: file.ownership,
      executable,
    });
    contents.set(file.path, { content: file.content, executable });
  }
  const manifestAt = await occupant(fs, directory, MANIFEST_FILE);
  if (manifestAt !== undefined) blocked.push(`${MANIFEST_FILE} cannot be added: ${manifestAt}`);

  // The declarations the proposal rests on, and the old records the
  // manifest records, must still be exactly as the assessment read them
  // when it applies; so must they be now.
  const unchanged: Unchanged[] = [];
  const rest = async (file: string): Promise<string> => {
    const seen = read.get(file);
    const now = await fs.hashWithin(directory, file, MAX_CHANGED_BYTES);
    if (seen === undefined || now.kind !== "file" || now.sha256 !== seen) {
      throw new ProjectChangeError(changedWhilePlanned(file));
    }
    unchanged.push({ path: file, sha256: seen });
    return seen;
  };
  const declarations = new Set(
    Object.values(parts.chosen).flatMap((part) =>
      part.evidence.filter((evidence) => evidence.how === "read").map(({ path: file }) => file),
    ),
  );
  for (const file of [...declarations].sort()) await rest(file);
  const records: NonNullable<Manifest["legacy"]>["records"] = [];
  for (const record of legacy) {
    if (record.state === "executable") continue;
    // Only records Liftoff reads are hashed; the others, which can hold
    // copies of files, credentials or state, are noted by name alone.
    const sha256 = record.opened ? await rest(record.path) : undefined;
    records.push({
      path: record.path,
      record: record.record,
      state: record.state,
      ...(record.format === undefined ? {} : { format: record.format }),
      ...(sha256 === undefined ? {} : { sha256 }),
    });
  }
  const release = legacy.find((record) => record.release !== undefined)?.release;

  const application: ApplicationChange[] = [
    ...assessment.findings
      .filter((finding) => isApplicationChange(finding, Object.values(parts.chosen)))
      .map(({ check, status, subject, message, next }) => ({
        check,
        status,
        ...(subject === undefined ? {} : { subject }),
        message,
        ...(next === undefined ? {} : { next: next.text }),
      })),
    ...(await unignored(fs, directory, generation.files, kept)),
    ...(await withoutRoots(fs, directory, parts.chosen.infrastructure)),
  ];
  const planned = {
    ...base,
    proposal,
    config,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    application,
  };
  if (blocked.length > 0) return { ...planned, blocked };

  const manifestText = serializeManifest({
    schema: MANIFEST_SCHEMA,
    generatedBy: { liftoff: liftoffVersion },
    history: [{ operation: "adopt", liftoff: liftoffVersion }],
    plugins: generation.selection.plugins.map(({ id, version }) => ({ id, version })),
    files: added.map(({ path: file, ownership, sha256, plugin }) => ({
      path: file,
      ownership,
      sha256,
      plugin,
    })),
    kept,
    ...(records.length === 0
      ? {}
      : { legacy: { ...(release === undefined ? {} : { release }), records } }),
  });
  if (Buffer.byteLength(manifestText) > MAX_RECORD_BYTES) {
    throw new ProjectChangeError(
      `${MANIFEST_FILE} would be over ${MAX_RECORD_BYTES / 1024 / 1024} MiB, more than Liftoff reads, so nothing was changed`,
    );
  }
  changes.push({
    path: MANIFEST_FILE,
    before: null,
    after: sha256Hex(manifestText),
    ownership: "managed",
    executable: false,
  });
  contents.set(MANIFEST_FILE, { content: manifestText, executable: false });
  const plan = sealChangePlan({
    schema: PLAN_SCHEMA,
    operation: "adopt",
    liftoff: liftoffVersion,
    target: directory,
    config: { ...config },
    effects: ["modify-files"],
    changes,
    unchanged,
  });
  return { ...planned, blocked, plan, contents };
}

/**
 * Plans the adoption a saved plan describes, from the configuration it
 * holds, and refuses it unless it is that plan exactly: made by this
 * release, for a project still as it was when the plan was made.
 */
export async function planAdoptFromSaved(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  saved: ChangePlan,
  liftoffVersion: string,
  where: Omit<AdoptWhere, "named">,
): Promise<AdoptPlan> {
  if (saved.operation !== "adopt") {
    throw new PlanError(
      `this plan is for ${CHANGE_COMMANDS[saved.operation]}, not liftoff adopt; apply it with that command`,
    );
  }
  if (saved.liftoff !== liftoffVersion) {
    throw new PlanError(
      `the plan was made by Liftoff ${saved.liftoff}, but this is ${liftoffVersion}; make a new plan`,
    );
  }
  let config: ProjectConfig;
  try {
    config = validateConfig(saved.config, "the plan's configuration");
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new PlanError(error.message);
  }
  const adopt = await planAdopt(ports, saved.target, liftoffVersion, choicesOf(config), {
    ...where,
    named: true,
  });
  if (adopt.plan?.hash !== saved.hash) {
    throw new PlanError(
      "the project changed since the plan was made, so the plan no longer says what adopt would do; make a new plan",
    );
  }
  return adopt;
}

/** The choices that make exactly this configuration. */
function choicesOf(config: ProjectConfig): AdoptChoices {
  return {
    name: config.name,
    stack: config.stack,
    pattern: config.pattern,
    frontend: config.frontend,
    infrastructure: config.infrastructure,
    environments: config.environments,
    agents: config.agents,
    governance: config.governance,
    aiReview: config.review.ai ? "on" : "off",
    ...(config.review.engine === undefined ? {} : { reviewEngine: config.review.engine }),
    owners: config.owners,
    layout: layoutOf(config),
  };
}

interface Resolved {
  readonly chosen: Partial<Record<Component, Part>>;
  readonly others: OtherPart[];
  readonly blocked: string[];
  readonly unsupported: boolean;
}

const described = (part: Part) => `${part.stack} in ${part.path}`;

/** The option that says what a part is: --stack for the backend, --frontend or --infrastructure. */
const optionFor = (choices: AdoptChoices, component: Component): string | undefined =>
  component === "backend" ? choices.stack : choices[component];

/**
 * Which directory holds each part. A part named with --layout must be
 * there; otherwise the one part of its kind this release supports is
 * taken, or the stack named for it. Several, or one that cannot be found,
 * block adopting rather than a guess. So does a directory Liftoff could not
 * tell the contents of, unless every part is named.
 */
function resolveParts(assessment: ProjectAssessment, choices: AdoptChoices): Resolved {
  const chosen: Partial<Record<Component, Part>> = {};
  const blocked: string[] = [];
  const supportedBackend = assessment.parts.some(
    (part) => part.component === "backend" && part.supported,
  );
  for (const component of COMPONENTS) {
    const option = optionFor(choices, component);
    const flag = component === "backend" ? "--stack" : `--${component}`;
    const bound = choices.layout?.[component];
    if (component !== "backend" && option === "none") {
      if (bound !== undefined) {
        blocked.push(`--layout binds the ${component}, but ${flag} none leaves it out`);
      }
      continue;
    }
    const found = assessment.parts.filter((part) => part.component === component && part.supported);
    if (bound !== undefined) {
      const at = found.filter((part) => pathKey(part.path) === pathKey(bound));
      const part = at.find((candidate) => option === undefined || candidate.stack === option);
      if (part !== undefined) {
        chosen[component] = part;
        continue;
      }
      const there = assessment.parts.find((other) => pathKey(other.path) === pathKey(bound));
      blocked.push(
        at[0] !== undefined
          ? `${bound} holds a ${component} on ${at[0].stack}, not on ${option}`
          : there !== undefined
            ? `${bound} holds ${there.supported ? `a ${there.component}` : `an application`} on ${there.stack}, not a ${component} this release supports`
            : `no ${component} this release supports is in ${bound}`,
      );
      continue;
    }
    const candidates = option === undefined ? found : found.filter((part) => part.stack === option);
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) {
      chosen[component] = only;
    } else if (candidates.length > 1) {
      blocked.push(
        `${candidates.length} directories hold a ${component} (${candidates.map(described).join(", ")}); name the one to adopt with --layout ${component}=<directory>`,
      );
    } else if (option !== undefined) {
      blocked.push(
        `${flag} ${option} names a ${component}, but none on ${option} was found; name its directory with --layout ${component}=<directory>`,
      );
    } else if (component === "backend") {
      const others = assessment.parts.filter((part) => !part.supported);
      blocked.push(
        others.length > 0
          ? `no backend this release supports was found: the project holds ${others.map(described).join(", ")}, which this release has no stack for`
          : "no backend this release supports was found: no pyproject.toml that depends on FastAPI, package.json that depends on Fastify, or go.mod that requires Huma",
      );
    }
  }

  // What was not seen may hold a part, unless every part is named.
  const pinned = COMPONENTS.every(
    (component) =>
      choices.layout?.[component] !== undefined || optionFor(choices, component) === "none",
  );
  const unclear = [
    ...assessment.findings
      .filter(
        (finding) =>
          finding.check === "structure.part" &&
          finding.subject !== undefined &&
          (finding.status === "unknown" || finding.status === "inaccessible"),
      )
      .map((finding) => finding.message),
    ...assessment.gaps
      .filter(
        (gap) => gap.kind === "limit" || gap.kind === "inaccessible" || gap.kind === "changed",
      )
      .map((gap) => `${gap.path ?? "."} was not walked: ${gap.detail}`),
  ];
  if (!pinned) {
    for (const message of unclear) {
      blocked.push(
        `${message}, so a part may be there that Liftoff cannot see; name every part with --layout, leaving out a frontend or infrastructure with --frontend none or --infrastructure none`,
      );
    }
  }

  const adopted = new Set(Object.values(chosen));
  const others = assessment.parts
    .filter((part) => !adopted.has(part))
    .map((part) => ({
      path: part.path,
      component: part.component,
      stack: part.stack,
      reason: !part.supported
        ? "this release has no standard for it, so it stays as it is, unchecked"
        : optionFor(choices, part.component as Component) === "none"
          ? `left out with --${part.component} none`
          : chosen[part.component as Component] !== undefined
            ? `another ${part.component} is adopted`
            : "not adopted",
    }));
  return {
    chosen,
    others,
    blocked,
    unsupported: !supportedBackend && unclear.length === 0,
  };
}

/**
 * The lines Liftoff's .gitignore has for what it writes only while one of
 * its commands runs, which the project's own .gitignore, kept in its place,
 * does not have.
 */
async function unignored(
  fs: ProjectFsPort,
  directory: string,
  generated: readonly ProjectFile[],
  kept: readonly string[],
): Promise<ApplicationChange[]> {
  const ignore = ".gitignore";
  const liftoff = generated.find((file) => file.path === ignore);
  if (liftoff === undefined || !kept.includes(ignore)) return [];
  const own = await fs.readWithin(directory, ignore, MAX_RECORD_BYTES);
  // A line counts with or without a leading "/", as does ignoring all of .liftoff.
  const has = new Set(
    own.kind === "file" && own.text !== undefined
      ? own.text.split(/\r?\n/).map((line) => line.trim().replace(/^\//, "").replace(/\/$/, ""))
      : [],
  );
  const missing = has.has(".liftoff")
    ? []
    : liftoff.content.split("\n").filter((line) => line.startsWith(".liftoff/") && !has.has(line));
  return missing.length === 0
    ? []
    : [
        {
          check: "liftoff.ignored",
          status: "noncompliant",
          message: `${ignore} does not list ${missing.join(", ")}, which Liftoff writes only while one of its commands runs`,
          next: `Add ${missing.length === 1 ? "it" : "them"} to ${ignore}.`,
        },
      ];
}

/**
 * Liftoff's CI validates the OpenTofu roots it makes: one for the
 * bootstrap and one for each environment. Infrastructure laid out
 * otherwise needs moving before those checks pass.
 */
async function withoutRoots(
  fs: ProjectFsPort,
  directory: string,
  part: Part | undefined,
): Promise<ApplicationChange[]> {
  if (part === undefined) return [];
  const missing: string[] = [];
  for (const root of ["bootstrap", "environments"]) {
    const at = part.path === "." ? root : `${part.path}/${root}`;
    if ((await fs.entry(path.join(directory, ...at.split("/")))).kind !== "directory") {
      missing.push(at);
    }
  }
  return missing.length === 0
    ? []
    : [
        {
          check: "infrastructure.roots",
          status: "noncompliant",
          subject: `infrastructure at ${part.path}`,
          message: `Liftoff's CI validates the OpenTofu roots in ${part.path}/bootstrap and each ${part.path}/environments/<environment>, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not there`,
          next: "Move the roots there, or leave the infrastructure out with --infrastructure none.",
        },
      ];
}

/** Whether a finding is about the application of an adopted part, which adopting never changes. */
function isApplicationChange(finding: AssessmentFinding, adopted: readonly Part[]): boolean {
  if (!APPLICATION_AREAS.has(finding.area)) return false;
  if (finding.status === "compliant" || finding.status === "unsupported") return false;
  return (
    finding.subject === undefined ||
    adopted.some((part) => finding.subject === `${part.component} at ${part.path}`)
  );
}

/** A project name made from the directory's name, if one can be. */
function nameFrom(directory: string): string | undefined {
  const name = path
    .basename(directory)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return projectNameProblem(name) === undefined ? name : undefined;
}

/** What an old configuration says that this release accepts as it is. */
interface OldChoices {
  readonly name?: string;
  readonly agents?: readonly string[];
  readonly governance?: string;
  readonly pattern?: string;
  readonly environments?: readonly string[];
}

/**
 * The choices a Liftoff release before the rebuild recorded in its
 * configuration, when it can be carried over (LEGACY-001): only values
 * this release has, exactly as they are. Anything else is left for the
 * proposal to make.
 */
async function oldChoices(
  fs: ProjectFsPort,
  directory: string,
  records: readonly LegacyRecord[],
  read: ReadonlyMap<string, string>,
): Promise<OldChoices> {
  const config = records.find((record) => record.record === "config");
  if (config?.state !== "migratable") return {};
  // Only the configuration that was found migratable is carried over.
  const now = await fs.readWithin(directory, config.path, MAX_LEGACY_BYTES);
  if (
    now.kind !== "file" ||
    now.text === undefined ||
    sha256Hex(now.text) !== read.get(config.path)
  ) {
    throw new ProjectChangeError(changedWhilePlanned(config.path));
  }
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(now.text) as Record<string, unknown>;
  } catch {
    return {};
  }
  const one = (value: unknown, known: (text: string) => boolean) =>
    typeof value === "string" && known(value) ? value : undefined;
  const some = (value: unknown, known: (text: string) => boolean) =>
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && known(item)) &&
    new Set(value).size === value.length
      ? (value as string[])
      : undefined;
  const has = (registry: object) => (key: string) => Object.hasOwn(registry, key);
  const name = one(fields.projectName, (text) => projectNameProblem(text) === undefined);
  const agents = some(fields.agents, has(AGENT_HOSTS));
  const governance = one(fields.governanceProfile, has(GOVERNANCE));
  const pattern = one(fields.pattern, has(PATTERNS));
  const environments = some(fields.environments, (text) =>
    (ENVIRONMENTS as readonly string[]).includes(text),
  );
  return {
    ...(name === undefined ? {} : { name }),
    ...(agents === undefined ? {} : { agents }),
    ...(governance === undefined ? {} : { governance }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(environments === undefined ? {} : { environments }),
  };
}

/**
 * Why something is, or may be, where one of Liftoff's files would go, or
 * undefined when nothing is. Names are compared as macOS and Windows
 * compare them, so a file in other letter case counts.
 */
async function occupant(
  fs: ProjectFsPort,
  directory: string,
  file: string,
): Promise<string | undefined> {
  const now: FileHash = await fs.hashWithin(directory, file, MAX_CHANGED_BYTES);
  switch (now.kind) {
    case "missing": {
      const named = await nameOnDisk(fs, directory, file);
      return named === undefined
        ? undefined
        : `the project has ${named}, which macOS and Windows take for the same file`;
    }
    case "file":
    case "directory":
      return `the project has a ${now.kind} there`;
    case "inaccessible":
      return "a directory on the way to it is closed to this user, so whether something is there cannot be told";
    default:
      return "a link or another kind of file is there or on the way to it, which Liftoff does not follow";
  }
}

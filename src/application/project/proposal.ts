import path from "node:path";
import type { LegacyRecord } from "../../domain/legacy/inventory.ts";
import { MAX_LEGACY_BYTES } from "../../domain/legacy/inventory.ts";
import { sha256Hex } from "../../domain/plan/plan.ts";
import {
  CONFIG_FILE,
  type Component,
  isGithubLogin,
  layoutOf,
  type ProjectConfig,
  projectNameProblem,
} from "../../domain/project/config.ts";
import { MANIFEST_FILE } from "../../domain/project/manifest.ts";
import { AGENT_HOSTS } from "../../plugins/builtin/agents/hosts.ts";
import { ENVIRONMENTS } from "../../plugins/contracts/project-plugin.ts";
import {
  DEFAULT_GOVERNANCE,
  DEFAULT_PATTERN,
  GOVERNANCE,
  NO_INFRASTRUCTURE,
  NO_PATTERN,
  PATTERNS,
  STACKS,
} from "../../plugins/registry.ts";
import { MAX_RECORD_BYTES, ProjectChangeError } from "../change/project-change.ts";
import type { ProjectFsPort } from "../ports.ts";

/**
 * What the person named on the command line about a project Liftoff is to
 * take on, by adopting or migrating it; anything not named is proposed.
 */
export interface ProjectChoices {
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

/** A part of the project Liftoff leaves as it is, the project's own, and why. */
export interface OtherPart {
  readonly path: string;
  readonly component: string;
  readonly stack: string;
  readonly reason: string;
}

/**
 * Why an option names something this release does not have, or rules out
 * another option given with it, or undefined. Checked before the project is
 * looked at, so an option's mistake is never hidden behind what keeps the
 * project from being taken on.
 */
export function optionProblem(choices: ProjectChoices): string | undefined {
  const unknown = (
    option: string,
    values: readonly string[] | undefined,
    known: (value: string) => boolean,
    available: readonly string[],
  ) => {
    const value = values?.find((candidate) => !known(candidate));
    return value === undefined
      ? undefined
      : `--${option}: unknown ${option === "agents" ? "agent" : option.replace(/s$/, "")} "${value}"; available: ${available.join(", ")}`;
  };
  const has = (registry: object) => (key: string) => Object.hasOwn(registry, key);
  const hosts = Object.keys(AGENT_HOSTS);
  const owners = choices.owners ?? [];
  const twice = (values: readonly string[], fold = (value: string) => value) =>
    new Set(values.map(fold)).size !== values.length;
  const name = choices.name === undefined ? undefined : projectNameProblem(choices.name);
  if (name !== undefined) return `--name: ${name}`;
  return (
    unknown("agents", choices.agents, has(AGENT_HOSTS), hosts) ??
    unknown(
      "environments",
      choices.environments,
      (value) => (ENVIRONMENTS as readonly string[]).includes(value),
      ENVIRONMENTS,
    ) ??
    unknown(
      "review-engine",
      choices.reviewEngine === undefined ? undefined : [choices.reviewEngine],
      has(AGENT_HOSTS),
      hosts,
    ) ??
    unknown(
      "stack",
      choices.stack === undefined ? undefined : [choices.stack],
      has(STACKS),
      Object.keys(STACKS),
    ) ??
    unknown(
      "pattern",
      choices.pattern === undefined ? undefined : [choices.pattern],
      (value) => value === NO_PATTERN || has(PATTERNS)(value),
      Object.keys(PATTERNS),
    ) ??
    unknown(
      "governance",
      choices.governance === undefined ? undefined : [choices.governance],
      has(GOVERNANCE),
      Object.keys(GOVERNANCE),
    ) ??
    (owners.find((owner) => !isGithubLogin(owner)) !== undefined
      ? `--owners: "${owners.find((owner) => !isGithubLogin(owner))}" is not a GitHub login`
      : undefined) ??
    (twice(choices.agents ?? []) ||
    twice(choices.environments ?? []) ||
    twice(owners, (owner) => owner.toLowerCase())
      ? "--agents, --environments and --owners each name a value once"
      : undefined) ??
    conflict(choices)
  );
}

/** Why options given together rule each other out, whatever the project holds. */
function conflict(choices: ProjectChoices): string | undefined {
  const { agents, environments, stack, pattern, infrastructure, reviewEngine } = choices;
  for (const component of ["frontend", "infrastructure"] as const) {
    if (choices.layout?.[component] !== undefined && choices[component] === "none") {
      return `--layout binds the ${component}, but --${component} none leaves it out`;
    }
  }
  if (reviewEngine !== undefined && agents !== undefined && !agents.includes(reviewEngine)) {
    return `--review-engine ${reviewEngine} must be one of the agents --agents selects`;
  }
  if (choices.aiReview === "on" && agents !== undefined && agents.length === 0) {
    return "--ai-review on needs a coding agent, and --agents selects none";
  }
  if (environments !== undefined && infrastructure !== undefined) {
    if (infrastructure === NO_INFRASTRUCTURE && environments.length > 0) {
      return "--environments are for infrastructure, which --infrastructure none leaves out";
    }
    if (infrastructure !== NO_INFRASTRUCTURE && environments.length === 0) {
      return `--infrastructure ${infrastructure} needs at least one of --environments`;
    }
  }
  const workload = stack === undefined ? undefined : STACKS[stack]?.workload;
  if (
    workload !== undefined &&
    pattern !== undefined &&
    (pattern !== NO_PATTERN) !== (workload === "genai")
  ) {
    return workload === "genai"
      ? `--stack ${stack} is for GenAI projects, which need a pattern, not --pattern none`
      : `--pattern is for GenAI projects, not a ${stack} backend`;
  }
  return undefined;
}

/** The choices that make exactly this configuration. */
export function choicesOf(config: ProjectConfig): ProjectChoices {
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

/**
 * Proposes a choice: the first of the sources that has a value, recorded in
 * `proposal` with where it came from.
 */
export function pick<T>(
  proposal: Proposal[],
  choice: string,
  shown: (value: T) => string,
  sources: readonly (readonly [ProposalSource, T | undefined])[],
): T | undefined {
  for (const [from, value] of sources) {
    if (value === undefined) continue;
    proposal.push({ choice, value: shown(value), from });
    return value;
  }
  return undefined;
}

const text = (value: string) => value;
const list = (value: readonly string[]) => (value.length === 0 ? "none" : value.join(", "));

/** The project's name: the option, the old configuration's, or one made from the directory's name. */
export const proposeName = (
  proposal: Proposal[],
  choices: ProjectChoices,
  old: OldChoices,
  directory: string,
): string | undefined =>
  pick(proposal, "name", text, [
    ["option", choices.name],
    ["old configuration", old.name],
    ["directory name", nameFrom(directory)],
  ]);

/** Why no name could be proposed. */
export const noName = (directory: string): string =>
  `the directory's name, ${path.basename(directory)}, does not make a project name; give one with --name`;

/** Every choice of a project other than its name and parts. */
export interface Settings {
  readonly pattern: string;
  readonly environments: readonly string[];
  readonly agents: readonly string[];
  readonly governance: string;
  readonly review: ProjectConfig["review"];
}

/**
 * Proposes every choice other than the name and the parts, each the first
 * of the option, what was found or the old configuration said, and the
 * default. The workflow is always manual: a framework's files stay the
 * project's, and no initializer runs.
 */
export function proposeSettings(
  proposal: Proposal[],
  choices: ProjectChoices,
  old: OldChoices,
  found: {
    readonly workload: string;
    readonly infrastructure: string;
    readonly agents: readonly string[];
  },
): Settings {
  const pattern =
    found.workload === "genai"
      ? (pick(proposal, "pattern", text, [
          ["option", choices.pattern],
          ["old configuration", old.pattern],
          ["default", DEFAULT_PATTERN],
        ]) ?? DEFAULT_PATTERN)
      : (choices.pattern ?? NO_PATTERN);
  const environments =
    found.infrastructure === NO_INFRASTRUCTURE
      ? (choices.environments ?? [])
      : (pick(proposal, "environments", list, [
          ["option", choices.environments],
          ["old configuration", old.environments],
          ["default", ENVIRONMENTS],
        ]) ?? ENVIRONMENTS);
  proposal.push({ choice: "workflow", value: "manual", from: "default" });
  const agents =
    pick(proposal, "agents", list, [
      ["option", choices.agents],
      ["old configuration", old.agents],
      ["found", found.agents.length === 0 ? undefined : found.agents],
      ["default", []],
    ]) ?? [];
  const governance =
    pick(proposal, "governance", text, [
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
  return { pattern, environments, agents, governance, review };
}

/** A project name made from the directory's name, if one can be. */
export function nameFrom(directory: string): string | undefined {
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
export interface OldChoices {
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
 * proposal to make. The configuration must still be as the inventory read
 * it; `changed` says what to do when it is not.
 */
export async function oldChoices(
  fs: ProjectFsPort,
  directory: string,
  records: readonly LegacyRecord[],
  read: ReadonlyMap<string, string>,
  changed: (file: string) => string,
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
    throw new ProjectChangeError(changed(config.path));
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
  // Infrastructure needs at least one environment, so none says nothing.
  const listed = some(fields.environments, (text) =>
    (ENVIRONMENTS as readonly string[]).includes(text),
  );
  const environments = listed?.length === 0 ? undefined : listed;
  return {
    ...(name === undefined ? {} : { name }),
    ...(agents === undefined ? {} : { agents }),
    ...(governance === undefined ? {} : { governance }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(environments === undefined ? {} : { environments }),
  };
}

/** Why a record from before the rebuild keeps Liftoff from taking the project on, if it does. */
export function legacyBlocks(records: readonly LegacyRecord[], doing: string): string[] {
  return records.flatMap((record) =>
    record.blocks !== undefined
      ? [`${record.path}: ${record.blocks}`]
      : record.state === "unsupported"
        ? [
            `${record.path}, from a Liftoff release before the rebuild, is not a record ${doing} can rely on (${record.reason}); ${doing} does not guess past it`,
          ]
        : [],
  );
}

/** Refuses a project Liftoff already has: one with liftoff.yaml or a manifest. */
export async function refuseLiftoffProject(fs: ProjectFsPort, directory: string): Promise<void> {
  for (const record of [CONFIG_FILE, MANIFEST_FILE]) {
    const found = await fs.hashWithin(directory, record, MAX_RECORD_BYTES);
    if (found.kind === "file" || found.kind === "directory") {
      throw new ProjectChangeError(
        `${record} is already here, so this is a Liftoff project, which liftoff update and liftoff repair change; liftoff validate checks it`,
      );
    }
  }
}

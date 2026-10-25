import type { ProjectConfig } from "../../domain/project/config.ts";
import type { Ownership } from "../../domain/project/manifest.ts";
import type { PolicyRule, ProfileId } from "../../domain/risk-policy/policy.ts";
import type { AgentHostId, AgentSource, SkillSource } from "./agent-host.ts";

/** One file a plugin contributes, before hashing. */
export interface Artifact {
  readonly path: string;
  readonly ownership: Ownership;
  readonly content: string;
}

/** Template and asset text already loaded from the release, keyed by asset path. */
export interface TemplateSet {
  /** Text of one asset file; throws if the release does not ship it. */
  read(path: string): string;
  /** Asset paths under a directory, recursively and sorted. */
  list(directory: string): readonly string[];
}

/** A command the project's checks run, for AGENTS.md, README and CI. */
export interface ProjectCheck {
  readonly name: string;
  readonly command: string;
  /** Repository-relative directory the command runs in. */
  readonly directory: string;
}

export interface GenerationContext {
  readonly config: ProjectConfig;
  readonly liftoffVersion: string;
  readonly hosts: readonly AgentHostId[];
  readonly profile: ProfileId;
  readonly stack: StackPlugin;
  /** The selected frontend, if any. */
  readonly frontend: FrontendPlugin | undefined;
  /** The stack, then the frontend if one is selected. */
  readonly components: readonly ComponentPlugin[];
  readonly templates: TemplateSet;
  readonly skills: readonly SkillSource[];
  readonly agents: readonly AgentSource[];
  /** Committed CI bundles by file name, such as "review-policy.mjs". */
  readonly ciBundles: Readonly<Record<string, string>>;
}

export type PluginKind =
  | "common"
  | "stack"
  | "frontend"
  | "workflow"
  | "agents"
  | "review"
  | "governance";

export interface ProjectPlugin {
  readonly id: string;
  readonly kind: PluginKind;
  /** Bumped whenever the files it generates change. */
  readonly version: string;
  readonly summary: string;
  /** Asset directories this plugin reads templates from. */
  readonly templateRoots: readonly string[];
  artifacts(context: GenerationContext): Artifact[];
}

/** A tool the project needs on the developer's machine, checked by `liftoff doctor`. */
export interface ProjectTool {
  readonly name: string;
  readonly command: string;
  readonly versionArgs: readonly string[];
  readonly required: boolean;
  /** Lowest version that works, as dotted numbers. */
  readonly minimum?: string;
  readonly purpose: string;
  readonly install: string;
}

/** A language CodeQL analyzes, as its workflow names it. */
export interface CodeqlLanguage {
  readonly language: string;
  readonly buildMode: "none" | "autobuild";
  /** What it covers, for the workflow's description, such as "the Go code". */
  readonly subject: string;
}

/**
 * A part of the application with its own directory, checks and container:
 * the API stack or a frontend. Files every part contributes to, such as
 * compose.yaml and the CI workflow, are assembled from each component's
 * parts directory:
 *
 * - `compose.yaml`: Compose services, a YAML mapping;
 * - `ci-jobs.yml`: CI jobs, a YAML mapping of job ids to jobs;
 * - `dependabot.yml`: Dependabot update entries, a YAML list;
 * - `README.md`: the component's README sections.
 */
export interface ComponentPlugin extends ProjectPlugin {
  readonly kind: "stack" | "frontend";
  readonly checks: readonly ProjectCheck[];
  readonly tools: readonly ProjectTool[];
  /** Review policy rules for the component's files, added after the built-in ones. */
  readonly reviewRules: readonly PolicyRule[];
  /** The first commands to run in a new project, such as installing and testing, and where. */
  readonly quickStart: { readonly directory: string; readonly command: string };
  /** Short description of the generated layout for README and AGENTS.md. */
  readonly layout: readonly { readonly path: string; readonly purpose: string }[];
  /** Asset directory holding the component's parts of the shared files. */
  readonly parts: string;
  readonly codeql: CodeqlLanguage;
}

export interface StackPlugin extends ComponentPlugin {
  readonly kind: "stack";
  readonly workload: string;
}

/** A web frontend. It reaches the API through the `api` service every stack runs. */
export interface FrontendPlugin extends ComponentPlugin {
  readonly kind: "frontend";
}

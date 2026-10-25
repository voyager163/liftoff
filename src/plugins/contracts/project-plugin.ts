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
  readonly workflow: WorkflowPlugin;
  readonly stack: StackPlugin;
  /** The selected GenAI pattern, for GenAI projects. */
  readonly pattern: PatternPlugin | undefined;
  /** The selected frontend, if any. */
  readonly frontend: FrontendPlugin | undefined;
  /** The selected infrastructure, if any. */
  readonly infrastructure: InfrastructurePlugin | undefined;
  /** Environments the infrastructure is generated for, in dev, staging, prod order. */
  readonly environments: readonly EnvironmentId[];
  /** The stack, then the pattern, the frontend and the infrastructure if selected. */
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
  | "pattern"
  | "frontend"
  | "infrastructure"
  | "workflow"
  | "agents"
  | "review"
  | "governance"
  | "release";

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
  /** Other commands that provide the same tool, tried in order when `command` cannot run. */
  readonly alternatives?: readonly string[];
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
 * A part of the project with its own directory and checks: the stack, a GenAI
 * pattern, a frontend or the infrastructure. Files every part contributes to, such as
 * compose.yaml and the CI workflow, are assembled from each component's
 * parts directory, where each of these files is optional:
 *
 * - `compose.yaml`: Compose services, a YAML mapping;
 * - `ci-jobs.yml`: CI jobs, a YAML mapping of job ids to jobs;
 * - `dependabot.yml`: Dependabot update entries, a YAML list;
 * - `README.md`: the component's README sections.
 */
export interface ComponentPlugin extends ProjectPlugin {
  readonly kind: "stack" | "pattern" | "frontend" | "infrastructure";
  readonly checks: readonly ProjectCheck[];
  readonly tools: readonly ProjectTool[];
  /** Review policy rules for the component's files, added after the built-in ones. */
  readonly reviewRules: readonly PolicyRule[];
  /** The first commands to run in a new project, such as installing and testing, and where. */
  readonly quickStart?: { readonly directory: string; readonly command: string };
  /** Short description of the generated layout for README and AGENTS.md. */
  readonly layout: readonly { readonly path: string; readonly purpose: string }[];
  /** Asset directory holding the component's parts of the shared files. */
  readonly parts: string;
  /** The container image it is shipped as: its name, and the directory its Dockerfile is in. */
  readonly image?: { readonly name: string; readonly context: string };
  /** The language CodeQL analyzes for it, if CodeQL supports one. */
  readonly codeql?: CodeqlLanguage;
  /** Values for its parts beyond the project name, such as text built from metadata. */
  readmeValues?(context: GenerationContext): Readonly<Record<string, string>>;
}

export interface StackPlugin extends ComponentPlugin {
  readonly kind: "stack";
  readonly workload: string;
  readonly codeql: CodeqlLanguage;
  readonly quickStart: { readonly directory: string; readonly command: string };
  /** The PostgreSQL database the stack uses, if any. */
  readonly database?: {
    /** The command, run in the API's image, that applies the migrations. */
    readonly migrateCommand: readonly string[];
    /** The scheme of APP_DATABASE_URL, such as "postgresql". */
    readonly urlScheme: string;
  };
}

/** How far a GenAI pattern goes, stated plainly for its users. */
export interface PatternMaturity {
  /** "complete" when the pattern does what its name says; "foundation" when it is a starting point. */
  readonly level: "complete" | "foundation";
  readonly implemented: readonly string[];
  /** What a production use would still need; never presented as done. */
  readonly notImplemented: readonly string[];
}

/** One of the GenAI patterns a GenAI stack can be generated with. */
export interface PatternPlugin extends ComponentPlugin {
  readonly kind: "pattern";
  /** The pattern's name, such as "rag". */
  readonly name: string;
  readonly maturity: PatternMaturity;
}

/** A web frontend. It reaches the API through the `api` service every stack runs. */
export interface FrontendPlugin extends ComponentPlugin {
  readonly kind: "frontend";
  readonly codeql: CodeqlLanguage;
}

/** One command of a framework's initializer, run in the new project's directory. */
export interface InitializerStep {
  readonly command: string;
  readonly args: readonly string[];
}

/** A development framework's own pinned initializer, which writes the framework's files. */
export interface WorkflowInitializer {
  /** The framework's name, such as "OpenSpec". */
  readonly name: string;
  /** The exact version it runs. */
  readonly version: string;
  /** What has to be installed to run it, for the message when it cannot start. */
  readonly needs: string;
  /** The commands to run, in order, for the selected coding-agent hosts. */
  steps(hosts: readonly AgentHostId[]): InitializerStep[];
}

/**
 * How changes are specified before they are built: OpenSpec, Spec Kit or
 * manual. A framework's files come from its own initializer, never from a
 * copy kept by Liftoff.
 */
export interface WorkflowPlugin extends ProjectPlugin {
  readonly kind: "workflow";
  /** The workflow's name for people, such as "OpenSpec". */
  readonly title: string;
  /** Tools the workflow needs on the developer's machine, checked by `liftoff doctor`. */
  readonly tools: readonly ProjectTool[];
  /** How to work with it, as Markdown paragraphs for README and AGENTS.md; empty for none. */
  readonly guide: readonly string[];
  readonly initializer?: WorkflowInitializer;
  /** Why it cannot be used with these hosts, if it cannot. */
  unsupportedHosts?(hosts: readonly AgentHostId[]): string | undefined;
}

/** The deployment environments infrastructure can be generated for, in promotion order. */
export const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type EnvironmentId = (typeof ENVIRONMENTS)[number];

/** Infrastructure as code for the API, the frontend if any, and the database. */
export interface InfrastructurePlugin extends ComponentPlugin {
  readonly kind: "infrastructure";
}

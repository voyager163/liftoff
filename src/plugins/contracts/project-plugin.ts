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
  readonly templates: TemplateSet;
  readonly skills: readonly SkillSource[];
  readonly agents: readonly AgentSource[];
  /** Committed CI bundles by file name, such as "review-policy.mjs". */
  readonly ciBundles: Readonly<Record<string, string>>;
}

export type PluginKind = "common" | "stack" | "workflow" | "agents" | "review" | "governance";

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

export interface StackPlugin extends ProjectPlugin {
  readonly kind: "stack";
  readonly workload: string;
  readonly checks: readonly ProjectCheck[];
  readonly tools: readonly ProjectTool[];
  /** Stack-specific review policy rules, added after the built-in ones. */
  readonly reviewRules: readonly PolicyRule[];
  /** Short description of the generated layout for README and AGENTS.md. */
  readonly layout: readonly { readonly path: string; readonly purpose: string }[];
}

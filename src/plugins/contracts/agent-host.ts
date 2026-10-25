/** A file Liftoff generates, with a repository-relative POSIX path. */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/** What an agent may do, in host-neutral terms. Each host maps these to its own tool names. */
export type AgentCapability = "read" | "search" | "execute";

/** A canonical skill: the Agent Skills SKILL.md format every supported host reads. */
export interface SkillSource {
  readonly name: string;
  readonly description: string;
  /** Markdown after the frontmatter, with includes already expanded. */
  readonly body: string;
}

/** A canonical subagent, rendered into each host's own agent format. */
export interface AgentSource {
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly AgentCapability[];
  /** The agent's instructions (its system prompt). */
  readonly instructions: string;
}

export type AgentHostId = "copilot" | "codex" | "claude";

/**
 * A coding-agent host Liftoff integrates with. Hosts differ in where they read
 * skills and agents and in their agent file format; the skill text is shared.
 */
export interface AgentHostPlugin {
  readonly id: AgentHostId;
  readonly displayName: string;
  /** Skill directories this host reads, in order of preference. */
  readonly skillDirectories: readonly string[];
  /** The file this host reads for project instructions. */
  readonly instructionsFile: string;
  renderAgent(agent: AgentSource): GeneratedFile;
}

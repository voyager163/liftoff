import type {
  AgentCapability,
  AgentHostId,
  AgentHostPlugin,
  AgentSource,
} from "../../contracts/agent-host.ts";

const MANAGED = "Managed by Liftoff. Change it through Liftoff rather than by hand.";

const yamlString = (value: string): string => JSON.stringify(value);

/** Claude Code: skills in .claude/skills, subagents in .claude/agents/<name>.md. */
const claudeTools: Record<AgentCapability, string[]> = {
  read: ["Read"],
  search: ["Grep", "Glob"],
  execute: ["Bash"],
};

export const claudeHost: AgentHostPlugin = {
  id: "claude",
  displayName: "Claude Code",
  skillDirectories: [".claude/skills"],
  instructionsFile: "CLAUDE.md",
  renderAgent(agent: AgentSource) {
    const tools = agent.capabilities.flatMap((c) => claudeTools[c]);
    return {
      path: `.claude/agents/${agent.name}.md`,
      content: [
        "---",
        `name: ${agent.name}`,
        `description: ${yamlString(agent.description)}`,
        `tools: ${tools.join(", ")}`,
        "disallowedTools: Edit, Write, NotebookEdit",
        "---",
        "",
        `<!-- ${MANAGED} -->`,
        "",
        agent.instructions.trimEnd(),
        "",
      ].join("\n"),
    };
  },
};

/** GitHub Copilot: reads .github/skills, .claude/skills and .agents/skills; custom agents in .github/agents. */
export const copilotHost: AgentHostPlugin = {
  id: "copilot",
  displayName: "GitHub Copilot",
  skillDirectories: [".github/skills", ".claude/skills", ".agents/skills"],
  instructionsFile: ".github/copilot-instructions.md",
  renderAgent(agent: AgentSource) {
    return {
      path: `.github/agents/${agent.name}.agent.md`,
      content: [
        "---",
        `name: ${agent.name}`,
        `description: ${yamlString(agent.description)}`,
        `tools: [${agent.capabilities.map((c) => yamlString(c)).join(", ")}]`,
        "---",
        "",
        `<!-- ${MANAGED} -->`,
        "",
        agent.instructions.trimEnd(),
        "",
      ].join("\n"),
    };
  },
};

/** Codex: skills in .agents/skills, custom agents as TOML in .codex/agents. */
export const codexHost: AgentHostPlugin = {
  id: "codex",
  displayName: "Codex",
  skillDirectories: [".agents/skills"],
  instructionsFile: "AGENTS.md",
  renderAgent(agent: AgentSource) {
    // A literal multi-line string cannot contain three single quotes in a row.
    if (agent.instructions.includes("'''")) {
      throw new Error(`agent ${agent.name} instructions cannot contain '''`);
    }
    // Codex enforces read-only in its sandbox when the agent cannot write.
    return {
      path: `.codex/agents/${agent.name}.toml`,
      content: [
        `# ${MANAGED}`,
        `name = ${JSON.stringify(agent.name)}`,
        `description = ${JSON.stringify(agent.description)}`,
        `sandbox_mode = "read-only"`,
        `developer_instructions = '''`,
        agent.instructions.trimEnd(),
        `'''`,
        "",
      ].join("\n"),
    };
  },
};

export const AGENT_HOSTS: Readonly<Record<AgentHostId, AgentHostPlugin>> = {
  copilot: copilotHost,
  codex: codexHost,
  claude: claudeHost,
};

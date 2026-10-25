import { parseAgent, parseSkill, renderAgentIntegration } from "../../generators/skills.ts";
import type {
  AgentHostId,
  AgentSource,
  GeneratedFile,
  SkillSource,
} from "../../plugins/contracts/agent-host.ts";
import type { AssetPort } from "../ports.ts";

export interface AgentSources {
  readonly skills: readonly SkillSource[];
  readonly agents: readonly AgentSource[];
}

/** Loads the canonical skills and agents shipped in assets/. */
export async function loadAgentSources(assets: AssetPort): Promise<AgentSources> {
  const partials: Record<string, string> = {};
  for (const file of await assets.list("skills/_partials")) {
    if (file.endsWith(".md")) {
      partials[file.slice(0, -3)] = await assets.readText(`skills/_partials/${file}`);
    }
  }
  const skills: SkillSource[] = [];
  for (const directory of await assets.list("skills")) {
    if (directory.startsWith("_")) continue;
    skills.push(
      parseSkill(directory, await assets.readText(`skills/${directory}/SKILL.md`), partials),
    );
  }
  const agents: AgentSource[] = [];
  for (const file of await assets.list("agents")) {
    if (file.endsWith(".md")) {
      agents.push(parseAgent(file.slice(0, -3), await assets.readText(`agents/${file}`)));
    }
  }
  return { skills, agents };
}

/** The skill and agent files for the selected coding-agent hosts. */
export async function agentFilesFor(
  assets: AssetPort,
  hosts: readonly AgentHostId[],
): Promise<GeneratedFile[]> {
  const sources = await loadAgentSources(assets);
  return renderAgentIntegration({ hosts, ...sources });
}

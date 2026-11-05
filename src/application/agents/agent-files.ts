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

/**
 * Loads the canonical skills and agents shipped in assets/. Review skills
 * apply everywhere; project skills (such as liftoff-setup) only to generated
 * projects.
 */
export async function loadAgentSources(
  assets: AssetPort,
  options: { readonly projectSkills?: boolean } = {},
): Promise<AgentSources> {
  const partials: Record<string, string> = {};
  for (const file of await assets.list("skills/_partials")) {
    if (file.endsWith(".md")) {
      partials[file.slice(0, -3)] = await assets.readText(`skills/_partials/${file}`);
    }
  }
  const skills: SkillSource[] = [];
  const roots = options.projectSkills ? ["skills", "project-skills"] : ["skills"];
  for (const root of roots) {
    for (const directory of await assets.list(root)) {
      if (directory.startsWith("_")) continue;
      const text = await assets.readText(`${root}/${directory}/SKILL.md`);
      skills.push(parseSkill(directory, text, partials));
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
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

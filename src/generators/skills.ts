import { parse as parseYaml } from "yaml";
import { AGENT_HOSTS } from "../plugins/builtin/agents/hosts.ts";
import type {
  AgentCapability,
  AgentHostId,
  AgentSource,
  GeneratedFile,
  SkillSource,
} from "../plugins/contracts/agent-host.ts";

export class SkillSourceError extends Error {
  override readonly name = "SkillSourceError";
}

/** Agent Skills names: lowercase letters, digits and single hyphens, at most 64 characters. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INCLUDE = /^<!-- include: ([a-z0-9-]+) -->$/gm;
const CAPABILITIES: readonly AgentCapability[] = ["read", "search", "execute"];

function splitFrontmatter(
  text: string,
  source: string,
): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new SkillSourceError(`${source}: missing YAML frontmatter`);
  const data = parseYaml(match[1] ?? "") as unknown;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SkillSourceError(`${source}: frontmatter must be a mapping`);
  }
  return { data: data as Record<string, unknown>, body: match[2] ?? "" };
}

function checkName(name: unknown, expected: string, source: string): string {
  if (typeof name !== "string" || !NAME.test(name) || name.length > 64) {
    throw new SkillSourceError(`${source}: name must be lowercase words joined by hyphens`);
  }
  if (name !== expected)
    throw new SkillSourceError(`${source}: name "${name}" must match "${expected}"`);
  return name;
}

function checkDescription(description: unknown, source: string): string {
  if (typeof description !== "string" || description.trim() === "" || description.length > 1024) {
    throw new SkillSourceError(`${source}: description must be 1 to 1024 characters`);
  }
  return description.trim();
}

function checkKeys(
  data: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
): void {
  const extra = Object.keys(data).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new SkillSourceError(`${source}: unknown frontmatter ${extra.join(", ")}`);
}

/** Expands `<!-- include: name -->` lines from shared partials, one level deep. */
function expandIncludes(
  body: string,
  partials: Readonly<Record<string, string>>,
  source: string,
): string {
  return body.replace(INCLUDE, (_line, name: string) => {
    const partial = partials[name];
    if (partial === undefined) throw new SkillSourceError(`${source}: unknown include "${name}"`);
    return partial.trimEnd();
  });
}

export function parseSkill(
  directory: string,
  text: string,
  partials: Readonly<Record<string, string>> = {},
): SkillSource {
  const source = `skills/${directory}/SKILL.md`;
  const { data, body } = splitFrontmatter(text, source);
  checkKeys(data, ["name", "description"], source);
  return {
    name: checkName(data.name, directory, source),
    description: checkDescription(data.description, source),
    body: expandIncludes(body, partials, source).trim(),
  };
}

export function parseAgent(fileName: string, text: string): AgentSource {
  const source = `agents/${fileName}.md`;
  const { data, body } = splitFrontmatter(text, source);
  checkKeys(data, ["name", "description", "capabilities"], source);
  const capabilities = data.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.some((c) => !CAPABILITIES.includes(c as AgentCapability))
  ) {
    throw new SkillSourceError(`${source}: capabilities must list ${CAPABILITIES.join(", ")}`);
  }
  return {
    name: checkName(data.name, fileName, source),
    description: checkDescription(data.description, source),
    capabilities: capabilities as AgentCapability[],
    instructions: body.trim(),
  };
}

/**
 * The fewest skill directories that every selected host reads, so each skill
 * is written once per directory rather than once per host. Hosts that read
 * only one directory are placed first; a host is skipped when a directory it
 * reads is already chosen. Copilot reads .claude/skills and .agents/skills,
 * so it gets .github/skills only when it is the sole host.
 */
export function skillDirectoriesFor(hosts: readonly AgentHostId[]): string[] {
  const directories = new Set<string>();
  const constrainedFirst = [...new Set(hosts)].sort(
    (a, b) => AGENT_HOSTS[a].skillDirectories.length - AGENT_HOSTS[b].skillDirectories.length,
  );
  for (const host of constrainedFirst) {
    const readable = AGENT_HOSTS[host].skillDirectories;
    if (!readable.some((dir) => directories.has(dir))) directories.add(readable[0] as string);
  }
  return [...directories].sort();
}

export function renderSkill(skill: SkillSource): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    "<!-- Managed by Liftoff. Change it through Liftoff rather than by hand. -->",
    "",
    skill.body,
    "",
  ].join("\n");
}

export interface ReviewIntegrationInput {
  readonly hosts: readonly AgentHostId[];
  readonly skills: readonly SkillSource[];
  readonly agents: readonly AgentSource[];
}

/** Every skill and agent file for the selected hosts, sorted by path. */
export function renderAgentIntegration(input: ReviewIntegrationInput): GeneratedFile[] {
  const hosts = [...new Set(input.hosts)];
  const files: GeneratedFile[] = [];
  for (const directory of skillDirectoriesFor(hosts)) {
    for (const skill of input.skills) {
      files.push({ path: `${directory}/${skill.name}/SKILL.md`, content: renderSkill(skill) });
    }
  }
  for (const host of hosts) {
    for (const agent of input.agents) files.push(AGENT_HOSTS[host].renderAgent(agent));
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path))
      throw new SkillSourceError(`two generated files share the path ${file.path}`);
    seen.add(file.path);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

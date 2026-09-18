import type {
  CanonicalSkillDefinition, CanonicalSkillId, SkillHostId, SkillProjection, SkillScope
} from '../../domain/skills/contracts.js';
import {
  canonicalSkillBody, canonicalSkillFrame, isCanonicalSkillHost, skillInvocation, SkillCatalogError, validateCanonicalSkillDefinition
} from '../../domain/skills/catalog.js';
import { registeredSkillPathParts } from '../../domain/skills/identity.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { sha256Hex } from '../../domain/governance/activation/canonical-json.js';

export function normalizeSkillHost(host: SkillHostId | 'copilot'): SkillHostId {
  if (host === 'copilot') return 'github-copilot';
  if (!isCanonicalSkillHost(host)) throw new SkillCatalogError(`Unsupported skill host: ${String(host)}`);
  return host;
}

function checkedScope(scope: SkillScope): SkillScope {
  if (scope !== 'user' && scope !== 'project') throw new SkillCatalogError('Skill projection scope must be user or project.');
  return scope;
}

export function resolveSkillPathParts(
  skillId: CanonicalSkillId, host: SkillHostId | 'copilot', scope: SkillScope
): readonly string[] {
  return registeredSkillPathParts(skillId, normalizeSkillHost(host), checkedScope(scope));
}

export function resolveSkillInvocation(
  skillId: CanonicalSkillId, host: SkillHostId | 'copilot', scope?: SkillScope
): string {
  if (scope !== undefined) checkedScope(scope);
  return skillInvocation(skillId, normalizeSkillHost(host));
}

export function renderHostSkillContent(
  value: CanonicalSkillDefinition, rawHost: SkillHostId | 'copilot', scope: SkillScope = 'project'
): string {
  const skill = validateCanonicalSkillDefinition(value);
  const host = normalizeSkillHost(rawHost);
  checkedScope(scope);
  const shared = scope === 'user' && (host === 'github-copilot' || host === 'codex');
  const invocation = shared ? `${skillInvocation(skill.id, 'github-copilot')} | ${skillInvocation(skill.id, 'codex')}`
    : skillInvocation(skill.id, host);
  return [
    canonicalSkillFrame(skill).trimEnd(), '', `# ${invocation}`, '',
    `Delivery scope: ${scope}. ${shared ? 'One personal file is visible to Copilot and Codex; it is not host-isolated.' : 'Host metadata does not grant execution authority.'}`,
    '', canonicalSkillBody(skill), ''
  ].join('\n');
}

export function projectSkillForHost(
  skill: CanonicalSkillDefinition, rawHost: SkillHostId | 'copilot', scope: SkillScope
): SkillProjection {
  const validated = validateCanonicalSkillDefinition(skill);
  const host = normalizeSkillHost(rawHost);
  const pathParts = resolveSkillPathParts(validated.id, host, scope);
  const renderedContent = renderHostSkillContent(validated, host, scope);
  return {
    skillId: validated.id, host, scope, relativeDestination: pathParts.join('/'), pathParts,
    renderedContent, contentHash: sha256Hex(renderedContent), canonicalHash: validated.contentHash,
    invocation: skillInvocation(validated.id, host)
  };
}

export function projectAllSkillsForHost(
  skills: readonly CanonicalSkillDefinition[], host: SkillHostId | 'copilot', scope: SkillScope
): readonly SkillProjection[] {
  return skills.map((skill) => projectSkillForHost(skill, host, scope));
}

function retainedIntegration(skill: CanonicalSkillDefinition, host: SkillHostId) {
  const operation = skill.id === 'governance-assess' ? 'assessment'
    : skill.id === 'setup' || skill.id === 'repair' ? skill.id : undefined;
  if (!operation) throw new SkillCatalogError('Only the three registered retained native project workflows use this projection.');
  return governanceAgentIntegrations[host][operation];
}

export function renderRetainedProjectSkillHeader(value: CanonicalSkillDefinition, rawHost: SkillHostId | 'copilot'): string {
  const skill = validateCanonicalSkillDefinition(value);
  const host = normalizeSkillHost(rawHost);
  const integration = retainedIntegration(skill, host);
  const frame = governanceAgentIntegrations[host].kind === 'skill' ? canonicalSkillFrame(skill) : '';
  return `${frame}# ${integration.invocation}\n`;
}

export function renderRetainedProjectSkill(value: CanonicalSkillDefinition, rawHost: SkillHostId | 'copilot'): string {
  const skill = validateCanonicalSkillDefinition(value);
  const host = normalizeSkillHost(rawHost);
  return `${renderRetainedProjectSkillHeader(skill, host)}\nProject context; retained transport.\n\n${canonicalSkillBody(skill)}\n`;
}

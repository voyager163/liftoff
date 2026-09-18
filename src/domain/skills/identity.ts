import { canonicalJson, isRecord } from '../governance/activation/canonical-json.js';
import { retiredManagedCoreIdentities } from '../project/artifact-lifecycle.js';
import { governanceAgentIntegrations } from '../project/catalog.js';
import {
  CANONICAL_SKILL_IDS,
  SUPPORTED_SKILL_HOSTS,
  type CanonicalSkillId,
  type SkillDeliveryIntent,
  type SkillHostId,
  type SkillScope
} from './contracts.js';

export const skillsDeliveryRecipe = { id: 'canonical-skills-delivery', version: 1 } as const;
export const skillAliasRetirementRecipe = { id: 'registered-project-skill-alias-retirement', version: 1 } as const;
export type RetiredSkillAliasId = (typeof retiredManagedCoreIdentities)[number]['logicalName'];

interface SkillsIdentityFields {
  cliVersion: string;
  skillsContractVersion: 1;
  catalogDigest: string;
  hosts: readonly SkillHostId[];
  skillIds: readonly CanonicalSkillId[];
}

export interface SkillDeliveryExecutionIdentity extends SkillsIdentityFields {
  recipe: typeof skillsDeliveryRecipe;
  scope: SkillScope;
  intent: SkillDeliveryIntent;
}

export interface SkillAliasRetirementIdentity extends SkillsIdentityFields {
  recipe: typeof skillAliasRetirementRecipe;
  scope: 'project';
  intent: 'migrate';
  retiredAliases: readonly RetiredSkillAliasId[];
  historyKey: string;
}

export type SkillsExecutionIdentity = SkillDeliveryExecutionIdentity | SkillAliasRetirementIdentity;

export function validateSkillsExecutionIdentity(value: unknown): SkillsExecutionIdentity {
  const retirement = isRecord(value) && isRecord(value.recipe) && value.recipe.id === skillAliasRetirementRecipe.id;
  const keys = ['cliVersion', 'skillsContractVersion', 'recipe', 'scope', 'intent', 'catalogDigest', 'hosts', 'skillIds',
    ...retirement ? ['retiredAliases', 'historyKey'] : []];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      typeof value.cliVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu.test(value.cliVersion) ||
      value.skillsContractVersion !== 1 || !isRecord(value.recipe) || Object.keys(value.recipe).length !== 2 ||
      value.recipe.id !== (retirement ? skillAliasRetirementRecipe.id : skillsDeliveryRecipe.id) || value.recipe.version !== 1 ||
      !(retirement ? value.scope === 'project' && value.intent === 'migrate'
        : ['user', 'project'].includes(String(value.scope)) && ['install', 'update', 'remove'].includes(String(value.intent))) ||
      typeof value.catalogDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.catalogDigest) ||
      !Array.isArray(value.hosts) || value.hosts.length === 0 ||
      canonicalJson(value.hosts) !== canonicalJson(SUPPORTED_SKILL_HOSTS.filter((host) => (value.hosts as unknown[]).includes(host))) ||
      !Array.isArray(value.skillIds) || value.skillIds.length === 0 ||
      canonicalJson(value.skillIds) !== canonicalJson(CANONICAL_SKILL_IDS.filter((id) => (value.skillIds as unknown[]).includes(id)))) {
    throw new Error('Skills recovery requires its exact independent contract-1 canonical-skills-delivery recipe-1, scope, catalog, host, and skill inventory identity.');
  }
  if (retirement) {
    if (typeof value.historyKey !== 'string' || !/^[a-f0-9]{64}$/u.test(value.historyKey) ||
        !Array.isArray(value.retiredAliases) || value.retiredAliases.length === 0 || !value.skillIds.includes('setup') ||
        canonicalJson(value.retiredAliases) !== canonicalJson(retiredManagedCoreIdentities.filter((entry) =>
          (value.retiredAliases as unknown[]).includes(entry.logicalName) &&
          (value.hosts as SkillHostId[]).some((host) => governanceAgentIntegrations[host].setup.logicalName === entry.replacementLogicalName)
        ).map((entry) => entry.logicalName))) {
      throw new Error('Skills alias retirement requires its exact project-only historical registration and history identity.');
    }
    return {
      cliVersion: value.cliVersion, skillsContractVersion: 1, recipe: skillAliasRetirementRecipe,
      scope: 'project', intent: 'migrate', catalogDigest: value.catalogDigest,
      hosts: [...value.hosts as SkillHostId[]], skillIds: [...value.skillIds as CanonicalSkillId[]],
      retiredAliases: [...value.retiredAliases as RetiredSkillAliasId[]], historyKey: value.historyKey
    };
  }
  return {
    cliVersion: value.cliVersion, skillsContractVersion: 1, recipe: skillsDeliveryRecipe,
    scope: value.scope as SkillScope, intent: value.intent as SkillDeliveryIntent,
    catalogDigest: value.catalogDigest, hosts: [...value.hosts as SkillHostId[]], skillIds: [...value.skillIds as CanonicalSkillId[]]
  };
}

export function skillAliasHistoryPaths(identity: SkillAliasRetirementIdentity): {
  record: string[];
  manifest: string[];
  sources: Array<{ logicalName: RetiredSkillAliasId; pathParts: string[] }>;
} {
  const root = ['.liftoff', 'skill-transport-history', identity.historyKey];
  return {
    record: [...root, 'record.json'], manifest: [...root, 'manifest.json'],
    sources: identity.retiredAliases.map((logicalName) => ({
      logicalName, pathParts: [...root, 'sources', `${logicalName}.md`]
    }))
  };
}

export function registeredSkillPathParts(skillId: CanonicalSkillId, host: SkillHostId, scope: SkillScope): readonly string[] {
  if (!CANONICAL_SKILL_IDS.includes(skillId) || !SUPPORTED_SKILL_HOSTS.includes(host) || !['user', 'project'].includes(scope)) {
    throw new Error('Unknown canonical skill, host, or scope identity.');
  }
  if (host === 'claude') return ['.claude', 'commands', `liftoff-${skillId}.md`];
  return [scope === 'project' && host === 'github-copilot' ? '.github' : '.agents', 'skills', `liftoff-${skillId}`, 'SKILL.md'];
}

export function validateSkillsTransactionPaths(
  identity: SkillsExecutionIdentity,
  mutations: readonly { type: string; pathParts: readonly string[]; mode?: number }[]
): void {
  if (identity.intent === 'migrate') {
    const history = skillAliasHistoryPaths(identity);
    const expected = new Map<string, string>([
      ['liftoff.manifest.json', 'write'], [history.record.join('/'), 'write'], [history.manifest.join('/'), 'write'],
      ...history.sources.map((entry): [string, string] => [entry.pathParts.join('/'), 'write']),
      ...retiredManagedCoreIdentities.filter((entry) => identity.retiredAliases.includes(entry.logicalName))
        .map((entry): [string, string] => [entry.pathParts.join('/'), 'delete'])
    ]);
    if (mutations.length !== expected.size || mutations.some((mutation) => {
      const name = mutation.pathParts.join('/');
      return expected.get(name) !== mutation.type ||
        mutation.type === 'write' && (name === 'liftoff.manifest.json' ? mutation.mode !== undefined : mutation.mode !== 0o600);
    })) {
      throw new Error('Skill alias retirement may change only its complete registered alias/manifest/history inventory, never active native transports.');
    }
    return;
  }
  const paths = new Set(identity.skillIds.flatMap((skillId) =>
    identity.hosts.map((host) => registeredSkillPathParts(skillId, host, identity.scope).join('/'))));
  for (const mutation of mutations) {
    const key = mutation.pathParts.join('/');
    if (key === '.liftoff/skills-ownership.json' && mutation.type === 'write') continue;
    if (!paths.has(key)) throw new Error(`Unregistered skills transaction path: ${key}`);
  }
}

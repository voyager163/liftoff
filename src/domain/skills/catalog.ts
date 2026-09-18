import {
  CANONICAL_SKILL_IDS, SUPPORTED_SKILL_HOSTS,
  type CanonicalSkillDefinition, type CanonicalSkillId, type CanonicalSkillMetadata,
  type SkillCatalog, type SkillHostId
} from './contracts.js';
import { canonicalJson, sha256Hex } from '../governance/activation/canonical-json.js';

type WorkflowContract = Pick<CanonicalSkillMetadata,
  'owningEngine' | 'requiredCapability' | 'commandOutput' | 'commandResultSchema' |
  'contractVersion' | 'authorizationMechanism' | 'effectClass' | 'authorizationRequired'> & {
    command: readonly string[];
  };

export const canonicalWorkflowContracts = {
  setup: {
    owningEngine: 'Repository Governance', requiredCapability: 'repository-governance',
    command: ['governance', 'status'], commandOutput: 'json', commandResultSchema: 3,
    authorizationMechanism: 'reviewed-plan', effectClass: 'inspection-and-mutation', authorizationRequired: true
  },
  assess: {
    owningEngine: 'Standards and Assessment', requiredCapability: 'standards-assessment',
    command: ['assess'], commandOutput: 'json', commandResultSchema: 1,
    authorizationMechanism: 'read-only', effectClass: 'read-only', authorizationRequired: false
  },
  init: {
    owningEngine: 'Project Generation', requiredCapability: 'project-generation',
    command: ['init'], commandOutput: 'human', commandResultSchema: null,
    authorizationMechanism: 'flag-consent', effectClass: 'inspection-and-mutation', authorizationRequired: true
  },
  adopt: {
    owningEngine: 'Project Evolution', requiredCapability: 'project-adoption',
    command: ['adopt'], commandOutput: 'json', commandResultSchema: 1,
    authorizationMechanism: 'reviewed-plan', effectClass: 'reviewed-mutation', authorizationRequired: true
  },
  update: {
    owningEngine: 'Project Evolution', requiredCapability: 'project-update',
    command: ['update'], commandOutput: 'json', commandResultSchema: 3,
    authorizationMechanism: 'reviewed-plan', effectClass: 'reviewed-mutation', authorizationRequired: true
  },
  repair: {
    owningEngine: 'Project Evolution', requiredCapability: 'project-repair',
    command: ['repair'], commandOutput: 'json', commandResultSchema: 2, contractVersion: 1,
    authorizationMechanism: 'reviewed-plan', effectClass: 'reviewed-mutation', authorizationRequired: true
  },
  migrate: {
    owningEngine: 'Project Evolution', requiredCapability: 'project-migration',
    command: ['migrate'], commandOutput: 'human', commandResultSchema: null,
    authorizationMechanism: 'flag-consent', effectClass: 'inspection-and-mutation', authorizationRequired: true
  },
  'governance-assess': {
    owningEngine: 'Repository Governance', requiredCapability: 'governance-assessment',
    command: ['governance', 'assess'], commandOutput: 'json', commandResultSchema: 1,
    authorizationMechanism: 'read-only', effectClass: 'read-only', authorizationRequired: false
  },
  governance: {
    owningEngine: 'Repository Governance', requiredCapability: 'repository-governance',
    command: ['governance', 'plan'], commandOutput: 'json', commandResultSchema: 3,
    authorizationMechanism: 'reviewed-plan', effectClass: 'reviewed-mutation', authorizationRequired: true
  },
  azure: {
    owningEngine: 'Azure Activation', requiredCapability: 'azure-activation',
    command: ['governance', 'plan'], commandOutput: 'json', commandResultSchema: 3,
    authorizationMechanism: 'reviewed-plan', effectClass: 'reviewed-mutation', authorizationRequired: true
  },
  'cli-upgrade': {
    owningEngine: 'Distribution and CLI Upgrade', requiredCapability: 'cli-upgrade',
    command: ['upgrade'], commandOutput: 'json', commandResultSchema: 1,
    authorizationMechanism: 'command-invocation', effectClass: 'routine-upgrade', authorizationRequired: false
  }
} as const satisfies Record<CanonicalSkillId, WorkflowContract>;

export class SkillCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillCatalogError';
  }
}

export function strictSkillObject(value: unknown, required: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length > 0) {
    throw new SkillCatalogError(`${label} must be a plain JSON object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (required.some((key) => !Object.hasOwn(descriptors, key)) ||
      names.some((key) => !required.includes(key) && !optional.includes(key) ||
        !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new SkillCatalogError(`${label} has missing, additional, or non-data fields.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new SkillCatalogError(`${label} must be bounded nonempty text without control or direction characters.`);
  }
  return value;
}

export function isCanonicalSkillId(value: unknown): value is CanonicalSkillId {
  return typeof value === 'string' && CANONICAL_SKILL_IDS.some((id) => value === id);
}

export function isCanonicalSkillHost(value: unknown): value is SkillHostId {
  return typeof value === 'string' && SUPPORTED_SKILL_HOSTS.some((host) => value === host);
}

export function skillInvocation(id: CanonicalSkillId, host: SkillHostId): string {
  if (!isCanonicalSkillId(id) || !isCanonicalSkillHost(host)) throw new SkillCatalogError('Unknown canonical skill or host.');
  return `${host === 'codex' ? '$' : '/'}liftoff-${id}`;
}

export function canonicalSkillFrame(skill: Pick<CanonicalSkillMetadata, 'id' | 'description'>): string {
  return `---\nname: liftoff-${skill.id}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n`;
}

export function validateCanonicalSkillMetadata(value: unknown): CanonicalSkillMetadata {
  const fields = [
    'id', 'name', 'description', 'owningEngine', 'requiredCapability', 'commandOutput', 'commandResultSchema',
    'authorizationMechanism', 'supportedHosts', 'defaultInvocations', 'entrypoint', 'effectClass', 'authorizationRequired'
  ];
  const row = strictSkillObject(value, fields, 'Canonical skill', ['contractVersion']);
  if (!isCanonicalSkillId(row.id)) throw new SkillCatalogError('Unknown canonical skill identity.');
  const id = row.id;
  const expected: WorkflowContract = canonicalWorkflowContracts[id];
  for (const field of ['owningEngine', 'requiredCapability', 'commandOutput', 'commandResultSchema',
    'authorizationMechanism', 'effectClass', 'authorizationRequired', 'contractVersion'] as const) {
    if (row[field] !== expected[field] || field === 'contractVersion' &&
        Object.hasOwn(row, field) !== Object.hasOwn(expected, field)) {
      throw new SkillCatalogError(`Canonical skill ${row.id} has an unregistered ${field} contract.`);
    }
  }
  if (row.entrypoint !== `${row.id}/SKILL.md`) throw new SkillCatalogError('Canonical entrypoint must match its exact registered portable identity.');
  if (!Array.isArray(row.supportedHosts) || row.supportedHosts.length !== SUPPORTED_SKILL_HOSTS.length ||
      canonicalJson(row.supportedHosts) !== canonicalJson(SUPPORTED_SKILL_HOSTS)) {
    throw new SkillCatalogError(`Canonical skill ${row.id} requires the exact duplicate-free supported host inventory.`);
  }
  const invocations = strictSkillObject(row.defaultInvocations, SUPPORTED_SKILL_HOSTS, 'Canonical default invocations');
  for (const host of SUPPORTED_SKILL_HOSTS) {
    if (invocations[host] !== skillInvocation(row.id, host)) throw new SkillCatalogError(`Canonical skill ${row.id} has an unregistered ${host} invocation.`);
  }
  return {
    id: row.id, name: text(row.name, 'Skill name', 160), description: text(row.description, 'Skill description', 1200),
    owningEngine: expected.owningEngine, requiredCapability: expected.requiredCapability,
    commandOutput: expected.commandOutput, commandResultSchema: expected.commandResultSchema,
    authorizationMechanism: expected.authorizationMechanism,
    ...(expected.contractVersion === undefined ? {} : { contractVersion: expected.contractVersion }),
    supportedHosts: [...SUPPORTED_SKILL_HOSTS],
    defaultInvocations: Object.fromEntries(SUPPORTED_SKILL_HOSTS.map((host) => [host, skillInvocation(id, host)])) as Record<SkillHostId, string>,
    entrypoint: `${row.id}/SKILL.md`, effectClass: expected.effectClass, authorizationRequired: expected.authorizationRequired
  };
}

export function enrichCanonicalSkill(metadata: CanonicalSkillMetadata, content: string, expectedHash: string): CanonicalSkillDefinition {
  const checked = validateCanonicalSkillMetadata(metadata);
  const frame = canonicalSkillFrame(checked);
  const body = typeof content === 'string' && content.startsWith(frame) ? content.slice(frame.length) : '';
  if (typeof content !== 'string' || content.length > 2 * 1024 * 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(content) ||
      !content.startsWith(frame) || !/^# [^\r\n]+\n/u.test(body) ||
      /^---\r?\n(?:name|description):/mu.test(body)) {
    throw new SkillCatalogError(`Canonical skill ${checked.id} has an invalid, duplicate, or mismatched metadata frame/body.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedHash) || sha256Hex(content) !== expectedHash) {
    throw new SkillCatalogError(`Canonical skill ${checked.id} does not match its verified resource digest.`);
  }
  return { ...checked, content, contentHash: expectedHash };
}

export function validateCanonicalSkillDefinition(value: unknown): CanonicalSkillDefinition {
  const row = strictSkillObject(value, [
    'id', 'name', 'description', 'owningEngine', 'requiredCapability', 'commandOutput', 'commandResultSchema',
    'authorizationMechanism', 'supportedHosts', 'defaultInvocations', 'entrypoint', 'effectClass', 'authorizationRequired',
    'content', 'contentHash'
  ], 'Enriched canonical skill', ['contractVersion']);
  const { content, contentHash, ...metadata } = row;
  if (typeof content !== 'string' || typeof contentHash !== 'string') throw new SkillCatalogError('Canonical skill source and digest are required.');
  return enrichCanonicalSkill(validateCanonicalSkillMetadata(metadata), content, contentHash);
}

export function canonicalSkillBody(value: CanonicalSkillDefinition): string {
  const skill = validateCanonicalSkillDefinition(value);
  return skill.content.slice(canonicalSkillFrame(skill).length).trimEnd();
}

export function validateSkillCatalogMetadata(value: unknown): { schemaVersion: 1; catalogVersion: string; skills: CanonicalSkillMetadata[] } {
  const row = strictSkillObject(value, ['schemaVersion', 'catalogVersion', 'skills'], 'Canonical skill catalog');
  if (row.schemaVersion !== 1 || typeof row.catalogVersion !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/u.test(row.catalogVersion) || !Array.isArray(row.skills) ||
      row.skills.length !== CANONICAL_SKILL_IDS.length) throw new SkillCatalogError('Unsupported canonical catalog identity or inventory.');
  const skills = row.skills.map(validateCanonicalSkillMetadata);
  if (new Set(skills.map((skill) => skill.id)).size !== CANONICAL_SKILL_IDS.length) throw new SkillCatalogError('Canonical catalog contains duplicate or missing skill identities.');
  return { schemaVersion: 1, catalogVersion: row.catalogVersion, skills };
}

export function validateEnrichedSkillCatalog(value: unknown): SkillCatalog {
  const row = strictSkillObject(value, ['schemaVersion', 'catalogVersion', 'skills'], 'Enriched skill catalog');
  if (!Array.isArray(row.skills)) throw new SkillCatalogError('Canonical skills must be an array.');
  const skills = row.skills.map(validateCanonicalSkillDefinition);
  validateSkillCatalogMetadata({
    schemaVersion: row.schemaVersion, catalogVersion: row.catalogVersion,
    skills: skills.map(({ content: _content, contentHash: _hash, ...metadata }) => metadata)
  });
  return { schemaVersion: 1, catalogVersion: row.catalogVersion as string, skills };
}

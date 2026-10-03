import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity
} from '../domain/governance/policy/identity.js';

const declarations = [
  ['repository-governance-policy', ['.liftoff', 'governance', 'policy.md']],
  ['repository-governance-context', ['.liftoff', 'governance', 'context.json']],
  ['repository-governance-guide', ['.liftoff', 'governance', 'README.md']],
  ['repository-governance-phase-graph', ['.liftoff', 'governance', 'phase-graph.json']],
  ['repository-governance-compatibility', ['.liftoff', 'governance', 'compatibility.json']],
  ['repository-governance-credential-policy-schema', ['.liftoff', 'governance', 'credential-policy.schema.json']],
  ['liftoff-setup-copilot', ['.github', 'prompts', 'liftoff-setup.prompt.md']],
  ['liftoff-setup-claude', ['.claude', 'commands', 'liftoff-setup.md']],
  ['liftoff-governance-assess-copilot', ['.github', 'prompts', 'liftoff-governance-assess.prompt.md']],
  ['liftoff-governance-assess-claude', ['.claude', 'commands', 'liftoff-governance-assess.md']],
  ['liftoff-setup-codex', ['.agents', 'skills', 'liftoff-setup', 'SKILL.md']],
  ['liftoff-governance-assess-codex', ['.agents', 'skills', 'liftoff-governance-assess', 'SKILL.md']],
  ['liftoff-repair-copilot', ['.github', 'prompts', 'liftoff-repair.prompt.md']],
  ['liftoff-repair-claude', ['.claude', 'commands', 'liftoff-repair.md']],
  ['liftoff-repair-codex', ['.agents', 'skills', 'liftoff-repair', 'SKILL.md']]
] as const;

export const releasedManagedMetadata = Object.freeze(declarations.map(([logicalName, pathParts]) =>
  Object.freeze({ logicalName, pathParts: Object.freeze(pathParts) })));

export const releasedManagedLogicalInventories = Object.freeze([8, 10, 12, 15].map(count =>
  Object.freeze(releasedManagedMetadata.slice(0, count).map(entry => entry.logicalName))));

// Preserve the published historical-source enumeration, not current catalog order.
export const releasedHistoricalMetadataPathParts = Object.freeze([
  Object.freeze(['liftoff.config.json'] as const),
  ...[3, 4, 1, 0, 2, 5, 6, 8, 7, 9, 10, 11, 12, 13, 14].map(index => releasedManagedMetadata[index]!.pathParts)
]);

export const releasedManagedActivationIdentities = Object.freeze([
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity
] as const);

export const releasedV3CompatibilityContract = Object.freeze({
  schemaVersion: 4,
  liftoffVersion: releasedV3ActivationIdentity.liftoffVersion,
  minimumManifestWriter: '0.10.0',
  manifestReadVersions: Object.freeze([2, 3, 4, 5, 6, 7] as const),
  manifestWriteVersion: 7,
  currentIdentity: releasedV3ActivationIdentity,
  graphHash: releasedV3ActivationIdentity.phaseGraphHash,
  historicalIdentities: Object.freeze([historicalV1ActivationIdentity, historicalV2ActivationIdentity] as const),
  readers: Object.freeze(['activation-v1', 'activation-v2'] as const),
  successorMigrations: Object.freeze([
    Object.freeze({
      id: 'activation-v1-to-v3', fromIdentity: historicalV1ActivationIdentity, toIdentity: releasedV3ActivationIdentity,
      strategy: 'preserve-history-revalidate', historySchemaVersion: 1, journalSchemaVersion: 1
    } as const),
    Object.freeze({
      id: 'activation-v2-to-v3', fromIdentity: historicalV2ActivationIdentity, toIdentity: releasedV3ActivationIdentity,
      strategy: 'preserve-history-revalidate', historySchemaVersion: 1, journalSchemaVersion: 1
    } as const)
  ]),
  logicalInventories: releasedManagedLogicalInventories,
  managedMetadata: releasedManagedMetadata
} as const);

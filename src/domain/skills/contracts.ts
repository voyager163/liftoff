import type { CodingAgentId } from '../project/contracts.js';

export const CANONICAL_SKILL_IDS = [
  'setup',
  'assess',
  'init',
  'adopt',
  'update',
  'repair',
  'migrate',
  'governance-assess',
  'governance',
  'azure',
  'cli-upgrade'
] as const;

export type CanonicalSkillId = (typeof CANONICAL_SKILL_IDS)[number];

export const CAPABILITY_ENGINE_OWNERS = [
  'Standards and Assessment',
  'Project Generation',
  'Project Evolution',
  'Repository Governance',
  'Azure Activation',
  'Distribution and CLI Upgrade'
] as const;

export type CapabilityEngineOwner = (typeof CAPABILITY_ENGINE_OWNERS)[number];

export type SkillHostId = CodingAgentId;

export const SUPPORTED_SKILL_HOSTS: readonly SkillHostId[] = [
  'github-copilot',
  'claude',
  'codex'
] as const;

export type SkillScope = 'user' | 'project';

export const skillsSubcommands = ['list', 'plan', 'inspect', 'install', 'update', 'remove', 'migrate'] as const;
export type SkillsSubcommand = (typeof skillsSubcommands)[number];

export type SkillEffectClass =
  | 'read-only'
  | 'inspection-and-mutation'
  | 'reviewed-mutation'
  | 'routine-upgrade';

export type SkillCommandOutput = 'json' | 'human';
export type SkillAuthorizationMechanism = 'read-only' | 'flag-consent' | 'reviewed-plan' | 'command-invocation';

export interface CanonicalSkillDefinition {
  id: CanonicalSkillId;
  name: string;
  description: string;
  owningEngine: CapabilityEngineOwner;
  requiredCapability: string;
  commandOutput: SkillCommandOutput;
  commandResultSchema: number | null;
  contractVersion?: number;
  authorizationMechanism: SkillAuthorizationMechanism;
  supportedHosts: readonly SkillHostId[];
  defaultInvocations: Record<SkillHostId, string>;
  entrypoint: string;
  effectClass: SkillEffectClass;
  authorizationRequired: boolean;
  content: string;
  contentHash: string;
}

export type CanonicalSkillMetadata = Omit<CanonicalSkillDefinition, 'content' | 'contentHash'>;

export interface SkillCatalog {
  schemaVersion: 1;
  catalogVersion: string;
  skills: readonly CanonicalSkillDefinition[];
}

export interface SkillProjection {
  skillId: CanonicalSkillId;
  host: SkillHostId;
  scope: SkillScope;
  relativeDestination: string;
  pathParts: readonly string[];
  renderedContent: string;
  contentHash: string;
  canonicalHash: string;
  invocation: string;
}

export interface SkillProjectionRecord {
  logicalId: string;
  skillId: CanonicalSkillId;
  host: SkillHostId;
  pathParts: readonly string[];
  relativeDestination: string;
  canonicalContentHash: string;
  projectedContentHash: string;
  projectedMode: number;
  catalogVersion: string;
  catalogDigest: string;
  consumers: readonly SkillHostId[];
  installedByPlan: string;
  updatedByPlan: string;
}

export interface SkillOwnershipStore {
  schemaVersion: 1;
  kind: 'liftoff-skills-ownership';
  catalogId: 'liftoff-canonical-skills';
  scope: SkillScope;
  targetRoot: string;
  projections: Record<string, SkillProjectionRecord>;
}

export type SkillActionType =
  | 'create'
  | 'adopt'
  | 'update'
  | 'retain'
  | 'remove'
  | 'conflict-modified'
  | 'collision-unowned'
  | 'blocked';

export interface PlannedSkillAction {
  skillId: CanonicalSkillId;
  host: SkillHostId;
  scope: SkillScope;
  relativeDestination: string;
  absolutePath: string;
  action: SkillActionType;
  existingContentHash?: string;
  targetContentHash?: string;
  existingMode?: number;
  targetMode?: number;
  consumers: readonly SkillHostId[];
  ownershipChanged: boolean;
  overlappingDiscoveryDisclosure?: string;
  reason?: string;
}

export type SkillDeliveryIntent = 'install' | 'update' | 'remove';

export interface SkillFileObservation {
  pathParts: readonly string[];
  state: 'absent' | 'file';
  contentHash?: string;
  mode?: number;
  device?: number;
  inode?: number;
  size?: number;
}

export interface SkillDirectoryObservation {
  pathParts: readonly string[];
  state: 'absent' | 'directory';
  mode?: number;
  device?: number;
  inode?: number;
  entriesDigest?: string;
}

export interface SkillDiscoveryObservation {
  root: string;
  files: readonly SkillFileObservation[];
  directories: readonly SkillDirectoryObservation[];
}

export interface SkillDeliveryPlan {
  schemaVersion: 1;
  kind: 'liftoff-skills-plan';
  contractVersion: 1;
  cliVersion: string;
  scope: SkillScope;
  targetRoot: string;
  intent: SkillDeliveryIntent;
  hosts: readonly SkillHostId[];
  skillIds: readonly CanonicalSkillId[];
  catalogVersion: string;
  catalogDigest: string;
  catalogInputs: SkillDiscoveryObservation;
  validFrom: string;
  expiresAt: string;
  actions: readonly PlannedSkillAction[];
  files: readonly SkillFileObservation[];
  directories: readonly SkillDirectoryObservation[];
  discovery: readonly SkillDiscoveryObservation[];
  blockers: readonly string[];
  fingerprint: string;
  overlappingDiscoveryDisclosures: readonly string[];
  hasCollisions: boolean;
  hasConflicts: boolean;
  summary: {
    create: number;
    adopt: number;
    update: number;
    retain: number;
    remove: number;
    ownership: number;
    blocked: number;
  };
}

export type CapabilityNegotiationStatus =
  | 'executable'
  | 'plan-only'
  | 'prerequisite-blocked'
  | 'unsupported'
  | 'unqualified';

export interface SkillCapabilityCheck {
  skillId: CanonicalSkillId;
  requiredCapability: string;
  commandOutput: SkillCommandOutput;
  commandResultSchema: number | null;
  contractVersion?: number;
  owningEngine: CapabilityEngineOwner;
  status: CapabilityNegotiationStatus;
  details?: string;
  authority: 'none';
  hostQualification: 'not-evaluated' | 'unqualified';
}

export interface ContextPreservingContinuation {
  executable: string;
  args: readonly string[];
  cwd: string;
  scope: string;
  project?: string;
  userTarget?: string;
  source?: string;
  target?: string;
  requiredAuthority?: readonly string[];
  compatibilityIdentity?: string;
  configRef?: {
    path: string;
    digest: string;
  };
}

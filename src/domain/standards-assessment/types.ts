export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type InventoryCategory =
  | 'source'
  | 'declarations'
  | 'locks'
  | 'tests'
  | 'build'
  | 'config'
  | 'docs'
  | 'containers'
  | 'infrastructure'
  | 'workflows'
  | 'framework'
  | 'agent'
  | 'provenance';

export const INVENTORY_CATEGORIES: readonly InventoryCategory[] = [
  'source',
  'declarations',
  'locks',
  'tests',
  'build',
  'config',
  'docs',
  'containers',
  'infrastructure',
  'workflows',
  'framework',
  'agent',
  'provenance'
] as const;

export interface AssessmentTarget {
  targetPath: string;
  projectRoot: string;
  repositoryRoot: string | null;
  componentPath: string | null;
  scanRoot: string;
  hasGit: boolean | null;
  hasManifest: boolean | null;
  manifestVersion: number | null;
  manifestPath?: string;
  manifestDigest?: string;
}

export type ProfileStatus = 'supported' | 'unsupported' | 'unresolved';

export interface StandardsProfileIdentity {
  schemaVersion: 1;
  id: string;
  revision: string;
  digest: string;
  name: string;
  description: string;
  status: ProfileStatus;
  declaredRuleCoverage: string[];
  componentRoot?: string;
  componentBoundaries?: {
    allowedRoots: string[];
    requiredDeclarations: string[];
    sourcePatterns: string[];
  };
}

export interface FileObservation {
  path: string;
  category: InventoryCategory;
  size: number;
  digest: string;
  modifiedTime: string;
  unstable?: boolean;
}

export type UnobservedReason =
  | 'size_limit_exceeded'
  | 'time_limit_exceeded'
  | 'permission_denied'
  | 'unsupported_file_type'
  | 'unreadable'
  | 'symlink_escape'
  | 'case_collision'
  | 'count_limit_exceeded'
  | 'unstable_during_collection'
  | 'excluded_directory'
  | 'malformed_declaration';

export interface UnobservedScope {
  path: string;
  reason: UnobservedReason;
  message: string;
}

export interface AssessmentInventory {
  summary: {
    totalFiles: number;
    totalBytes: number;
    byCategory: Record<InventoryCategory, number>;
  };
  files: FileObservation[];
  unobserved: UnobservedScope[];
  limits: {
    maxFiles: number;
    maxFileSize: number;
    maxDepth: number;
    maxScanBytes?: number;
    scanTimeoutMs?: number;
    exceeded: boolean;
  };
  protectedExclusions: string[];
  contentMap?: Map<string, string>;
}

export type RuleSeverity = 'info' | 'warning' | 'error';

export interface RuleDefinition {
  id: string;
  title: string;
  description: string;
  severity: RuleSeverity;
  applicableProfiles: string[];
  applicableScope: 'project' | 'component';
  expected: string;
}

export type FindingClassification =
  | 'aligned'
  | 'difference'
  | 'missing'
  | 'conflicting'
  | 'unsupported'
  | 'unknown'
  | 'inapplicable';

export interface EvidenceReference {
  path: string;
  digest: string | null;
  line?: number;
}

export interface AssessmentFinding {
  ruleId: string;
  title: string;
  targetProfile: string;
  scope: string;
  severity: RuleSeverity;
  classification: FindingClassification;
  expected: string;
  observed: {
    facts: Record<string, JsonValue> | string[];
    references: EvidenceReference[];
    limitations: string[];
  };
  remedy?: {
    capability: string;
    action: string;
  };
}

export interface AssessmentCoverage {
  declaredRules: number;
  assessedRules: number;
  alignedRules: number;
  differingRules: number;
  missingRules: number;
  unsupportedRules: number;
  unknownRules: number;
}

export type RecommendationCapability = 'adopt' | 'update' | 'repair' | 'governance' | 'init';
export type RecommendationEngine =
  | 'Standards and Assessment'
  | 'Project Generation'
  | 'Project Evolution'
  | 'Repository Governance'
  | 'Azure Activation'
  | 'Distribution and CLI Upgrade';

import type { QualificationState } from '../../protocol/capabilities.js';
import type { CommandSchemaDescriptor } from '../../protocol/capabilities.js';
import type { StructuredContinuationV1 } from '../../protocol/continuation.js';

export type { QualificationState };
export type RecommendationQualification = QualificationState;

export interface AssessmentRecommendation {
  id: string;
  title: string;
  capability: RecommendationCapability;
  capabilityId: string;
  engine: RecommendationEngine;
  status: 'available' | 'plan-only' | 'blocked';
  executable: string | null;
  args: string[];
  cwd: string;
  scope: string;
  project: string;
  inputs?: {
    reference: string;
    digest: string;
  };
  approval: 'required' | 'read-only' | 'consent-required';
  compatibility: string;
  commandSchema: CommandSchemaDescriptor;
  qualification: RecommendationQualification;
  requiredAuthority: string[];
  blockedReasons: string[];
  continuation?: StructuredContinuationV1;
}

export interface AssessmentDiagnostic {
  code: string;
  severity: RuleSeverity;
  message: string;
  source?: string;
}

export type AssessmentOutcome = 'success' | 'differences' | 'error';

export interface AssessmentResult {
  schemaVersion: 1;
  command: 'assess';
  cliVersion: string;
  capabilityProtocolSchemaVersion: 1;
  target: AssessmentTarget;
  profile: StandardsProfileIdentity;
  observedProfiles: StandardsProfileIdentity[];
  capturedInputs?: {
    reference: string;
    digest: string;
  };
  observedAt: string;
  inventory: AssessmentInventory;
  findings: AssessmentFinding[];
  diagnostics: AssessmentDiagnostic[];
  coverage: AssessmentCoverage;
  recommendations: AssessmentRecommendation[];
  outcome: AssessmentOutcome;
  exitCode: 0 | 1 | 2;
}

export interface AssessProjectOptions {
  targetPath?: string;
  projectRoot?: string;
  componentPath?: string;
  profile?: string;
  inputsPath?: string;
  invocationCwd?: string;
  capturedClock?: string;
  maxFiles?: number;
  maxFileSize?: number;
  maxDepth?: number;
  maxScanBytes?: number;
  scanTimeoutMs?: number;
}

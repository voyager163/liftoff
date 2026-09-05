import type { ActivationIdentity, PhaseId } from '../governance-activation/types.js';
import type { CommandRunner } from '../process-runner.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const classifications = [
  'aligned', 'outdated', 'missing', 'conflicting', 'approved-exception', 'inapplicable', 'not-observed'
] as const;
export type Classification = typeof classifications[number];
export type Severity = 'info' | 'warning' | 'error';
export type Layer = 'recorded' | 'declared' | 'live' | 'evidence';
export type Ownership = 'managed-core' | 'project-owned' | 'remote' | 'external-authority';
export type Outcome = 'aligned' | 'differences' | 'partial' | 'not-applicable' | 'error';

export interface ObservationSource {
  kind: 'package' | 'file' | 'git' | 'evidence' | 'github' | 'azure';
  location: string;
  digest: string | null;
  capturedAt: string;
  revision: string | null;
  line: number | null;
}

export interface Observation {
  availability: 'observed' | 'missing' | 'not-observed';
  value: JsonValue;
  source: ObservationSource | null;
  reason: string | null;
  facts?: JsonValue;
}

export interface AssessmentDiagnostic {
  code: string;
  severity: Severity;
  message: string;
  source: string | null;
}

export interface ControlDefinition {
  id: string;
  title: string;
  policySection: string;
  severity: Severity;
  applicability: 'always' | 'api' | 'private-dast' | 'state-path';
  evaluator: string;
  proofLayers: Layer[];
  expected: JsonValue;
  phaseIds: PhaseId[];
  supported: boolean;
  exceptionAllowed: boolean;
  ownership: Ownership;
  recommendation: string;
}

export interface AssessmentCatalog {
  schemaVersion: 1;
  profile: 'single-maintainer-gitflow';
  policyVersion: string;
  policyDigest: string;
  families: string[];
  controls: ControlDefinition[];
}

export interface AssessmentTarget {
  cliVersion: string;
  profile: 'single-maintainer-gitflow';
  policyVersion: string;
  policyDigest: string;
  activationIdentity: ActivationIdentity;
  phaseGraphHash: string;
  catalogSchemaVersion: 1;
  catalogDigest: string;
}

export interface FindingScope {
  repository: string | null;
  environment: string | null;
  resource: string | null;
}

export interface AssessmentFinding {
  controlId: string;
  title: string;
  policySection: string;
  severity: Severity;
  scope: FindingScope;
  expected: JsonValue;
  applicability: 'applicable' | 'inapplicable' | 'unknown';
  classification: Classification;
  observations: Partial<Record<Layer, Observation>>;
  requiredProof: Layer[];
  missingProof: Layer[];
  unsupported: boolean;
  reasons: string[];
  affectedPhases: PhaseId[];
  exception: { id: string; expiresAt: string; envelopeDigest: string } | null;
  recommendation: { ownership: Ownership; approvalRequired: boolean; action: string };
}

export interface AssessmentProjectIdentity {
  availability: 'known' | 'unsupported' | 'unavailable';
  manifestVersion: number | null;
  cliVersion: string | null;
  profile: string | null;
  policyVersion: string | null;
  recordedActivationIdentity: JsonValue;
  stateSource: 'not-started' | 'user' | 'unsupported' | 'unavailable';
}

export interface AssessmentReport {
  schemaVersion: 1;
  command: 'governance assess';
  readOnly: true;
  mode: 'local' | 'live';
  projectRoot: string;
  target: AssessmentTarget | null;
  projectIdentity: AssessmentProjectIdentity;
  snapshot: {
    capturedAt: string;
    repository: string | null;
    localHead: string | null;
    worktreeDigest: string;
    inputsStable: boolean;
  };
  outcome: Outcome;
  exitCode: 0 | 1 | 2;
  coverage: {
    total: number;
    applicable: number;
    inapplicable: number;
    unknownApplicability: number;
    fullyObserved: number;
    unobserved: number;
    unsupported: number;
    differences: number;
    approvedExceptions: number;
  };
  findings: AssessmentFinding[];
  diagnostics: AssessmentDiagnostic[];
  resultDigest: string;
}

export interface AzureAssessmentBinding {
  subscriptionId: string;
  environment: 'dev' | 'staging' | 'prod';
  resourceId: string;
  resourceType: string;
  role: 'state' | 'application' | 'runner-network';
}

export interface LiveAssessmentScope {
  repository: { owner: string; name: string; id: string | null } | null;
  refs: string[];
  environments: string[];
  runner: {
    organization: string;
    runnerId: number;
    groupId: number | null;
    networkConfigurationId: string | null;
  } | null;
  azure: AzureAssessmentBinding[];
}

export interface LiveAssessmentResult {
  observations: Record<string, Observation>;
  diagnostics: AssessmentDiagnostic[];
  refsStable: boolean;
}

export interface LiveAssessmentOptions {
  runner?: CommandRunner;
  now?: () => Date;
}

export const assessmentLimits = {
  fileBytes: 1024 * 1024,
  responseBytes: 5 * 1024 * 1024,
  requestTimeoutMs: 10_000,
  liveDeadlineMs: 60_000,
  maxPages: 20,
  retries: 1,
  maxFiles: 500
} as const;

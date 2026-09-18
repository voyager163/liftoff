import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import type { ManifestProjectArtifact, ManifestStandards, ManifestWorkload, ProjectProvisioningGroup } from '../../domain/project/contracts.js';
import type {
  ApplicationPreparationRequest, ApplicationPreparationResult, ApplicationPrivateOutputRole,
  ApplicationResolvedCheck, ApplicationResolvedPreparation, ApplicationToolIdentity
} from './application-preparation-types.js';

export const applicationBounds = {
  files: 512,
  directories: 256,
  directoryEntries: 256,
  depth: 12,
  pathBytes: 1024,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  references: 2048,
  referenceTokens: 500_000,
  patchBytes: 64 * 1024,
  mappings: 96,
  commands: 8,
  commandTimeoutMs: 120_000,
  commandOutputBytes: 64 * 1024
} as const;

export type ApplicationComponent = 'backend' | 'frontend' | 'functions' | 'database' | 'project';
export type ApplicationEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface ApplicationDirectoryObservation {
  pathParts: string[];
  exists: boolean;
  mode: number | null;
  entries: { name: string; kind: ApplicationEntryKind }[];
}

export interface ApplicationTargetArtifact {
  logicalName: string;
  category: string;
  pathParts: string[];
  provisioningGroup: ProjectProvisioningGroup;
  component: ApplicationComponent;
  componentRootPathParts: string[];
}

export interface ApplicationTargetLayout {
  id: 'liftoff-application-artifacts-v1';
  version: 1;
  workload: ManifestWorkload;
  artifacts: ApplicationTargetArtifact[];
  standards?: ManifestStandards;
  digest: string;
}

export interface ApplicationFileObservation {
  pathParts: string[];
  digest: string;
  mode: number;
  bytes: number;
  text: boolean;
  currentTargetLogicalName: string | null;
  provenance: (ManifestProjectArtifact & {
    contentMatchesRecordedHash: boolean;
    identity: 'recorded-only' | 'current-artifact';
  }) | null;
}

export interface ApplicationReference {
  id: string;
  sourcePathParts: string[];
  line: number;
  column: number;
  kind: 'path-literal' | 'relative-literal' | 'python-import';
  targetPathParts: string[];
  targetKind: 'file' | 'directory';
}

export interface ApplicationInventoryReport {
  schemaVersion: 1;
  kind: 'liftoff-application-inventory';
  projectRoot: string;
  repairContractVersion: 1;
  complete: boolean;
  inspectionDigest: string;
  target: ApplicationTargetLayout | null;
  files: ApplicationFileObservation[];
  directoryInventory: ApplicationDirectoryObservation[];
  references: ApplicationReference[];
  exclusions: { pathParts: string[]; kind: ApplicationEntryKind; reason: string }[];
  unresolvedMappings: {
    sourcePathParts: string[];
    decision: 'explicit-mapping-required' | 'current-path-customization-review';
  }[];
  referenceCoverage: 'bounded-literals-only';
  limitations: string[];
  blockers: string[];
  bounds: typeof applicationBounds;
}

/** Only report is public JSON. Snapshots contain private original application bytes. */
export interface ApplicationLayoutInspection {
  report: ApplicationInventoryReport;
  snapshots: ProjectFileSnapshot[];
}

export interface ApplicationReferenceDisposition {
  referenceId: string;
  disposition: 'updated' | 'unchanged-reviewed' | 'historical-documentation';
  afterTargetPathParts: string[] | null;
}

export interface ApplicationPatchMapping {
  sourcePathParts: string[];
  targetPathParts: string[];
  expectedSourceDigest: string;
  expectedSourceMode: number;
  stagedPathParts: string[];
  targetMode: number;
  role: 'application' | 'reference';
  targetIdentity: {
    kind: 'generated-artifact' | 'custom-component';
    logicalName: string;
  };
  customization: 'preserved' | 'reviewed-edit';
  references: ApplicationReferenceDisposition[];
}

export interface ApplicationVerificationCommand {
  executable: string;
  args: string[];
  cwdPathParts: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  network: boolean;
}

export interface ApplicationPatchDocument {
  schemaVersion: 1;
  kind: 'liftoff-application-patch';
  projectRoot: string;
  inspectionDigest: string;
  targetLayoutDigest: string;
  dynamicReferencesReviewed: true;
  unresolvedMappings: [];
  mappings: ApplicationPatchMapping[];
  verification: { commands: ApplicationVerificationCommand[]; preparation?: ApplicationPreparationRequest[] };
}

export interface ApplicationVerificationPolicy {
  kind: 'isolated-application-checks';
  commands: ApplicationVerificationCommand[];
  preparation: ApplicationResolvedPreparation[];
  toolchain: ApplicationToolIdentity[];
  executionCommands: ApplicationResolvedCheck[];
  outputRoles: ApplicationPrivateOutputRole[];
  effects: {
    projectCode: true;
    preparation: boolean;
    lifecycle: false;
    isolatedCopy: true;
    network: boolean;
    securitySandbox: false;
  };
}

export interface ApplicationPatchScope {
  kind: 'application-layout-patch';
  sourceLayout: 'explicit-project-file-mapping-v1';
  projectRoot: string;
  manifestDigest: string;
  inspectionDigest: string;
  target: ApplicationTargetLayout | null;
  patch: { path: string; digest: string | null; mode: number | null };
  staging: {
    root: string;
    files: { pathParts: string[]; digest: string; mode: number }[];
    directoryInventory: ApplicationDirectoryObservation[];
  };
  directoryInventory: ApplicationDirectoryObservation[];
  mappings: ApplicationPatchMapping[];
  references: ApplicationReference[];
  candidateReferences: ApplicationReference[];
  dynamicReferencesReviewed: boolean;
  preparation: ApplicationResolvedPreparation[];
  toolchain: ApplicationToolIdentity[];
}

export interface ApplicationPatchEffect {
  sourcePathParts: string[];
  targetPathParts: string[];
  beforeDigest: string;
  afterDigest: string;
  beforeMode: number;
  afterMode: number;
  role: ApplicationPatchMapping['role'];
  targetIdentity: ApplicationPatchMapping['targetIdentity'];
  customization: ApplicationPatchMapping['customization'];
  references: ApplicationReferenceDisposition[];
}

export interface ApplicationPatchReport {
  schemaVersion: 1;
  kind: 'liftoff-application-patch-report';
  projectRoot: string;
  patchPath: string;
  status: 'proposed' | 'blocked';
  inventory: ApplicationInventoryReport;
  effects: ApplicationPatchEffect[];
  verificationPolicy: ApplicationVerificationPolicy;
  readonly networkRequired: boolean;
  blockers: string[];
  limitations: string[];
}

/** Only report, scope, and verificationPolicy are JSON-safe; never serialize this whole object. */
export interface ApplicationPatchCandidate {
  patchPath: string;
  blockers: string[];
  report: ApplicationPatchReport;
  snapshots: ProjectFileSnapshot[];
  mutations: ProjectFileMutation[];
  scope: ApplicationPatchScope;
  verificationPolicy: ApplicationVerificationPolicy;
  readonly networkRequired: boolean;
}

/** Shared private candidate shape; a recipe's public submission and authority remain separate. */
export interface ApplicationCandidate {
  blockers: string[];
  snapshots: ProjectFileSnapshot[];
  mutations: ProjectFileMutation[];
  scope: {
    projectRoot: string;
    inspectionDigest: string;
    target: ApplicationTargetLayout | null;
    staging: { root: string };
    directoryInventory: ApplicationDirectoryObservation[];
    preparation: ApplicationResolvedPreparation[];
    toolchain: ApplicationToolIdentity[];
  };
  verificationPolicy: ApplicationVerificationPolicy;
  readonly networkRequired: boolean;
}

export interface ApplicationVerificationResult {
  schemaVersion: 1;
  kind: 'liftoff-application-verification';
  status: 'passed' | 'failed' | 'blocked';
  candidateDigest: string;
  inspectionDigest: string;
  verificationPolicyDigest: string;
  providerDigest: string;
  toolchainDigest: string;
  preparedScopeDigest: string;
  startedAt: string;
  completedAt: string;
  commands: {
    index: number;
    status: number | null;
    signal: string | null;
    timedOut: boolean;
    outputLimitExceeded: boolean;
    passed: boolean;
  }[];
  preparation: ApplicationPreparationResult[];
  blockers: string[];
  /**
   * Equality of bounded application inventory using the originally supplied manifest metadata.
   * Excludes raw manifest/config/state/control/credential contents and other host effects.
   */
  inspectedProjectUnchanged: boolean;
  cleanupComplete: boolean;
  retainedWorkspace?: string;
  workspaceId?: string;
  limitation: string;
}

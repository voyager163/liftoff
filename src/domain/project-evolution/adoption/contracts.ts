import type { ExternalCommand, ManifestComponent, ManifestStandards } from '../../project/contracts.js';
import type { AdoptionExecutionIdentity } from './identity.js';

export interface AdoptionFileIdentity {
  pathParts: string[];
  digest: string | null;
  mode: number | null;
}

export interface AdoptionEffect {
  producer: 'application-patch' | 'application-addition' | 'manifest' | 'desired-state' | 'framework' | 'managed-integration' | 'adoption-record';
  logicalName: string;
  type: 'write' | 'delete' | 'adopt';
  pathParts: string[];
  before: { digest: string | null; mode: number | null };
  after: { digest: string | null; mode: number | null };
}

export interface AdoptionFrameworkSelection {
  workflow: 'openspec' | 'spec-kit';
  agents: Array<'github-copilot' | 'claude' | 'codex'>;
  defaultAgent?: 'github-copilot' | 'claude' | 'codex';
  initialize: boolean;
  copilotCloud: boolean;
}

export interface AdoptionFrameworkBinding {
  definitionId: 'openspec' | 'spec-kit';
  contractVersion: string;
  launcherPath: string;
  executablePath: string;
  toolDigest: string;
  runtimeDigest: string;
  commands: ExternalCommand[];
  expectedPaths: string[][];
}

export interface AdoptionPlan extends AdoptionExecutionIdentity {
  schemaVersion: 1;
  kind: 'liftoff-adoption-plan';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  projectName: string;
  standards: ManifestStandards;
  component: ManifestComponent;
  assessmentDigest: string;
  inspectionDigest: string;
  proposal: { path: string; digest: string; mode: number } | null;
  framework: AdoptionFrameworkSelection;
  frameworkPreparation: {
    status: 'not-required' | 'required' | 'prepared';
    binding: AdoptionFrameworkBinding | null;
    files: AdoptionFileIdentity[];
  };
  governanceProfile: 'none' | 'single-maintainer-gitflow';
  source: AdoptionFileIdentity[];
  directoryDigest: string;
  targetDigest: string;
  verificationDigest: string;
  toolchainDigest: string;
  effects: AdoptionEffect[];
  permissions: {
    projectCode: boolean;
    dependencyPreparation: boolean;
    network: boolean;
    framework: boolean;
    fileTransaction: boolean;
  };
  recordId: string;
  createdAt: string;
  expiresAt: string;
  fingerprint: string;
}

export interface AdoptionRecord extends AdoptionExecutionIdentity {
  schemaVersion: 1;
  kind: 'liftoff-adoption-record';
  recordId: string;
  projectRoot: string;
  projectIdentity: AdoptionPlan['projectIdentity'];
  fingerprint: string;
  reviewedAt: string;
  standards: ManifestStandards;
  assessmentDigest: string;
  source: AdoptionFileIdentity[];
  effects: AdoptionEffect[];
  verification: { status: 'passed' | 'not-required'; digest: string | null };
  backup: { namespace: 'adoption-backup'; indexKey: string } | null;
  authorization: { namespace: 'adoption-approval'; fingerprint: string; boundary: 'exact-transaction-digest' };
  manifestHash: string;
  activationEvidence: 'not-issued';
}

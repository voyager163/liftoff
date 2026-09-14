import type { ExternalCommand } from '../../domain/project/contracts.js';
import type { CommandRunner } from '../../process-runner.js';
import type { ApplicationTargetArtifact } from './application-types.js';
import type { RepairPreview } from './preview.js';
import type { RepairWorkspaceStorageOptions } from './workspaces-types.js';

export type ApplicationPreparationProviderId = 'npm-ci' | 'uv-locked-sync' | 'go-mod-download';
export type ApplicationPackageSourceId = 'npmjs' | 'microsoft-npm' | 'pypi' | 'microsoft-pypi' | 'go-proxy';
export type ApplicationToolId = 'node' | 'npm' | 'python' | 'uv' | 'go';

export interface ApplicationPreparationRequest {
  provider: ApplicationPreparationProviderId;
  version: 1;
  cwdPathParts: string[];
  packageSource: ApplicationPackageSourceId;
  network: boolean;
  lifecycle: 'disabled';
}

export interface ApplicationToolRequirement {
  minimumVersion: string;
  releaseLine: string;
  allowPrerelease: boolean;
}

export interface ApplicationToolFileIdentity {
  path: string;
  digest: string;
  bytes: number;
  mode: number;
  device: string;
  inode: string;
  modifiedNs: string;
  changedNs: string;
}

export interface ApplicationToolIdentity {
  schemaVersion: 1;
  id: ApplicationToolId;
  launcherPath: string;
  executablePath: string;
  prefixArgs: string[];
  version: string;
  requirement: ApplicationToolRequirement;
  files: ApplicationToolFileIdentity[];
  probe: ExternalCommand;
  digest: string;
}

export interface ApplicationPrivateOutputRole {
  id: string;
  kind: 'dependency' | 'cache' | 'build-output';
  pathParts: string[];
  /** Dependencies become immutable once their registered preparation has completed. */
  protectedAfterPreparation: boolean;
}

export interface ApplicationPreparationCommand {
  tool: ApplicationToolId;
  args: string[];
  cwdPathParts: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ApplicationResolvedPreparation {
  schemaVersion: 1;
  provider: ApplicationPreparationProviderId;
  version: 1;
  component: ApplicationTargetArtifact;
  cwdPathParts: string[];
  packageSource: ApplicationPackageSourceId;
  registry: string;
  network: boolean;
  lifecycle: 'disabled';
  inputs: { pathParts: string[]; digest: string; mode: number }[];
  commands: ApplicationPreparationCommand[];
  tools: ApplicationToolId[];
  outputRoles: ApplicationPrivateOutputRole[];
  packageCount: number;
  suppressedLifecyclePackages: number;
  pythonExtras: string[];
  toolRequirements: Record<string, string>;
  digest: string;
}

export interface ApplicationInspectionOptions {
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

export interface ApplicationPreparationResult {
  schemaVersion: 1;
  provider: ApplicationPreparationProviderId;
  version: 1;
  cwdPathParts: string[];
  policyDigest: string;
  status: 'passed' | 'failed';
  commands: {
    index: number;
    status: number | null;
    signal: string | null;
    timedOut: boolean;
    outputLimitExceeded: boolean;
    passed: boolean;
  }[];
}

export interface ApplicationVerificationOptions {
  preview: RepairPreview;
  storage?: RepairWorkspaceStorageOptions;
  env?: NodeJS.ProcessEnv;
  allowProjectCode: boolean;
  allowDependencyPreparation: boolean;
  allowNetwork: boolean;
  /** Coordinator-owned raw manifest/configuration and immutable-preview revalidation. */
  assertCurrent: () => Promise<void>;
}

export interface ApplicationResolvedCheck {
  executable: string;
  args: string[];
  cwdPathParts: string[];
  tool: ApplicationToolId;
  /** A selected private Python environment, resolved only after locked preparation. */
  pythonEnvironmentPathParts: string[] | null;
}

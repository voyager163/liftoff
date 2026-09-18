import type { Readable } from 'node:stream';
import type { CommandRunner } from '../process-runner.js';
import type { ConfiguredRegistryTargetLookup, SelfUpgradeExecutor } from '../self-upgrade.js';
import type { StableRelease } from '../stable-release.js';
import type { PresentationSession, PresentationSessionOptions } from '../terminal.js';
import type { UpdateApprovalPrompt } from './update/approval.js';
import type { resolveUpdatePreviewLocation } from '../adapters/filesystem/update-previews.js';
import type { WorkstationNoProgressStore, WorkstationProbeOptions } from '../workstation.js';
import type { NativeUpgradeResult } from './distribution/native-upgrade.js';
import type { ApplicationEngines } from './engine-composition.js';
import type { GovernanceTransitionAdapters } from '../governance-activation/transition-ports.js';

export interface CommandContext {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: Readable;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  selfUpgrade?: SelfUpgradeExecutor;
  nativeUpgradeCheck?: () => Promise<NativeUpgradeResult>;
  stableReleaseLookup?: () => Promise<StableRelease>;
  configuredRegistryTargetLookup?: ConfiguredRegistryTargetLookup;
  updatePreview?: Parameters<typeof resolveUpdatePreviewLocation>[1];
  storage?: Parameters<typeof resolveUpdatePreviewLocation>[1];
  adapters?: GovernanceTransitionAdapters;
  approveUpdatePlan?: UpdateApprovalPrompt;
  approveRepairPlan?: UpdateApprovalPrompt;
  approveAdoptionPlan?: UpdateApprovalPrompt;
  updateNow?: () => Date;
  workstationProbe?: WorkstationProbeOptions;
  workstationNoProgressStore?: WorkstationNoProgressStore;
  terminal?: Pick<
    PresentationSessionOptions,
    'columns' | 'color' | 'snapshot' | 'env' | 'layout' | 'normalize'
  >;
}

export interface ExecutionContext extends CommandContext {
  presentation: PresentationSession;
  engines?: ApplicationEngines;
}

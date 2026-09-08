import type { Readable } from 'node:stream';
import type { CommandRunner } from '../process-runner.js';
import type { ConfiguredRegistryTargetLookup, SelfUpgradeExecutor } from '../self-upgrade.js';
import type { StableRelease } from '../stable-release.js';
import type { PresentationSession, PresentationSessionOptions } from '../terminal.js';

export interface CommandContext {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: Readable;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  selfUpgrade?: SelfUpgradeExecutor;
  stableReleaseLookup?: () => Promise<StableRelease>;
  configuredRegistryTargetLookup?: ConfiguredRegistryTargetLookup;
  terminal?: Pick<
    PresentationSessionOptions,
    'columns' | 'color' | 'snapshot' | 'env' | 'layout' | 'normalize'
  >;
}

export interface ExecutionContext extends CommandContext {
  presentation: PresentationSession;
}

import type { ExternalCommand } from '../../domain/project/contracts.js';
import type {
  SelfUpgradeResult,
  SelfUpgradeStage
} from '../../domain/distribution/liftoff-upgrade.js';
import type {
  ExecutionContext
} from '../context.js';
import {
  liftoffVersion
} from '../../version.js';
import {
  runSelfUpgrade
} from './self-upgrade.js';

export interface UpgradeRequest {
  mode: 'check' | 'apply';
  json: boolean;
}

/** Human-mode progress callbacks; JSON requests never carry them, so stdout stays one final result. */
export interface UpgradeObserver {
  onStage(stage: SelfUpgradeStage, detail?: string): void;
  onInstallCommand(command: ExternalCommand): void;
}

export async function executeUpgrade(
  request: UpgradeRequest,
  context: ExecutionContext,
  observer?: UpgradeObserver
): Promise<SelfUpgradeResult> {
  const { mode, json } = request;
  const execute = context.selfUpgrade ?? ((request) =>
    runSelfUpgrade(request, {
      environment: context.env ?? process.env
    }));
  try {
    return await execute({
      mode,
      currentVersion: liftoffVersion,
      stdout: context.stdout,
      stderr: context.stderr,
      json,
      ...(!json && observer
        ? {
            onStage: (stage: SelfUpgradeStage, detail?: string) => observer.onStage(stage, detail),
            onInstallCommand: (command: ExternalCommand) => observer.onInstallCommand(command)
          }
        : {})
    });
  } catch {
    return {
      schemaVersion: 1,
      mode,
      status: 'failed',
      currentVersion: liftoffVersion,
      reasonCode: 'verification_failed'
    };
  }
}

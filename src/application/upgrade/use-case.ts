import {
  formatCommand
} from '../../process-runner.js';
import {
  runSelfUpgrade,
  selfUpgradeExitCode,
  selfUpgradeRemedy,
  selfUpgradeSummary,
  type SelfUpgradeResult
} from '../../self-upgrade.js';
import {
  PresentationSession
} from '../../terminal.js';
import type {
  ExecutionContext
} from '../context.js';
import {
  liftoffVersion
} from '../../version.js';

function renderSelfUpgradeResult(
  value: SelfUpgradeResult,
  presentation: PresentationSession
): void {
  const details = [
    { label: 'Current CLI', value: value.currentVersion },
    ...('targetVersion' in value && value.targetVersion
      ? [{ label: 'Canonical target', value: value.targetVersion }]
      : []),
    ...('registryKind' in value && value.registryKind
      ? [{ label: 'Delivery registry', value: value.registryKind }]
      : [])
  ];
  presentation.definitions('CLI upgrade result', details);
  switch (value.status) {
    case 'current':
      presentation.status('success', 'CLI is current', selfUpgradeSummary(value));
      return;
    case 'update-available':
      presentation.status('warning', 'CLI update available', selfUpgradeSummary(value));
      presentation.command('liftoff upgrade');
      return;
    case 'upgraded':
      presentation.completion(
        'Liftoff CLI upgraded',
        selfUpgradeSummary(value),
        [{ label: 'Installed version', value: value.targetVersion }],
        'liftoff update --check'
      );
      return;
    case 'blocked':
    case 'failed': {
      presentation.status(
        value.status === 'blocked' ? 'warning' : 'error',
        value.status === 'blocked' ? 'CLI upgrade blocked' : 'CLI upgrade failed',
        selfUpgradeSummary(value)
      );
      const remedy = selfUpgradeRemedy(value);
      if (remedy) {
        presentation.remedy(remedy);
      }
      return;
    }
    default: {
      const exhaustive: never = value;
      throw new Error(`Unhandled self-upgrade result: ${String(exhaustive)}`);
    }
  }
}

export interface UpgradeRequest {
  mode: 'check' | 'apply';
  json: boolean;
}

export async function upgradeLiftoff(
  request: UpgradeRequest,
  context: ExecutionContext
): Promise<number> {
  const { mode, json } = request;
  if (!json) {
    context.presentation.commandIdentity(
      'upgrade',
      'Replace the supported global Liftoff CLI installation'
    );
  }
  const execute = context.selfUpgrade ?? ((request) =>
    runSelfUpgrade(request, {
      environment: context.env ?? process.env
    }));
  let value: SelfUpgradeResult;
  try {
    value = await execute({
      mode,
      currentVersion: liftoffVersion,
      stdout: context.stdout,
      stderr: context.stderr,
      json,
      ...(!json
        ? {
            onStage: (stage: Parameters<NonNullable<Parameters<typeof runSelfUpgrade>[0]['onStage']>>[0], detail?: string) =>
              context.presentation.stage(stage, detail),
            onInstallCommand: (command: Parameters<NonNullable<Parameters<typeof runSelfUpgrade>[0]['onInstallCommand']>>[0]) =>
              context.presentation.command(formatCommand(command))
          }
        : {})
    });
  } catch {
    value = {
      schemaVersion: 1,
      mode,
      status: 'failed',
      currentVersion: liftoffVersion,
      reasonCode: 'verification_failed'
    };
  }
  if (json) {
    context.presentation.rawStdout(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    renderSelfUpgradeResult(value, context.presentation);
  }
  return selfUpgradeExitCode(value);
}

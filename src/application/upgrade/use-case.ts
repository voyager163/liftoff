import {
  formatCommand
} from '../../process-runner.js';
import {
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
import {
  runNativeOwnerUpgrade, nativeUpgradeExitCode, type NativeUpgradeResult
} from '../distribution/native-upgrade.js';

function renderSelfUpgradeResult(
  value: SelfUpgradeResult,
  presentation: PresentationSession
): void {
  const details = [
    { label: 'Current CLI', value: value.currentVersion },
    ...(value.installationTarget
      ? [{ label: 'Installation target', value: value.installationTarget }]
      : []),
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
      'Replace the verified native CLI through its actual installation owner'
    );
  }
  const execute = context.selfUpgrade ?? ((upgradeReq) => runNativeOwnerUpgrade(upgradeReq, {
    env: context.env, cwd: context.cwd, runner: context.runner
  }));
  let value: SelfUpgradeResult | NativeUpgradeResult;
  try {
    value = await execute({
      mode,
      currentVersion: liftoffVersion,
      stdout: context.stdout,
      stderr: context.stderr,
      json,
      ...(!json
        ? {
            onStage: (stage: Parameters<NonNullable<Parameters<typeof runNativeOwnerUpgrade>[0]['onStage']>>[0], detail?: string) =>
              context.presentation.stage(stage, detail),
            onInstallCommand: (command: Parameters<NonNullable<Parameters<typeof runNativeOwnerUpgrade>[0]['onInstallCommand']>>[0]) =>
              context.presentation.command(formatCommand(command))
          }
        : {})
    });
  } catch {
    value = context.selfUpgrade ? {
      schemaVersion: 1,
      mode,
      status: 'failed',
      currentVersion: liftoffVersion,
      reasonCode: 'verification_failed'
    } : {
      schemaVersion: 1, distribution: 'native', mode, status: 'failed', currentVersion: liftoffVersion,
      reasonCode: 'verification_failed', owner: 'unknown', upstreamAvailability: 'unknown', ownerAvailability: 'unknown',
      completedEffects: [],
      uncertainEffects: mode === 'apply' ? ['The native owner operation outcome is unconfirmed; possible partial effects must be preserved.'] : [],
      recoveryRequired: mode === 'apply',
      ...(mode === 'apply' ? { recordPersistence: 'unconfirmed' as const } : {}),
      manualAction: 'Inspect the exact installation and original owner-operation records. No speculative rollback, cleanup or new replacement is authorized by this failed observation.'
    };
  }
  if (json) {
    context.presentation.rawStdout(`${JSON.stringify(value, null, 2)}\n`);
  } else if ('distribution' in value) {
    context.presentation.definitions('Native CLI upgrade', [
      { label: 'Current version', value: value.currentVersion },
      { label: 'Owner', value: value.owner },
      { label: 'Upstream availability', value: value.upstreamAvailability },
      { label: 'Owner availability', value: value.ownerAvailability },
      ...(value.targetVersion ? [{ label: 'Exact target', value: value.targetVersion }] : []),
      ...(value.recoveryRequired ? [{ label: 'Recovery', value: 'required' }] : []),
      ...(value.recordPersistence ? [{ label: 'Record persistence', value: value.recordPersistence }] : [])
    ]);
    context.presentation.status(
      value.status === 'current' || value.status === 'upgraded' ? 'success' : value.status === 'failed' ? 'error' : 'warning',
      value.status, value.reasonCode
    );
    if (value.completedEffects.length) {
      context.presentation.bullets('Completed effects', value.completedEffects);
    }
    if (value.uncertainEffects.length) {
      context.presentation.bullets('Uncertain effects', value.uncertainEffects);
    }
    if (value.manualAction) context.presentation.remedy(value.manualAction);
  } else {
    renderSelfUpgradeResult(value, context.presentation);
  }
  return 'distribution' in value ? nativeUpgradeExitCode(value) : selfUpgradeExitCode(value);
}

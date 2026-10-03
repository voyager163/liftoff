import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import {
  executeUpgrade
} from '../../application/upgrade/use-case.js';
import {
  selfUpgradeExitCode,
  selfUpgradeRemedy,
  selfUpgradeSummary,
  type SelfUpgradeResult
} from '../../domain/distribution/liftoff-upgrade.js';
import {
  formatCommand
} from '../../process-runner.js';
import type {
  PresentationSession
} from '../../terminal.js';
import { readBooleanFlag } from '../args/readers.js';

export function renderSelfUpgradeResult(
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

export const upgradeCommand = async (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => {
  const mode = readBooleanFlag(parsed.flags, 'check') === true ? 'check' : 'apply';
  const json = readBooleanFlag(parsed.flags, 'json') === true;
  if (!json) {
    context.presentation.commandIdentity(
      'upgrade',
      'Replace the supported global Liftoff CLI installation'
    );
  }
  const value = await executeUpgrade({ mode, json }, context, json ? undefined : {
    onStage: (stage, detail) => context.presentation.stage(stage, detail),
    onInstallCommand: (command) => context.presentation.command(formatCommand(command))
  });
  context.outcome?.record(value.status === 'update-available' ? 'attention-required' :
    value.status === 'failed' || value.status === 'blocked' ? 'failure' : 'success');
  if (json) {
    context.presentation.rawStdout(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    renderSelfUpgradeResult(value, context.presentation);
  }
  return selfUpgradeExitCode(value);
};

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
    ...(value.installationOwner ? [{ label: 'Installation owner', value: value.installationOwner }] : []),
    ...(value.upstream ? [{ label: 'Upstream availability', value: `${value.upstream.status}${value.upstream.version ? ` (${value.upstream.version})` : ''}` }] : []),
    ...(value.channel ? [{ label: 'Channel availability', value: `${value.channel.status}${value.channel.version ? ` (${value.channel.version})` : ''}` }] : []),
    ...(value.effects ? [{ label: 'Installation effects', value: value.effects }] : []),
    ...(value.verification ? [{ label: 'Verification', value: value.verification }] : []),
    ...(value.restartRequired ? [{ label: 'Restart required', value: 'yes' }] : []),
    ...(value.installationTarget
      ? [{ label: 'Installation target', value: value.installationTarget }]
      : []),
    ...('targetVersion' in value && value.targetVersion
      ? [{ label: 'Stable target', value: value.targetVersion }]
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
    case 'failed':
    case 'handoff-required': {
      presentation.status(
        value.status === 'failed' ? 'error' : 'warning',
        value.status === 'blocked' ? 'CLI upgrade blocked' :
          value.status === 'handoff-required' ? 'CLI upgrade requires handoff' : 'CLI upgrade failed',
        selfUpgradeSummary(value)
      );
      const remedy = selfUpgradeRemedy(value);
      if (remedy) {
        presentation.remedy(remedy);
      }
      if (value.handoff) presentation.command(formatCommand(value.handoff));
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
      'Upgrade only the verified owning Liftoff installation'
    );
  }
  const value = await executeUpgrade({ mode, json }, context, json ? undefined : {
    onStage: (stage, detail) => context.presentation.stage(stage, detail),
    onInstallCommand: (command) => context.presentation.command(formatCommand(command))
  });
  context.outcome?.record(value.status === 'update-available' ? 'attention-required' :
    value.status === 'handoff-required' ? 'attention-required' :
    value.status === 'failed' || value.status === 'blocked' ? 'failure' : 'success');
  if (json) {
    context.presentation.rawStdout(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    renderSelfUpgradeResult(value, context.presentation);
  }
  return selfUpgradeExitCode(value);
};

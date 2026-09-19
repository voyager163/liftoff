import path from 'node:path';
import type { InstallationMigrationPlan } from '../../domain/distribution/contracts.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { createStructuredContinuation, type StructuredContinuationV1 } from '../../protocol/continuation.js';
import { migrationPlanState } from './plan-migration.js';

export function createInstallationContinuation(
  plan: InstallationMigrationPlan,
  action: 'migrate' | 'inspect',
  json = false
): StructuredContinuationV1 {
  if (action !== 'migrate' && action !== 'inspect' || typeof json !== 'boolean') {
    throw new DistributionError('Installation guidance requires an exact registered action and output mode.', 'invalid_metadata');
  }
  const state = migrationPlanState(plan);
  const target = plan.targetInstallation;
  const paths = state.admission.host.os === 'win32' ? path.win32 : path.posix;
  const executable = action === 'migrate'
    ? paths.join(state.candidate.bundleRoot, ...state.candidate.provenance.entrypoints.launcher.split('/'))
    : target.launcherPath;
  const args = action === 'migrate' ? [
    'installation', 'migrate', '--to', target.owner,
    '--candidate', target.candidatePath, '--destination', target.destinationDirectory,
    '--launcher', target.launcherPath, '--approve-plan', plan.planFingerprint
  ] : ['installation', 'inspect'];
  if (json) args.push('--json');
  const requiredAuthority = action === 'migrate' ? ['exact-installation-plan'] : [];
  const continuation = createStructuredContinuation({
    executable, args, cwd: state.detector.cwd, scope: 'installation', targetScope: 'installation',
    userInstallTarget: target.destinationDirectory, requiredAuthority,
    compatibilityIdentity: plan.planFingerprint, platform: state.admission.host.os
  });
  if (continuation.executable !== executable || continuation.cwd !== state.detector.cwd ||
      continuation.scope !== 'installation' || continuation.targetScope !== 'installation' ||
      continuation.userInstallTarget !== target.destinationDirectory || continuation.project !== undefined ||
      continuation.compatibilityIdentity !== plan.planFingerprint ||
      continuation.args.length !== args.length || continuation.args.some((arg, index) => arg !== args[index]) ||
      continuation.requiredAuthority?.length !== requiredAuthority.length ||
      continuation.requiredAuthority.some((authority, index) => authority !== requiredAuthority[index])) {
    throw new DistributionError('The shared continuation could not retain the exact admitted installation action and target.', 'verification_failed');
  }
  return continuation;
}

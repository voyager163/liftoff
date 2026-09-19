import { canonicalJson } from '../governance/activation/canonical-json.js';
import { validateArtifactPathParts } from '../project/paths.js';
import { DistributionError } from './errors.js';
import { digest, object, stableVersion } from './validation.js';

export interface InstallationExecutionIdentity {
  schemaVersion: 1;
  recipe: 'native-direct-handover';
  intent: 'migrate' | 'upgrade';
  version: string;
  candidateIdentity: string;
  launcherPathParts: string[];
  receiptPathParts: string[];
}

export function validateInstallationExecutionIdentity(raw: unknown): InstallationExecutionIdentity {
  const value = object(raw, [
    'schemaVersion', 'recipe', 'intent', 'version', 'candidateIdentity', 'launcherPathParts', 'receiptPathParts'
  ], 'Native installation transaction identity');
  if (value.schemaVersion !== 1 || value.recipe !== 'native-direct-handover' ||
      (value.intent !== 'migrate' && value.intent !== 'upgrade')) {
    throw new DistributionError('Installation recovery requires its independent registered native handover identity.');
  }
  const launcherPathParts = validateArtifactPathParts(value.launcherPathParts);
  const receiptPathParts = validateArtifactPathParts(value.receiptPathParts);
  // CMD remains readable only for old journal preservation; current selection never produces it.
  if (receiptPathParts.at(-1) !== 'liftoff-receipt.json' ||
      !['liftoff', 'liftoff.exe', 'liftoff.cmd'].includes(launcherPathParts.at(-1) ?? '') ||
      canonicalJson(launcherPathParts) === canonicalJson(receiptPathParts)) {
    throw new DistributionError('Installation journal is not bound to its exact launcher and direct receipt.');
  }
  return {
    schemaVersion: 1, recipe: 'native-direct-handover', intent: value.intent,
    version: stableVersion(value.version), candidateIdentity: digest(value.candidateIdentity, 'Candidate identity'),
    launcherPathParts, receiptPathParts
  };
}

export function validateInstallationTransactionPaths(
  identity: InstallationExecutionIdentity,
  mutations: readonly { type: string; pathParts: readonly string[]; mode?: number }[]
): void {
  const expected = new Map([
    [identity.launcherPathParts.join('/'), 0o755],
    [identity.receiptPathParts.join('/'), 0o600]
  ]);
  if (mutations.length !== expected.size || mutations.some((mutation) =>
    mutation.type !== 'write' || expected.get(mutation.pathParts.join('/')) !== mutation.mode)) {
    throw new DistributionError('Native handover may write only its exact launcher and receipt; payload cleanup is not authorized.');
  }
}

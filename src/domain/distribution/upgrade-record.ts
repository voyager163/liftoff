import { DistributionError } from './errors.js';
import { digest, integer, object, stableVersion, text, timestamp, uuidPattern } from './validation.js';
import { parseNativeTransactionOutcome, type NativeInstallationTransactionOutcome } from './transaction-outcome.js';

export interface NativeUpgradeRecord {
  schemaVersion: 1;
  operation: 'native-upgrade';
  operationId: string;
  planFingerprint: string;
  revision: number;
  previousDigest?: string;
  owner: 'direct' | 'homebrew-cask' | 'winget';
  packageId: string;
  previousVersion: string;
  targetVersion: string;
  manifestDigest: string;
  provenanceDigest: string;
  sourceDigest: string;
  ownerDigest: string;
  transactionRoot: string;
  destinationDirectory: string;
  launcherPath: string;
  expiresAt: string;
  startedAt: string;
  updatedAt: string;
  status: 'in_progress' | 'failed' | 'completed';
  completedEffects: string[];
  uncertainEffects: string[];
  retainedPaths: string[];
  pendingEffectId?: string;
  failure?: string;
  processSettlement: 'settled' | 'unconfirmed';
  recovery?: { operationId: string; recordDigest: string; action: 'retry' | 'verify-current' };
  transaction?: NativeInstallationTransactionOutcome;
}

export function parseNativeUpgradeRecord(raw: unknown): NativeUpgradeRecord {
  const value = object(raw, [
    'schemaVersion', 'operation', 'operationId', 'planFingerprint', 'revision', 'previousDigest', 'owner', 'packageId',
    'previousVersion', 'targetVersion', 'manifestDigest', 'provenanceDigest', 'sourceDigest', 'ownerDigest', 'transactionRoot',
    'destinationDirectory', 'launcherPath', 'expiresAt', 'startedAt', 'updatedAt', 'status', 'completedEffects',
    'uncertainEffects', 'retainedPaths', 'pendingEffectId', 'failure', 'processSettlement', 'recovery', 'transaction'
  ], 'Native upgrade record');
  if (value.schemaVersion !== 1 || value.operation !== 'native-upgrade' ||
      typeof value.operationId !== 'string' || !uuidPattern.test(value.operationId) ||
      (value.owner !== 'direct' && value.owner !== 'homebrew-cask' && value.owner !== 'winget') ||
      (value.status !== 'in_progress' && value.status !== 'failed' && value.status !== 'completed') ||
      (value.processSettlement !== 'settled' && value.processSettlement !== 'unconfirmed')) {
    throw new DistributionError('Unknown native upgrade record identity.', 'recovery_required');
  }
  let recovery: NativeUpgradeRecord['recovery'];
  if (value.recovery !== undefined) {
    const original = object(value.recovery, ['operationId', 'recordDigest', 'action'], 'Native upgrade continuation');
    if (typeof original.operationId !== 'string' || !uuidPattern.test(original.operationId) ||
        (original.action !== 'retry' && original.action !== 'verify-current')) throw new DistributionError('Unknown native upgrade continuation identity.');
    recovery = { operationId: original.operationId, recordDigest: digest(original.recordDigest, 'Prior upgrade record'), action: original.action };
  }
  const effects = recovery?.action === 'verify-current' ? ['verify-target-installation'] : ['stage-candidate', 'install-target-owner', 'verify-target-installation'];
  const strings = (input: unknown, label: string): string[] => {
    if (!Array.isArray(input) || input.length > 128) throw new DistributionError(`Invalid native ${label}.`);
    const entries = input.map((entry) => text(entry, label));
    if (new Set(entries).size !== entries.length) throw new DistributionError(`Duplicate native ${label}.`);
    return entries;
  };
  const completedEffects = strings(value.completedEffects, 'completed effects');
  const uncertainEffects = strings(value.uncertainEffects, 'uncertain effects');
  const transaction = value.transaction === undefined ? undefined : parseNativeTransactionOutcome(value.transaction);
  if ([...completedEffects, ...uncertainEffects, ...(value.pendingEffectId ? [value.pendingEffectId] : [])].some((entry) =>
    !effects.includes(String(entry))) || value.status === 'completed' &&
      (completedEffects.length !== effects.length || uncertainEffects.length || value.pendingEffectId || value.processSettlement !== 'settled' ||
        transaction && (transaction.status !== 'committed' || !transaction.committed ||
          transaction.rollbackFailures.length || transaction.cleanupFailures.length || transaction.processSettlement !== 'settled'))) {
    throw new DistributionError('Native upgrade record has inconsistent effects or completion.', 'recovery_required');
  }
  return {
    schemaVersion: 1, operation: 'native-upgrade', operationId: value.operationId,
    planFingerprint: digest(value.planFingerprint, 'Native upgrade binding'), revision: integer(value.revision, 'Native upgrade revision', 0, 1024),
    owner: value.owner, packageId: text(value.packageId, 'Native owner package'), previousVersion: stableVersion(value.previousVersion),
    targetVersion: stableVersion(value.targetVersion), manifestDigest: digest(value.manifestDigest, 'Native manifest binding'),
    provenanceDigest: digest(value.provenanceDigest, 'Native provenance binding'), sourceDigest: digest(value.sourceDigest, 'Native source binding'),
    ownerDigest: digest(value.ownerDigest, 'Previous native owner binding'), transactionRoot: text(value.transactionRoot, 'Installation transaction root'),
    destinationDirectory: text(value.destinationDirectory, 'Installation destination'), launcherPath: text(value.launcherPath, 'Installation launcher'),
    expiresAt: timestamp(value.expiresAt, 'Native operation expiry'), startedAt: timestamp(value.startedAt, 'Native upgrade start'),
    updatedAt: timestamp(value.updatedAt, 'Native upgrade checkpoint'), status: value.status, completedEffects, uncertainEffects,
    retainedPaths: strings(value.retainedPaths, 'Retained native payloads'), processSettlement: value.processSettlement,
    ...(recovery ? { recovery } : {}),
    ...(transaction ? { transaction } : {}),
    ...(value.previousDigest !== undefined ? { previousDigest: digest(value.previousDigest, 'Previous upgrade revision') } : {}),
    ...(value.pendingEffectId !== undefined ? { pendingEffectId: text(value.pendingEffectId, 'Pending upgrade effect') } : {}),
    ...(value.failure !== undefined ? { failure: text(value.failure, 'Native upgrade failure', 4096) } : {})
  };
}

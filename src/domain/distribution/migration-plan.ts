import { canonicalJson, canonicalSha256 } from '../governance/activation/canonical-json.js';
import {
  legacyNpmPackageName, type InstallationMigrationPlan, type LegacyInstallationFacts, type NativeArch,
  type NativeOs, type OrderedMigrationEffect, type TargetInstallationFacts
} from './contracts.js';
import { DistributionError } from './errors.js';
import { digest, freeze, object, stableVersion, text, timestamp, uuidPattern } from './validation.js';

export const canonicalJsonStringify = canonicalJson;

export function computePlanFingerprint(fields: Omit<InstallationMigrationPlan, 'planFingerprint'>): string {
  return canonicalSha256(fields);
}

export function buildMigrationPlan(params: {
  platform: NativeOs;
  architecture: NativeArch;
  legacyInstallation: LegacyInstallationFacts;
  targetOwner: 'homebrew-cask' | 'winget' | 'direct';
  targetPackage: string;
  targetVersion: string;
  candidatePath: string;
  candidateIdentity: string;
  destinationDirectory: string;
  launcherPath: string;
  transactionRoot: string;
  sourceId: string;
  sourceDigest: string;
  bindingDigest: string;
  createdAt: string;
  expiresAt: string;
  recoveryCommand: string;
  recovery?: InstallationMigrationPlan['recovery'];
}): InstallationMigrationPlan {
  const {
    platform, architecture, legacyInstallation, targetOwner, targetPackage, targetVersion, candidatePath,
    candidateIdentity, destinationDirectory, launcherPath, transactionRoot, sourceId, sourceDigest, bindingDigest,
    createdAt, expiresAt, recoveryCommand, recovery
  } = params;
  if ((platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') || (architecture !== 'arm64' && architecture !== 'x64') ||
      targetOwner === 'homebrew-cask' && platform !== 'darwin' || targetOwner === 'winget' && platform !== 'win32') {
    throw new DistributionError('Selected native owner does not support this exact host target.', 'unsupported_host');
  }
  stableVersion(targetVersion);
  stableVersion(legacyInstallation.installedVersion);
  if (legacyInstallation.owner !== 'npm' || legacyInstallation.packageName !== legacyNpmPackageName ||
      !legacyInstallation.packageRoot || !legacyInstallation.integrity || !legacyInstallation.evidenceDigest ||
      !legacyInstallation.launcherPath || !legacyInstallation.launcherPaths?.length) {
    throw new DistributionError('Migration requires the complete observed legacy npm package, artifact, prefix, and launcher identity.', 'ownership_unknown');
  }
  digest(candidateIdentity, 'Candidate identity');
  digest(bindingDigest, 'Operation binding');
  digest(sourceDigest, 'Owner-source identity');
  digest(legacyInstallation.evidenceDigest, 'Legacy owner evidence');
  timestamp(createdAt, 'Review window start');
  timestamp(expiresAt, 'Review window expiry');
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) - Date.parse(createdAt) > 60 * 60_000) {
    throw new DistributionError('Invalid installation review window.');
  }
  const targetInstallation: TargetInstallationFacts = {
    owner: targetOwner, targetPackage: text(targetPackage, 'Registered target package'), targetVersion,
    candidatePath, candidateIdentity, destinationDirectory, launcherPath, sourceId, sourceDigest
  };
  text(recoveryCommand, 'Owner-specific recovery command', 8192);
  const effects: OrderedMigrationEffect[] = [
    { step: 1, id: 'verify-unlinked-candidate', description: 'Verify registered final bytes, host, resources, runtime, and candidate startup while unlinked.', critical: true },
    { step: 2, id: 'stage-target', description: 'Checkpoint and stage the exact native payload without changing the active launcher.', critical: true },
    { step: 3, id: 'retire-legacy-package', description: 'Retire only the exact verified legacy Liftoff npm package and its observed launchers.', critical: true },
    { step: 4, id: 'install-target-owner', description: `Install or activate ${targetPackage}@${targetVersion} through the selected ${targetOwner} owner.`, critical: true },
    { step: 5, id: 'verify-target-installation', description: 'Independently verify the final owner, explicit launcher, resources, and normal command resolution.', critical: true }
  ];
  if (recovery && (!uuidPattern.test(recovery.migrationId) || typeof recovery.sourceRetired !== 'boolean' ||
      typeof recovery.targetInstalled !== 'boolean' || typeof recovery.recoverTransaction !== 'boolean')) {
    throw new DistributionError('Recovery requires the exact recorded installation identity and observed disposition.');
  }
  if (recovery) {
    digest(recovery.recordDigest, 'Recovery record digest');
    digest(recovery.originalPlanFingerprint, 'Original reviewed transaction');
  }
  const orderedEffects = [
    ...(recovery?.recoverTransaction ? [{
      step: 0, id: 'recover-original-transaction', description: 'Recover only the original sealed direct launcher/receipt transaction under its unchanged owned-path preconditions.', critical: true
    }] : []),
    ...effects.filter((effect) =>
      !(recovery?.sourceRetired && effect.id === 'retire-legacy-package') &&
      !(recovery?.targetInstalled && ['stage-target', 'install-target-owner'].includes(effect.id)))
  ].map((effect, index) => ({ ...effect, step: index + 1 }));
  const fields: Omit<InstallationMigrationPlan, 'planFingerprint'> = {
    schemaVersion: 1, createdAt, expiresAt, bindingDigest, transactionRoot, platform, architecture,
    legacyInstallation: { ...legacyInstallation, launcherPaths: [...legacyInstallation.launcherPaths], launcherConflicts: [...legacyInstallation.launcherConflicts] },
    targetInstallation, orderedEffects,
    ...(recovery ? { recovery: { ...recovery } } : {}),
    legacyRecovery: {
      packageName: legacyNpmPackageName, packageVersion: legacyInstallation.installedVersion,
      prefix: legacyInstallation.prefix, recoveryCommand
    }
  };
  return freeze({ ...fields, planFingerprint: computePlanFingerprint(fields) });
}

export function parseMigrationPlan(raw: unknown): InstallationMigrationPlan {
  const value = object(raw, [
    'schemaVersion', 'planFingerprint', 'createdAt', 'expiresAt', 'bindingDigest', 'transactionRoot', 'platform',
    'architecture', 'legacyInstallation', 'targetInstallation', 'orderedEffects', 'legacyRecovery', 'recovery'
  ], 'Installation migration plan');
  const legacy = object(value.legacyInstallation, [
    'owner', 'packageName', 'installedVersion', 'executablePath', 'prefix', 'launcherPath', 'launcherConflicts',
    'packageRoot', 'integrity', 'evidenceDigest', 'launcherPaths'
  ], 'Legacy installation');
  const target = object(value.targetInstallation, [
    'owner', 'targetPackage', 'targetVersion', 'candidatePath', 'candidateIdentity', 'destinationDirectory', 'launcherPath', 'sourceId', 'sourceDigest'
  ], 'Target installation');
  const recovery = object(value.legacyRecovery, ['packageName', 'packageVersion', 'prefix', 'recoveryCommand'], 'Legacy recovery');
  let continuation: InstallationMigrationPlan['recovery'];
  if (value.recovery !== undefined) {
    const source = object(value.recovery, [
      'migrationId', 'recordDigest', 'sourceRetired', 'targetInstalled', 'recoverTransaction', 'originalPlanFingerprint'
    ], 'Native recovery plan');
    if (typeof source.sourceRetired !== 'boolean' || typeof source.targetInstalled !== 'boolean' || typeof source.recoverTransaction !== 'boolean') {
      throw new DistributionError('Recovery requires observed source and target dispositions.');
    }
    continuation = {
      migrationId: text(source.migrationId, 'Original migration ID'), recordDigest: digest(source.recordDigest, 'Original record digest'),
      sourceRetired: source.sourceRetired, targetInstalled: source.targetInstalled, recoverTransaction: source.recoverTransaction,
      originalPlanFingerprint: digest(source.originalPlanFingerprint, 'Original approved transaction')
    };
  }
  if (value.schemaVersion !== 1 || (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux') ||
      (value.architecture !== 'arm64' && value.architecture !== 'x64') || legacy.owner !== 'npm' ||
      legacy.packageName !== legacyNpmPackageName || !Array.isArray(legacy.launcherConflicts) || !Array.isArray(legacy.launcherPaths) ||
      (target.owner !== 'direct' && target.owner !== 'homebrew-cask' && target.owner !== 'winget')) {
    throw new DistributionError('Invalid installation migration scope or owner.');
  }
  const plan = buildMigrationPlan({
    platform: value.platform, architecture: value.architecture,
    legacyInstallation: {
      owner: 'npm', packageName: legacyNpmPackageName, installedVersion: stableVersion(legacy.installedVersion),
      executablePath: text(legacy.executablePath, 'Legacy executable'), prefix: text(legacy.prefix, 'Legacy prefix'),
      launcherPath: text(legacy.launcherPath, 'Legacy launcher'), packageRoot: text(legacy.packageRoot, 'Legacy package root'),
      integrity: text(legacy.integrity, 'Legacy artifact integrity'), evidenceDigest: digest(legacy.evidenceDigest, 'Legacy evidence'),
      launcherConflicts: legacy.launcherConflicts.map((entry) => text(entry, 'Launcher conflict')),
      launcherPaths: legacy.launcherPaths.map((entry) => text(entry, 'Legacy launcher'))
    },
    targetOwner: target.owner, targetPackage: text(target.targetPackage, 'Target package'), targetVersion: stableVersion(target.targetVersion),
    candidatePath: text(target.candidatePath, 'Candidate path'), candidateIdentity: digest(target.candidateIdentity, 'Candidate identity'),
    destinationDirectory: text(target.destinationDirectory, 'Target destination'), launcherPath: text(target.launcherPath, 'Target launcher'),
    transactionRoot: text(value.transactionRoot, 'Installation transaction root'), sourceId: text(target.sourceId, 'Target source'),
    sourceDigest: digest(target.sourceDigest, 'Target source digest'), bindingDigest: digest(value.bindingDigest, 'Plan binding'),
    createdAt: timestamp(value.createdAt, 'Review window'), expiresAt: timestamp(value.expiresAt, 'Review expiry'),
    recoveryCommand: text(recovery.recoveryCommand, 'Owner-specific recovery command', 8192),
    ...(continuation ? { recovery: continuation } : {})
  });
  if (canonicalJson(raw) !== canonicalJson(plan)) throw new DistributionError('Migration plan differs from its registered ordered effects or exact fingerprint.', 'stale_plan');
  return plan;
}

export function verifyPlanIntegrity(plan: InstallationMigrationPlan): boolean {
  try { parseMigrationPlan(plan); return true; }
  catch (error) { if (error instanceof DistributionError) return false; throw error; }
}

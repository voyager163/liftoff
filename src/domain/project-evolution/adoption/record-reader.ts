import type { ManifestStandards } from '../../project/contracts.js';
import { canonicalSha256, isRecord } from '../../governance/activation/canonical-json.js';
import { manifestPathKey, manifestPortablePath } from '../../project/manifest/current.js';
import type { AdoptionEffect, AdoptionFileIdentity, AdoptionRecord } from './contracts.js';
import { validateAdoptionExecutionIdentity } from './identity.js';

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error(`${label} has missing or unknown schema-1 fields.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is not a complete SHA-256 identity.`);
  return value;
}

function fileState(value: unknown): { digest: string | null; mode: number | null } {
  const item = exact(value, ['digest', 'mode'], 'Adoption file state');
  if (item.digest === null && item.mode === null) return { digest: null, mode: null };
  if (typeof item.mode !== 'number' || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) {
    throw new Error('Adoption file state requires exact ordinary mode bits.');
  }
  return { digest: digest(item.digest, 'Adoption file'), mode: item.mode };
}

export function validateAdoptionRecord(
  value: unknown, expected: { recordId: string; standards: ManifestStandards; assessmentDigest: string }
): AdoptionRecord {
  const item = exact(value, [
    'schemaVersion', 'kind', 'cliVersion', 'adoptionContractVersion', 'recipe', 'recordId', 'projectRoot',
    'projectIdentity', 'fingerprint', 'reviewedAt', 'standards', 'assessmentDigest', 'source', 'effects',
    'verification', 'backup', 'authorization', 'manifestHash', 'activationEvidence'
  ], 'Adoption record');
  const identity = validateAdoptionExecutionIdentity({
    cliVersion: item.cliVersion, adoptionContractVersion: item.adoptionContractVersion, recipe: item.recipe
  });
  if (item.schemaVersion !== 1 || item.kind !== 'liftoff-adoption-record' || item.recordId !== expected.recordId ||
    item.assessmentDigest !== expected.assessmentDigest || canonicalSha256(item.standards) !== canonicalSha256(expected.standards) ||
    typeof item.projectRoot !== 'string' || !item.projectRoot || /[\u0000-\u001f\u007f]/u.test(item.projectRoot) ||
    typeof item.reviewedAt !== 'string' || !Number.isFinite(Date.parse(item.reviewedAt)) || item.activationEvidence !== 'not-issued') {
    throw new Error('Adoption record identity does not match the exact declared provenance.');
  }
  const projectIdentity = exact(item.projectIdentity, ['device', 'inode', 'birthtime'], 'Adoption project identity');
  if (typeof projectIdentity.device !== 'string' || !/^\d+$/u.test(projectIdentity.device) ||
    typeof projectIdentity.inode !== 'string' || !/^\d+$/u.test(projectIdentity.inode) ||
    typeof projectIdentity.birthtime !== 'string' || !/^\d+(?:\.\d+)?$/u.test(projectIdentity.birthtime)) {
    throw new Error('Adoption project identity is malformed.');
  }
  if (!Array.isArray(item.source) || item.source.length > 4096 || !Array.isArray(item.effects) || item.effects.length > 1024) {
    throw new Error('Adoption record inventories exceed the registered bounds.');
  }
  const source = item.source.map((value): AdoptionFileIdentity => {
    const file = exact(value, ['pathParts', 'digest', 'mode'], 'Adoption source');
    return { pathParts: manifestPortablePath(file.pathParts, 'Adoption source'), ...fileState({ digest: file.digest, mode: file.mode }) };
  });
  const producers: AdoptionEffect['producer'][] = [
    'application-patch', 'application-addition', 'manifest', 'desired-state', 'framework', 'managed-integration', 'adoption-record'
  ];
  const effects = item.effects.map((value): AdoptionEffect => {
    const effect = exact(value, ['producer', 'logicalName', 'type', 'pathParts', 'before', 'after'], 'Adoption effect');
    const producer = producers.find((producer) => producer === effect.producer);
    if (!producer || typeof effect.logicalName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(effect.logicalName) ||
      effect.type !== 'write' && effect.type !== 'delete' && effect.type !== 'adopt') throw new Error('Adoption effect has an unregistered producer or identity.');
    const before = fileState(effect.before), after = fileState(effect.after);
    if (effect.type === 'delete' ? after.digest !== null : after.digest === null ||
      effect.type === 'adopt' && canonicalSha256(before) !== canonicalSha256(after)) {
      throw new Error('Adoption effect is inconsistent with its before/after file states.');
    }
    return { producer, logicalName: effect.logicalName, type: effect.type, pathParts: manifestPortablePath(effect.pathParts, 'Adoption effect'), before, after };
  });
  for (const inventory of [source, effects]) {
    const paths: string[] = [];
    for (const entry of inventory) {
      const key = manifestPathKey(entry.pathParts);
      if (paths.some((previous) => previous === key || previous.startsWith(`${key}/`) || key.startsWith(`${previous}/`))) {
        throw new Error('Adoption record contains duplicate, aliased or overlapping file identities.');
      }
      paths.push(key);
    }
  }
  const fingerprint = digest(item.fingerprint, 'Adoption fingerprint');
  const verification = exact(item.verification, ['status', 'digest'], 'Adoption verification');
  if (verification.status !== 'passed' && verification.status !== 'not-required' ||
    verification.status === 'not-required' && verification.digest !== null) throw new Error('Adoption verification scope is invalid.');
  const backup = item.backup === null ? null : exact(item.backup, ['namespace', 'indexKey'], 'Adoption backup');
  if (backup && backup.namespace !== 'adoption-backup') throw new Error('Adoption backup names an unregistered recovery namespace.');
  const authorization = exact(item.authorization, ['namespace', 'fingerprint', 'boundary'], 'Adoption authorization');
  if (authorization.namespace !== 'adoption-approval' || authorization.fingerprint !== fingerprint || authorization.boundary !== 'exact-transaction-digest') {
    throw new Error('Adoption public metadata does not bind its separate external transaction authority.');
  }
  return {
    schemaVersion: 1, kind: 'liftoff-adoption-record', ...identity,
    recordId: digest(item.recordId, 'Adoption record ID'), projectRoot: item.projectRoot,
    projectIdentity: { device: projectIdentity.device, inode: projectIdentity.inode, birthtime: projectIdentity.birthtime },
    fingerprint, reviewedAt: item.reviewedAt, standards: structuredClone(expected.standards),
    assessmentDigest: digest(item.assessmentDigest, 'Adoption assessment'), source, effects,
    verification: { status: verification.status, digest: verification.status === 'passed' ? digest(verification.digest, 'Adoption verification') : null },
    backup: backup ? { namespace: 'adoption-backup', indexKey: digest(backup.indexKey, 'Adoption backup index') } : null,
    authorization: { namespace: 'adoption-approval', fingerprint, boundary: 'exact-transaction-digest' },
    manifestHash: digest(item.manifestHash, 'Adoption manifest'), activationEvidence: 'not-issued'
  };
}

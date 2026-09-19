import { deepStrictEqual } from 'node:assert/strict';
import { OPERATOR_DOCUMENTS } from './distribution/native-document-links.mjs';

// This private source-test transport is neither an npm publication nor a native release artifact.
export const PRIVATE_SOURCE_SMOKE_MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

export function assertPrivateSourcePackageSize(packResult) {
  const size = packResult.unpackedSize;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Private source-smoke package has an invalid unpacked size');
  }
  if (size > PRIVATE_SOURCE_SMOKE_MAX_UNPACKED_BYTES) {
    throw new Error(`Private source-smoke package exceeds the 20 MiB unpacked-size budget: ${size}`);
  }
}

export function assertInfrastructureDocumentation(packResult) {
  const paths = packResult.files.map((file) => file.path);
  for (const required of OPERATOR_DOCUMENTS) {
    if (!paths.includes(required)) throw new Error(`Packed package is missing ${required}`);
  }
  for (const file of paths) {
    if ((file.toLowerCase() === 'infrastructure' || file.toLowerCase().startsWith('infrastructure/')) &&
        !OPERATOR_DOCUMENTS.includes(file)) {
      throw new Error(`Packed package unexpectedly includes ${file}`);
    }
  }
}

export function assertCurrentUpgradeHelp(stdout) {
  for (const expected of [
    'verified installation owner', 'owner migration and project update are separate', '--check', '--json'
  ]) {
    if (!stdout.includes(expected)) throw new Error(`Installed liftoff upgrade help is missing ${expected}`);
  }
  if (stdout.includes('supported global npm Liftoff CLI')) {
    throw new Error('Installed liftoff upgrade help advertises historical npm replacement');
  }
}

export function assertSourcePackageUpgradeRefusal(result, mode, version) {
  deepStrictEqual(result, {
    schemaVersion: 1,
    distribution: 'native',
    mode,
    status: 'blocked',
    currentVersion: version,
    owner: 'unknown',
    upstreamAvailability: 'unknown',
    ownerAvailability: 'unknown',
    reasonCode: 'ownership_unknown',
    completedEffects: [],
    uncertainEffects: [],
    recoveryRequired: false,
    manualAction: 'Inspect actual installation ownership and PATH resolution. Routine upgrade never acquires another owner or an unlinked bundle.'
  }, 'A private source-test archive must not claim historical npm ownership or native replacement authority');
}

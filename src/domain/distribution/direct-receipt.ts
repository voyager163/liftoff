import path from 'node:path';
import {
  canonicalProductName, type DirectInstallReceipt, type NativeTarget, type NativeTargetRuntimeConstraints
} from './contracts.js';
import { DirectReceiptValidationError } from './errors.js';
import { parseNativeResources, parseNativeTarget, parseRuntimeConstraints } from './release-manifest.js';
import { digest, object, sourceCommit, stableVersion, text, timestamp, uuidPattern } from './validation.js';

export function parseDirectReceipt(raw: unknown): DirectInstallReceipt {
  const value = object(raw, [
    'schemaVersion', 'product', 'version', 'target', 'installedAt', 'sourceCommit', 'installRoot', 'versionRoot',
    'launcherPath', 'runtime', 'checksumSha256', 'authority'
  ], 'Direct installation receipt');
  if (value.schemaVersion !== 1 || value.product !== canonicalProductName) {
    throw new DirectReceiptValidationError('Direct receipt requires schema 1 and canonical Liftoff product identity.');
  }
  const target = parseNativeTarget(value.target);
  const api = target.startsWith('win32-') ? path.win32 : path.posix;
  const absolute = (input: unknown, label: string): string => {
    const result = text(input, label);
    if (!api.isAbsolute(result) || api.normalize(result) !== result || result === api.parse(result).root ||
        result.startsWith('\\\\?\\') || result.startsWith('\\\\.\\')) {
      throw new DirectReceiptValidationError(`${label} must be an unambiguous absolute native path.`);
    }
    return result;
  };
  const installRoot = absolute(value.installRoot, 'Installation root');
  const versionRoot = absolute(value.versionRoot, 'Versioned payload root');
  const launcherPath = absolute(value.launcherPath, 'Direct launcher');
  const relative = api.relative(api.join(installRoot, 'versions'), versionRoot);
  if (!relative || relative.startsWith('..') || api.isAbsolute(relative) || relative.includes(api.sep)) {
    throw new DirectReceiptValidationError('Direct payload must identify one explicit version directory under its installation root.');
  }
  let authority: DirectInstallReceipt['authority'];
  if (value.authority !== undefined) {
    const proof = object(value.authority, [
      'id', 'manifestDigest', 'provenanceDigest', 'launcherSha256', 'resources', 'transactionRoot'
    ], 'Direct receipt authority');
    if (typeof proof.id !== 'string' || !uuidPattern.test(proof.id)) throw new DirectReceiptValidationError('Invalid direct receipt authority ID.');
    authority = {
      id: proof.id, manifestDigest: digest(proof.manifestDigest, 'Native manifest identity'),
      provenanceDigest: digest(proof.provenanceDigest, 'Native provenance identity'),
      launcherSha256: digest(proof.launcherSha256, 'Direct launcher identity'),
      resources: parseNativeResources(proof.resources), transactionRoot: absolute(proof.transactionRoot, 'Transaction root')
    };
    for (const destination of [installRoot, launcherPath]) {
      const confined = api.relative(authority.transactionRoot, destination);
      if (!confined || confined === '..' || confined.startsWith(`..${api.sep}`) || api.isAbsolute(confined)) {
        throw new DirectReceiptValidationError('Direct owner destination escapes its recorded transaction boundary.');
      }
    }
  }
  return {
    schemaVersion: 1, product: canonicalProductName, version: stableVersion(value.version), target,
    installedAt: timestamp(value.installedAt, 'Direct installation time'), sourceCommit: sourceCommit(value.sourceCommit),
    installRoot, versionRoot, launcherPath, runtime: parseRuntimeConstraints(value.runtime, target),
    checksumSha256: digest(value.checksumSha256, 'Final native checksum'), ...(authority ? { authority } : {})
  };
}

export function createDirectReceipt(params: {
  version: string; target: NativeTarget; sourceCommit: string; installRoot: string; versionRoot: string;
  launcherPath: string; runtime: NativeTargetRuntimeConstraints; checksumSha256: string; installedAt?: string;
  authority?: DirectInstallReceipt['authority'];
}): DirectInstallReceipt {
  return parseDirectReceipt({
    schemaVersion: 1, product: canonicalProductName, ...params,
    installedAt: params.installedAt ?? new Date().toISOString()
  });
}

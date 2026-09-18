import { DistributionError } from '../../domain/distribution/errors.js';
import { NativeAdmission, type AdmittedNativeCandidate, type NativeAdmissionOptions } from '../../adapters/distribution/native-admission.js';
import type { NativeTargetRuntimeConstraints } from '../../domain/distribution/contracts.js';

export interface ResolvedTargetInfo {
  targetVersion: string;
  sourceCommit: string;
  checksumSha256: string;
  runtime: NativeTargetRuntimeConstraints;
  candidate: AdmittedNativeCandidate;
}

export interface ResolveTargetVersionOptions extends NativeAdmissionOptions {
  candidatePath?: string;
  entrypoint?: string;
  admission?: NativeAdmission;
}

export async function resolveTargetVersion(options: ResolveTargetVersionOptions = {}): Promise<ResolvedTargetInfo> {
  const admission = options.admission ?? new NativeAdmission(options);
  let candidatePath = options.candidatePath;
  if (!candidatePath) {
    await admission.releaseClient.trustRegistration();
    const entrypoint = options.entrypoint ?? process.argv[1];
    candidatePath = entrypoint ? await admission.findBundleRoot(entrypoint) : undefined;
  }
  if (!candidatePath) throw new DistributionError('Select a verified unlinked native bundle with --candidate, or invoke that bundle by explicit path.', 'ownership_unknown');
  const root = await admission.findBundleRoot(candidatePath);
  if (!root) throw new DistributionError('Candidate has no registered native build manifest.', 'invalid_metadata');
  const candidate = await admission.admitBundle(root);
  return {
    targetVersion: candidate.version, sourceCommit: candidate.sourceCommit, checksumSha256: candidate.archiveDigest,
    runtime: candidate.provenance.runtime, candidate
  };
}

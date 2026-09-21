import { inspectPackageArchive } from '../package-smoke-artifact.mjs';
import { canonicalDigest } from './admission.ts';
import { verifyCandidateBytes } from './npm-release.ts';
import { identifier, SecurityEvidenceError } from './evidence.ts';

/**
 * Observes actual archive files, not installed/resolved transitive graphs.
 * Deliberately does not emit a release-evidence envelope, a security verdict,
 * verifiable build provenance, attestation, or a signing claim.
 */
export function createLocalPackageRecords(
  candidateValue: unknown, bytes: Uint8Array, now: Date,
  runtime: { node: string; platform: string; architecture: string }
): Record<'packed-files.cdx.json' | 'unsigned-build-record.json', unknown> {
  const candidate = verifyCandidateBytes(candidateValue, bytes);
  if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(candidate.createdAt)) {
    throw new SecurityEvidenceError('invalid-package-record-time');
  }
  for (const value of Object.values(runtime)) identifier(value, 'invalid-package-record-runtime');
  const archive = inspectPackageArchive(Buffer.from(bytes), candidate.artifact);
  const rootRef = `pkg:npm/%40msn-control/liftoff@${candidate.artifact.version}`;
  const properties = [
    { name: 'liftoff:qualification', value: 'not-established' },
    { name: 'liftoff:scope', value: 'actual-packed-files-only' },
    { name: 'liftoff:dependency-coverage', value: 'incomplete-runtime-and-template-graphs' }
  ];
  return {
    'packed-files.cdx.json': {
      bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
      metadata: {
        timestamp: now.toISOString(),
        component: {
          type: 'application', 'bom-ref': rootRef, group: '@msn-control', name: 'liftoff',
          version: candidate.artifact.version, purl: rootRef,
          hashes: [{ alg: 'SHA-256', content: candidate.artifact.sha256.slice(7) }]
        },
        properties
      },
      components: archive.files.map((file: { path: string; sha256: string }) => ({
        type: 'file', 'bom-ref': `file:${file.path}`, name: file.path,
        hashes: [{ alg: 'SHA-256', content: file.sha256 }]
      })),
      compositions: [{ aggregate: 'incomplete', assemblies: [rootRef] }]
    },
    'unsigned-build-record.json': {
      schemaVersion: 1, kind: 'unsigned-local-build-record', generatedAt: now.toISOString(),
      candidateDigest: canonicalDigest(candidate), source: candidate.source, artifact: candidate.artifact,
      observedRuntime: runtime,
      observedOperations: ['bounded-archive-inspection', 'archive-file-hashing'],
      sourceBinding: 'candidate-descriptor-not-independent-proof',
      buildExecution: 'not-observed-by-this-record',
      verifiableProvenance: false, attestation: false, securityAssessment: false, signing: false
    }
  };
}

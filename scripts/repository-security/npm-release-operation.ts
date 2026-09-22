import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { canonicalDigest } from './admission.ts';
import { digest, parseIdentity, record, sha, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';
import {
  parseNpmCandidate, planReleaseRetry, validateReleaseQualification, verifyCandidateBytes,
  type NpmCandidate, type ReleaseObservation, type TrustedReleaseContext
} from './npm-release.ts';
import { publicationEventDecision, verifyTagProtectionBoundary, type TagRuleset } from './tag-policy.ts';
import { verifyReleaseChecksums } from './github-release.ts';

export const releaseProducerDependencies = Object.freeze([
  'authenticated-protected-main-and-current-run-readback',
  'authenticated-release-producer-receipts-under-adopted-policy',
  'complete-packed-runtime-and-template-component-sbom',
  'verifiable-build-provenance-distinct-from-unsigned-local-record',
  'current-complete-vulnerability-and-secrets-verdicts',
  'qualified-publisher-identity-environment-oidc-and-tag-authority-readback',
  'authenticated-read-only-canonical-verification-receipt'
]);

export interface PublisherAuthority {
  identity: EvidenceIdentity;
  sourceRef: 'refs/heads/main';
  mainProtected: true;
  environment: 'npm-publisher';
  requiredReviewers: 0;
  appId: number;
  repositoryScope: ['voyager163/liftoff'];
  nonpublisherDenied: true;
  npmTrustedPublisher: { repository: 'voyager163/liftoff'; workflow: '.github/workflows/release.yml'; environment: 'npm-publisher' };
  tagRulesets: TagRuleset[];
  immutableReleasesEnabled: true;
  observedAt: string;
  validUntil: string;
}

export interface ReleaseOperation {
  readonly kind: 'release-operation-data';
}

interface OperationState {
  candidate: NpmCandidate;
  tarball: Uint8Array;
  evidence: unknown;
  payloads: Map<string, Uint8Array>;
  expected: TrustedReleaseContext;
  assets: Map<string, Uint8Array>;
  authority: PublisherAuthority;
}
const operations = new WeakMap<ReleaseOperation, OperationState>();
const verifiedProvenance = new WeakSet<object>();
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fail(code: string): never { throw new SecurityEvidenceError(`release-operation-${code}`); }

/**
 * Consume a real verifier result, not candidate-authored provenance JSON.
 * Execution injection is for tests; the CLI always invokes gh itself and never
 * enrolls a signer, signs, uploads, or treats provenance as a security verdict.
 */
export async function verifyReleaseProvenance(
  input: { candidate: unknown; tarballPath: string; bundlePath: string;
    identity: Pick<EvidenceIdentity, 'repository' | 'event' | 'sourceSha' | 'workflowSha' | 'runId' | 'attempt'> },
  now: Date,
  execute: (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string> = spawnSync
) {
  const candidate = parseNpmCandidate(input.candidate);
  record(input.identity, ['repository', 'event', 'sourceSha', 'workflowSha', 'runId', 'attempt'], 'provenance-identity');
  const identity = { ...input.identity, sourceSha: sha(input.identity.sourceSha), workflowSha: sha(input.identity.workflowSha) };
  if (!/^[1-9][0-9]{0,29}$/.test(identity.runId) || !Number.isSafeInteger(identity.attempt) ||
      identity.attempt < 1 || identity.attempt > 999999 || !Number.isFinite(now.getTime())) fail('provenance-identity');
  if (candidate.source.dirty || identity.repository !== 'voyager163/liftoff' ||
      identity.event !== 'workflow_dispatch' || identity.sourceSha !== candidate.source.commit ||
      now.getTime() < timestamp(candidate.createdAt) ||
      now.getTime() - timestamp(candidate.createdAt) > 86_400_000) fail('provenance-source');
  const snapshot = async (file: string, maximum: number) => {
    if (!path.isAbsolute(file) || /[\0\r\n]/.test(file)) fail('provenance-file');
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n ||
        before.size > BigInt(maximum) || await realpath(file) !== file) fail('provenance-file');
    const bytes = await readFile(file), after = await lstat(file, { bigint: true });
    const fields = ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'] as const;
    if (BigInt(bytes.length) !== before.size || fields.some(field => after[field] !== before[field]) ||
        await realpath(file) !== file) fail('provenance-file-drift');
    return { bytes, digest: hash(bytes), stamp: fields.map(field => String(before[field])).join(':') };
  };
  let archive: Awaited<ReturnType<typeof snapshot>>, bundle: Awaited<ReturnType<typeof snapshot>>;
  try {
    archive = await snapshot(input.tarballPath, 32 * 1024 * 1024);
    bundle = await snapshot(input.bundlePath, 4 * 1024 * 1024);
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('provenance-file-unavailable');
  }
  verifyCandidateBytes(candidate, archive.bytes);
  const repository = 'https://github.com/voyager163/liftoff';
  const workflow = `${repository}/.github/workflows/release.yml@refs/heads/main`;
  const args = [
    'attestation', 'verify', input.tarballPath, '--bundle', input.bundlePath, '--repo', 'voyager163/liftoff',
    '--hostname', 'github.com', '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
    '--cert-identity', workflow, '--signer-digest', identity.workflowSha,
    '--source-digest', candidate.source.commit, '--source-ref', 'refs/heads/main',
    '--deny-self-hosted-runners', '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json'
  ];
  const observed = (() => {
    try {
      return execute('gh', args, {
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat',
          GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' }
      });
    } catch { return fail('provenance-verifier-failed'); }
  })();
  if (observed.error || observed.status !== 0 || observed.signal !== null || typeof observed.stdout !== 'string') {
    fail('provenance-verifier-failed');
  }
  try {
    const afterArchive = await snapshot(input.tarballPath, 32 * 1024 * 1024);
    const afterBundle = await snapshot(input.bundlePath, 4 * 1024 * 1024);
    if (archive.digest !== afterArchive.digest || archive.stamp !== afterArchive.stamp ||
        bundle.digest !== afterBundle.digest || bundle.stamp !== afterBundle.stamp) fail('provenance-file-drift');
    const values: unknown = JSON.parse(observed.stdout);
    if (!Array.isArray(values) || values.length !== 1) fail('provenance-verifier-shape');
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provenance-verifier-shape');
      return value as Record<string, unknown>;
    };
    const result = object(object(values[0]).verificationResult);
    const certificate = object(object(result.signature).certificate);
    const required = {
      issuer: 'https://token.actions.githubusercontent.com', subjectAlternativeName: workflow,
      buildSignerURI: workflow, buildSignerDigest: identity.workflowSha, runnerEnvironment: 'github-hosted',
      sourceRepositoryURI: repository, sourceRepositoryDigest: candidate.source.commit,
      sourceRepositoryRef: 'refs/heads/main', buildConfigURI: workflow, buildConfigDigest: identity.workflowSha,
      buildTrigger: 'workflow_dispatch',
      runInvocationURI: `${repository}/actions/runs/${identity.runId}/attempts/${identity.attempt}`,
      sourceRepositoryVisibilityAtSigning: 'public'
    };
    if (Object.entries(required).some(([field, value]) => certificate[field] !== value)) fail('provenance-certificate-identity');
    const statement = object(result.statement);
    if (statement._type !== 'https://in-toto.io/Statement/v1' ||
        statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
        !Array.isArray(statement.subject) || statement.subject.length !== 1) fail('provenance-statement');
    const subject = object(statement.subject[0]), digests = object(subject.digest);
    if (subject.name !== candidate.artifact.filename || digests.sha256 !== candidate.artifact.sha256.slice(7)) fail('provenance-subject');
    const predicate = object(statement.predicate), definition = object(predicate.buildDefinition);
    const parameters = object(object(definition.externalParameters).workflow), run = object(predicate.runDetails);
    if (definition.buildType !== 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1' ||
        parameters.repository !== repository || parameters.ref !== 'refs/heads/main' ||
        parameters.path !== '.github/workflows/release.yml' ||
        object(object(definition.internalParameters).github).event_name !== 'workflow_dispatch' ||
        object(run.builder).id !== 'https://github.com/actions/runner/github-hosted' ||
        object(run.metadata).invocationId !== required.runInvocationURI ||
        !Array.isArray(definition.resolvedDependencies) || definition.resolvedDependencies.length > 100) {
      fail('provenance-build-definition');
    }
    const sources = definition.resolvedDependencies.map(object).filter(value =>
      value.uri === `git+${repository}@refs/heads/main`);
    if (sources.length !== 1 || object(sources[0]!.digest).gitCommit !== candidate.source.commit) fail('provenance-build-source');
    if (!Array.isArray(result.verifiedTimestamps) || !result.verifiedTimestamps.length ||
        result.verifiedTimestamps.length > 8) fail('provenance-witness');
    const witnessed = result.verifiedTimestamps.map(value => {
      const stamp = object(value).timestamp;
      if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) fail('provenance-witness');
      const time = Date.parse(stamp);
      if (time < timestamp(candidate.createdAt) || time > now.getTime() || now.getTime() - time > 86_400_000) fail('provenance-stale-witness');
      return new Date(time).toISOString();
    });
    const observation = Object.freeze({
      kind: 'verified-release-provenance-observation' as const,
      candidateDigest: canonicalDigest(candidate), artifactDigest: candidate.artifact.sha256,
      bundleDigest: bundle.digest, verificationOutputDigest: hash(Buffer.from(observed.stdout)),
      identity: Object.freeze(identity), witnessedAt: Object.freeze(witnessed.sort()), verifiedAt: now.toISOString(),
      verifiedBy: 'gh-attestation-verify' as const,
      certificateIdentityMatched: true, currentRunMatched: true, securityVerdict: 'not-established' as const,
      publisherAuthority: 'not-established' as const, publicationAuthorized: false as const
    });
    verifiedProvenance.add(observation);
    return observation;
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('provenance-result-invalid');
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-time');
  return Date.parse(value as string);
}

function requireAuthority(authority: PublisherAuthority, expected: TrustedReleaseContext, now: Date) {
  record(authority, [
    'identity', 'sourceRef', 'mainProtected', 'environment', 'requiredReviewers', 'appId', 'repositoryScope',
    'nonpublisherDenied', 'npmTrustedPublisher', 'tagRulesets', 'immutableReleasesEnabled', 'observedAt', 'validUntil'
  ], 'invalid-publisher-authority');
  if (canonicalDigest(parseIdentity(authority.identity)) !== canonicalDigest(parseIdentity(expected.identity)) ||
      authority.sourceRef !== 'refs/heads/main' || authority.mainProtected !== true ||
      authority.environment !== 'npm-publisher' || authority.requiredReviewers !== 0 ||
      canonicalDigest(authority.repositoryScope) !== canonicalDigest(['voyager163/liftoff']) ||
      authority.nonpublisherDenied !== true || authority.immutableReleasesEnabled !== true ||
      canonicalDigest(authority.npmTrustedPublisher) !== canonicalDigest({
        repository: 'voyager163/liftoff', workflow: '.github/workflows/release.yml', environment: 'npm-publisher'
      })) fail('publisher-readback-mismatch');
  verifyTagProtectionBoundary(authority.tagRulesets, authority.appId);
  const observed = timestamp(authority.observedAt), expiry = timestamp(authority.validUntil);
  if (!Number.isFinite(now.getTime()) || observed > now.getTime() || expiry <= now.getTime() ||
      now.getTime() - observed > 86_400_000 || expiry > observed + 86_400_000) fail('stale-publisher-readback');
}

/**
 * Trusted adapter boundary, not a JSON-bundle loader. The caller must obtain
 * context/authority and receipts independently of candidate assertions. The
 * CLI intentionally has no such adapter until real producers are qualified.
 */
export function prepareReleaseOperation(
  input: {
    candidate: unknown; tarball: Uint8Array; evidence: unknown;
    payloads: ReadonlyMap<string, Uint8Array>; expected: TrustedReleaseContext;
    assets: ReadonlyMap<string, Uint8Array>; authority: PublisherAuthority;
  },
  now: Date
): ReleaseOperation {
  if (input.assets.size < 1 || input.assets.size > 100 ||
      [...input.assets.values()].some(bytes => bytes.byteLength < 1 || bytes.byteLength > 32 * 1024 * 1024) ||
      [...input.assets.values()].reduce((size, bytes) => size + bytes.byteLength, 0) > 64 * 1024 * 1024) fail('asset-size-bound');
  if (input.payloads.size < 1 || input.payloads.size > 5 ||
      [...input.payloads.values()].some(bytes => bytes.byteLength < 1 || bytes.byteLength > 4 * 1024 * 1024)) fail('payload-size-bound');
  const state: OperationState = {
    candidate: parseNpmCandidate(structuredClone(input.candidate)),
    tarball: Uint8Array.from(input.tarball), evidence: structuredClone(input.evidence),
    payloads: new Map([...input.payloads].map(([key, bytes]) => [key, Uint8Array.from(bytes)])),
    expected: structuredClone(input.expected),
    assets: new Map([...input.assets].map(([key, bytes]) => [key, Uint8Array.from(bytes)])),
    authority: structuredClone(input.authority)
  };
  validateReleaseQualification(state.candidate, state.tarball, state.evidence, state.payloads, state.expected, now);
  verifyReleaseChecksums(state.assets);
  requireAuthority(state.authority, state.expected, now);
  if (state.assets.size !== state.expected.assets.length ||
      state.expected.assets.some(asset => !state.assets.has(asset.name) || hash(state.assets.get(asset.name)!) !== digest(asset.digest)) ||
      hash(state.assets.get(state.candidate.artifact.filename) ?? new Uint8Array()) !== state.candidate.artifact.sha256) fail('asset-bytes-mismatch');
  const handle: ReleaseOperation = Object.freeze({ kind: 'release-operation-data' });
  operations.set(handle, state);
  return handle;
}

export interface CanonicalReleaseReceipt {
  kind: 'canonical-installed-verification';
  identity: EvidenceIdentity;
  candidateDigest: string;
  integrity: string;
  registry: 'https://registry.npmjs.org';
  producerJob: 'canonical-verify';
  permissions: { contents: 'read' };
  environment: null;
  commands: ['help', 'upgrade-help', 'version', 'plan'];
  completedAt: string;
}

/** No production transport is installed. Tests supply an in-memory fake only. */
export interface ReleaseTransport {
  readState(): Promise<ReleaseObservation>;
  createTag(name: string, commit: string): Promise<void>;
  createDraft(tag: string, commit: string): Promise<void>;
  uploadMissingAsset(name: string, bytes: Uint8Array): Promise<void>;
  publishExactNpm(candidate: NpmCandidate, bytes: Uint8Array): Promise<void>;
  publishDraft(): Promise<void>;
}

export type ReleasePhase = 'assemble' | 'npm' | 'finalize';
export interface PhaseOutcome {
  phase: ReleasePhase;
  status: 'completed' | 'blocked';
  effectsCompleted: string[];
  effectsAttempted: string[];
  lastObservation: ReleaseObservation | null;
}
export class ReleasePhaseError extends Error {
  readonly outcome: PhaseOutcome;
  constructor(outcome: PhaseOutcome) {
    super(`Release ${outcome.phase} blocked; retain completed effects and reconcile readback before retry.`);
    this.outcome = outcome;
  }
}

export function npmPublicationArguments(candidateValue: unknown, tarballPath: string): string[] {
  const candidate = parseNpmCandidate(candidateValue);
  if (!path.isAbsolute(tarballPath) || /[\0\r\n]/.test(tarballPath) ||
      path.basename(tarballPath) !== candidate.artifact.filename) fail('invalid-tarball-path');
  return ['publish', tarballPath, '--ignore-scripts', '--access', 'public', '--provenance',
    '--registry=https://registry.npmjs.org', '--@msn-control:registry=https://registry.npmjs.org',
    '--tag', candidate.distTag];
}

/**
 * Three explicit stages in the SAME release workflow. There is deliberately
 * no installed-code verification callback here: that runs in a separate,
 * read-only job with no publisher environment or OIDC/installation authority.
 */
export async function executeReleasePhase(
  handle: ReleaseOperation, phase: ReleasePhase, transport: ReleaseTransport, now: () => Date,
  canonical?: { receipt: CanonicalReleaseReceipt; independentlyVerifiedDigest: string }
): Promise<PhaseOutcome> {
  const state = operations.get(handle);
  if (!state || !['assemble', 'npm', 'finalize'].includes(phase)) fail('unverified-operation');
  const outcome: PhaseOutcome = { phase, status: 'blocked', effectsCompleted: [], effectsAttempted: [], lastObservation: null };
  const fresh = () => {
    validateReleaseQualification(state.candidate, state.tarball, state.evidence, state.payloads, state.expected, now());
    requireAuthority(state.authority, state.expected, now());
    verifyCandidateBytes(state.candidate, state.tarball);
  };
  const read = async () => {
    fresh();
    const observation = await transport.readState();
    fresh();
    if (planReleaseRetry(state.candidate, state.expected.assets, observation).state === 'blocked') fail('readback-conflict-forward-correction-required');
    outcome.lastObservation = structuredClone(observation);
    return observation;
  };
  const completeAssets = (value: ReleaseObservation) =>
    value.github !== null && value.github.assets.length === state.expected.assets.length &&
    state.expected.assets.every(asset => value.github!.assets.some(actual => actual.name === asset.name && actual.digest === asset.digest));
  const effect = async (name: string, action: () => Promise<void>) => {
    fresh();
    outcome.effectsAttempted.push(name);
    await action();
    outcome.effectsCompleted.push(name);
  };
  try {
    let observed = await read();
    if (phase === 'assemble') {
      if (!observed.tag) {
        await effect('tag-created', () => transport.createTag(state.candidate.releaseTag, state.candidate.source.commit));
        observed = await read();
        if (!observed.tag) fail('tag-readback-missing');
      }
      if (!observed.github) {
        await effect('draft-created', () => transport.createDraft(state.candidate.releaseTag, state.candidate.source.commit));
        observed = await read();
        if (!observed.github || observed.github.state !== 'draft') fail('draft-readback-missing');
      }
      for (const asset of state.expected.assets) {
        observed = await read();
        if (observed.github?.assets.some(actual => actual.name === asset.name)) continue;
        if (observed.github?.state !== 'draft') fail('immutable-asset-missing');
        await effect(`asset-uploaded:${asset.name}`, () =>
          transport.uploadMissingAsset(asset.name, Uint8Array.from(state.assets.get(asset.name)!)));
        observed = await read();
        if (!observed.github?.assets.some(actual => actual.name === asset.name && actual.digest === asset.digest)) fail('asset-readback-missing');
      }
      if (!completeAssets(observed)) fail('incomplete-draft');
    } else if (phase === 'npm') {
      if (!observed.tag || !completeAssets(observed)) fail('complete-draft-required-before-npm');
      if (!observed.npm) {
        await effect('npm-published', () => transport.publishExactNpm(structuredClone(state.candidate), Uint8Array.from(state.tarball)));
        observed = await read();
        if (!observed.npm) fail('npm-readback-missing');
      }
    } else {
      if (!observed.npm || !observed.tag || !completeAssets(observed)) fail('incomplete-publication');
      const receipt = canonical?.receipt;
      if (!receipt || canonicalDigest(receipt) !== digest(canonical!.independentlyVerifiedDigest) ||
          receipt.kind !== 'canonical-installed-verification' ||
          canonicalDigest(parseIdentity(receipt.identity)) !== canonicalDigest(state.expected.identity) ||
          receipt.candidateDigest !== canonicalDigest(state.candidate) || receipt.integrity !== state.candidate.artifact.integrity ||
          receipt.registry !== 'https://registry.npmjs.org' || receipt.producerJob !== 'canonical-verify' ||
          canonicalDigest(receipt.permissions) !== canonicalDigest({ contents: 'read' }) || receipt.environment !== null ||
          canonicalDigest(receipt.commands) !== canonicalDigest(['help', 'upgrade-help', 'version', 'plan']) ||
          timestamp(receipt.completedAt) < Date.parse(state.candidate.createdAt) ||
          timestamp(receipt.completedAt) > now().getTime() || now().getTime() - timestamp(receipt.completedAt) > 86_400_000) fail('canonical-receipt-required');
      if (observed.github!.state === 'draft') {
        await effect('github-release-published', () => transport.publishDraft());
        observed = await read();
      }
      if (observed.github?.state !== 'published' || observed.github.immutable !== true || !completeAssets(observed)) fail('immutable-readback-required');
    }
    return { ...outcome, status: 'completed' };
  } catch {
    // Never expose arbitrary transport output or silently roll back completed effects.
    throw new ReleasePhaseError(outcome);
  }
}

/**
 * Real workflow preflight. It can report candidate/dry-run progress, but cannot
 * create a trusted context from files produced by the candidate itself.
 * No authenticated producer/authority adapter exists in the current baseline.
 */
export function releaseReadiness(
  candidateValue: unknown, feasibility: unknown,
  invocation: { event: 'workflow_dispatch' | 'push' | 'pull_request'; ref: string; dryRun: boolean; sourceSha: string;
    workflowSha?: string; runId?: string; attempt?: number },
  provenance?: Awaited<ReturnType<typeof verifyReleaseProvenance>>, now = new Date()
) {
  const candidate = parseNpmCandidate(candidateValue);
  const request = publicationEventDecision(invocation.event, invocation.ref, invocation.dryRun);
  const blockers: string[] = [];
  if (candidate.source.dirty) blockers.push('dirty-source');
  if (candidate.source.commit !== invocation.sourceSha) blockers.push('source-mismatch');
  if (invocation.ref !== 'refs/heads/main' || invocation.event !== 'workflow_dispatch') blockers.push('unapproved-publication-event');
  if (feasibility === null || typeof feasibility !== 'object' ||
      !('status' in feasibility) || feasibility.status !== 'qualified') blockers.push('publisher-feasibility-unqualified');
  // These are real unresolved integration dependencies, not green placeholders.
  if (provenance && (!verifiedProvenance.has(provenance) || provenance.candidateDigest !== canonicalDigest(candidate) ||
      provenance.artifactDigest !== candidate.artifact.sha256 || provenance.identity.sourceSha !== invocation.sourceSha ||
      provenance.identity.workflowSha !== invocation.workflowSha || provenance.identity.runId !== invocation.runId ||
      provenance.identity.attempt !== invocation.attempt || !Number.isFinite(now.getTime()) ||
      now.getTime() < timestamp(provenance.verifiedAt) || now.getTime() - timestamp(candidate.createdAt) > 86_400_000)) {
    fail('unverified-provenance-observation');
  }
  blockers.push(...releaseProducerDependencies.filter(dependency =>
    !provenance || dependency !== 'verifiable-build-provenance-distinct-from-unsigned-local-record'));
  return {
    kind: 'release-readiness' as const, publicationRequested: request.publicationRequested,
    publicationAuthorized: false as const, candidateDigest: canonicalDigest(candidate),
    provenanceVerified: provenance !== undefined, blockers
  };
}

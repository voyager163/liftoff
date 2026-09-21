import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalDigest } from './admission.ts';
import { digest, parseIdentity, record, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';
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
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fail(code: string): never { throw new SecurityEvidenceError(`release-operation-${code}`); }

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
  invocation: { event: 'workflow_dispatch' | 'push' | 'pull_request'; ref: string; dryRun: boolean; sourceSha: string }
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
  blockers.push(...releaseProducerDependencies);
  return {
    kind: 'release-readiness' as const, publicationRequested: request.publicationRequested,
    publicationAuthorized: false as const, candidateDigest: canonicalDigest(candidate), blockers
  };
}

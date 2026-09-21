import { createHash } from 'node:crypto';
import { canonicalDigest } from './admission.ts';
import {
  digest, identifier, parseIdentity, portableParts, record, SecurityEvidenceError, sha, text,
  type EvidenceIdentity
} from './evidence.ts';

const roles = ['functional', 'sbom', 'provenance', 'vulnerabilities', 'secrets'] as const;
type ReleaseRole = typeof roles[number];
const canonicalRegistry = 'https://registry.npmjs.org';
const packageName = '@msn-control/liftoff';
const maximumAge = 86_400_000;

export interface NpmCandidate {
  schemaVersion: 1;
  kind: 'npm-release-candidate';
  source: { commit: string; tree: string; inputsDigest: string; dirty: boolean };
  artifact: { name: string; version: string; filename: string; size: number; sha256: string; integrity: string };
  releaseTag: string;
  distTag: 'latest' | 'next';
  createdAt: string;
}

export interface ReleaseProducer {
  workflow: string[];
  job: string;
  tool: { name: string; version: string; database: string };
}

export interface ReleaseEvidence {
  schemaVersion: 1;
  kind: 'release-evidence';
  role: ReleaseRole;
  identity: EvidenceIdentity;
  producer: ReleaseProducer;
  candidateDigest: string;
  artifactDigest: string;
  assetsDigest: string;
  generatedAt: string;
  completedAt: string;
  validUntil: string;
  complete: true;
  verdict: 'passed';
  coverage: { id: string; digest: string }[];
  payloadDigest: string;
}

export interface ReleaseAsset {
  name: string;
  digest: string;
}

/**
 * Loaded by the trusted coordinator, NOT from the candidate/report bundle. Producer
 * authentication, adopted-policy evaluation and SBOM/provenance parsing happen
 * before this boundary; matching metadata is not cryptographic producer proof.
 */
export interface TrustedReleaseContext {
  identity: EvidenceIdentity;
  sourceRef: 'refs/heads/main';
  protectedMainCommit: string;
  candidateDigest: string;
  assets: ReleaseAsset[];
  evidence: {
    role: ReleaseRole;
    producer: ReleaseProducer;
    reportDigest: string;
    payloadDigest: string;
    coverage: { id: string; digest: string }[];
  }[];
}

function fail(code: string): never { throw new SecurityEvidenceError(`release-${code}`); }

function rejectAdmission(value: unknown): void {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'pull-request-admission') {
    fail('admission-is-not-qualification');
  }
}

function time(value: unknown): number {
  const input = text(value, 'release-invalid-time', 30);
  const stamp = Date.parse(input);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString() !== input) fail('invalid-time');
  return stamp;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid-integer');
  return value;
}

function list(value: unknown, minimum = 1, maximum = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail('invalid-list');
  return value;
}

function unique(values: string[]): void {
  if (new Set(values.map(value => value.toLowerCase())).size !== values.length) fail('duplicate-identity');
}

export function npmIntegrity(value: unknown): string {
  const input = text(value, 'release-invalid-integrity', 100);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(input) ||
      `sha512-${Buffer.from(input.slice(7), 'base64').toString('base64')}` !== input) fail('invalid-integrity');
  return input;
}

export function artifactHashes(bytes: Uint8Array): { sha256: string; integrity: string } {
  if (bytes.byteLength < 1 || bytes.byteLength > 32 * 1024 * 1024) fail('artifact-size');
  return {
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  };
}

function filename(value: unknown): string {
  const parts = portableParts([value]);
  if (parts[0]!.startsWith('.')) fail('invalid-filename');
  return parts[0]!;
}

function coverage(value: unknown): { id: string; digest: string }[] {
  const result = list(value).map(value => {
    const item = record(value, ['id', 'digest'], 'release-invalid-coverage');
    return { id: identifier(item.id, 'release-invalid-component'), digest: digest(item.digest) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  unique(result.map(item => item.id));
  return result;
}

function producer(value: unknown): ReleaseProducer {
  const item = record(value, ['workflow', 'job', 'tool'], 'release-invalid-producer');
  const tool = record(item.tool, ['name', 'version', 'database'], 'release-invalid-tool');
  return {
    workflow: portableParts(item.workflow), job: identifier(item.job, 'release-invalid-job'),
    tool: {
      name: identifier(tool.name, 'release-invalid-tool'),
      version: identifier(tool.version, 'release-invalid-tool-version'),
      database: identifier(tool.database, 'release-missing-database')
    }
  };
}

export function parseNpmCandidate(value: unknown): NpmCandidate {
  rejectAdmission(value);
  const item = record(value, [
    'schemaVersion', 'kind', 'source', 'artifact', 'releaseTag', 'distTag', 'createdAt'
  ], 'release-invalid-candidate');
  if (item.schemaVersion !== 1 || item.kind !== 'npm-release-candidate') fail('invalid-candidate');
  const source = record(item.source, ['commit', 'tree', 'inputsDigest', 'dirty'], 'release-invalid-source');
  if (typeof source.dirty !== 'boolean') fail('invalid-source');
  const artifact = record(item.artifact, [
    'name', 'version', 'filename', 'size', 'sha256', 'integrity'
  ], 'release-invalid-artifact');
  const version = text(artifact.version, 'release-invalid-version', 256);
  const numeric = '(?:0|[1-9]\\d*)';
  const pre = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
  if (!new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(version) ||
      !version.split(/[+-]/, 1)[0]!.split('.').every(part => Number.isSafeInteger(Number(part)))) fail('invalid-version');
  const distTag = version.split('+', 1)[0]!.includes('-') ? 'next' : 'latest';
  if (artifact.name !== packageName || item.releaseTag !== `v${version}` || item.distTag !== distTag) fail('identity-mismatch');
  const archive = filename(artifact.filename);
  if (archive !== `msn-control-liftoff-${version}.tgz`) fail('artifact-filename');
  time(item.createdAt);
  return {
    schemaVersion: 1, kind: 'npm-release-candidate',
    source: { commit: sha(source.commit), tree: sha(source.tree), inputsDigest: digest(source.inputsDigest), dirty: source.dirty },
    artifact: { name: packageName, version, filename: archive, size: integer(artifact.size, 1, 32 * 1024 * 1024),
      sha256: digest(artifact.sha256), integrity: npmIntegrity(artifact.integrity) },
    releaseTag: `v${version}`, distTag, createdAt: item.createdAt as string
  };
}

export function verifyCandidateBytes(value: unknown, bytes: Uint8Array): NpmCandidate {
  const candidate = parseNpmCandidate(value);
  const hashes = artifactHashes(bytes);
  if (candidate.artifact.size !== bytes.byteLength || hashes.sha256 !== candidate.artifact.sha256 ||
      hashes.integrity !== candidate.artifact.integrity) fail('artifact-substitution');
  return candidate;
}

function assets(value: unknown): ReleaseAsset[] {
  const result = list(value, 1, 100).map(value => {
    const item = record(value, ['name', 'digest'], 'release-invalid-asset');
    return { name: filename(item.name), digest: digest(item.digest) };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  unique(result.map(item => item.name));
  return result;
}

function requireReleaseSecrets(
  value: unknown, candidate: NpmCandidate, identity: EvidenceIdentity, now: Date
): void {
  const sourceCommit = candidate.source.commit;
  if (value !== null && typeof value === 'object' && 'kind' in value &&
      value.kind === 'fresh-adopted-source-secrets-evidence') {
    const item = record(value, [
      'schemaVersion', 'kind', 'identity', 'candidateDigest', 'artifactDigest', 'sourceCommit', 'sourceReportDigest',
      'scopeDigest', 'startedAt', 'completedAt', 'adoptedPolicyCommit', 'adoptedPolicyDigest', 'complete',
      'findingPolicy', 'observedFindings', 'blockedFindings', 'policyDiagnostics', 'confirmedUnremediated',
      'currentTreeComplete', 'declaredHistoryComplete', 'cleanup', 'admissionEvidenceUsed', 'publicationAuthorized'
    ], 'release-invalid-fresh-secrets');
    if (item.schemaVersion !== 1 || canonicalDigest(parseIdentity(item.identity)) !== canonicalDigest(identity) ||
        item.candidateDigest !== canonicalDigest(candidate) || item.artifactDigest !== candidate.artifact.sha256 ||
        item.sourceCommit !== sourceCommit || item.adoptedPolicyCommit !== sourceCommit || identity.baseSha !== sourceCommit ||
        item.adoptedPolicyDigest !== identity.policyDigest || item.complete !== true ||
        item.findingPolicy !== 'passed' || item.blockedFindings !== 0 || item.policyDiagnostics !== 0 ||
        item.confirmedUnremediated !== 0 || item.currentTreeComplete !== true || item.declaredHistoryComplete !== true ||
        item.cleanup !== 'completed' || item.admissionEvidenceUsed !== false || item.publicationAuthorized !== false) {
      fail('unqualified-secrets');
    }
    digest(item.sourceReportDigest); digest(item.scopeDigest);
    integer(item.observedFindings, 0, 20_000);
    const started = time(item.startedAt), completed = time(item.completedAt);
    if (started < time(candidate.createdAt) || completed < started || completed > now.getTime() ||
        now.getTime() - started > maximumAge) fail('stale-secrets');
    return;
  }
  const item = record(value, [
    'schemaVersion', 'assessment', 'gate', 'protection', 'evidenceDigest', 'policyDigest', 'sourceCommit',
    'coverage', 'findings', 'counts'
  ], 'release-invalid-secrets-result');
  if (item.schemaVersion !== 1 || item.assessment !== 'qualified' || item.gate !== 'passed' ||
      item.protection !== 'not-established' || item.sourceCommit !== sourceCommit ||
      !/^[a-f0-9]{64}$/.test(String(item.evidenceDigest)) || !/^[a-f0-9]{64}$/.test(String(item.policyDigest))) fail('unqualified-secrets');
  const scopes = list(item.coverage, 1, 500).map(value => {
    const scope = record(value, ['scopeIndex', 'status', 'qualified'], 'release-invalid-secret-scope');
    if (scope.status !== 'complete' || scope.qualified !== true) fail('incomplete-secrets-coverage');
    return String(integer(scope.scopeIndex, 0, 10_000));
  });
  unique(scopes);
  const states = ['unresolved', 'confirmed-awaiting-remediation', 'false-positive', 'nonfunctional-fixture', 'remediated'];
  const counts = record(item.counts, states, 'release-invalid-secret-counts');
  const findings = list(item.findings, 0, 20_000).map(value => {
    const finding = record(value, [
      'id', 'ruleIndex', 'locationIndex', 'line', 'column', 'endLine', 'endColumn', 'commit', 'state', 'blocking'
    ], 'release-invalid-secret-finding');
    if (!states.includes(String(finding.state)) || finding.blocking !== false) fail('blocking-secret-finding');
    return finding;
  });
  for (const state of states) {
    if (integer(counts[state], 0, 20_000) !== findings.filter(finding => finding.state === state).length) fail('secret-count-mismatch');
  }
  if (counts.unresolved !== 0 || counts['confirmed-awaiting-remediation'] !== 0) fail('unresolved-secret-exposure');
}

/**
 * Validates exact bytes and the *current* trusted producer receipts. Does not
 * scan, create an SBOM, sign, authenticate a workflow, or authorize publication.
 * Payloads are actual retained report bytes; fixtures exercise logic only.
 */
export function validateReleaseQualification(
  candidateValue: unknown,
  tarball: Uint8Array,
  evidenceValues: unknown,
  payloads: ReadonlyMap<string, Uint8Array>,
  expected: TrustedReleaseContext,
  now: Date
): { kind: 'validated-release-data'; candidateDigest: string; assetsDigest: string } {
  rejectAdmission(evidenceValues);
  const candidate = verifyCandidateBytes(candidateValue, tarball);
  const identity = parseIdentity(expected.identity);
  if (candidate.source.dirty || expected.sourceRef !== 'refs/heads/main' ||
      sha(expected.protectedMainCommit) !== candidate.source.commit || identity.sourceSha !== candidate.source.commit ||
      identity.repository !== 'voyager163/liftoff' || !['push', 'workflow_dispatch'].includes(identity.event)) fail('unqualified-source');
  const candidateDigest = canonicalDigest(candidate);
  if (candidateDigest !== digest(expected.candidateDigest)) fail('candidate-mismatch');
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || time(candidate.createdAt) > nowMs || nowMs - time(candidate.createdAt) > maximumAge) fail('stale-candidate');
  const required = list(expected.evidence, roles.length, roles.length);
  const reports = list(evidenceValues, roles.length, roles.length);
  const expectedAssets = assets(expected.assets);
  const assetsDigest = canonicalDigest(expectedAssets);
  const seen: string[] = [];
  unique(expected.evidence.map(item => item.role));
  if (roles.some(role => !expected.evidence.some(item => item.role === role))) fail('missing-role');
  for (const value of reports) {
    rejectAdmission(value);
    const item = record(value, [
      'schemaVersion', 'kind', 'role', 'identity', 'producer', 'candidateDigest', 'artifactDigest', 'assetsDigest',
      'generatedAt', 'completedAt', 'validUntil', 'complete', 'verdict', 'coverage', 'payloadDigest'
    ], 'release-invalid-evidence');
    if (item.schemaVersion !== 1 || item.kind !== 'release-evidence' || item.complete !== true || item.verdict !== 'passed') fail('incomplete-evidence');
    const trusted = required.find(value => (value as TrustedReleaseContext['evidence'][number]).role === item.role) as
      TrustedReleaseContext['evidence'][number] | undefined;
    if (!trusted) fail('unknown-role');
    seen.push(trusted.role);
    if (canonicalDigest(parseIdentity(item.identity)) !== canonicalDigest(identity)) fail('evidence-identity');
    if (canonicalDigest(producer(item.producer)) !== canonicalDigest(producer(trusted.producer))) fail('producer-mismatch');
    if (item.candidateDigest !== candidateDigest || item.artifactDigest !== candidate.artifact.sha256) fail('evidence-subject');
    if (item.assetsDigest !== assetsDigest) fail('asset-set-mismatch');
    const start = time(item.generatedAt), end = time(item.completedAt), expiry = time(item.validUntil);
    if (start < time(candidate.createdAt) || end < start || end > nowMs || nowMs - start > maximumAge ||
        expiry <= nowMs || expiry > start + maximumAge) fail('stale-evidence');
    if (canonicalDigest(coverage(item.coverage)) !== canonicalDigest(coverage(trusted.coverage))) fail('coverage-mismatch');
    if (canonicalDigest(item) !== digest(trusted.reportDigest) || digest(item.payloadDigest) !== digest(trusted.payloadDigest)) fail('receipt-mismatch');
    const payload = payloads.get(trusted.payloadDigest);
    if (!payload || payload.byteLength < 1 || payload.byteLength > 4 * 1024 * 1024 ||
        `sha256:${createHash('sha256').update(payload).digest('hex')}` !== trusted.payloadDigest) fail('missing-or-changed-payload');
    // JSON admission reports cannot be relabelled as SBOM/security/provenance payloads.
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(payload).toString('utf8')); } catch { fail('invalid-payload-json'); }
    rejectAdmission(parsed);
    if (parsed && typeof parsed === 'object' && 'kind' in parsed && parsed.kind === 'unsigned-local-build-record') {
      fail('unsigned-record-is-not-qualified-evidence');
    }
    if (trusted.role === 'sbom' && parsed && typeof parsed === 'object' && 'compositions' in parsed &&
        Array.isArray(parsed.compositions) && parsed.compositions.some(item =>
          !item || typeof item !== 'object' || item.aggregate !== 'complete')) fail('incomplete-packed-component-sbom');
    if (trusted.role === 'secrets') requireReleaseSecrets(parsed, candidate, identity, now);
  }
  unique(seen);
  if (seen.length !== roles.length || payloads.size !== new Set(expected.evidence.map(item => item.payloadDigest)).size) fail('evidence-set');
  if (!expectedAssets.some(asset => asset.name === candidate.artifact.filename && asset.digest === candidate.artifact.sha256) ||
      expected.evidence.some(report => !expectedAssets.some(asset => asset.digest === report.payloadDigest))) fail('missing-evidence-asset');
  return { kind: 'validated-release-data', candidateDigest, assetsDigest };
}

export interface ReleaseObservation {
  tag: null | { name: string; commit: string };
  npm: null | { registry: string; name: string; version: string; integrity: string; distTag: string; distTagVersion: string };
  github: null | { tag: string; commit: string; state: 'draft' | 'published'; immutable: boolean; assets: ReleaseAsset[] };
}

export interface ReleaseRetryPlan {
  state: 'unpublished' | 'partial' | 'complete' | 'blocked';
  completed: string[];
  pending: string[];
  actions: string[];
  reason: string;
}

/**
 * Plans only from authoritative readback: null means confirmed absent, not a
 * failed lookup. Requires revalidation of qualification before any pending
 * effect. It never invokes a publisher and never repairs by destructive edits.
 */
export function planReleaseRetry(
  candidateValue: unknown, expectedAssetValues: unknown, observationValue: unknown
): ReleaseRetryPlan {
  const candidate = parseNpmCandidate(candidateValue);
  const expectedAssets = assets(expectedAssetValues);
  if (!expectedAssets.some(asset => asset.name === candidate.artifact.filename && asset.digest === candidate.artifact.sha256)) fail('missing-package-asset');
  const observation = record(observationValue, ['tag', 'npm', 'github'], 'release-invalid-observation');
  const completed: string[] = [], pending: string[] = [], actions: string[] = [];
  const blocked = (reason: string): ReleaseRetryPlan => ({ state: 'blocked', completed, pending, actions: [], reason });
  if (candidate.source.dirty) return blocked('dirty-source-requires-committed-candidate');
  if (observation.tag !== null) {
    const tag = record(observation.tag, ['name', 'commit'], 'release-invalid-tag');
    if (tag.name !== candidate.releaseTag || sha(tag.commit) !== candidate.source.commit) return blocked('tag-conflict-forward-correction-required');
    completed.push('tag-created');
  } else {
    pending.push('tag-created');
    actions.push('create-exact-tag');
  }
  if (observation.npm !== null) {
    const npm = record(observation.npm, ['registry', 'name', 'version', 'integrity', 'distTag', 'distTagVersion'], 'release-invalid-npm-observation');
    if (npm.registry !== canonicalRegistry || npm.name !== candidate.artifact.name || npm.version !== candidate.artifact.version ||
        npmIntegrity(npm.integrity) !== candidate.artifact.integrity) return blocked('npm-conflict-forward-correction-required');
    completed.push('npm-published');
    if (npm.distTag !== candidate.distTag || npm.distTagVersion !== candidate.artifact.version) return blocked('npm-dist-tag-conflict-forward-correction-required');
    completed.push('npm-canonical-verified');
  } else {
    pending.push('npm-published', 'npm-canonical-verified');
    actions.push('publish-exact-tarball', 'verify-canonical-npm');
  }
  if (observation.github === null) {
    pending.push('github-draft-complete', 'github-immutable-published');
    actions.push('create-draft', ...expectedAssets.map(asset => `upload-missing:${asset.name}`), 'verify-draft', 'publish-draft', 'verify-immutable-release');
  } else {
    const github = record(observation.github, ['tag', 'commit', 'state', 'immutable', 'assets'], 'release-invalid-github-observation');
    if (!['draft', 'published'].includes(github.state as string) || typeof github.immutable !== 'boolean') fail('invalid-github-state');
    if (github.tag !== candidate.releaseTag || sha(github.commit) !== candidate.source.commit || observation.tag === null) return blocked('github-tag-conflict-forward-correction-required');
    if (github.state === 'draft' && github.immutable) fail('invalid-github-state');
    const actualAssets = list(github.assets, 0, 100).length ? assets(github.assets) : [];
    if (actualAssets.some(asset => !expectedAssets.some(expected => expected.name === asset.name && expected.digest === asset.digest))) return blocked('github-asset-conflict-forward-correction-required');
    const missing = expectedAssets.filter(asset => !actualAssets.some(actual => actual.name === asset.name));
    completed.push(...actualAssets.map(asset => `github-asset:${asset.name}`));
    if (github.state === 'published') {
      if (missing.length || !github.immutable) return blocked('published-github-incomplete-or-mutable-forward-correction-required');
      completed.push('github-draft-complete', 'github-immutable-published');
    } else {
      pending.push('github-immutable-published');
      if (missing.length) pending.push('github-draft-complete');
      else completed.push('github-draft-complete');
      actions.push(...missing.map(asset => `upload-missing:${asset.name}`), 'verify-draft', 'publish-draft', 'verify-immutable-release');
    }
  }
  return {
    state: pending.length === 0 ? 'complete' : completed.length ? 'partial' : 'unpublished',
    completed, pending, actions,
    reason: pending.length ? 'revalidate-current-qualification-before-pending-effects' : 'exact-existing-release'
  };
}

import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalDigest } from '../scripts/repository-security/admission.ts';
import { artifactHashes, type NpmCandidate, type ReleaseEvidence, type ReleaseObservation, type TrustedReleaseContext } from '../scripts/repository-security/npm-release.ts';
import {
  executeReleasePhase, npmPublicationArguments, prepareReleaseOperation, releaseReadiness,
  ReleasePhaseError, type CanonicalReleaseReceipt, type PublisherAuthority, type ReleaseTransport
} from '../scripts/repository-security/npm-release-operation.ts';
import { planTagProtection } from '../scripts/repository-security/tag-policy.ts';
import { createReleaseChecksums } from '../scripts/repository-security/github-release.ts';

const now = new Date('2026-09-20T12:00:00.000Z');
const commit = 'a'.repeat(40), digest = `sha256:${'a'.repeat(64)}`;
const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// All authority, database, scanner and registry values below are synthetic.
// No production transport exists, and no real publication is executed.
function fixture() {
  const tarball = Buffer.from('Synthetic transport artifact, not a qualified npm package.');
  const candidate: NpmCandidate = {
    schemaVersion: 1, kind: 'npm-release-candidate',
    source: { commit, tree: 'b'.repeat(40), inputsDigest: digest, dirty: false },
    artifact: { name: '@msn-control/liftoff', version: '0.12.3', filename: 'msn-control-liftoff-0.12.3.tgz',
      size: tarball.length, ...artifactHashes(tarball) },
    releaseTag: 'v0.12.3', distTag: 'latest', createdAt: '2026-09-20T11:00:00.000Z'
  };
  const identity = {
    repository: 'voyager163/liftoff', event: 'workflow_dispatch' as const,
    sourceSha: commit, baseSha: commit, workflowSha: commit, runId: '123', attempt: 1,
    policyDigest: digest, inventoryDigest: digest, configurationDigest: digest
  };
  const producer = { workflow: ['.github', 'workflows', 'release.yml'], job: 'synthetic-receipt',
    tool: { name: 'fixture-only', version: '1', database: 'fixture-only' } };
  const secret = {
    schemaVersion: 1, assessment: 'qualified', gate: 'passed', protection: 'not-established',
    evidenceDigest: 'a'.repeat(64), policyDigest: 'a'.repeat(64), sourceCommit: commit,
    coverage: [{ scopeIndex: 0, status: 'complete', qualified: true }], findings: [] as unknown[],
    counts: { unresolved: 0, 'confirmed-awaiting-remediation': 0, 'false-positive': 0, 'nonfunctional-fixture': 0, remediated: 0 }
  };
  const payloads = new Map<string, Uint8Array>(), assets = new Map<string, Uint8Array>([[candidate.artifact.filename, tarball]]);
  const evidence: ReleaseEvidence[] = (['functional', 'sbom', 'provenance', 'vulnerabilities', 'secrets'] as const).map(role => {
    const bytes = Buffer.from(JSON.stringify(role === 'secrets' ? secret : { kind: 'fixture-only', role }));
    payloads.set(hash(bytes), bytes); assets.set(`${role}.json`, bytes);
    return {
      schemaVersion: 1, kind: 'release-evidence', role, identity: { ...identity }, producer: structuredClone(producer),
      candidateDigest: canonicalDigest(candidate), artifactDigest: candidate.artifact.sha256, assetsDigest: digest,
      generatedAt: '2026-09-20T11:15:00.000Z', completedAt: '2026-09-20T11:20:00.000Z',
      validUntil: '2026-09-21T11:15:00.000Z', complete: true, verdict: 'passed',
      coverage: [{ id: 'fixture-component', digest }], payloadDigest: hash(bytes)
    };
  });
  const expected: TrustedReleaseContext = {
    identity, sourceRef: 'refs/heads/main', protectedMainCommit: commit,
    candidateDigest: canonicalDigest(candidate), assets: [], evidence: []
  };
  function bind() {
    assets.delete('SHA256SUMS');
    assets.set('SHA256SUMS', createReleaseChecksums(assets));
    expected.assets = [...assets].map(([name, bytes]) => ({ name, digest: hash(bytes) })).sort((a, b) => a.name < b.name ? -1 : 1);
    for (const report of evidence) report.assetsDigest = canonicalDigest(expected.assets);
    expected.evidence = evidence.map(report => ({
      role: report.role, producer: report.producer, payloadDigest: report.payloadDigest,
      reportDigest: canonicalDigest(report), coverage: report.coverage
    }));
  }
  bind();
  function replacePayload(role: ReleaseEvidence['role'], value: unknown) {
    const report = evidence.find(item => item.role === role)!;
    payloads.delete(report.payloadDigest);
    const bytes = Buffer.from(JSON.stringify(value));
    report.payloadDigest = hash(bytes); payloads.set(report.payloadDigest, bytes); assets.set(`${role}.json`, bytes);
    bind();
  }
  const authority: PublisherAuthority = {
    identity: { ...identity }, sourceRef: 'refs/heads/main', mainProtected: true,
    environment: 'npm-publisher', requiredReviewers: 0, appId: 99999,
    repositoryScope: ['voyager163/liftoff'], nonpublisherDenied: true,
    npmTrustedPublisher: { repository: 'voyager163/liftoff', workflow: '.github/workflows/release.yml', environment: 'npm-publisher' },
    tagRulesets: planTagProtection(99999).rulesets, immutableReleasesEnabled: true,
    observedAt: '2026-09-20T11:50:00.000Z', validUntil: '2026-09-21T11:50:00.000Z'
  };
  const input = { candidate, tarball, evidence, payloads, assets, expected, authority };
  const receipt: CanonicalReleaseReceipt = {
    kind: 'canonical-installed-verification', identity: { ...identity }, candidateDigest: canonicalDigest(candidate),
    integrity: candidate.artifact.integrity, registry: 'https://registry.npmjs.org', producerJob: 'canonical-verify',
    permissions: { contents: 'read' }, environment: null, commands: ['help', 'upgrade-help', 'version', 'plan'],
    completedAt: '2026-09-20T11:59:00.000Z'
  };
  return { input, secret, replacePayload, receipt, canonical: () => ({ receipt, independentlyVerifiedDigest: canonicalDigest(receipt) }) };
}

function fakeTransport(input: ReturnType<typeof fixture>['input']) {
  const observation: ReleaseObservation = { tag: null, npm: null, github: null };
  const calls: string[] = [];
  let failAfterNpm = false;
  const transport: ReleaseTransport = {
    async readState() {
      if (failAfterNpm) { failAfterNpm = false; throw new Error('synthetic transport failure'); }
      return structuredClone(observation);
    },
    async createTag(name, commit) {
      expect(observation.tag).toBeNull(); calls.push('create-tag'); observation.tag = { name, commit };
    },
    async createDraft(tag, commit) {
      expect(observation.github).toBeNull(); calls.push('create-draft');
      observation.github = { tag, commit, state: 'draft', immutable: false, assets: [] };
    },
    async uploadMissingAsset(name, bytes) {
      expect(observation.github!.assets.some(asset => asset.name === name)).toBe(false);
      calls.push(`upload:${name}`); observation.github!.assets.push({ name, digest: hash(bytes) });
    },
    async publishExactNpm(candidate, bytes) {
      expect(observation.npm).toBeNull();
      expect(bytes).toEqual(Uint8Array.from(input.tarball));
      calls.push('npm-publish');
      observation.npm = { registry: 'https://registry.npmjs.org', name: candidate.artifact.name,
        version: candidate.artifact.version, integrity: artifactHashes(bytes).integrity,
        distTag: candidate.distTag, distTagVersion: candidate.artifact.version };
    },
    async publishDraft() {
      expect(observation.github!.state).toBe('draft');
      calls.push('publish-draft'); observation.github!.state = 'published'; observation.github!.immutable = true;
    }
  };
  return { observation, calls, transport, failNextRead: () => { failAfterNpm = true; } };
}

describe('existing release coordinator phases with fake transports only', () => {
  it('assembles exact tag/all assets, publishes once, waits for isolated verification, then finalizes idempotently', async () => {
    const value = fixture(), fake = fakeTransport(value.input);
    const operation = prepareReleaseOperation(value.input, now);
    await executeReleasePhase(operation, 'assemble', fake.transport, () => now);
    await executeReleasePhase(operation, 'assemble', fake.transport, () => now);
    expect(fake.calls.filter(call => call === 'create-tag')).toHaveLength(1);
    expect(fake.calls.filter(call => call.startsWith('upload:'))).toHaveLength(value.input.assets.size);
    await executeReleasePhase(operation, 'npm', fake.transport, () => now);
    await executeReleasePhase(operation, 'npm', fake.transport, () => now);
    expect(fake.calls.filter(call => call === 'npm-publish')).toHaveLength(1);
    await expect(executeReleasePhase(operation, 'finalize', fake.transport, () => now)).rejects.toBeInstanceOf(ReleasePhaseError);
    expect(fake.calls).not.toContain('publish-draft');
    const result = await executeReleasePhase(operation, 'finalize', fake.transport, () => now, value.canonical());
    expect(result.status).toBe('completed');
    await executeReleasePhase(operation, 'finalize', fake.transport, () => now, value.canonical());
    expect(fake.calls.filter(call => call === 'publish-draft')).toHaveLength(1);
    expect(fake.calls.join(' ')).not.toMatch(/delete|move|overwrite|unpublish/);
  });

  it('blocks npm before the exact draft is complete', async () => {
    const value = fixture(), fake = fakeTransport(value.input);
    await expect(executeReleasePhase(prepareReleaseOperation(value.input, now), 'npm', fake.transport, () => now)).rejects.toBeInstanceOf(ReleasePhaseError);
    expect(fake.calls).toEqual([]);
  });

  it.each(['tag', 'npm', 'asset', 'mutable-published'])('blocks conflicting existing %s without overwrites', async conflict => {
    const value = fixture(), fake = fakeTransport(value.input), operation = prepareReleaseOperation(value.input, now);
    await executeReleasePhase(operation, 'assemble', fake.transport, () => now);
    await executeReleasePhase(operation, 'npm', fake.transport, () => now);
    if (conflict === 'tag') fake.observation.tag!.commit = 'c'.repeat(40);
    if (conflict === 'npm') fake.observation.npm!.version = '0.12.4';
    if (conflict === 'asset') fake.observation.github!.assets[0].digest = `sha256:${'b'.repeat(64)}`;
    if (conflict === 'mutable-published') fake.observation.github!.state = 'published';
    const before = [...fake.calls];
    await expect(executeReleasePhase(operation, 'finalize', fake.transport, () => now, value.canonical())).rejects.toBeInstanceOf(ReleasePhaseError);
    expect(fake.calls).toEqual(before);
  });

  it('reports acknowledged npm success separately from failed readback and retries without republishing', async () => {
    const value = fixture(), fake = fakeTransport(value.input), operation = prepareReleaseOperation(value.input, now);
    await executeReleasePhase(operation, 'assemble', fake.transport, () => now);
    const publish = fake.transport.publishExactNpm;
    fake.transport.publishExactNpm = async (...args) => { await publish(...args); fake.failNextRead(); };
    let failure: ReleasePhaseError | undefined;
    try { await executeReleasePhase(operation, 'npm', fake.transport, () => now); }
    catch (error) { failure = error as ReleasePhaseError; }
    expect(failure?.outcome).toMatchObject({ status: 'blocked', effectsAttempted: ['npm-published'], effectsCompleted: ['npm-published'] });
    await executeReleasePhase(operation, 'npm', fake.transport, () => now);
    expect(fake.calls.filter(call => call === 'npm-publish')).toHaveLength(1);
  });

  it('records an uncertain attempted effect without claiming success after a transport failure', async () => {
    const value = fixture(), fake = fakeTransport(value.input), operation = prepareReleaseOperation(value.input, now);
    fake.transport.createTag = async () => { throw new Error('Do-not-log-transport-sentinel'); };
    await expect(executeReleasePhase(operation, 'assemble', fake.transport, () => now)).rejects.toMatchObject({
      outcome: { effectsAttempted: ['tag-created'], effectsCompleted: [] }
    });
  });

  it.each(['environment', 'oidc', 'source', 'attempt', 'stale'])('rejects unsafe canonical %s receipt', async problem => {
    const value = fixture(), fake = fakeTransport(value.input), operation = prepareReleaseOperation(value.input, now);
    await executeReleasePhase(operation, 'assemble', fake.transport, () => now);
    await executeReleasePhase(operation, 'npm', fake.transport, () => now);
    if (problem === 'environment') Object.assign(value.receipt, { environment: 'npm-publisher' });
    if (problem === 'oidc') Object.assign(value.receipt.permissions, { 'id-token': 'write' });
    if (problem === 'source') value.receipt.identity.sourceSha = 'c'.repeat(40);
    if (problem === 'attempt') value.receipt.identity.attempt = 2;
    if (problem === 'stale') value.receipt.completedAt = '2026-09-19T11:00:00.000Z';
    await expect(executeReleasePhase(operation, 'finalize', fake.transport, () => now, value.canonical())).rejects.toBeInstanceOf(ReleasePhaseError);
    expect(fake.calls).not.toContain('publish-draft');
  });

  it.each(['shared-app', 'missing-app', 'environment', 'reviewers', 'nonpublisher', 'scope', 'expiry', 'mutable-tags'])('rejects unqualified publisher %s', problem => {
    const value = fixture(), authority = value.input.authority;
    if (problem === 'shared-app') authority.appId = 15368;
    if (problem === 'missing-app') Object.assign(authority, { appId: null });
    if (problem === 'environment') Object.assign(authority, { environment: 'invented-environment' });
    if (problem === 'reviewers') Object.assign(authority, { requiredReviewers: 1 });
    if (problem === 'nonpublisher') Object.assign(authority, { nonpublisherDenied: false });
    if (problem === 'scope') authority.repositoryScope.push('voyager163/liftoff');
    if (problem === 'expiry') authority.validUntil = now.toISOString();
    if (problem === 'mutable-tags') authority.tagRulesets[1].bypass_actors = authority.tagRulesets[0].bypass_actors;
    expect(() => prepareReleaseOperation(value.input, now)).toThrow();
  });

  it.each(['incomplete', 'wrong-source', 'untriaged', 'unremediated', 'policy-blocked'])('blocks actual sanitized secrets %s despite a passing envelope', problem => {
    const value = fixture(), secret = structuredClone(value.secret);
    if (problem === 'incomplete') secret.coverage[0].qualified = false;
    if (problem === 'wrong-source') secret.sourceCommit = 'c'.repeat(40);
    if (problem === 'policy-blocked') secret.gate = 'blocked';
    if (problem === 'untriaged' || problem === 'unremediated') {
      const state = problem === 'untriaged' ? 'unresolved' : 'confirmed-awaiting-remediation';
      secret.counts[state] = 1;
      secret.findings.push({ id: digest, ruleIndex: 0, locationIndex: 0, line: 1, column: 1, endLine: 1, endColumn: 1,
        commit, state, blocking: false });
    }
    value.replacePayload('secrets', secret);
    expect(() => prepareReleaseOperation(value.input, now)).toThrow(/secret/);
  });

  it('binds fresh adopted source-secrets payloads to exact release source, bytes, policy and attempt', () => {
    const value = fixture();
    const payload = {
      schemaVersion: 1, kind: 'fresh-adopted-source-secrets-evidence',
      identity: value.input.expected.identity, candidateDigest: canonicalDigest(value.input.candidate),
      artifactDigest: value.input.candidate.artifact.sha256, sourceCommit: commit,
      sourceReportDigest: digest, scopeDigest: digest,
      startedAt: '2026-09-20T11:10:00.000Z', completedAt: '2026-09-20T11:12:00.000Z',
      adoptedPolicyCommit: commit, adoptedPolicyDigest: value.input.expected.identity.policyDigest,
      complete: true, findingPolicy: 'passed', observedFindings: 2, blockedFindings: 0,
      policyDiagnostics: 0, confirmedUnremediated: 0,
      currentTreeComplete: true, declaredHistoryComplete: true, cleanup: 'completed',
      admissionEvidenceUsed: false, publicationAuthorized: false
    };
    value.replacePayload('secrets', payload);
    expect(() => prepareReleaseOperation(value.input, now)).not.toThrow();
    for (const change of [
      { currentTreeComplete: false }, { declaredHistoryComplete: false },
      { blockedFindings: 1 }, { confirmedUnremediated: 1 }, { policyDiagnostics: 1 },
      { findingPolicy: 'blocked' }, { complete: false }, { cleanup: 'failed' },
      { admissionEvidenceUsed: true }, { publicationAuthorized: true },
      { sourceCommit: 'c'.repeat(40) }, { adoptedPolicyCommit: 'c'.repeat(40) },
      { adoptedPolicyDigest: `sha256:${'b'.repeat(64)}` }, { artifactDigest: digest },
      { candidateDigest: digest }, { identity: { ...payload.identity, attempt: 2 } },
      { startedAt: '2026-09-20T10:59:59.999Z' },
      { completedAt: '2026-09-20T12:00:00.001Z' }
    ]) {
      value.replacePayload('secrets', { ...payload, ...change });
      expect(() => prepareReleaseOperation(value.input, now)).toThrow(/secret/);
    }
  });

  it.each(['normal-admitted', 'maintenance-admitted'])('rejects %s admission as any qualification payload', decision => {
    const value = fixture();
    value.replacePayload('provenance', { kind: 'pull-request-admission', decision });
    expect(() => prepareReleaseOperation(value.input, now)).toThrow(/admission/);
  });
  it('rejects unsigned local records and incomplete component SBOMs as qualification', () => {
    const value = fixture();
    value.replacePayload('provenance', { kind: 'unsigned-local-build-record' });
    expect(() => prepareReleaseOperation(value.input, now)).toThrow(/unsigned-record/);
    const second = fixture();
    second.replacePayload('sbom', { compositions: [{ aggregate: 'incomplete' }] });
    expect(() => prepareReleaseOperation(second.input, now)).toThrow(/incomplete-packed/);
  });

  it('rejects evidence that expires while a readback is in flight, before any effect', async () => {
    const value = fixture(), fake = fakeTransport(value.input), operation = prepareReleaseOperation(value.input, now);
    let clock = now;
    fake.transport.readState = async () => { clock = new Date('2026-09-22T12:00:00.000Z'); return structuredClone(fake.observation); };
    await expect(executeReleasePhase(operation, 'assemble', fake.transport, () => clock)).rejects.toBeInstanceOf(ReleasePhaseError);
    expect(fake.calls).toEqual([]);
  });

  it('builds exact-tarball npm arguments, never an implicit source publish', () => {
    const value = fixture();
    const target = path.resolve('registered-output', value.input.candidate.artifact.filename);
    expect(npmPublicationArguments(value.input.candidate, target)).toEqual([
      'publish', target, '--ignore-scripts', '--access', 'public', '--provenance',
      '--registry=https://registry.npmjs.org', '--@msn-control:registry=https://registry.npmjs.org', '--tag', 'latest'
    ]);
    expect(() => npmPublicationArguments(value.input.candidate, '.')).toThrow();
  });

  it('cannot mint production authority from a feasibility/candidate claim or a dry run', () => {
    for (const dryRun of [true, false]) {
      const value = fixture();
      const readiness = releaseReadiness(value.input.candidate, { status: 'qualified' }, {
        event: 'workflow_dispatch', ref: 'refs/heads/main', sourceSha: commit, dryRun
      });
      expect(readiness.publicationAuthorized).toBe(false);
      expect(readiness.blockers).toContain('authenticated-release-producer-receipts-under-adopted-policy');
    }
  });
});

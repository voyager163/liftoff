import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createSecretsBoundary, SECRET_LIMITS,
  type SecretCapture, type SecretDispositionState
} from '../scripts/repository-security/secrets.ts';

// Intentionally not a provider credential or detector-supported live token.
const sentinel = 'NONFUNCTIONAL_SENTINEL_DO_NOT_LOG_fa42';
const head = 'a'.repeat(40);
const historical = 'b'.repeat(40);
const base = 'c'.repeat(40);
const other = 'd'.repeat(40);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const evidence = hash('synthetic evidence only');
const at = '2026-09-20T04:00:00.000Z';
const now = '2026-09-20T05:00:00.000Z';

function selectorFixture() {
  return {
    ruleId: 'fixture-rule', pathParts: ['tests', 'folder with spaces', 'fixture.txt'],
    line: 4, column: 2, endLine: 4, endColumn: 12, commit: historical
  };
}

function dispositionFixture(state: SecretDispositionState = 'nonfunctional-fixture') {
  const rationale = {
    unresolved: 'awaiting-triage',
    'confirmed-awaiting-remediation': 'credential-exposure-confirmed',
    'false-positive': 'pattern-is-not-a-credential',
    'nonfunctional-fixture': 'documented-nonfunctional-fixture',
    remediated: 'owner-verified-invalidation'
  };
  return {
    finding: selectorFixture(), state, owner: 'credential-owner', rationale: rationale[state],
    approval: {
      owner: 'maintainer', approvedAt: '2026-09-20T04:20:00.000Z',
      basePolicyCommit: base, basePolicyDigest: hash('trusted base policy'), evidenceDigest: evidence
    },
    remediation: state === 'remediated' ? {
      method: 'revoked', credentialOwner: 'credential-owner', authorizedBy: 'credential-owner',
      authorizedAt: '2026-09-20T04:01:00.000Z', completedAt: '2026-09-20T04:05:00.000Z',
      authorizationDigest: evidence, evidenceDigest: evidence, sourceCommit: head,
      sourceCheckedAt: '2026-09-20T04:10:00.000Z', sourceEvidenceDigest: evidence
    } : null
  };
}

function policyFixture() {
  return {
    schemaVersion: 1, repository: 'voyager163/liftoff', basePolicyCommit: base,
    basePolicyDigest: hash('trusted base policy'),
    detector: { name: 'gitleaks', version: '0.0.0', binaryDigest: hash('fixture binary'), configDigest: hash('fixture config') },
    rules: ['fixture-rule'], exclusions: [] as ReturnType<typeof selectorFixture>[],
    dispositions: [] as ReturnType<typeof dispositionFixture>[]
  };
}
type PolicyFixture = ReturnType<typeof policyFixture>;

function contextFixture(policy = policyFixture()) {
  return {
    schemaVersion: 1,
    identity: {
      repository: 'voyager163/liftoff', event: 'schedule', ref: 'refs/heads/develop',
      sourceCommit: head, baseCommit: null as string | null, workflowCommit: base,
      runId: 123, attempt: 1, basePolicyCommit: base, basePolicyDigest: hash('trusted base policy'),
      inventoryDigest: hash('fixture inventory')
    },
    mode: 'full', observedAt: at, now, maxAgeSeconds: 86_400, policyDigest: hash(JSON.stringify(policy)),
    scopes: [
      { id: 'current-tree', kind: 'current-tree', ref: 'refs/heads/develop', revision: head, baseRevision: null as string | null, commits: [head] },
      { id: 'develop-history', kind: 'reachable-history', ref: 'refs/heads/develop', revision: head, baseRevision: null as string | null, commits: [head, historical] }
    ],
    locations: [selectorFixture().pathParts, ['src', 'index.ts']]
  };
}
type ContextFixture = ReturnType<typeof contextFixture>;

function findingFixture() {
  return { finding: selectorFixture(), scopeIds: ['develop-history'], currentSource: 'absent' };
}

function reportFixture(policy = policyFixture(), context = contextFixture(policy), findings = [findingFixture()]) {
  return {
    schemaVersion: 1, identity: context.identity, policyDigest: context.policyDigest, detector: policy.detector,
    observedAt: context.observedAt, startedAt: '2026-09-20T04:30:00.000Z', completedAt: '2026-09-20T04:40:00.000Z',
    coverage: context.scopes.map(scope => ({
      id: scope.id, kind: scope.kind, ref: scope.ref, revision: scope.revision, baseRevision: scope.baseRevision,
      commitCount: scope.commits.length, commitsDigest: hash(JSON.stringify([...scope.commits].sort())),
      status: 'complete', shallow: false, missingObjects: 0, skippedInputs: 0
    })),
    findingCount: findings.length, findings
  };
}
type ReportFixture = ReturnType<typeof reportFixture>;

function capture(report: unknown = reportFixture(), overrides: Partial<SecretCapture> = {}): SecretCapture {
  return {
    exitCode: 1, timedOut: false, signal: null, stdout: new Uint8Array(), stderr: new Uint8Array(),
    report: Buffer.from(JSON.stringify(report)), ...overrides
  };
}

function boundary(policy = policyFixture(), context = contextFixture(policy)) {
  return createSecretsBoundary(JSON.stringify(context), JSON.stringify(policy));
}

describe('secrets evidence contract (deterministic simulations only)', () => {
  it('distinguishes no findings from real protection or hosted enforcement proof', () => {
    const b = boundary();
    const result = b.assess(capture(reportFixture(undefined, undefined, []), { exitCode: 0 }));
    expect(result).toMatchObject({
      assessment: 'qualified', gate: 'passed', protection: 'not-established',
      sourceCommit: head, findings: [], counts: { unresolved: 0 }
    });
    expect(result.coverage).toEqual([
      { scopeIndex: 0, status: 'complete', qualified: true },
      { scopeIndex: 1, status: 'complete', qualified: true }
    ]);
    expect(JSON.parse(b.serialize(result))).toEqual(result);
  });

  it.each(['unresolved', 'confirmed-awaiting-remediation'] as const)('blocks %s independently of CVE severity', state => {
    const p = policyFixture();
    p.dispositions.push(dispositionFixture(state));
    const result = boundary(p).assess(capture(reportFixture(p)));
    expect(result.assessment).toBe('qualified');
    expect(result.gate).toBe('blocked');
    expect(result.counts[state]).toBe(1);
    expect(result.findings[0]).toMatchObject({ state, blocking: true });
  });

  it('treats missing triage as unresolved rather than an empty allowlist', () => {
    const result = boundary().assess(capture());
    expect(result.gate).toBe('blocked');
    expect(result.counts.unresolved).toBe(1);
  });

  it('retains a path-only detection without inventing a line or treating null as a wildcard', () => {
    const selector = { ...selectorFixture(), line: null, column: null, endLine: null, endColumn: null };
    const raw = { ...findingFixture(), finding: selector };
    const policy = policyFixture();
    const context = contextFixture(policy);
    const report = { ...reportFixture(policy, context), findings: [raw] };
    const result = boundary(policy, context).assess(capture(report));
    expect(result).toMatchObject({ gate: 'blocked', counts: { unresolved: 1 } });
    expect(result.findings[0]).toMatchObject({ line: null, column: null, endLine: null, endColumn: null });
    const disposition = { ...dispositionFixture('false-positive'), finding: selector };
    const adopted = { ...policy, dispositions: [disposition] };
    const adoptedContext = { ...context, policyDigest: hash(JSON.stringify(adopted)) };
    const gate = createSecretsBoundary(JSON.stringify(adoptedContext), JSON.stringify(adopted));
    const adoptedReport = { ...report, policyDigest: adoptedContext.policyDigest };
    expect(gate.assess(capture(adoptedReport)).gate).toBe('passed');
    expect(gate.assess(capture({ ...adoptedReport, findings: [findingFixture()] })))
      .toMatchObject({ gate: 'blocked', counts: { unresolved: 1 } });
  });

  it.each(['line', 'column', 'endLine', 'endColumn'])('rejects partially absent %s coordinates', field => {
    const report = { ...reportFixture(), findings: [{
      ...findingFixture(), finding: { ...selectorFixture(), [field]: null }
    }] };
    expect(() => boundary().assess(capture(report))).toThrow('invalid-metadata');
  });

  it.each(['false-positive', 'nonfunctional-fixture', 'remediated'] as const)('permits exact trusted %s records', state => {
    const p = policyFixture();
    p.dispositions.push(dispositionFixture(state));
    const result = boundary(p).assess(capture(reportFixture(p)));
    expect(result.gate).toBe('passed');
    expect(result.counts[state]).toBe(1);
    expect(result.findings[0]).toMatchObject({
      ruleIndex: 0, locationIndex: 0, line: 4, commit: historical, state, blocking: false
    });
    expect(result.findings[0]?.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves a historical occurrence through owner invalidation without history rewriting', () => {
    const p = policyFixture();
    const remediated = dispositionFixture('remediated');
    p.dispositions.push(remediated);
    const c = contextFixture(p);
    const before = JSON.stringify(c.scopes);
    expect(boundary(p, c).assess(capture(reportFixture(p, c))).gate).toBe('passed');
    expect(JSON.stringify(c.scopes)).toBe(before);
    expect(c.scopes[1]?.commits).toContain(historical);
  });

  it.each(['present', 'unknown'])('still blocks remediated history when current-source state is %s', currentSource => {
    const p = policyFixture();
    p.dispositions.push(dispositionFixture('remediated'));
    const r = reportFixture(p);
    r.findings = [{ ...findingFixture(), currentSource }];
    expect(boundary(p).assess(capture(r)).gate).toBe('blocked');
  });

  it('accepts owner-authorized rotation as well as revocation', () => {
    const p = policyFixture();
    const d = dispositionFixture('remediated');
    if (!d.remediation) throw new Error('Fixture missing remediation');
    d.remediation.method = 'rotated';
    p.dispositions.push(d);
    expect(boundary(p).assess(capture(reportFixture(p))).gate).toBe('passed');
  });

  it('requires all applicable scope memberships and cannot relabel a current-tree hit absent', () => {
    const f = { ...findingFixture(), finding: { ...selectorFixture(), commit: head } };
    expect(() => boundary().assess(capture(reportFixture(undefined, undefined, [f])))).toThrow(/incomplete-scope/);
    f.scopeIds = ['current-tree', 'develop-history'];
    expect(() => boundary().assess(capture(reportFixture(undefined, undefined, [f])))).toThrow(/invalid-metadata/);
    f.currentSource = 'present';
    expect(boundary().assess(capture(reportFixture(undefined, undefined, [f]))).gate).toBe('blocked');
  });

  it('retains detection from an introduced commit removed before the PR head', () => {
    const p = policyFixture();
    const c = contextFixture(p);
    c.mode = 'intake';
    c.identity.event = 'pull_request';
    c.identity.baseCommit = base;
    c.scopes[1] = {
      id: 'introduced-history', kind: 'introduced-history', ref: c.identity.ref,
      revision: head, baseRevision: base, commits: [head, historical]
    };
    const f = { ...findingFixture(), scopeIds: ['introduced-history'] };
    const r = reportFixture(p, c, [f]);
    const result = boundary(p, c).assess(capture(r));
    expect(result).toMatchObject({ assessment: 'qualified', gate: 'blocked' });
    expect(result.findings[0]?.commit).toBe(historical);
    expect(result.findings[0]?.commit).not.toBe(head);
    r.coverage = r.coverage.slice(0, 1);
    expect(boundary(p, c).assess(capture(r)).assessment).toBe('unqualified');
  });

  it.each([
    ['missing history', (r: ReportFixture) => ({ ...r, coverage: r.coverage.slice(0, 1) })],
    ['missing tree', (r: ReportFixture) => ({ ...r, coverage: r.coverage.slice(1) })],
    ['no scopes completed', (r: ReportFixture) => ({ ...r, coverage: [] })],
    ['shallow history', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, shallow: true })) })],
    ['missing objects', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, missingObjects: 1 })) })],
    ['unapproved exclusions', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, skippedInputs: 1 })) })],
    ...['incomplete', 'failed', 'skipped', 'cancelled'].map(status => [
      status, (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, status })) })
    ] as const)
  ] as const)('marks %s explicitly unqualified, never clean', (_name, change) => {
    const r = change(reportFixture(undefined, undefined, []));
    expect(boundary().assess(capture(r, { exitCode: 0 }))).toMatchObject({ assessment: 'unqualified', gate: 'blocked' });
  });
});

describe('exact trusted policy, remediation and candidate proposals', () => {
  it('reports an exact fixture proposal without suppressing its own unresolved hit', () => {
    const b = boundary();
    const candidate = policyFixture();
    candidate.dispositions.push(dispositionFixture());
    candidate.exclusions.push(selectorFixture());
    expect(b.propose(JSON.stringify(candidate))).toEqual({
      authority: 'proposal-only', adoptionRequired: true,
      changes: ['exclusions', 'dispositions'], dispositionCount: 1
    });
    expect(b.assess(capture()).gate).toBe('blocked');
    expect(() => b.assess(capture(reportFixture(candidate)))).toThrow(/identity-mismatch/);
    expect(boundary(candidate).assess(capture(reportFixture(candidate))).gate).toBe('passed');
  });

  it('reports detector and rule changes, but will not accept candidate execution identity', () => {
    const b = boundary();
    const candidate = policyFixture();
    candidate.detector.configDigest = hash('candidate configuration');
    candidate.rules.push('another-exact-rule');
    expect(b.propose(JSON.stringify(candidate)).changes).toEqual(['detector', 'rules']);
    const r = reportFixture();
    r.detector = candidate.detector;
    expect(() => b.assess(capture(r))).toThrow(/identity-mismatch/);
  });

  it('does not invent a second-person review rule or expiration window', () => {
    const p = policyFixture();
    const d = dispositionFixture('false-positive');
    d.owner = 'maintainer';
    d.approval.owner = 'maintainer';
    d.approval.approvedAt = '2025-01-01T00:00:00.000Z';
    p.dispositions.push(d);
    expect(boundary(p).assess(capture(reportFixture(p))).gate).toBe('passed');
    expect(boundary(p).propose(JSON.stringify(p))).toMatchObject({ adoptionRequired: false, changes: [] });
  });

  it.each([
    ['rule', (d: ReturnType<typeof dispositionFixture>) => { d.finding.ruleId = 'other-rule'; }],
    ['path', (d: ReturnType<typeof dispositionFixture>) => { d.finding.pathParts = ['src', 'index.ts']; }],
    ['line', (d: ReturnType<typeof dispositionFixture>) => { d.finding.line++; d.finding.endLine++; }],
    ['column', (d: ReturnType<typeof dispositionFixture>) => { d.finding.column++; }],
    ['end column', (d: ReturnType<typeof dispositionFixture>) => { d.finding.endColumn++; }],
    ['commit', (d: ReturnType<typeof dispositionFixture>) => { d.finding.commit = head; }]
  ])('does not transplant a disposition across a different %s', (_label, change) => {
    const p = policyFixture();
    p.rules.push('other-rule');
    const d = dispositionFixture('false-positive');
    change(d);
    p.dispositions.push(d);
    expect(boundary(p).assess(capture(reportFixture(p))).gate).toBe('blocked');
  });

  it.each([
    ['missing approval', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, approval: null })],
    ['wrong approval policy commit', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, approval: { ...d.approval, basePolicyCommit: other } })],
    ['wrong approval policy digest', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, approval: { ...d.approval, basePolicyDigest: evidence } })],
    ['missing credential owner', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, owner: '' })],
    ['free-text secret rationale', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, rationale: sentinel })],
    ['live-credential state', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, state: 'accepted-live-credential' })],
    ['low severity', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, severity: 'low' })],
    ['30-day exception', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, expiresAt: '2026-10-20T00:00:00Z' })],
    ['90-day exception', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, expiresAt: '2026-12-19T00:00:00Z' })],
    ['mitigation exception', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, mitigation: 'will rotate later' })],
    ['missing invalidation', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: null })],
    ['alert closure only', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { alertClosed: true } })],
    ['file deletion only', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { fileDeleted: true } })],
    ['history rewrite only', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { historyRewritten: true } })],
    ['incorrect owner authorization', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, authorizedBy: 'not-owner' } })],
    ['incorrect credential owner', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, credentialOwner: 'not-owner' } })],
    ['no owner authorization', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, authorizationDigest: '' } })],
    ['no invalidation evidence', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, evidenceDigest: '' } })],
    ['no removal evidence', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, sourceEvidenceDigest: '' } })],
    ['unrelated source commit', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, sourceCommit: other } })],
    ['invalidation after approval', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, completedAt: now } })],
    ['authorization after invalidation', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, authorizedAt: now } })],
    ['source check before invalidation', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, remediation: { ...d.remediation, sourceCheckedAt: at } })],
    ['future approval', (d: ReturnType<typeof dispositionFixture>) => ({ ...d, approval: { ...d.approval, approvedAt: '2027-01-01T00:00:00Z' } })]
  ])('rejects %s rather than manufacturing remediation', (_name, change) => {
    const p = { ...policyFixture(), dispositions: [change(dispositionFixture('remediated'))] };
    const c = contextFixture();
    c.policyDigest = hash(JSON.stringify(p));
    expect(() => createSecretsBoundary(JSON.stringify(c), JSON.stringify(p))).toThrow(/Secrets contract rejected/);
  });

  it.each([
    ['wildcard rule', { ...selectorFixture(), ruleId: '*' }],
    ['wildcard path', { ...selectorFixture(), pathParts: ['**'] }],
    ['all commits', { ...selectorFixture(), commit: '*' }],
    ['line range', { ...selectorFixture(), line: [1, 100] }],
    ['negative line', { ...selectorFixture(), line: -1 }]
  ])('rejects broad baseline %s', (_name, exclusion) => {
    const p = { ...policyFixture(), exclusions: [exclusion] };
    expect(() => boundary().propose(JSON.stringify(p))).toThrow(/Secrets contract rejected/);
  });

  it.each(['unresolved', 'confirmed-awaiting-remediation', 'remediated'] as const)('rejects detector exclusion for %s', state => {
    const p = policyFixture();
    p.dispositions.push(dispositionFixture(state));
    p.exclusions.push(selectorFixture());
    expect(() => boundary(p)).toThrow(/unapproved-exclusion/);
  });

  it('rejects an exact exclusion without reviewed false-positive/fixture disposition', () => {
    const p = policyFixture();
    p.exclusions.push(selectorFixture());
    expect(() => boundary().propose(JSON.stringify(p))).toThrow(/unapproved-exclusion/);
  });

  it('does not accept remediation attached to unresolved or fixture dispositions', () => {
    const d = { ...dispositionFixture(), remediation: dispositionFixture('remediated').remediation };
    expect(() => boundary().propose(JSON.stringify({ ...policyFixture(), dispositions: [d] }))).toThrow(/invalid-disposition/);
  });
});

describe('bounded strict parsers and complete identity binding', () => {
  it.each([
    ['unknown schema', (r: ReportFixture) => ({ ...r, schemaVersion: 2 })],
    ['unknown report field', (r: ReportFixture) => ({ ...r, Raw: sentinel })],
    ['missing detector', (r: ReportFixture) => { const { detector: _detector, ...rest } = r; return rest; }],
    ['unknown scope', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, id: 'not-declared' })) })],
    ['wrong ref', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, ref: 'refs/heads/other' })) })],
    ['wrong revision', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, revision: other })) })],
    ['wrong commit count', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, commitCount: 99 })) })],
    ['wrong commit inventory', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, commitsDigest: evidence })) })],
    ['unknown scan status', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, status: 'assumed-clean' })) })],
    ['shallow string', (r: ReportFixture) => ({ ...r, coverage: r.coverage.map(c => ({ ...c, shallow: 'false' })) })],
    ['finding count mismatch', (r: ReportFixture) => ({ ...r, findingCount: 0 })],
    ['string finding count', (r: ReportFixture) => ({ ...r, findingCount: '1' })],
    ['fractional finding count', (r: ReportFixture) => ({ ...r, findingCount: 0.5 })],
    ['unknown finding field', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, secret: sentinel })) })],
    ['unexpected source state', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, currentSource: 'deleted-alert' })) })],
    ['unknown finding rule', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, finding: { ...f.finding, ruleId: 'undeclared-rule' } })) })],
    ['unknown finding commit', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, finding: { ...f.finding, commit: other } })) })],
    ['undeclared location', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, finding: { ...f.finding, pathParts: ['other.txt'] } })) })],
    ['wrong location case', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, finding: { ...f.finding, pathParts: ['Tests', 'folder with spaces', 'fixture.txt'] } })) })],
    ['missing finding scopes', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, scopeIds: [] })) })],
    ['duplicate findings', (r: ReportFixture) => ({ ...r, findingCount: 2, findings: [...r.findings, ...r.findings] })],
    ['duplicate scope results', (r: ReportFixture) => ({ ...r, coverage: [...r.coverage, ...r.coverage] })],
    ['duplicate finding scope', (r: ReportFixture) => ({ ...r, findings: r.findings.map(f => ({ ...f, scopeIds: [...f.scopeIds, ...f.scopeIds] })) })]
  ])('rejects %s', (_name, change) => {
    expect(() => boundary().assess(capture(change(reportFixture())))).toThrow(/Secrets contract rejected/);
  });

  it.each([
    ['repository', 'another/repository'], ['event', 'push'], ['ref', 'refs/heads/main'],
    ['sourceCommit', other], ['baseCommit', other], ['workflowCommit', other],
    ['runId', 456], ['attempt', 2], ['basePolicyCommit', other],
    ['basePolicyDigest', evidence], ['inventoryDigest', evidence]
  ])('binds exact %s', (key, value) => {
    const r = reportFixture();
    const changed = { ...r, identity: { ...r.identity, [key]: value } };
    expect(() => boundary().assess(capture(changed))).toThrow(/identity-mismatch/);
  });

  it.each([
    ['name', 'other-scanner'], ['version', '0.0.1'],
    ['binaryDigest', evidence], ['configDigest', evidence]
  ])('binds detector %s', (key, value) => {
    const r = reportFixture();
    expect(() => boundary().assess(capture({ ...r, detector: { ...r.detector, [key]: value } }))).toThrow(/Secrets contract rejected/);
  });

  it.each([
    ['../../private'], ['..'], ['.'], ['/home'], ['C:\\Users'], ['dir/../file'],
    ['dir\\file'], ['file\u0000'], ['file\n'], ['file\u007f'], ['file\u009b'],
    ['file\u202e'], ['file:stream'], ['file*'], ['file?'], ['trailing.'],
    ['trailing '], [' leading'], ['CON'], ['NUL.txt'], ['COM1'], ['LPT9.txt'], []
  ])('rejects nonportable or unsafe path parts %j', (...parts) => {
    const r = reportFixture();
    const f = findingFixture();
    f.finding.pathParts = parts;
    r.findings = [f];
    expect(() => boundary().assess(capture(r))).toThrow(/Secrets contract rejected/);
  });

  it.each([
    ['missing tree', (c: ContextFixture) => ({ ...c, scopes: c.scopes.slice(1) })],
    ['head-only scope', (c: ContextFixture) => ({ ...c, scopes: c.scopes.slice(0, 1) })],
    ['empty scope', (c: ContextFixture) => ({ ...c, scopes: [] })],
    ['empty commits', (c: ContextFixture) => ({ ...c, scopes: c.scopes.map(s => ({ ...s, commits: [] })) })],
    ['duplicate commits', (c: ContextFixture) => ({ ...c, scopes: c.scopes.map(s => ({ ...s, commits: [...s.commits, ...s.commits] })) })],
    ['duplicate scopes', (c: ContextFixture) => ({ ...c, scopes: [...c.scopes, ...c.scopes] })],
    ['case alias paths', (c: ContextFixture) => ({ ...c, locations: [['file.txt'], ['FILE.txt']] })],
    ['empty location registry', (c: ContextFixture) => ({ ...c, locations: [] })],
    ['unbounded freshness', (c: ContextFixture) => ({ ...c, maxAgeSeconds: 86_401 })],
    ['stale scope observation', (c: ContextFixture) => ({ ...c, observedAt: '2026-09-01T00:00:00Z' })],
    ['future scope observation', (c: ContextFixture) => ({ ...c, observedAt: '2027-09-01T00:00:00Z' })],
    ['wrong head identity', (c: ContextFixture) => ({ ...c, identity: { ...c.identity, sourceCommit: other } })],
    ['PR without introduced history', (c: ContextFixture) => ({ ...c, mode: 'intake', identity: { ...c.identity, event: 'pull_request', baseCommit: base } })],
    ['wrong trusted policy bytes', (c: ContextFixture) => ({ ...c, policyDigest: evidence })]
  ])('rejects trusted context with %s', (_name, change) => {
    expect(() => createSecretsBoundary(JSON.stringify(change(contextFixture())), JSON.stringify(policyFixture()))).toThrow(/Secrets contract rejected/);
  });

  it.each([
    ['duplicate rule', (p: PolicyFixture) => ({ ...p, rules: [...p.rules, ...p.rules] })],
    ['no rules', (p: PolicyFixture) => ({ ...p, rules: [] })],
    ['duplicate disposition', (p: PolicyFixture) => ({ ...p, dispositions: [dispositionFixture(), dispositionFixture()] })],
    ['duplicate exclusions', (p: PolicyFixture) => ({ ...p, dispositions: [dispositionFixture()], exclusions: [selectorFixture(), selectorFixture()] })],
    ['unknown policy entry', (p: PolicyFixture) => ({ ...p, ignoreUnfixed: true })],
    ['broad baseline', (p: PolicyFixture) => ({ ...p, baseline: '*' })],
    ['mutable scanner version', (p: PolicyFixture) => ({ ...p, detector: { ...p.detector, version: 'latest' } })]
  ])('rejects policy %s', (_name, change) => {
    expect(() => boundary().propose(JSON.stringify(change(policyFixture())))).toThrow(/Secrets contract rejected/);
  });

  it.each([
    ['starts before scope observation', { startedAt: '2026-09-19T04:00:00Z' }],
    ['completes before starting', { completedAt: at }],
    ['completes in future', { completedAt: '2026-09-21T00:00:00Z' }],
    ['wrong observation', { observedAt: '2026-09-20T04:01:00Z' }],
    ['invalid calendar date', { completedAt: '2026-02-30T00:00:00Z' }],
    ['missing timezone', { completedAt: '2026-09-20T04:40:00' }]
  ])('rejects evidence that %s', (_name, change) => {
    expect(() => boundary().assess(capture({ ...reportFixture(), ...change }))).toThrow(/Secrets contract rejected/);
  });

  it('accepts UTC second-resolution timestamps and the exact freshness boundary', () => {
    const p = policyFixture();
    const c = contextFixture(p);
    c.observedAt = '2026-09-20T04:00:00Z';
    c.now = '2026-09-21T04:00:00Z';
    const r = reportFixture(p, c, []);
    r.startedAt = c.observedAt;
    r.completedAt = c.observedAt;
    expect(boundary(p, c).assess(capture(r, { exitCode: 0 })).gate).toBe('passed');
    c.now = '2026-09-21T04:00:00.001Z';
    expect(() => boundary(p, c)).toThrow(/stale-evidence/);
  });

  it.each([
    ['oversized report', Buffer.alloc(SECRET_LIMITS.jsonBytes + 1, 32)],
    ['too many findings', Buffer.from(JSON.stringify({ ...reportFixture(), findings: Array.from({ length: SECRET_LIMITS.findings + 1 }, findingFixture) }))],
    ['too many scopes', Buffer.from(JSON.stringify({ ...reportFixture(), coverage: Array.from({ length: SECRET_LIMITS.scopes + 1 }, () => reportFixture().coverage[0]) }))],
    ['deep JSON', Buffer.from('['.repeat(30) + '0' + ']'.repeat(30))],
    ['oversized string', Buffer.from(JSON.stringify({ data: 'x'.repeat(513) }))],
    ['invalid UTF-8', new Uint8Array([0xff])],
    ['nonfinite number', Buffer.from('{"count":1e999}')],
    ['prototype mutation', Buffer.from('{"__proto__":{}}')],
    ['trailing JSON', Buffer.from('{}{}')],
    ['duplicate JSON key', Buffer.from('{"schemaVersion":1,"schemaVersion":1}')],
    ['nested duplicate key', Buffer.from('{"identity":{"runId":123,"runId":456}}')]
  ])('rejects %s within metadata bounds', (_name, report) => {
    expect(() => boundary().assess(capture(undefined, { report }))).toThrow(/Secrets contract rejected/);
  });
});

describe('no raw scanner output or parser errors reach public surfaces', () => {
  it.each(['stdout', 'stderr'] as const)('rejects sentinel in %s silently', channel => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let rejection: unknown;
    try {
      boundary().assess(capture(undefined, { [channel]: Buffer.from(sentinel) }));
    } catch (failure: unknown) {
      rejection = failure;
    }
    const writes = { stdout: stdout.mock.calls.length, stderr: stderr.mock.calls.length };
    stdout.mockRestore();
    stderr.mockRestore();
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toBe('SecretContractError: Secrets contract rejected: unsafe-output.');
    expect(String(rejection)).not.toContain(sentinel);
    expect(JSON.stringify(rejection)).not.toContain(sentinel);
    expect(rejection).not.toHaveProperty('cause');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(writes).toEqual({ stdout: 0, stderr: 0 });
  });

  it.each([
    `${sentinel} not JSON`,
    `{"unterminated":"${sentinel}`,
    `{"schemaVersion":1,"findings":[{"Secret":"${sentinel}","Match":"${sentinel}","Line":"${sentinel}"}]}`,
    JSON.stringify({ ...reportFixture(), error: sentinel }),
    JSON.stringify({ ...reportFixture(), findings: [{ finding: { ...selectorFixture(), pathParts: [sentinel] }, scopeIds: ['develop-history'], currentSource: 'absent' }] }),
    JSON.stringify({ ...reportFixture(), findings: [{ finding: { ...selectorFixture(), ruleId: sentinel }, scopeIds: ['develop-history'], currentSource: 'absent' }] }),
    JSON.stringify({ ...reportFixture(), detector: { ...policyFixture().detector, version: sentinel } }),
    JSON.stringify({ ...reportFixture(), coverage: [{ error: sentinel }] }),
    `[{"secret":"${sentinel}","html_url":"https://invalid.example/alert"}]`
  ])('does not retain raw report or native parser exception %#', report => {
    let rejection: unknown;
    try { boundary().assess(capture(undefined, { report: Buffer.from(report) })); } catch (error: unknown) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).not.toContain(sentinel);
    expect(JSON.stringify(rejection)).not.toContain(sentinel);
    expect(rejection).not.toHaveProperty('cause');
    if (rejection instanceof Error) expect(rejection.stack).not.toContain(sentinel);
  });

  it('only serializes immutable, issued results; public comments/artifacts cannot add excerpts', () => {
    const b = boundary();
    const result = b.assess(capture());
    const report = b.serialize(result);
    const publicArtifact = JSON.stringify(result);
    const publicComment = `Secrets evaluation: ${report}`;
    for (const output of [report, publicArtifact, publicComment]) {
      expect(output).not.toContain(sentinel);
      expect(output).not.toContain('fixture.txt');
      expect(output).not.toContain('fixture-rule');
      expect(output).not.toContain('credential-owner');
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(Object.isFrozen(result.findings[0])).toBe(true);
    expect(Object.isFrozen(result.coverage[0])).toBe(true);
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(() => b.serialize({ ...result, sourceCommit: sentinel })).toThrow(/invalid-shape/);
    const forged = { ...result, rawMatch: sentinel };
    expect(() => b.serialize(forged)).toThrow(/invalid-shape/);
    expect(() => boundary().serialize(result)).toThrow(/invalid-shape/);
    expect(b.serialize(result)).toBe(report);
  });

  it('does not echo even metadata-shaped sentinels from a trusted registry in public output', () => {
    const p = policyFixture();
    const c = contextFixture(p);
    c.locations = [[sentinel]];
    const f = { ...findingFixture(), finding: { ...selectorFixture(), pathParts: [sentinel] } };
    const b = boundary(p, c);
    const result = b.assess(capture(reportFixture(p, c, [f])));
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(b.serialize(result)).not.toContain(sentinel);
    expect(result.findings[0]?.locationIndex).toBe(0);
  });

  it.each([
    ['timeout', { timedOut: true }],
    ['signal termination', { signal: 'SIGTERM', exitCode: null }],
    ['sentinel signal', { signal: sentinel }],
    ['scanner failure', { exitCode: 2 }],
    ['missing exit', { exitCode: null }],
    ['missing report', { report: null }],
    ['empty report', { report: new Uint8Array() }],
    ['findings with success exit', { exitCode: 0 }]
  ])('fails closed on %s without reusing successful output', (_name, overrides) => {
    const b = boundary();
    expect(b.assess(capture(reportFixture(undefined, undefined, []), { exitCode: 0 })).gate).toBe('passed');
    expect(() => b.assess(capture(undefined, overrides))).toThrow(/Secrets contract rejected/);
  });

  it('does not turn a nonzero finding exit and empty findings into success', () => {
    expect(() => boundary().assess(capture(reportFixture(undefined, undefined, [])))).toThrow(/scanner-failed/);
  });
});

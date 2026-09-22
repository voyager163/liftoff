import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptedBaseIdentity, admissionGitFailureMetadata, canonicalDigest, evaluateAdmission, loadAdoptedBase, readAdoptedPolicyData,
  rejectAdmissionAsPublicationEvidence, revalidateAdmission,
  type AdmissionObservation, type AdoptedBaseHandle, type PolicyAdapter, type RawFinding
} from '../scripts/repository-security/admission.ts';
import { findingDigest, type SecurityFinding } from '../scripts/repository-security/evidence.ts';
import { adoptedSecretDispositionVerdict, secretDispositionAdapter, vulnerabilityPolicyAdapter } from '../scripts/repository-security/policy-data.ts';
import { npmPolicyAdapter, npmRawFindings } from '../scripts/repository-security/npm-policy.ts';
import { createAdmissionGitFixture } from './fixtures/security-git.js';
import { verifyPrExecution } from '../scripts/repository-security/workflow-invocation.ts';

const now = new Date('2026-09-20T12:00:00.000Z');
const hash = `sha256:${'a'.repeat(64)}`, secondHash = `sha256:${'b'.repeat(64)}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const fullFinding: SecurityFinding = {
  id: 'fixture-advisory', kind: 'vulnerability', tool: 'fixture', rule: 'GHSA-fixture',
  scope: 'fixture-graph', component: 'fixture-package', version: '1.0.0',
  chains: [['application', 'fixture-package']], location: ['package-lock.json'],
  artifactDigest: hash, severity: 'high', owner: 'voyager163'
};
const finding: RawFinding = { key: findingDigest(fullFinding), kind: 'vulnerability', confirmedUnremediated: false };
const secret: RawFinding = { key: secondHash, kind: 'secret', confirmedUnremediated: false };

function exception(overrides: Record<string, unknown> = {}) {
  return {
    findingDigest: finding.key, disposition: 'mitigated', owner: 'voyager163',
    rationale: 'Exact nonfunctional fixture behavior.', mitigation: 'Keep the fixture isolated.',
    reviewedAt: '2026-09-01', reviewBy: '2026-10-01', ...overrides
  };
}

function policy(exceptions: unknown[] = []) { return JSON.stringify({ schemaVersion: 1, exceptions }); }

const registry = {
  schemaVersion: 1, repository: 'voyager163/liftoff',
  policyData: [{ id: 'exceptions', adapter: 'vulnerability', pathParts: ['security', 'exceptions.json'] }],
  controlInputs: [['validator.txt'], ['security', 'control-plane.json']],
  validatorInputs: [['validator.txt']]
};

async function scenario(
  before = policy(), after = policy([exception()]), changes: Record<string, string> = {},
  registryValue = registry, baseExtras: Record<string, string> = {}
) {
  const fixture = await createAdmissionGitFixture();
  cleanups.push(() => fixture.cleanup());
  const baseFiles = {
    'app.js': 'export const source = "unchanged";\n',
    'validator.txt': 'Fixed synthetic validator identity.\n',
    'security/control-plane.json': JSON.stringify(registryValue),
    'security/exceptions.json': before, ...baseExtras
  };
  const baseCommit = await fixture.commit(baseFiles);
  const headCommit = await fixture.commit({ ...baseFiles, 'security/exceptions.json': after, ...changes });
  const handle = await loadAdoptedBase(fixture.root, {
    repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit, headCommit, now
  });
  return { fixture, handle, baseCommit, headCommit };
}

function observations(handle: AdoptedBaseHandle, baseFindings = [finding], candidateFindings = baseFindings) {
  const identity = adoptedBaseIdentity(handle);
  const shared = {
    attempt: 1, validatorDigest: identity.validatorDigest, policyDigest: identity.policyDigest,
    analysisConfigurationDigest: hash, coverageDigest: hash, completedAt: '2026-09-20T11:00:00.000Z',
    execution: 'success' as const, integrity: 'success' as const, functional: 'success' as const,
    coverageComplete: true, findingPolicy: 'blocked' as const
  };
  const base: AdmissionObservation = {
    ...shared, sourceCommit: identity.baseCommit, runId: '101',
    protectedInputsDigest: identity.baseProtectedInputsDigest, findings: baseFindings
  };
  const candidate: AdmissionObservation = {
    ...shared, sourceCommit: identity.headCommit, runId: '202',
    protectedInputsDigest: identity.headProtectedInputsDigest, findings: candidateFindings
  };
  return { base, candidate };
}

function expected(value: ReturnType<typeof observations>) {
  return {
    base: { sourceCommit: value.base.sourceCommit, runId: value.base.runId, attempt: value.base.attempt, reportDigest: canonicalDigest(value.base) },
    candidate: { sourceCommit: value.candidate.sourceCommit, runId: value.candidate.runId, attempt: value.candidate.attempt, reportDigest: canonicalDigest(value.candidate) }
  };
}

const vulnerabilityAdapters = new Map<string, PolicyAdapter>([['vulnerability', vulnerabilityPolicyAdapter([fullFinding])]]);

async function hostedScenario(extraTestedSource = false) {
  const workflowPath = '.github/workflows/codeql.yml';
  const invocationPath = 'scripts/repository-security/workflow-invocation.ts';
  const hostedRegistry = { ...registry,
    controlInputs: [...registry.controlInputs, workflowPath.split('/'), invocationPath.split('/')],
    validatorInputs: [...registry.validatorInputs, invocationPath.split('/')]
  };
  const extras = { [workflowPath]: 'name: Synthetic source analysis fixture\n', [invocationPath]: '// Synthetic validator identity only.\n' };
  const f = await scenario(policy(), policy([exception()]), {}, hostedRegistry, extras);
  const testedSource = extraTestedSource ? await f.fixture.commit({
    'app.js': 'export const source = "changed combined tree";\n',
    'validator.txt': 'Fixed synthetic validator identity.\n',
    'security/control-plane.json': JSON.stringify(hostedRegistry),
    'security/exceptions.json': policy([exception()]), ...extras
  }) : f.headCommit;
  const merge = await f.fixture.testedMerge(f.baseCommit, f.headCommit, testedSource);
  const environment: NodeJS.ProcessEnv = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'voyager163/liftoff', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_SHA: merge.commit, GITHUB_WORKFLOW_SHA: merge.commit, GITHUB_REF: 'refs/pull/91/merge',
    GITHUB_BASE_REF: 'develop', GITHUB_RUN_ID: '202', GITHUB_RUN_ATTEMPT: '1',
    LIFTOFF_PR_BASE_SHA: f.baseCommit, LIFTOFF_PR_HEAD_SHA: f.headCommit
  };
  const root = '/repos/voyager163/liftoff', jobName = 'Synthetic source analysis';
  const records: Record<string, unknown> = {
    [`${root}/pulls/91`]: { number: 91, state: 'open', merged: false, merge_commit_sha: merge.commit,
      base: { sha: f.baseCommit, ref: 'develop', repo: { full_name: 'voyager163/liftoff' } }, head: { sha: f.headCommit } },
    [`${root}/actions/runs/202`]: { id: 202, run_attempt: 1, event: 'pull_request', head_sha: f.headCommit,
      path: workflowPath, repository: { full_name: 'voyager163/liftoff' }, status: 'completed', conclusion: 'failure' },
    [`${root}/git/commits/${merge.commit}`]: { sha: merge.commit, tree: { sha: merge.tree }, parents: merge.parents.map(sha => ({ sha })) },
    [`${root}/actions/jobs/101`]: { id: 101, run_id: 202, run_attempt: 1, head_sha: f.headCommit, name: jobName,
      status: 'completed', conclusion: 'failure', completed_at: '2026-09-20T11:59:00Z',
      check_run_url: 'https://api.github.com/repos/voyager163/liftoff/check-runs/102' },
    [`${root}/check-runs/102`]: { id: 102, head_sha: f.headCommit, name: jobName,
      status: 'completed', conclusion: 'failure', app: { id: 15368, slug: 'github-actions' } }
  };
  const execution = verifyPrExecution(environment, { checkoutSha: merge.commit, mergeParents: merge.parents, tree: merge.tree },
    { workflow: workflowPath, jobId: 101, jobName }, now, (_command, args) => {
      const value = records[args.at(-1)!];
      if (!value) throw new Error('Unregistered fixture metadata route.');
      const stdout = JSON.stringify(value);
      return { pid: 1, stdout, stderr: '', output: [null, stdout, ''], status: 0, signal: null };
    });
  const context = { repository: 'voyager163/liftoff' as const, baseRef: 'develop' as const,
    baseCommit: f.baseCommit, headCommit: f.headCommit, now, executionMode: 'hosted-pr' as const, execution };
  const handle = await loadAdoptedBase(f.fixture.root, context), identity = adoptedBaseIdentity(handle);
  const evidence = observations(handle);
  evidence.candidate.sourceCommit = identity.testedCommit;
  evidence.candidate.protectedInputsDigest = identity.testedProtectedInputsDigest;
  evidence.candidate.executionBindingDigest = identity.executionBindingDigest!;
  return { ...f, handle, context, evidence, merge };
}

describe('actual tested tree and independent proposal identities (real Git, simulated hosted readback)', () => {
  it('evaluates exact policy maintenance against the tested tree without relabelling findings as PR-head execution', async () => {
    const f = await hostedScenario();
    const result = evaluateAdmission(f.handle, f.evidence, expected(f.evidence), vulnerabilityAdapters);
    expect(result).toMatchObject({
      decision: 'maintenance-admitted', baseCommit: f.baseCommit, headCommit: f.headCommit,
      testedCommit: f.merge.commit, sourceMode: 'verified-pr-tested-merge',
      findingPolicy: 'blocked', policyAdopted: false, publicationQualified: false, hostedQualification: false
    });
    expect(f.merge.commit).not.toBe(f.headCommit);
    const relabelled = structuredClone(f.evidence);
    relabelled.candidate.sourceCommit = f.headCommit;
    expect(() => evaluateAdmission(f.handle, relabelled, expected(relabelled), vulnerabilityAdapters))
      .toThrow('admission-commit-mismatch');
  });
  it.each(['binding', 'attempt', 'run', 'inputs', 'policy', 'inventory', 'new-finding', 'functional', 'integrity'] as const)(
    'rejects or blocks %s drift despite correct base/head/tested labels', async change => {
    const f = await hostedScenario(), evidence = structuredClone(f.evidence);
    if (change === 'binding') delete evidence.candidate.executionBindingDigest;
    if (change === 'attempt') evidence.candidate.attempt++;
    if (change === 'run') evidence.candidate.runId = '203';
    if (change === 'inputs') evidence.candidate.protectedInputsDigest = secondHash;
    if (change === 'policy') evidence.candidate.policyDigest = secondHash;
    if (change === 'inventory') evidence.candidate.coverageDigest = secondHash;
    if (change === 'new-finding') {
      evidence.candidate.findings = [...evidence.candidate.findings, { ...finding, key: secondHash }];
      expect(evidence.base.findings).toHaveLength(1);
    }
    if (change === 'functional') evidence.candidate.functional = 'failure';
    if (change === 'integrity') evidence.candidate.integrity = 'failure';
    if (change === 'inventory' || change === 'new-finding') {
      expect(evaluateAdmission(f.handle, evidence, expected(evidence), vulnerabilityAdapters).decision).toBe('blocked');
    } else expect(() => evaluateAdmission(f.handle, evidence, expected(evidence), vulnerabilityAdapters)).toThrow();
  });
  it('does not make an altered combined source tree eligible merely because the PR changed only policy data', async () => {
    const f = await hostedScenario(true);
    expect(() => evaluateAdmission(f.handle, f.evidence, expected(f.evidence), vulnerabilityAdapters))
      .toThrow('maintenance-tested-inputs-changed');
  });
  it('requires a live origin handle and preserves explicitly local legacy fixtures', async () => {
    const f = await hostedScenario();
    await expect(loadAdoptedBase(f.fixture.root, { ...f.context, execution: undefined })).rejects.toThrow('hosted-execution-required');
    await expect(loadAdoptedBase(f.fixture.root, { ...f.context, execution: structuredClone(f.context.execution) }))
      .rejects.toThrow('unverified-hosted-execution');
    const legacy = await scenario(), evidence = observations(legacy.handle);
    expect(evaluateAdmission(legacy.handle, evidence, expected(evidence), vulnerabilityAdapters)).toMatchObject({
      sourceMode: 'local-head-only', testedCommit: legacy.headCommit, executionBindingDigest: null, hostedQualification: false
    });
  });
});

describe('trusted-base normal and policy-only maintenance admission', () => {
  it('reports only finite Git operation/code categories without paths, output or credentials', () => {
    const sentinel = 'PRIVATE_GIT_DIAGNOSTIC_SENTINEL';
    const diagnostic = admissionGitFailureMetadata(['rev-parse', '--show-toplevel'], {
      code: 128, stderr: `fatal: unable to read config file ${sentinel}`, stdout: sentinel, path: sentinel
    });
    expect(diagnostic).toEqual({ operation: 'root', nativeCode: 128, reason: 'config-unreadable', timedOut: false });
    expect(JSON.stringify(diagnostic)).not.toContain(sentinel);
    expect(admissionGitFailureMetadata(['cat-file', 'blob', sentinel], {
      code: sentinel, stderr: sentinel, killed: true
    })).toEqual({ operation: 'blob-content', nativeCode: 'unclassified', reason: 'unclassified', timedOut: true });
  });
  it('admits only observed-base exact Trivy unscored policy proposals while retaining the blocking verdict', async () => {
    const unscored: SecurityFinding = {
      ...fullFinding, kind: 'policy', tool: 'trivy', rule: 'DLA-4783-1',
      policyClass: 'trivy-valid-native-unscored-advisory', upstreamSeverity: 'UNKNOWN',
      component: hash, version: hash, location: ['image', 'os-pkgs', 'debian', 'a'.repeat(64)]
    };
    const observed: RawFinding = { key: findingDigest(unscored), kind: 'policy', confirmedUnremediated: false };
    const grant = exception({ findingDigest: observed.key });
    const adapters = new Map([['vulnerability', vulnerabilityPolicyAdapter([unscored])]]);
    const { handle } = await scenario(policy(), policy([grant]));
    const evidence = observations(handle, [observed], [observed]);
    expect(evaluateAdmission(handle, evidence, expected(evidence), adapters)).toMatchObject({
      decision: 'maintenance-admitted', findingPolicy: 'blocked', policyAdopted: false, publicationQualified: false
    });
    const future = observations(handle, [], [observed]);
    expect(evaluateAdmission(handle, future, expected(future), adapters).decision).toBe('blocked');
    for (const changes of [
      { findingDigest: hash }, { reviewBy: '2026-10-02' }
    ]) {
      const invalid = await scenario(policy(), policy([{ ...grant, ...changes }]));
      const raw = observations(invalid.handle, [observed], [observed]);
      expect(evaluateAdmission(invalid.handle, raw, expected(raw), adapters).decision).toBe('blocked');
    }
  });

  it('admits only exact existing-base unscored-policy proposals without activating them before merge', async () => {
    const unscored: SecurityFinding = {
      ...fullFinding, kind: 'policy', tool: 'osv-scanner', rule: 'GO-2026-5932',
      policyClass: 'osv-valid-unscored-advisory', upstreamSeverity: 'unscored', severity: 'high'
    };
    const observed: RawFinding = { key: findingDigest(unscored), kind: 'policy', confirmedUnremediated: false };
    const grant = exception({ findingDigest: observed.key });
    const adapters = new Map([['vulnerability', vulnerabilityPolicyAdapter([unscored])]]);
    const { handle } = await scenario(policy(), policy([grant]));
    const evidence = observations(handle, [observed], [observed]);
    expect(evaluateAdmission(handle, evidence, expected(evidence), adapters)).toMatchObject({
      decision: 'maintenance-admitted', findingPolicy: 'blocked', policyAdopted: false, publicationQualified: false
    });
    const future = observations(handle, [], [observed]);
    expect(evaluateAdmission(handle, future, expected(future), adapters).decision).toBe('blocked');
    const overlong = await scenario(policy(), policy([{ ...grant, reviewBy: '2026-10-02' }]));
    const invalid = observations(overlong.handle, [observed], [observed]);
    expect(evaluateAdmission(overlong.handle, invalid, expected(invalid), adapters).decision).toBe('blocked');
    const generic = await scenario(policy(), policy([{ ...grant, findingDigest: hash }]));
    const unmatched = observations(generic.handle, [observed], [observed]);
    expect(evaluateAdmission(generic.handle, unmatched, expected(unmatched), adapters).decision).toBe('blocked');
  });

  it('reuses actual npm policy normalization and strict chains, expiry and stale-entry enforcement', async () => {
    const auditReport = JSON.parse(await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'template-dependency-audit', 'direct.json'), 'utf8'));
    const inputs = [{ entry: { id: 'liftoff-cli', label: 'Liftoff CLI', pathParts: ['package-lock.json'] }, auditReport }];
    const raw = npmRawFindings(inputs);
    const npmException = {
      advisoryId: 'GHSA-AAAA-BBBB-CCCC', package: 'direct-package', manifestPathParts: ['package-lock.json'],
      dependencyChains: [['direct-package']], disposition: 'mitigated',
      rationale: 'Synthetic test only.', mitigation: 'Do not execute the synthetic package.', owner: 'voyager163',
      reviewedAt: '2026-09-01', reviewBy: '2026-10-01'
    };
    const npmRegistry = { ...registry, policyData: [{ id: 'npm', adapter: 'npm', pathParts: ['security', 'exceptions.json'] }] };
    const adapters = new Map([['npm', npmPolicyAdapter(inputs)]]);
    const valid = await scenario(policy(), policy([npmException]), {}, npmRegistry);
    const evidence = observations(valid.handle, raw);
    expect(evaluateAdmission(valid.handle, evidence, expected(evidence), adapters)).toMatchObject({
      decision: 'maintenance-admitted', findingPolicy: 'blocked'
    });
    for (const override of [
      { dependencyChains: [['other-package', 'direct-package']] },
      { reviewBy: '2026-10-02' },
      { manifestPathParts: ['services', 'telemetry-ingest', 'package-lock.json'] }
    ]) {
      const invalid = await scenario(policy(), policy([{ ...npmException, ...override }]), {}, npmRegistry);
      const invalidEvidence = observations(invalid.handle, raw);
      expect(evaluateAdmission(invalid.handle, invalidEvidence, expected(invalidEvidence), adapters).decision).toBe('blocked');
    }
    const unknownSeverity = JSON.parse(JSON.stringify(auditReport).replaceAll('"severity":"high"', '"severity":"unknown"'));
    expect(() => npmRawFindings([{ ...inputs[0]!, auditReport: unknownSeverity }])).toThrow('invalid-npm-observation');
  });

  it('admits exact data-only proposals without clearing findings or issuing publication evidence', async () => {
    const { handle, baseCommit, headCommit } = await scenario();
    const evidence = observations(handle);
    const result = evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters);
    expect(baseCommit).not.toBe(headCommit);
    expect(adoptedBaseIdentity(handle).baseProtectedInputsDigest).toBe(adoptedBaseIdentity(handle).headProtectedInputsDigest);
    expect(result).toMatchObject({
      decision: 'maintenance-admitted', findingPolicy: 'blocked',
      policyAdopted: false, publicationQualified: false, changes: 1, newFindings: 0
    });
    expect(evidence.candidate.findingPolicy).toBe('blocked');
    expect(() => rejectAdmissionAsPublicationEvidence(result)).toThrow('admission-is-not-publication-qualification');
  });

  it('loads adopted policy from the base object rather than candidate or dirty working files', async () => {
    const { fixture, handle, baseCommit, headCommit } = await scenario();
    const original = adoptedBaseIdentity(handle);
    await writeFile(path.join(fixture.root, 'security', 'control-plane.json'), '{"approved":true}');
    await writeFile(path.join(fixture.root, 'security', 'exceptions.json'), '{"approved":true}');
    const reloaded = await loadAdoptedBase(fixture.root, {
      repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit, headCommit, now
    });
    expect(adoptedBaseIdentity(reloaded)).toEqual(original);
    expect(() => adoptedBaseIdentity({ kind: 'independently-loaded-base' })).toThrow('unverified-adopted-base');
    await expect(loadAdoptedBase(fixture.root, {
      repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit, headCommit, validatorDigest: secondHash, now
    })).rejects.toThrow('validator-source-mismatch');
  });

  it('uses a proposal only after it becomes independently loaded base content', async () => {
    const initial = await scenario();
    expect(readAdoptedPolicyData(initial.handle, 'exceptions')).toBe(policy());
    const laterHead = await initial.fixture.commit({
      'app.js': 'export const source = "unchanged";\n',
      'validator.txt': 'Fixed synthetic validator identity.\n',
      'security/control-plane.json': JSON.stringify(registry),
      'security/exceptions.json': policy([exception()]),
      'README.md': 'A normal documentation change after adoption.\n'
    });
    const adopted = await loadAdoptedBase(initial.fixture.root, {
      repository: 'voyager163/liftoff', baseRef: 'develop',
      baseCommit: initial.headCommit, headCommit: laterHead, now
    });
    const actualBasePolicy = readAdoptedPolicyData(adopted, 'exceptions');
    expect(actualBasePolicy).toBe(policy([exception()]));
    expect(vulnerabilityAdapters.get('vulnerability')!.parse(actualBasePolicy, [finding], now).records[0]?.valid).toBe(true);
    const evidence = observations(adopted);
    evidence.base.findingPolicy = 'passed';
    evidence.candidate.findingPolicy = 'passed';
    expect(evaluateAdmission(adopted, evidence, expected(evidence), vulnerabilityAdapters)).toMatchObject({
      decision: 'normal-admitted', findingPolicy: 'passed', policyAdopted: false, publicationQualified: false
    });
  });

  it('invalidates a previous decision when a newly loaded head or evidence changes', async () => {
    const original = await scenario();
    const evidence = observations(original.handle);
    const admitted = evaluateAdmission(original.handle, evidence, expected(evidence), vulnerabilityAdapters);
    expect(revalidateAdmission(admitted, original.handle, evidence, expected(evidence), vulnerabilityAdapters)).toEqual(admitted);
    const later = await scenario(policy(), policy([exception({ mitigation: 'Changed exact proposal bytes.' })]));
    const laterEvidence = observations(later.handle);
    expect(() => revalidateAdmission(admitted, later.handle, laterEvidence, expected(laterEvidence), vulnerabilityAdapters))
      .toThrow('stale-admission-decision');
    expect(() => evaluateAdmission(later.handle, evidence, expected(evidence), vulnerabilityAdapters)).toThrow('admission-commit-mismatch');
  });

  it.each(['app.js', 'validator.txt', 'package-lock.json', '.github/workflows/new.yml', 'security/new-rules.json'])(
    'never admits a new grant with mixed protected edit %s', async file => {
      const { handle } = await scenario(policy(), policy([exception()]), { [file]: 'Changed protected input.\n' });
      const evidence = observations(handle);
      const result = evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters);
      expect(result.decision).toBe('blocked');
      expect(result.reason).toBe('candidate-grants-cannot-authorize-normal-change');
    });

  it('ignores a candidate attempt to register its own protected source as policy data', async () => {
    const forgedRegistry = { ...registry, policyData: [...registry.policyData,
      { id: 'code', adapter: 'vulnerability', pathParts: ['app.js'] }] };
    const { handle } = await scenario(policy(), policy([exception()]), {
      'security/control-plane.json': JSON.stringify(forgedRegistry), 'app.js': policy([exception()])
    });
    const evidence = observations(handle);
    expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters).decision).toBe('blocked');
  });

  it('rejects future, transplanted, expired and overlong new permissions', async () => {
    for (const entry of [
      exception({ findingDigest: secondHash }), exception({ reviewedAt: '2026-09-21' }),
      exception({ reviewBy: '2026-09-19' }), exception({ reviewBy: '2026-10-02' })
    ]) {
      const { handle } = await scenario(policy(), policy([entry]));
      const evidence = observations(handle);
      expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters).reason)
        .toBe('invalid-new-or-expanded-policy-record');
    }
  });

  it('allows an exact renewal but leaves the expired adopted-policy verdict visible', async () => {
    const { handle } = await scenario(
      policy([exception({ reviewedAt: '2026-08-01', reviewBy: '2026-08-31' })]),
      policy([exception()])
    );
    const evidence = observations(handle);
    expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters)).toMatchObject({
      decision: 'maintenance-admitted', findingPolicy: 'blocked', policyAdopted: false
    });
  });

  it('rejects new raw findings despite unchanged protected source', async () => {
    const { handle } = await scenario();
    const evidence = observations(handle, [finding], [finding, { ...finding, key: secondHash }]);
    expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters).reason)
      .toBe('incompatible-maintenance-observations');
  });

  it.each([
    { execution: 'skipped' }, { execution: 'failure' }, { execution: 'cancelled' },
    { coverageComplete: false }, { integrity: 'failure' }, { functional: 'failure' }
  ] as const)('never admits missing or failed mandatory evidence %j', async override => {
    const { handle } = await scenario();
    const evidence = observations(handle);
    Object.assign(evidence.candidate, override);
    expect(() => evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters))
      .toThrow('incomplete-admission-observation');
  });

  it('rejects forged report fields and stale provenance even with a claimed approval', async () => {
    const { handle } = await scenario();
    const evidence = observations(handle), known = expected(evidence);
    evidence.candidate.findingPolicy = 'passed';
    expect(() => evaluateAdmission(handle, evidence, known, vulnerabilityAdapters)).toThrow('admission-provenance-mismatch');
    evidence.candidate.completedAt = '2026-09-18T11:00:00.000Z';
    expect(() => evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters)).toThrow('stale-admission-observation');
    const forged = await scenario(policy(), JSON.stringify({ schemaVersion: 1, exceptions: [exception()], approved: true }));
    const observationsForForgery = observations(forged.handle);
    expect(() => evaluateAdmission(forged.handle, observationsForForgery, expected(observationsForForgery), vulnerabilityAdapters))
      .toThrow('invalid-vulnerability-policy');
  });

  it('rejects mode changes and case-only policy renames', async () => {
    const first = await scenario();
    const executableHead = await first.fixture.executable(['security', 'exceptions.json']);
    const executable = await loadAdoptedBase(first.fixture.root, {
      repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit: first.baseCommit, headCommit: executableHead, now
    });
    const evidence = observations(executable);
    expect(evaluateAdmission(executable, evidence, expected(evidence), vulnerabilityAdapters).decision).toBe('blocked');

    const renamedHead = await first.fixture.commit({
      'app.js': 'export const source = "unchanged";\n', 'validator.txt': 'Fixed synthetic validator identity.\n',
      'security/control-plane.json': JSON.stringify(registry), 'security/Exceptions.json': policy([exception()])
    });
    const renamed = await loadAdoptedBase(first.fixture.root, {
      repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit: first.baseCommit, headCommit: renamedHead, now
    });
    const renamedEvidence = observations(renamed);
    expect(evaluateAdmission(renamed, renamedEvidence, expected(renamedEvidence), vulnerabilityAdapters).decision).toBe('blocked');
  });

  it('rejects Git symlink policy entries without following a filesystem link', async () => {
    const initial = await scenario();
    const headCommit = await initial.fixture.symlinkEntry(['security', 'exceptions.json']);
    const handle = await loadAdoptedBase(initial.fixture.root, {
      repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit: initial.baseCommit, headCommit, now
    });
    const evidence = observations(handle);
    expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters).decision).toBe('blocked');
  });

  it('permits a normal fix to retire only its resolved exact waiver', async () => {
    const { handle } = await scenario(policy([exception()]), policy(), { 'app.js': 'export const source = "fixed";\n' });
    const evidence = observations(handle, [finding], []);
    evidence.candidate.findingPolicy = 'passed';
    expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters).decision).toBe('normal-admitted');
    evidence.candidate.findings = [finding];
    expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters).reason).toBe('unresolved-waiver-retirement');
    const stale = await scenario(policy([exception()]), policy([exception()]), { 'app.js': 'export const source = "fixed";\n' });
    const staleEvidence = observations(stale.handle, [finding], []);
    staleEvidence.candidate.findingPolicy = 'passed';
    expect(evaluateAdmission(stale.handle, staleEvidence, expected(staleEvidence), vulnerabilityAdapters).reason)
      .toBe('remaining-policy-diagnostics');
  });

  it('does not make a failing base functional check prevent a verified normal fix', async () => {
    const { handle } = await scenario(policy(), policy(), { 'app.js': 'export const source = "fixed";\n' });
    const evidence = observations(handle, [], []);
    evidence.base.functional = 'failure';
    evidence.candidate.findingPolicy = 'passed';
    expect(evaluateAdmission(handle, evidence, expected(evidence), vulnerabilityAdapters).decision).toBe('normal-admitted');
    const headOnly = evaluateAdmission(handle, { base: null, candidate: evidence.candidate },
      { base: null, candidate: expected(evidence).candidate }, vulnerabilityAdapters);
    expect(headOnly).toMatchObject({ decision: 'normal-admitted', newFindings: null });
    const maintenance = await scenario();
    const maintenanceEvidence = observations(maintenance.handle);
    expect(() => evaluateAdmission(maintenance.handle, { base: null, candidate: maintenanceEvidence.candidate },
      { base: null, candidate: expected(maintenanceEvidence).candidate }, vulnerabilityAdapters))
      .toThrow('maintenance-needs-complete-base-observation');
    maintenanceEvidence.base.functional = 'failure';
    expect(() => evaluateAdmission(maintenance.handle, maintenanceEvidence, expected(maintenanceEvidence), vulnerabilityAdapters))
      .toThrow('incomplete-admission-observation');
  });

  it('qualifies exact secret false-positive proposals without trusting candidate approval fields', async () => {
    const secretRegistry = {
      ...registry, policyData: [{ id: 'secrets', adapter: 'secrets', pathParts: ['security', 'exceptions.json'] }]
    };
    const disposition = {
      findingKey: secret.key, state: 'false-positive', owner: 'voyager163',
      rationale: 'pattern-is-not-a-credential', evidenceDigests: [hash], incidentHistory: []
    };
    const secretPolicy = (entries: unknown[]) => JSON.stringify({ schemaVersion: 1, dispositions: entries });
    const adapters = new Map([['secrets', secretDispositionAdapter([{
      key: secret.key, confirmedUnremediated: false, evidenceDigests: [hash], verifiedRemediationDigests: []
    }])]]);
    const facts = [{ key: secret.key, confirmedUnremediated: false, evidenceDigests: [hash], verifiedRemediationDigests: [] }];
    const { handle } = await scenario(secretPolicy([]), secretPolicy([disposition]), {}, secretRegistry);
    const evidence = observations(handle, [secret]);
    expect(evaluateAdmission(handle, evidence, expected(evidence), adapters)).toMatchObject({
      decision: 'maintenance-admitted', findingPolicy: 'blocked', policyAdopted: false
    });
    expect(adoptedSecretDispositionVerdict(handle, 'secrets', facts, [secret], now)).toMatchObject({
      passed: false, blocked: 1, coverageQualified: false, publicationQualified: false
    });
    expect(() => adoptedSecretDispositionVerdict(handle, 'secrets', facts, [], now)).toThrow('secret-fact-observation-mismatch');
    evidence.base.findings = [{ ...secret, confirmedUnremediated: true }];
    evidence.candidate.findings = [{ ...secret, confirmedUnremediated: true }];
    expect(evaluateAdmission(handle, evidence, expected(evidence), adapters).reason).toBe('confirmed-unremediated-exposure');
    const forged = await scenario(secretPolicy([]), secretPolicy([{ ...disposition, approval: { owner: 'voyager163' } }]), {}, secretRegistry);
    const forgedEvidence = observations(forged.handle, [secret]);
    expect(() => evaluateAdmission(forged.handle, forgedEvidence, expected(forgedEvidence), adapters))
      .toThrow('invalid-secret-disposition-record');
  });

  it('honors only actually adopted exact secret data and independently verified remediation references', async () => {
    const secretRegistry = {
      ...registry, policyData: [{ id: 'secrets', adapter: 'secrets', pathParts: ['security', 'exceptions.json'] }]
    };
    const disposition = {
      findingKey: secret.key, state: 'nonfunctional-fixture', owner: 'voyager163',
      rationale: 'documented-nonfunctional-fixture', evidenceDigests: [hash], incidentHistory: []
    };
    const source = JSON.stringify({ schemaVersion: 1, dispositions: [disposition] });
    const adopted = await scenario(source, source, { 'README.md': 'Normal change after adoption.' }, secretRegistry);
    const facts = [{ key: secret.key, confirmedUnremediated: false, evidenceDigests: [hash], verifiedRemediationDigests: [] }];
    expect(adoptedSecretDispositionVerdict(adopted.handle, 'secrets', facts, [secret], now)).toMatchObject({
      authorityCommit: adopted.baseCommit, passed: true, coverageQualified: false
    });
    const fabricatedRemediation = JSON.stringify({ schemaVersion: 1, dispositions: [{
      ...disposition, state: 'remediated', rationale: 'owner-verified-invalidation', incidentHistory: [hash]
    }] });
    expect(secretDispositionAdapter(facts).parse(fabricatedRemediation, [secret], now).records[0]?.valid).toBe(false);
  });

  it('preserves incident history even when withdrawal would reduce permission', async () => {
    const secretRegistry = {
      ...registry, policyData: [{ id: 'secrets', adapter: 'secrets', pathParts: ['security', 'exceptions.json'] }]
    };
    const incident = {
      findingKey: secret.key, state: 'remediated', owner: 'voyager163',
      rationale: 'owner-verified-invalidation', evidenceDigests: [hash], incidentHistory: [hash]
    };
    const { handle } = await scenario(JSON.stringify({ schemaVersion: 1, dispositions: [incident] }),
      JSON.stringify({ schemaVersion: 1, dispositions: [] }), {}, secretRegistry);
    const adapters = new Map([['secrets', secretDispositionAdapter([{
      key: secret.key, confirmedUnremediated: false, evidenceDigests: [hash], verifiedRemediationDigests: [hash]
    }])]]);
    const evidence = observations(handle, [secret]);
    expect(evaluateAdmission(handle, evidence, expected(evidence), adapters).reason).toBe('incident-record-removal-or-change');
  });

  it('retains verified historical remediation after a complete normal fix removes the raw detection', async () => {
    const secretRegistry = {
      ...registry, policyData: [{ id: 'secrets', adapter: 'secrets', pathParts: ['security', 'exceptions.json'] }]
    };
    const record = {
      findingKey: secret.key, state: 'remediated', owner: 'voyager163',
      rationale: 'owner-verified-invalidation', evidenceDigests: [hash], incidentHistory: [hash]
    };
    const source = JSON.stringify({ schemaVersion: 1, dispositions: [record] });
    const fixture = await scenario(source, source, { 'app.js': 'export const source = "resolved";\n' }, secretRegistry);
    const facts = [{ key: secret.key, confirmedUnremediated: false, evidenceDigests: [hash], verifiedRemediationDigests: [hash] }];
    const adapter = secretDispositionAdapter(facts);
    const retained = adapter.parse(source, [], now);
    expect(retained.diagnostics).toEqual([]);
    expect(retained.records[0]).toMatchObject({ valid: true, allowsFinding: false, incident: 'remediated', incidentHistory: [hash] });
    const evidence = observations(fixture.handle, [secret], []);
    evidence.candidate.findingPolicy = 'passed';
    expect(evaluateAdmission(fixture.handle, evidence, expected(evidence), new Map([['secrets', adapter]])).decision)
      .toBe('normal-admitted');
    expect(adoptedSecretDispositionVerdict(fixture.handle, 'secrets', facts, [], now)).toMatchObject({
      passed: true, blocked: 0, coverageQualified: false
    });
    const future = await scenario(
      '{"schemaVersion":1,"dispositions":[]}', source, {}, secretRegistry
    );
    const futureEvidence = observations(future.handle, [], []);
    expect(evaluateAdmission(future.handle, futureEvidence, expected(futureEvidence), new Map([['secrets', adapter]])).reason)
      .toBe('invalid-new-or-expanded-policy-record');
  });
});

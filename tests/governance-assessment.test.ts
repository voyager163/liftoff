import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAssessmentCatalog, validateAssessmentCatalog } from '../src/governance-assessment/catalog.js';
import { classifyFinding, assembleAssessmentReport, validateAssessmentReport } from '../src/governance-assessment/report.js';
import { notObserved, observed, source, sanitizeAssessmentText } from '../src/governance-assessment/sanitize.js';
import { AssessmentFiles } from '../src/governance-assessment/readers.js';
import { parseAssessmentWorkflow } from '../src/governance-assessment/yaml.js';
import { protectedRefs, singleMaintainer, pinnedActions, failOpenFlags, observedRequiredContexts } from '../src/governance-assessment/predicates.js';
import type { AssessmentFinding, ControlDefinition, Observation } from '../src/governance-assessment/types.js';

const now = '2026-09-05T00:00:00.000Z';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root(): Promise<string> {
  await mkdir(path.join(process.cwd(), '.cache'), { recursive: true });
  const value = await mkdtemp(path.join(process.cwd(), '.cache', 'assessment unit '));
  roots.push(value);
  return value;
}
function control(overrides: Partial<ControlDefinition> = {}): ControlDefinition {
  return {
    id: 'governance.example', title: 'Example', policySection: 'Example', severity: 'warning',
    applicability: 'always', evaluator: 'no-codeowners', proofLayers: ['declared'], expected: false,
    phaseIds: [], supported: true, exceptionAllowed: false, ownership: 'project-owned',
    recommendation: 'Review a separate project change.', ...overrides
  };
}
function finding(observation: Observation, overrides: Partial<Parameters<typeof classifyFinding>[0]> = {}): AssessmentFinding {
  return classifyFinding({
    control: control(), scope: { repository: 'owner/repo', environment: null, resource: null },
    applicability: 'applicable', observations: { declared: observation }, ...overrides
  });
}
function report(findings: AssessmentFinding[], options: { disabled?: boolean; failed?: boolean; inputsStable?: boolean } = {}) {
  return assembleAssessmentReport({
    projectRoot: '/project', mode: 'local', target: loadAssessmentCatalog().target,
    projectIdentity: { availability: 'known', manifestVersion: 7, cliVersion: '0.10.3', profile: options.disabled ? 'none' : 'single-maintainer-gitflow', policyVersion: options.disabled ? null : '6', recordedActivationIdentity: null, stateSource: 'not-started' },
    snapshot: { capturedAt: now, repository: 'owner/repo', localHead: null, worktreeDigest: 'a'.repeat(64), inputsStable: options.inputsStable ?? true },
    findings, diagnostics: [], disabled: options.disabled, failed: options.failed
  });
}
const provenance = source('file', 'governance/rulesets/default.json', now, false);

describe('governance assessment report and catalog', () => {
  it('binds non-empty coverage to the installed policy and rejects invalid inventories', () => {
    const { catalog, target } = loadAssessmentCatalog();
    expect(target.policyDigest).toBe(catalog.policyDigest);
    expect(target.catalogDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.controls.length).toBeGreaterThan(20);
    expect(() => validateAssessmentCatalog({ ...catalog, controls: [] })).toThrow(/coverage/);
    expect(() => validateAssessmentCatalog({ ...catalog, policyDigest: 'f'.repeat(64) })).toThrow(/digest/);
    expect(() => validateAssessmentCatalog({ ...catalog, controls: [...catalog.controls, catalog.controls[0]] })).toThrow(/duplicate/);
    expect(() => validateAssessmentCatalog({ ...catalog, controls: catalog.controls.map((item, index) => index ? item : { ...item, evaluator: 'invented' }) })).toThrow(/evaluator/);
  });

  it.each([
    ['aligned', observed(false, provenance), 'applicable'],
    ['conflicting', observed(true, provenance), 'applicable'],
    ['missing', { availability: 'missing', value: null, source: provenance, reason: 'Authoritatively absent.' }, 'applicable'],
    ['not-observed', notObserved('Access denied.'), 'applicable'],
    ['not-observed', observed(false, provenance), 'unknown'],
    ['inapplicable', notObserved('Not needed.'), 'inapplicable']
  ] as const)('classifies %s without treating missing proof as a pass', (expected, observation, applicability) => {
    expect(finding(observation, { applicability }).classification).toBe(expected);
  });

  it('keeps known differences and unobserved live proof together', () => {
    const item = finding(observed(true, provenance), {
      control: control({ proofLayers: ['declared', 'live'] }),
      observations: { declared: observed(true, provenance), live: notObserved('Live collection was not requested.') }
    });
    expect(item.classification).toBe('conflicting');
    expect(item.missingProof).toEqual(['live']);
    expect(report([item])).toMatchObject({ outcome: 'partial', exitCode: 2, coverage: { differences: 1, unobserved: 1 } });
  });

  it('never hides unsupported controls or unknown applicability', () => {
    const item = finding(observed(false, provenance), { control: control({ supported: false, evaluator: 'unsupported' }) });
    expect(item.classification).toBe('not-observed');
    expect(report([item])).toMatchObject({ outcome: 'partial', exitCode: 2, coverage: { unsupported: 1 } });
  });

  it('reports exceptions as differences and never uses one to cover missing proof', () => {
    const exception = { id: 'approved', expiresAt: '2030-01-01T00:00:00Z', envelopeDigest: 'b'.repeat(64) };
    const item = finding(observed(true, provenance), { control: control({ exceptionAllowed: true }), exception });
    expect(item.classification).toBe('approved-exception');
    expect(report([item])).toMatchObject({ outcome: 'differences', exitCode: 2, coverage: { approvedExceptions: 1 } });
    expect(finding(notObserved('Denied'), { control: control({ exceptionAllowed: true }), exception }).classification).toBe('not-observed');
  });

  it('has explicit aligned, disabled, partial, differences and error exits', () => {
    expect(report([finding(observed(false, provenance))])).toMatchObject({ outcome: 'aligned', exitCode: 0 });
    expect(report([], { disabled: true })).toMatchObject({ outcome: 'not-applicable', exitCode: 0 });
    expect(report([finding(observed(true, provenance))])).toMatchObject({ outcome: 'differences', exitCode: 2 });
    expect(report([finding(observed(false, provenance))], { inputsStable: false })).toMatchObject({ outcome: 'partial', exitCode: 2 });
    expect(report([], { failed: true })).toMatchObject({ outcome: 'error', exitCode: 1 });
    expect(report([])).toMatchObject({ outcome: 'error', exitCode: 1 });
  });

  it('orders equivalent findings deterministically and rejects forged schema/digests', () => {
    const a = finding(observed(false, provenance));
    const b = finding(notObserved('Denied'), { control: control({ id: 'governance.second' }) });
    const first = report([a, b]);
    expect(report([b, a])).toEqual(first);
    expect(() => validateAssessmentReport({ ...first, extra: true })).toThrow(/fields/);
    expect(() => validateAssessmentReport({ ...first, resultDigest: 'f'.repeat(64) })).toThrow(/digest/);
    expect(() => validateAssessmentReport({ ...first, outcome: 'aligned', exitCode: 0 })).toThrow(/alignment/);
  });
});

describe('safe assessment parsing and policy predicates', () => {
  it('bounds file reads, protects paths, and detects input changes without writing', async () => {
    const project = await root();
    await writeFile(path.join(project, 'first.json'), '{}');
    const files = new AssessmentFiles(project);
    expect(await files.read(['first.json'])).toBe('{}');
    expect(await files.stable()).toBe(true);
    await writeFile(path.join(project, 'first.json'), '{"changed":true}');
    expect(await files.stable()).toBe(false);
    await expect(files.read(['..', 'outside'])).rejects.toThrow(/unsafe/);
    await expect(files.read(['C:', 'outside'])).rejects.toThrow(/unsafe/);
    await expect(files.read(['\\\\server\\share', 'outside'])).rejects.toThrow(/unsafe/);
    await writeFile(path.join(project, 'large.json'), 'x'.repeat(1024 * 1024 + 1));
    await expect(files.read(['large.json'])).rejects.toThrow(/limit/);
  });

  it.each([
    'name: one\nname: two\n',
    'value: !!js/function function() {}\n',
    'value: !custom unsafe\n'
  ])('rejects unsafe YAML without evaluating project content', (yaml) => {
    expect(() => parseAssessmentWorkflow(yaml, 'workflow.yml')).toThrow(/YAML|tags/);
  });

  it('rejects excessive YAML alias expansion and treats expressions as unknown', () => {
    const yaml = [
      'a: &a [one, two, three, four, five]',
      'b: &b [*a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b]',
      'd: [*c, *c, *c, *c, *c]'
    ].join('\n');
    expect(() => parseAssessmentWorkflow(yaml, 'aliases.yml')).toThrow(/alias/);
    const dynamic = parseAssessmentWorkflow('jobs:\n  check:\n    uses: ${{ inputs.workflow }}\n', 'dynamic.yml');
    expect(pinnedActions([dynamic]).value).toBeNull();
  });

  it('distinguishes immutable action references and required-job fail-open flags', () => {
    const workflow = parseAssessmentWorkflow(`permissions: {contents: read}
jobs:
  scan:
    name: Scan
    steps:
      - uses: actions/checkout@${'a'.repeat(40)}
`, 'workflow.yml');
    expect(pinnedActions([workflow]).value).toBe(true);
    const unsafe = parseAssessmentWorkflow('jobs:\n  scan:\n    name: Scan\n    continue-on-error: true\n    steps: []\n', 'unsafe.yml');
    const rules = [{ target: 'branch', enforcement: 'active', rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Scan', integration_id: null }] } }] }];
    expect(failOpenFlags([unsafe], rules).value).toBe(true);
    expect(failOpenFlags([unsafe], []).value).toBeNull();
  });

  it('honors single-maintainer zero-review rules instead of generic reviewer defaults', () => {
    const rules = [{
      target: 'branch', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [
        { type: 'deletion' }, { type: 'non_fast_forward' },
        { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: false, require_last_push_approval: false, dismiss_stale_reviews_on_push: true } },
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: true, required_status_checks: [{ context: 'Scan' }] } }
      ]
    }];
    expect(protectedRefs(rules).value).toBe(true);
    expect(singleMaintainer(rules).value).toBe(true);
    expect(singleMaintainer([]).value).toBe(false);
  });

  it('does not borrow successful checks from another protected ref', () => {
    const rules = [{
      target: 'branch', enforcement: 'active',
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Scan', integration_id: 42 }] } }]
    }];
    const refs = [
      { ref: 'develop', sha: 'a'.repeat(40), checks: [{ name: 'Scan', appId: 42, status: 'completed', conclusion: 'success' }] },
      { ref: 'main', sha: 'b'.repeat(40), checks: [] }
    ];
    expect(observedRequiredContexts(rules, refs).value).toBe(false);
  });

  it('does not treat a wildcard family as a concrete branch when exclusions exist', () => {
    const rules = [{
      target: 'branch', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/release/unprotected'] } },
      rules: [
        { type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request' },
        { type: 'required_status_checks', parameters: {
          strict_required_status_checks_policy: true, do_not_enforce_on_create: true,
          required_status_checks: [{ context: 'Scan' }]
        } }
      ]
    }];
    expect(protectedRefs(rules).value).not.toBe(true);
  });

  it('requires every required job to resolve before declaring its flags safe', () => {
    const workflow = parseAssessmentWorkflow('jobs:\n  scan:\n    name: Scan\n    steps: []\n', 'scan.yml');
    const rules = [{
      target: 'branch', enforcement: 'active',
      rules: [{ type: 'required_status_checks', parameters: {
        required_status_checks: [{ context: 'Scan' }, { context: 'Integration' }]
      } }]
    }];
    expect(failOpenFlags([workflow], rules).value).toBeNull();
  });

  it('withholds secrets before truncation and removes terminal control sequences', () => {
    expect(sanitizeAssessmentText(`\u001b[31mDenied\u001b[0m`)).toBe('Denied');
    expect(sanitizeAssessmentText(`${'x'.repeat(4000)} github_pat_${'z'.repeat(40)}`)).toContain('withheld');
    expect(sanitizeAssessmentText('Authorization: Bearer private-value')).toContain('withheld');
    expect(sanitizeAssessmentText('https://name:password@example.com')).toContain('withheld');
  });
});

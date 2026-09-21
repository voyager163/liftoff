import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { combineArtifactGates, summarizeCheckovGate, summarizeImageGate, type ArtifactGateObservation } from '../scripts/repository-security/artifact-gates.ts';
import { assessCheckovScope, type CheckovInputScope } from '../scripts/repository-security/checkov.ts';
import { generatedSecurityCases, imageCases } from '../scripts/repository-security/inventory.ts';
import { TRIVY_POLICY, type ImageAssessment } from '../scripts/repository-security/trivy.ts';

const now = new Date('2026-09-21T00:00:00.000Z'), hash = `sha256:${'a'.repeat(64)}`;
const policy = await readFile(path.join(process.cwd(), 'security', 'finding-policy.json'), 'utf8');

describe('source and generated artifact group composition', () => {
  function fixture() {
    const required = ['source-iac', 'runtime-images', ...generatedSecurityCases.map(entry => `generated-iac/${entry.id}`)];
    const observations: ArtifactGateObservation[] = required.map(id => ({
      id, kind: id === 'runtime-images' ? 'images' : 'iac',
      units: id === 'runtime-images' ? imageCases.map(image => image.id) : [id],
      sourceCommit: 'a'.repeat(40), inputDigest: hash, reportDigest: hash,
      completedAt: now.toISOString(), execution: 'complete', findingGate: 'passed', cleanup: 'completed'
    }));
    return { expected: structuredClone(observations), observations };
  }
  it('binds every registered case and preserves a real blocked image result independently of complete analysis', () => {
    const value = fixture();
    value.observations[1]!.findingGate = 'blocked';
    expect(combineArtifactGates(value.expected, value.observations, 'a'.repeat(40), now)).toMatchObject({
      expectedGroups: 15, observedGroups: 15, analysisComplete: true, gate: 'blocked',
      authentication: 'not-established-by-composition', publicationQualified: false
    });
  });
  it.each(['missing', 'skipped', 'cancelled', 'error', 'cleanup', 'unmapped'])('keeps %s scope unqualified', state => {
    const value = fixture();
    if (state === 'missing') value.observations.pop();
    if (state === 'skipped' || state === 'cancelled' || state === 'error') value.observations[0]!.execution = state;
    if (state === 'cleanup') value.observations[0]!.cleanup = 'failed';
    if (state === 'unmapped') value.observations[0]!.findingGate = 'incomplete';
    expect(combineArtifactGates(value.expected, value.observations, 'a'.repeat(40), now).gate).toBe('incomplete');
  });
  it.each(['source', 'input', 'report', 'unit', 'stale', 'unknown', 'duplicate'])('rejects %s identity mismatch', field => {
    const value = fixture(), first = value.observations[0]!;
    if (field === 'source') first.sourceCommit = 'b'.repeat(40);
    if (field === 'input') first.inputDigest = `sha256:${'b'.repeat(64)}`;
    if (field === 'report') first.reportDigest = `sha256:${'b'.repeat(64)}`;
    if (field === 'unit') first.units = ['unregistered'];
    if (field === 'stale') first.completedAt = '2026-09-18T00:00:00.000Z';
    if (field === 'unknown') first.id = 'native-cli-container';
    if (field === 'duplicate') value.observations.push(first);
    expect(() => combineArtifactGates(value.expected, value.observations, 'a'.repeat(40), now)).toThrow();
  });
});

function fixtures() {
  const built = imageCases.map(entry => ({ caseId: entry.id, imageDigest: hash, platform: entry.platform }));
  const assessments: ImageAssessment[] = imageCases.map(entry => ({
    caseId: entry.id, imageDigest: hash, platform: 'linux/amd64', toolVersion: TRIVY_POLICY.version,
    databaseDigest: hash, generatedAt: '2026-09-20T23:00:00.000Z', completedAt: '2026-09-20T23:01:00.000Z',
    coverage: { os: { status: 'required', packages: 1 },
      application: entry.id === 'frontend' ? { status: 'inapplicable-static-assets', packages: 0 } : { status: 'required', packages: 1 } },
    findings: [], sourceComponents: []
  }));
  return { selected: imageCases.map(entry => entry.id), built, assessments };
}

describe('complete image-case gate without synthetic native-artifact verdicts', () => {
  it('requires all eight images for full-inventory coverage but reports a selected subset explicitly', () => {
    const f = fixtures(), result = summarizeImageGate(f.selected, f.built, f.assessments, 'completed', now);
    expect(result).toMatchObject({ analysisComplete: true, gate: 'passed', fullImageInventory: true, publicationQualified: false });
    expect(summarizeImageGate(['node'], f.built.slice(0, 1), f.assessments.slice(0, 1), 'completed', now))
      .toMatchObject({ analysisComplete: true, gate: 'passed', fullImageInventory: false, sourceRunAuthentication: false });
    expect(() => summarizeImageGate(['native-cli'], [], [], 'completed', now)).toThrow('image-inventory');
  });
  it('blocks actual native UNKNOWN policy findings without treating analysis or startup as clean', () => {
    const f = fixtures();
    f.assessments[0]!.findings = [{
      id: 'exact-image-finding', kind: 'policy', tool: 'trivy', rule: 'DLA-4783-1', scope: 'node',
      component: hash, version: hash, artifactDigest: hash, severity: 'high',
      policyClass: 'trivy-valid-native-unscored-advisory', upstreamSeverity: 'UNKNOWN',
      chains: [[hash]], location: ['image', 'os-pkgs', 'debian', 'a'.repeat(64)], owner: 'voyager163'
    }];
    const result = summarizeImageGate(f.selected, f.built, f.assessments, 'completed', now);
    expect(result).toMatchObject({ analysisComplete: true, gate: 'blocked' });
    expect(result.cases[0]).toMatchObject({ blocking: 1, policyFindings: 1, findings: 1 });
  });
  it.each(['build', 'report', 'cleanup-failed', 'cleanup-pending'])('never passes %s absence or failure', mode => {
    const f = fixtures();
    if (mode === 'build') { f.built.pop(); f.assessments.pop(); }
    if (mode === 'report') f.assessments.pop();
    const result = summarizeImageGate(f.selected, f.built, f.assessments,
      mode === 'cleanup-failed' ? 'failed' : mode === 'cleanup-pending' ? 'pending' : 'completed', now);
    expect(result.analysisComplete).toBe(false);
    expect(result.gate).toBe('incomplete');
  });
  it.each(['digest', 'platform', 'version', 'coverage', 'time', 'duplicate', 'unknown'])('rejects %s mismatch', mode => {
    const f = fixtures();
    if (mode === 'digest') f.assessments[0]!.imageDigest = `sha256:${'b'.repeat(64)}`;
    if (mode === 'platform') f.assessments[0]!.platform = 'linux/arm64';
    if (mode === 'version') f.assessments[0]!.toolVersion = '0.0.0';
    if (mode === 'coverage') f.assessments[0]!.coverage.application.packages = 0;
    if (mode === 'time') f.assessments[0]!.completedAt = '2026-09-22T00:00:00.000Z';
    if (mode === 'duplicate') f.assessments.push(f.assessments[0]!);
    if (mode === 'unknown') f.assessments[0]!.caseId = 'unregistered';
    expect(() => summarizeImageGate(f.selected, f.built, f.assessments, 'completed', now)).toThrow('artifact-gate-');
  });
});

describe('IaC analysis and resource/finding policy are separate requirements', () => {
  const scope: CheckovInputScope = { framework: 'terraform',
    files: [{ pathParts: ['fixture', 'main.tf'], content: 'terraform {}\n' }] };
  it.each(['missing', 'error', 'cancelled', 'skipped'] as const)('keeps %s required scope red', status => {
    const result = summarizeCheckovGate([{ id: 'fixture', scope }], [{ id: 'fixture', status }], policy);
    expect(result).toMatchObject({ analysisComplete: false, gate: 'incomplete', publicationQualified: false });
  });
  it('rejects duplicates, unknown scopes and fabricated complete observations', () => {
    const expected = [{ id: 'fixture', scope }];
    expect(() => summarizeCheckovGate(expected, [{ id: 'unknown', status: 'missing' }], policy)).toThrow();
    expect(() => summarizeCheckovGate(expected, [{ id: 'fixture', status: 'complete', result: { analysisComplete: true } }], policy)).toThrow();
    expect(() => summarizeCheckovGate([...expected, ...expected], [], policy)).toThrow();
  });
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_GATE === '1')(
  'keeps actual native blocking and unmapped resource diagnostics visible in the aggregate gate',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Registered external parent required.');
    const scope: CheckovInputScope = { framework: 'terraform', files: [{
      pathParts: ['fixture', 'main.tf'], content: [
        'resource "azurerm_storage_account" "fixture" {',
        ' name = "inertfixture000"', ' resource_group_name = "inert-fixture-group"',
        ' location = "West Europe"', ' account_tier = "Standard"', ' account_replication_type = "LRS"',
        ' enable_https_traffic_only = false', '}'
      ].join('\n')
    }] };
    const native = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', scope, parent);
    const result = summarizeCheckovGate([{ id: 'fixture', scope }], [{ id: 'fixture', status: 'complete', result: native }], policy);
    expect(result.analysisComplete).toBe(true);
    expect(result.cases[0]!.blocking).toContain('CKV_AZURE_3');
    expect(result.cases[0]!.unmapped.length).toBeGreaterThan(0);
    expect(result.gate).toBe('incomplete');
    expect(result.nativeFailuresUnchanged).toBe(true);
    expect(() => summarizeCheckovGate([{ id: 'fixture', scope }],
      [{ id: 'fixture', status: 'complete', result: structuredClone(native) }], policy)).toThrow();
    const changed = structuredClone(scope); changed.files[0]!.content += '\n';
    expect(() => summarizeCheckovGate([{ id: 'fixture', scope: changed }],
      [{ id: 'fixture', status: 'complete', result: native }], policy)).toThrow('iac-input-drift');
  }, 120_000
);

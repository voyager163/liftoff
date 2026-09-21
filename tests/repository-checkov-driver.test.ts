import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { checkovAssessmentExitCode, committedCheckovPlan, composeImageInventory, generatedCheckovPlan } from '../scripts/repository-security/checkov-driver.ts';
import { committedIacRoots, generatedSecurityCases } from '../scripts/repository-security/inventory.ts';
import { validateCheckovInputScope } from '../scripts/repository-security/checkov.ts';

const committed = () => [
  ...committedIacRoots.map(root => ({ pathParts: [...root, 'versions.tf'], content: 'terraform {}\n' })),
  { pathParts: ['services', 'telemetry-ingest', 'Dockerfile'], content: 'FROM scratch\n' }
];
const images = composeImageInventory(JSON.parse(readFileSync(path.join(process.cwd(), 'assets', 'supported-stack.json'), 'utf8')));

describe('explicit Checkov source and real generated selection', () => {
  it('propagates exact local gate outcomes without interpreting diagnostics as passed native checks', () => {
    expect(checkovAssessmentExitCode({ selectedAnalysisComplete: true, findingGate: { analysisComplete: true, gate: 'passed' } })).toBe(0);
    expect(checkovAssessmentExitCode({ selectedAnalysisComplete: true, findingGate: { analysisComplete: true, gate: 'blocked' } })).toBe(1);
    expect(checkovAssessmentExitCode({ selectedAnalysisComplete: true, findingGate: { analysisComplete: true, gate: 'incomplete' } })).toBe(2);
    expect(checkovAssessmentExitCode({ selectedAnalysisComplete: false, findingGate: { analysisComplete: false, gate: 'incomplete' } })).toBe(2);
    expect(() => checkovAssessmentExitCode({
      selectedAnalysisComplete: true, findingGate: { analysisComplete: false, gate: 'passed' }
    })).toThrow('incoherent-gate');
  });
  it('selects every committed root and telemetry without scanning tool or home directories', () => {
    const files = committed(), plan = committedCheckovPlan(files);
    expect(plan.cases).toHaveLength(4);
    expect(plan.cases.map(item => item.scope.framework)).toEqual(['terraform', 'terraform', 'terraform', 'dockerfile']);
    expect(plan.unsupported).toEqual([]);
    expect(plan.cases[0]!.scope.terraformContext).toMatchObject({
      rootDirectory: ['infrastructure', 'opentofu', 'bootstrap'], moduleDirectories: [],
      variableFiles: [{ content: expect.stringContaining('operator_cidrs = ["192.0.2.1/32"]') }]
    });
    for (const item of plan.cases) expect(() => validateCheckovInputScope(item.scope)).not.toThrow();
    files[0]!.content = 'not the frozen input';
    expect(plan.cases[0]!.scope.files[0]!.content).toBe('terraform {}\n');
  });

  it('rejects missing roots, nested unknown inputs, controls and path aliases', () => {
    for (const files of [
      [], committed().slice(1), committed().slice(0, 3), [...committed(), committed()[0]!],
      [...committed(), { pathParts: ['home', 'source.tf'], content: 'x' }],
      [...committed(), { pathParts: [...committedIacRoots[0]!, 'nested', 'unknown.tf'], content: 'x' }],
      [...committed(), { pathParts: [...committedIacRoots[0]!, '.checkov.yaml'], content: 'x' }],
      [...committed(), { pathParts: ['..', 'source.tf'], content: 'x' }]
    ]) expect(() => committedCheckovPlan(files)).toThrow();
  });

  it.each(generatedSecurityCases.map(entry => [entry.id, entry] as const))(
    'binds actual %s artifacts and nonfunctional variable values without external modules or silent Compose omission',
    (id, entry) => {
      const artifacts = buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true }));
      const plan = generatedCheckovPlan(id, artifacts, images);
      expect(plan.cases.filter(item => item.scope.framework === 'terraform')).toHaveLength(3);
      expect(plan.cases.some(item => item.scope.framework === 'dockerfile')).toBe(true);
      expect(plan.unsupported.filter(item => item.reason === 'variable-file-evaluation-not-yet-qualified')).toHaveLength(0);
      expect(plan.cases.filter(item => item.scope.framework === 'yaml')).toHaveLength(1);
      expect(plan.unsupported).toEqual([]);
      for (const item of plan.cases) for (const file of item.scope.files) {
        expect(artifacts.some(artifact => artifact.pathParts.join('/') === file.pathParts.join('/') &&
          artifact.content === file.content)).toBe(true);
      }
      for (const item of plan.cases.filter(item => item.scope.framework === 'terraform')) {
        expect(item.scope.terraformContext?.moduleDirectories).toEqual([
          ['infrastructure', 'opentofu', 'azure', 'modules', 'application']
        ]);
        expect(item.scope.terraformContext?.variableFiles).toHaveLength(2);
        expect(item.scope.terraformContext?.variableFiles[1]?.content).toContain('NONFUNCTIONAL_SCANNER_FIXTURE_NOT_A_CREDENTIAL');
        expect(artifacts.some(artifact => artifact.content === item.scope.terraformContext?.variableFiles[0]?.content)).toBe(true);
      }
      expect(() => generatedCheckovPlan(id, artifacts.filter(artifact =>
        artifact.logicalName !== 'opentofu-application-main'), images)).toThrow('incomplete-generated-coverage');
    }
  );

  it('does not accept unregistered generator cases', () => {
    expect(() => generatedCheckovPlan('retired-power-apps', [])).toThrow('unknown-generated-case');
  });
});

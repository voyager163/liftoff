import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installedCapabilities } from '../src/application/capabilities.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { parseProjectManifest } from '../src/application/project/manifest.js';
import { resolveModernManifestSourceContext } from '../src/application/project/source-context.js';
import { loadPackagedSkillSource } from '../src/adapters/packaged-assets/skill-sources.js';
import { projectAssessmentAgentIntegrations } from '../src/domain/project/catalog.js';
import { renderProjectAssessmentIntegration } from '../src/generators/governance/integrations.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import type { CodingAgentId, ProjectOptions } from '../src/domain/project/contracts.js';

const canonical = readFileSync('assets/skills/assessment.md', 'utf8');
const agents: readonly CodingAgentId[] = ['github-copilot', 'claude', 'codex'];
const cases = (['manual', 'openspec', 'spec-kit'] as const).flatMap(specWorkflow =>
  (['none', 'single-maintainer-gitflow'] as const).flatMap(governanceProfile =>
    [...agents.map(agent => [agent]), [...agents], ...(specWorkflow === 'manual' ? [[]] : [])].map(selected => ({
      specWorkflow, governanceProfile, selected
    }))));

function currentManifest(selected: CodingAgentId[]) {
  const options: ProjectOptions = {
    projectName: 'Assessment ownership fixture', projectType: 'standard', apiStack: 'node',
    specWorkflow: 'manual', governanceProfile: 'none', agents: selected,
    includeFrontend: false, environments: ['dev']
  };
  const artifact = buildCurrentArtifacts(buildCurrentProjectPlan(options, { requireProjectName: true }))
    .find(entry => entry.logicalName === 'manifest');
  if (!artifact) throw new Error('Actual generation must produce a manifest.');
  const manifest = parseProjectManifest(JSON.parse(artifact.content));
  if (manifest.artifactVersion !== 8) throw new Error('Actual generation must produce manifest 8.');
  return structuredClone(manifest);
}

describe('canonical capability-negotiated whole-project assessment integrations', () => {
  it('loads one exact body and negotiates only actual read-only producer fields', () => {
    expect(loadPackagedSkillSource('assessment')).toBe(canonical);
    const capabilities = installedCapabilities();
    expect(capabilities.schemas.reports.projectAssessment).toBe(1);
    expect(capabilities.schemas.projectAssessment).toMatchObject({
      command: 'assess', report: 1, readOnly: true, modes: ['local', 'live'],
      projectExecution: false, projectWrites: false, credentialEnrollment: false, telemetry: false,
      liveProviders: ['github'], liveConformance: false
    });
    const text = canonical.replace(/\s+/gu, ' ');
    expect(text.indexOf('liftoff capabilities --json')).toBeLessThan(text.indexOf('liftoff assess --project'));
    for (const phrase of [
      'Missing, malformed or incompatible capabilities: STOP',
      'without project or provider access',
      'Use `--live` only after an explicit request',
      'does not authorize Azure, account or runner discovery',
      'schema 1', 'remediation.available', 'previewCommand', 'separateConsent',
      'Do not invent executable, cwd, approval or effect fields absent from this schema',
      'unavailable or unadvertised recommendations are blockers',
      'workflow/profile/plugin changes have separate authorities',
      'new-environment activation is not existing-deployment/state migration',
      'not an atomic filesystem/provider snapshot',
      'Stop after explaining evidence',
      'CLI-only users can run the same negotiated assessment',
      'never install one merely to assess a project'
    ]) expect(text).toContain(phrase);
    expect(text).toContain('the installed release, not registry latest');
    expect(text).toContain('Never manufacture a command, report, receipt or compatibility flag');
    expect(text).toContain('a narrower governance report');
  });

  it.each(agents)('keeps the exact shared body under the native %s invocation', agent => {
    const integration = projectAssessmentAgentIntegrations[agent];
    const content = renderProjectAssessmentIntegration(agent);
    expect(content.endsWith(canonical)).toBe(true);
    expect(content.slice(content.indexOf(`# ${integration.invocation}\n`)))
      .toBe(`# ${integration.invocation}\n\n${canonical}`);
    if (integration.kind === 'skill') expect(content).toContain('name: liftoff-assess');
    else expect(content.startsWith(`# ${integration.invocation}\n`)).toBe(true);
  });

  it.each(cases)('generates only selected hosts for $specWorkflow/$governanceProfile/$selected', sample => {
    const options: ProjectOptions = {
      projectName: 'Assessment skill fixture', projectType: 'standard', apiStack: 'node',
      specWorkflow: sample.specWorkflow, governanceProfile: sample.governanceProfile,
      agents: sample.selected, includeFrontend: false, environments: ['dev'],
      ...(sample.specWorkflow === 'spec-kit' ? { defaultAgent: sample.selected[0] } : {})
    };
    const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan(options, { requireProjectName: true }));
    const manifestArtifact = artifacts.find(artifact => artifact.logicalName === 'manifest');
    if (!manifestArtifact) throw new Error('Actual generation must produce a manifest.');
    const manifest = parseProjectManifest(JSON.parse(manifestArtifact.content));
    if (manifest.artifactVersion !== 8) throw new Error('Actual current generation must produce manifest 8.');
    const context = resolveModernManifestSourceContext(manifest);
    for (const agent of agents) {
      const integration = projectAssessmentAgentIntegrations[agent];
      const generated = artifacts.find(artifact => artifact.logicalName === integration.logicalName);
      if (sample.selected.includes(agent)) {
        expect(generated).toMatchObject({
          category: 'assessment', lifecycle: 'managed-core', pathParts: [...integration.pathParts],
          content: renderProjectAssessmentIntegration(agent)
        });
        expect(manifest.managedArtifacts.some(artifact => artifact.logicalName === integration.logicalName)).toBe(true);
      } else {
        expect(generated).toBeUndefined();
        expect(manifest.managedArtifacts.some(artifact => artifact.logicalName === integration.logicalName)).toBe(false);
      }
      expect(context.source.requiredHandoffLogicalNames).not.toContain(integration.logicalName);
    }
    if (sample.governanceProfile === 'none') expect(manifest.governance).toEqual({ profile: 'none', state: 'disabled' });
    if (sample.specWorkflow === 'manual') {
      expect(manifest.framework).toEqual({ state: 'not-required' });
      expect(artifacts.some(artifact => artifact.lifecycle === 'framework' || artifact.lifecycle === 'seed')).toBe(false);
    }
  });

  it.each(['category', 'path', 'project ledger'] as const)(
    'rejects forged assessment managed authority through %s', mutation => {
      const manifest = currentManifest(['github-copilot']);
      const integration = projectAssessmentAgentIntegrations['github-copilot'];
      const row = manifest.managedArtifacts.find(entry => entry.logicalName === integration.logicalName);
      if (!row) throw new Error('Actual selected source must declare its assessment integration.');
      if (mutation === 'category') Reflect.set(row, 'category', 'project');
      if (mutation === 'path') Reflect.set(row, 'pathParts', ['custom', 'unowned.md']);
      if (mutation === 'project ledger') {
        Reflect.set(manifest, 'managedArtifacts', manifest.managedArtifacts.filter(entry => entry !== row));
      }
      if (mutation === 'project ledger') {
        Reflect.set(manifest, 'projectArtifacts', [...manifest.projectArtifacts, {
          logicalName: row.logicalName, category: row.category, pathParts: row.pathParts,
          generatedBy: manifest.liftoffVersion, generationHash: row.contentHash, provisioningGroup: 'base'
        }]);
      }
      expect(() => parseProjectManifest(manifest)).toThrow();
    }
  );

  it('keeps a missing assessment ledger readable as managed drift, not a governance completion requirement', () => {
    const manifest = currentManifest(['github-copilot']);
    const name = projectAssessmentAgentIntegrations['github-copilot'].logicalName;
    Reflect.set(manifest, 'managedArtifacts', manifest.managedArtifacts.filter(entry => entry.logicalName !== name));
    const parsed = parseProjectManifest(manifest);
    if (parsed.artifactVersion !== 8) throw new Error('Actual current source must remain manifest 8.');
    const context = resolveModernManifestSourceContext(parsed);
    expect(parsed.managedArtifacts.some(entry => entry.logicalName === name)).toBe(false);
    expect(context.source.managedArtifacts.some(entry => entry.logicalName === name)).toBe(true);
    expect(context.source.requiredHandoffLogicalNames).toEqual([]);
  });

  it.each(agents)('protects the exact unselected %s assessment path, not neighboring skills', agent => {
    const manifest = currentManifest([]);
    const integration = projectAssessmentAgentIntegrations[agent];
    const context = resolveModernManifestSourceContext(manifest);
    expect(context.source.layoutDescriptor.protectedPaths).toContainEqual(integration.pathParts);
    const custom = [...integration.pathParts.slice(0, -1), 'custom-neighbor.md'];
    expect(context.source.layoutDescriptor.protectedPaths).not.toContainEqual(custom);
    Reflect.set(manifest, 'activeLayout', {
      ...manifest.activeLayout,
      bindings: [
        ...manifest.activeLayout.bindings.filter(binding => binding.kind !== 'artifact' || binding.logicalName !== 'project-readme'),
        { kind: 'artifact', logicalName: 'project-readme', pathParts: integration.pathParts }
      ]
    });
    expect(() => parseProjectManifest(manifest)).toThrow();
  });
});

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { templateDependencyInventory } from '../scripts/template-dependency-security.mjs';

const root = process.cwd();
const changeRoot = path.join(root, 'openspec', 'changes', 'harden-public-repository');
const capabilities = [
  'liftoff-source-repository', 'liftoff-repository-security-validation',
  'liftoff-template-dependency-security', 'liftoff-npm-distribution'
];

describe('repository hardening baseline and acceptance plan', () => {
  it('records explicit owner consent only for the monitored private conduct contact', async () => {
    const contact = JSON.parse(await readFile(path.join(root, 'security', 'community-contact.json'), 'utf8'));
    expect(contact).toMatchObject({
      purpose: 'private-conduct-reporting', address: 'ask.msncontrol@gmail.com',
      ownerConfirmedWorking: true, ownerConfirmedMonitored: true, publicationConsent: true,
      vulnerabilityRoute: 'https://github.com/voyager163/liftoff/security/advisories/new',
      supportRoute: 'https://github.com/voyager163/liftoff/issues',
      testMessageSent: false, mailboxProvisioned: false, grantsOtherHostedAuthority: false
    });
  });

  it('records the real npm base, graph identities and authority without claiming scans', async () => {
    const baseline = JSON.parse(await readFile(path.join(root, 'security', 'hardening-baseline.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(baseline.sourceCommit).toBe('70d10881b46d873118d825735696f39b6d35ebe0');
    expect(baseline.sourceInventory.package).toMatchObject({ name: pkg.name, version: '0.12.3' });
    expect(baseline.sourceInventory.npmGraphs).toEqual(templateDependencyInventory.map(entry => entry.id));
    expect(baseline.authority).toMatchObject({
      localImplementation: true, hostedMutations: false, hostedRunsAndBehaviorTests: false,
      credentialActions: false, commitsPushesPullRequests: false, signPublishDeployCloud: false
    });
    expect(baseline.secretsScope.assessmentExecuted).toBe(false);
    expect(Object.keys(baseline.secretsScope.publishedRefCommits)).toHaveLength(36);
    for (const sha of Object.values(baseline.secretsScope.publishedRefCommits)) expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline.ciDependencies.map((item: { state: string }) => item.state)).toEqual(['blocked', 'blocked']);
    expect(baseline.repositoryState.mainProtection.requiredChecks).toHaveLength(3);
  });

  it('assigns every approved scenario to exact tasks and evidence types without fabricating contexts', async () => {
    const matrix = JSON.parse(await readFile(path.join(root, 'security', 'hardening-acceptance.json'), 'utf8'));
    const activeChange = existsSync(path.join(changeRoot, 'tasks.md'));
    const tasks = activeChange ? await readFile(path.join(changeRoot, 'tasks.md'), 'utf8') : null;
    const taskIds = tasks === null ? null : new Set([...tasks.matchAll(/^- \[[ x]\] (\d+\.\d+) /gm)].map(match => match[1]));
    const roles = new Set(matrix.checkRoles.map((item: { role: string }) => item.role));
    const requirements: string[] = [];
    let scenarioCount = 0;
    for (const capability of capabilities) {
      const specRoot = activeChange ? changeRoot : path.join(root, 'openspec');
      const spec = await readFile(path.join(specRoot, 'specs', capability, 'spec.md'), 'utf8');
      for (const block of spec.split('### Requirement: ').slice(1)) {
        const name = block.split('\n')[0]!;
        if (!activeChange && !(name in matrix.requirements)) continue;
        requirements.push(name);
        const mapping = matrix.requirements[name];
        expect(mapping, name).toBeDefined();
        expect(mapping.evidence.length).toBeGreaterThan(0);
        expect(roles.has(mapping.role), name).toBe(true);
        for (const id of mapping.tasks) {
          expect(id).toMatch(/^\d+\.\d+$/);
          if (taskIds) expect(taskIds.has(id), `${name}: ${id}`).toBe(true);
        }
        const scenarios = [...block.matchAll(/^#### Scenario: (.+)$/gm)];
        expect(scenarios.length, name).toBeGreaterThan(0);
        scenarioCount += scenarios.length;
      }
    }
    expect(Object.keys(matrix.requirements).sort()).toEqual(requirements.sort());
    expect(requirements).toHaveLength(39);
    expect(scenarioCount).toBeGreaterThan(100);
    expect(matrix.admissionContract).toEqual({
      routes: ['normal', 'policy-maintenance'],
      normalRequiresActualFindingSuccess: true,
      maintenanceChangesFindingVerdicts: false,
      candidateTraceabilityIsAuthority: false,
      adoption: 'ordinary-maintainer-merge',
      publicationAcceptsAdmissionEvidence: false
    });
    for (const role of matrix.checkRoles) {
      if (role.kind === 'finding-report') {
        expect(role.requiredRoutes).toEqual([]);
        expect(role.normalAdmissionConsumesVerdict).toBe(true);
      } else {
        expect(role.requiredRoutes).toEqual(['normal', 'policy-maintenance']);
      }
      if (role.role !== 'functional') {
        expect(role.observedContexts).toEqual([]);
        expect(role.observedAppId).toBeNull();
      }
    }
  });
});

import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { loadManifest, writeArtifacts } from '../src/file-system.js';
import {
  currentActivationIdentity, canonicalPhaseGraph, canonicalPhaseGraphHash, phaseIds,
  buildSavedTransitionPlan, inspectGovernanceSourceOfTruth,
  type GovernanceTransitionInspection, type PhaseEvidenceRecord
} from '../src/governance-activation/index.js';
import { validateUserActivationState } from '../src/governance-activation/validators.js';
import { assessGovernance, findAssessmentException, selectBoundAssessmentEvidence, resolveAssessmentLiveScope } from '../src/governance-assessment/engine.js';
import { inspectAssessmentProject } from '../src/governance-assessment/project.js';
import { AssessmentFiles } from '../src/governance-assessment/readers.js';
import { observed, source } from '../src/governance-assessment/sanitize.js';
import { loadAssessmentCatalog } from '../src/governance-assessment/catalog.js';
import * as liveModule from '../src/governance-assessment/live.js';
import { canonicalSha256 } from '../src/governance-activation/canonical-json.js';
import { transitionPlanForPhase } from '../src/governance-activation/approvals.js';
import { evidenceContextForPhase } from '../src/governance-activation/evidence.js';
import type { ProjectOptions, ExternalCommand } from '../src/types.js';
import type { CommandRunner } from '../src/process-runner.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const roots: string[] = [];
const now = () => new Date('2026-09-05T00:00:00.000Z');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(options: Partial<ProjectOptions> = {}) {
  await mkdir(path.join(process.cwd(), '.cache'), { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache', 'assessment-engine '));
  roots.push(root);
  const plan = buildProjectPlan({
    projectName: 'Assessment Project', specWorkflow: 'openspec', agents: ['copilot'],
    ...(options.projectType === 'power-apps-code-app' ? {} : {
      projectType: 'standard', apiStack: options.projectType === 'genai' ? 'python' : 'go',
      cloud: 'azure', region: 'eastus', includeFrontend: false
    }),
    ...options
  }, { requireProjectName: true });
  await writeArtifacts(root, buildArtifacts(plan));
  return root;
}
async function tree(root: string): Promise<string> {
  const entries: Array<[string, string]> = [];
  async function visit(parts: string[]) {
    for (const entry of await readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const child = [...parts, entry.name];
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) entries.push([child.join('/'), await readFile(path.join(root, ...child), 'utf8')]);
    }
  }
  await visit([]);
  return canonicalSha256(entries.sort(([a], [b]) => a.localeCompare(b, 'en')));
}
const noCommands: CommandRunner = {
  async run(command) { throw new Error(`Unexpected external command: ${command.executable}`); }
};
function state() {
  return validateUserActivationState({
    schemaVersion: 1, identity: currentActivationIdentity,
    repository: { id: 'R_assessment', name: 'owner/repo', defaultBranch: 'develop' },
    activeChange: null, applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: now().toISOString(), evidence: [], approvals: [], blockers: []
    }])),
    createdAt: now().toISOString(), updatedAt: now().toISOString()
  });
}

describe('read-only assessment command', () => {
  it.each([
    { projectType: 'standard', apiStack: 'go' },
    { projectType: 'standard', apiStack: 'node' },
    { projectType: 'genai', pattern: 'prompt' },
    { projectType: 'power-apps-code-app' }
  ] satisfies Partial<ProjectOptions>[])('assesses fresh workload %j offline without running baseline or changing files', async (options) => {
    const root = await fixture(options);
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
      schemaVersion: 1, readOnly: true, mode: 'local', outcome: 'partial', exitCode: 2,
      projectIdentity: { stateSource: 'not-started' }
    });
    expect(new Set(report.findings.map((item) => item.controlId))).toEqual(
      new Set(loadAssessmentCatalog().catalog.controls.map((control) => control.id))
    );
    expect(report.findings.filter((item) => item.controlId === 'identity.managed-core').every((item) => item.classification === 'aligned')).toBe(true);
    expect(report.findings.find((item) => item.controlId === 'gitflow.default-branch')?.classification).toBe('not-observed');
    expect(await tree(root)).toBe(before);
    expect(report.findings.find((item) => item.controlId === 'runner.private-assignment')?.applicability)
      .toBe(options.projectType === 'power-apps-code-app' ? 'inapplicable' : 'unknown');
  });

  it('does not query live services or activate a disabled profile even with --live', async () => {
    const root = await fixture({ governanceProfile: 'none' });
    const before = await tree(root);
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'not-applicable', exitCode: 0, findings: [] });
    expect(await tree(root)).toBe(before);
  });

  it('distinguishes conflicting managed content from unchanged CLI versions', async () => {
    const root = await fixture();
    const file = path.join(root, '.liftoff', 'governance', 'policy.md');
    await writeFile(file, `${await readFile(file, 'utf8')}\nProject customization\n`);
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report.projectIdentity.cliVersion).toBe(report.target?.cliVersion);
    expect(report.findings.find((item) => item.controlId === 'identity.managed-core' && item.scope.resource === '.liftoff/governance/policy.md')?.classification)
      .toBe('conflicting');
    expect(await tree(root)).toBe(before);
  });

  it('keeps unsupported activation identity assessable without relaxing the mutating manifest reader', async () => {
    const root = await fixture();
    const file = path.join(root, 'liftoff.manifest.json');
    const manifest = await loadManifest(root);
    if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') throw new Error('Expected governed fixture.');
    await writeFile(file, JSON.stringify({
      ...manifest, governance: { ...manifest.governance, policyVersion: '99', activationIdentity: { ...currentActivationIdentity, policyVersion: '99' } }
    }));
    const before = await tree(root);
    await expect(loadManifest(root)).rejects.toThrow(/policyVersion|identity/);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
      outcome: 'partial', projectIdentity: { availability: 'unsupported' }
    });
    expect(report.diagnostics.some((entry) => entry.code === 'unsupported-activation')).toBe(true);
    expect(await tree(root)).toBe(before);
  });

  it('preserves opaque future state and does not expose its payload', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'governance'));
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify({
      schemaVersion: 99, secret: `github_pat_${'x'.repeat(40)}`
    }));
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'partial', projectIdentity: { stateSource: 'unsupported' } });
    expect(JSON.stringify(report)).not.toContain('github_pat_');
    expect(await tree(root)).toBe(before);
  });

  it.each(['seed-valid', 'blocked', 'archived', 'completed'] as const)(
    'assesses recorded setup state without advancing phases (%s)',
    async (progress) => {
      const root = await fixture();
      const initialized = await runCommand(parseArgs(['governance', 'apply-next', '--json', '--execute']), {
        cwd: root, stdout: new CaptureStream(), stderr: new CaptureStream(), runner: new ReadyInitRunner()
      });
      expect(initialized).toBe(0);
      const statePath = path.join(root, 'governance', 'activation-state.json');
      const current = validateUserActivationState(JSON.parse(await readFile(statePath, 'utf8')));
      if (progress === 'blocked') {
        current.phases['seed-verified'] = {
          ...current.phases['seed-verified'], state: 'blocked', blockers: ['Recorded local baseline failure.']
        };
      }
      if (progress === 'archived') {
        const archived = path.join(root, 'openspec', 'changes', 'archive', '2026-09-05-bootstrap-assessment-project');
        await mkdir(path.dirname(archived), { recursive: true });
        await rename(path.join(root, 'openspec', 'changes', 'bootstrap-assessment-project'), archived);
        current.phases['seed-archived'].state = 'verified';
      }
      if (progress === 'completed') {
        for (const phase of canonicalPhaseGraph.phases) {
          current.phases[phase.id].state = phase.terminalStates.find((value) => value !== 'failed')!;
        }
      }
      await writeFile(statePath, JSON.stringify(current));
      const before = await tree(root);
      const report = await assessGovernance(root, { runner: noCommands, now });
      expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
        outcome: 'partial', projectIdentity: { stateSource: 'user' }
      });
      expect(report.findings.find((entry) => entry.controlId === 'evidence.governance')?.classification).toBe('not-observed');
      expect(await tree(root)).toBe(before);
    }
  );

  it.each([2, 3, 4, 5, 6] as const)('assesses supported manifest schema %s without migration', async (version) => {
    const root = await fixture({ projectType: 'genai', pattern: 'prompt', apiStack: 'python' });
    const manifest = await loadManifest(root);
    if (manifest.project.workload.kind === 'power-apps-code-app' || manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') throw new Error('Wrong legacy fixture.');
    const workload = manifest.project.workload;
    const historicalManaged = manifest.managedArtifacts.filter((entry) => !entry.logicalName.startsWith('liftoff-governance-assess-'));
    const artifacts = [...historicalManaged, ...manifest.projectArtifacts.map((entry) => ({
      logicalName: entry.logicalName, category: entry.category, pathParts: entry.pathParts, contentHash: entry.generationHash
    }))];
    const raw: Record<string, unknown> = {
      ...manifest, artifactVersion: version, managedArtifacts: historicalManaged,
      governance: { profile: manifest.governance.profile, state: manifest.governance.state, policyVersion: manifest.governance.policyVersion }
    };
    if (version <= 5) {
      raw.artifacts = artifacts;
      delete raw.managedArtifacts; delete raw.projectArtifacts;
    }
    if (version <= 4) delete raw.governance;
    if (version <= 3) raw.project = {
      name: manifest.project.name, ...(version === 3 ? { projectType: 'genai', apiStack: workload.apiStack, agents: manifest.project.agents } : {}),
      pattern: 'prompt', cloud: workload.cloud, region: workload.region, frontend: workload.frontend,
      environments: workload.environments, specWorkflow: manifest.project.specWorkflow
    };
    if (version === 2) delete raw.framework;
    await writeFile(path.join(root, 'liftoff.manifest.json'), JSON.stringify(raw));
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report, JSON.stringify(report.diagnostics)).toMatchObject({ outcome: 'partial', projectIdentity: { manifestVersion: version } });
    expect(await tree(root)).toBe(before);
  });

  it('returns a JSON error before unsafe or unknown-manifest paths can be used', async () => {
    const root = await fixture();
    const file = path.join(root, 'liftoff.manifest.json');
    const manifest = await loadManifest(root);
    manifest.managedArtifacts[0]!.pathParts = ['..', 'outside-secret'];
    await writeFile(file, JSON.stringify(manifest));
    expect(await assessGovernance(root, { runner: noCommands, now })).toMatchObject({ outcome: 'error', exitCode: 1 });
    await writeFile(file, JSON.stringify({ ...manifest, artifactVersion: 99 }));
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'error', diagnostics: [expect.objectContaining({ code: 'unsupported-manifest' })] });
  });

  it('refuses escaping symlinks and malformed workflow YAML without executing helpers', async ({ skip }) => {
    if (process.platform === 'win32') { skip(); return; }
    const root = await fixture();
    const outside = await fixture();
    const file = path.join(root, '.liftoff', 'governance', 'policy.md');
    await rm(file);
    await symlink(path.join(outside, 'README.md'), file);
    expect(await assessGovernance(root, { runner: noCommands, now })).toMatchObject({ outcome: 'error' });
  });

  it('rejects escaping workflow-directory symlinks or Windows junctions', async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(path.join(outside, '.github'), path.join(root, '.github', 'workflows'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'error', exitCode: 1 });
  });

  it('disables Git execution hooks and optional index writes during local inspection', async () => {
    const root = await fixture();
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    git(['init', '--initial-branch=develop']);
    git(['add', 'README.md']);
    const marker = path.join(root, 'hook-executed');
    const monitor = path.join(root, 'monitor.cjs');
    await writeFile(monitor, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    const hook = `"${process.execPath.replaceAll('\\', '/')}" "${monitor.replaceAll('\\', '/')}"`;
    git(['config', '--local', 'core.fsmonitor', hook]);
    git(['config', '--local', 'diff.external', hook]);
    const before = await tree(root);
    const report = await assessGovernance(root, { now });
    expect(report.outcome).toBe('partial');
    expect(await tree(root)).toBe(before);
    expect((await readdir(root)).includes('hook-executed')).toBe(false);
  });

  it('never runs repository-configured clean/process filters during assessment', async () => {
    const root = await fixture();
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    git(['init', '--initial-branch=develop']);
    const marker = path.join(root, 'filter-executed');
    const filter = path.join(root, 'filter.cjs');
    await writeFile(filter, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(fs.readFileSync(0));\n`);
    git(['config', '--local', 'filter.assessment.clean',
      `"${process.execPath.replaceAll('\\', '/')}" "${filter.replaceAll('\\', '/')}"`]);
    await writeFile(path.join(root, '.gitattributes'), '*.md filter=assessment\n');
    git(['add', 'README.md']);
    expect(await readFile(marker, 'utf8')).toBe('executed');
    await rm(marker);
    await writeFile(path.join(root, 'README.md'), 'Changed worktree contents\n');
    const before = await tree(root);
    const report = await assessGovernance(root, { now });
    expect(report.outcome).toBe('partial');
    expect(await tree(root)).toBe(before);
    expect((await readdir(root)).includes('filter-executed')).toBe(false);
  });

  it('withholds mixed snapshots when a live collector overlaps local changes', async () => {
    const root = await fixture();
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    const workflow = path.join(root, '.github', 'workflows', 'checks.yml');
    await writeFile(workflow, 'name: Before\njobs: {test: {steps: []}}\n');
    vi.spyOn(liveModule, 'collectLiveAssessment').mockImplementation(async () => {
      await writeFile(workflow, 'name: After\njobs: {test: {steps: []}}\n');
      return { observations: {}, diagnostics: [], refsStable: true };
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'partial', snapshot: { inputsStable: false } });
    expect(report.findings.filter((item) => item.applicability !== 'inapplicable').every((item) => item.classification === 'not-observed')).toBe(true);
  });

  it('uses explicit live reads only when requested and preserves partial state', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'governance'));
    const current = state();
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify(current));
    const before = await tree(root);
    const calls: ExternalCommand[] = [];
    const runner: CommandRunner = {
      async run(command) {
        calls.push(command);
        return {
          command, displayCommand: command.executable, status: 0, signal: null,
          stdout: JSON.stringify({ id: 123, node_id: 'R_assessment', full_name: 'owner/repo', default_branch: 'develop' }),
          stderr: '', timedOut: false
        };
      }
    };
    await assessGovernance(root, { runner, now });
    expect(calls).toHaveLength(0);
    const live = await assessGovernance(root, { live: true, runner, now });
    expect(live.mode).toBe('live');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((command) => command.executable === 'gh' && command.args.includes('GET'))).toBe(true);
    expect(await tree(root)).toBe(before);
  });

  it('renders the same versioned report through strict project-aware CLI routing', async () => {
    const root = await fixture();
    const stdout = new CaptureStream();
    const code = await runCommand(parseArgs(['governance', 'assess', '--json']), {
      cwd: root, stdout, stderr: new CaptureStream(), runner: noCommands
    });
    expect(code).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({ command: 'governance assess', schemaVersion: 1, outcome: 'partial' });
  });

  it('requires exact identity, baseline, resource, scope and expiry for exceptions', () => {
    const control = loadAssessmentCatalog().catalog.controls.find((entry) => entry.id === 'security.action-pinning')!;
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'workflow-source-ready')!;
    const current = state();
    const context = evidenceContextForPhase(phase.id);
    const plan = transitionPlanForPhase(phase, current, context.transition);
    const action = 'slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.1.0';
    const approval = {
      schemaVersion: 1, id: 'action-exception', ...plan,
      resources: [{ type: 'action-reference', identity: action }],
      destinations: [{ type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo', subscriptionId: null }],
      policyExceptions: [control.id], approvedAt: '2026-09-04T00:00:00Z', expiresAt: '2026-10-04T00:00:00Z', approver: 'owner'
    };
    const scope = { repository: 'owner/repo', environment: null, resource: null };
    expect(findAssessmentException(control, [approval], scope, plan.baselineSha, action, now())).toMatchObject({ id: approval.id });
    expect(findAssessmentException(control, [approval], { ...scope, repository: 'other/repo' }, plan.baselineSha, action, now())).toBeNull();
    expect(findAssessmentException(control, [approval], scope, 'f'.repeat(64), action, now())).toBeNull();
    expect(findAssessmentException(control, [{ ...approval, expiresAt: '2026-09-04T00:00:00Z' }], scope, plan.baselineSha, action, now())).toBeNull();
  });

  it('does not classify different declared and enforced check bindings as aligned', async () => {
    const root = await fixture();
    const ruleset = (context: string) => ({
      target: 'branch', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context, integration_id: 42 }] } }]
    });
    await mkdir(path.join(root, 'governance', 'rulesets'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'rulesets', 'checks.json'), JSON.stringify(ruleset('Security Scan')));
    const origin = source('github', 'https://api.github.com/repos/owner/repo', now().toISOString());
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'github.repository': observed({ defaultBranch: 'develop' }, origin),
        'github.rulesets': observed([ruleset('Lint')], origin),
        'github.checks': observed(['develop', 'main'].map((ref) => ({
          ref, sha: 'a'.repeat(40), checks: [{ name: 'Lint', appId: 42, status: 'completed', conclusion: 'success' }]
        })), origin)
      }, diagnostics: [], refsStable: true
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report.findings.find((item) => item.controlId === 'governance.required-contexts')?.classification).toBe('conflicting');
  });

  it('retains a known ruleset mismatch when check-run proof is unavailable', async () => {
    const root = await fixture();
    const ruleset = (context: string) => ({
      target: 'branch', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context, integration_id: 42 }] } }]
    });
    await mkdir(path.join(root, 'governance', 'rulesets'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'rulesets', 'checks.json'), JSON.stringify(ruleset('Security Scan')));
    const origin = source('github', 'https://api.github.com/repos/owner/repo', now().toISOString());
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'github.repository': observed({ defaultBranch: 'develop' }, origin),
        'github.rulesets': observed([ruleset('Lint')], origin)
      }, diagnostics: [], refsStable: true
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    const finding = report.findings.find((item) => item.controlId === 'governance.required-contexts');
    expect(finding).toMatchObject({ classification: 'conflicting', missingProof: ['live'] });
    expect(finding?.reasons.join(' ')).toContain('bindings differ');
    expect(report.outcome).toBe('partial');
  });

  it('binds declared tag bypass to the same verified Actions app as live rules', async () => {
    const root = await fixture();
    const creation = (actor: number) => ({
      target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      bypass_actors: [{ actor_type: 'Integration', actor_id: actor, bypass_mode: 'always' }],
      rules: [{ type: 'creation' }]
    });
    const immutable = {
      target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      bypass_actors: [], rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }]
    };
    await mkdir(path.join(root, 'governance', 'rulesets'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'rulesets', 'creation.json'), JSON.stringify(creation(999999)));
    await writeFile(path.join(root, 'governance', 'rulesets', 'immutable.json'), JSON.stringify(immutable));
    const origin = source('github', 'https://api.github.com/repos/owner/repo/rulesets', now().toISOString());
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'github.actions-app': observed({ id: 15368, slug: 'github-actions' }, origin),
        'github.rulesets': observed([creation(15368), immutable], origin)
      }, diagnostics: [], refsStable: true
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report.findings.find((item) => item.controlId === 'release.tag-controls')?.classification).toBe('conflicting');
  });

  it('does not let future or unbound approvals authorize Azure collection', async () => {
    const root = await fixture();
    const current = state();
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'provider-ready')!;
    const plan = transitionPlanForPhase(phase, current, evidenceContextForPhase(phase.id).transition);
    const subscriptionId = '00000000-0000-0000-0000-000000000001';
    const approval = {
      schemaVersion: 1, id: 'future', ...plan,
      approvedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', approver: 'owner',
      resources: [{ type: 'Microsoft.Storage/storageAccounts', identity: `/subscriptions/${subscriptionId}/resourceGroups/app/providers/Microsoft.Storage/storageAccounts/state` }],
      destinations: [
        { type: 'repository', identity: 'owner/repo', repository: 'owner/repo', subscriptionId: null },
        { type: 'environment', identity: 'staging', repository: 'owner/repo', subscriptionId },
        { type: 'subscription', identity: subscriptionId, repository: 'owner/repo', subscriptionId }
      ]
    };
    await mkdir(path.join(root, 'governance', 'approvals'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify(current));
    await writeFile(path.join(root, 'governance', 'approvals', 'future.json'), JSON.stringify(approval));
    const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {}, diagnostics: [], refsStable: true
    });
    await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(collector).toHaveBeenCalledWith(expect.objectContaining({ azure: [], runner: null }), expect.any(Object));
  });

  it('selects only referenced evidence bound to a real baseline and saved phase context', async () => {
    const root = await fixture();
    const manifest = await loadManifest(root);
    const current = state();
    const phaseId = 'phase-0-complete';
    const baselineSha = 'a'.repeat(64);
    const inputDigest = 'b'.repeat(64);
    const contexts = Object.fromEntries(phaseIds.map((id) => [id,
      evidenceContextForPhase(id, { repositoryId: current.repository.id, baselineSha, inputDigest, now: now() })
    ])) as GovernanceTransitionInspection['contexts'];
    const inspection: GovernanceTransitionInspection = {
      projectRoot: root, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash,
      state: current, approvals: [], evidence: [], contexts,
      readiness: {
        nextReadyPhase: phaseId,
        phases: Object.fromEntries(phaseIds.map((id) => [id, { state: id === phaseId ? 'ready' : 'blocked', blockers: [] }])) as GovernanceTransitionInspection['readiness']['phases']
      },
      sourceOfTruth: await inspectGovernanceSourceOfTruth({ projectRoot: root, manifest, state: current, evidence: [] })
    };
    const plan = await buildSavedTransitionPlan({ inspection, runner: noCommands, now: now() });
    expect(plan).not.toBeNull();
    const context = contexts[phaseId];
    const record: PhaseEvidenceRecord = {
      evidenceId: 'bound-discovery',
      header: {
        schemaVersion: 1, repositoryId: current.repository.id, identity: currentActivationIdentity,
        phaseGraphHash: canonicalPhaseGraphHash, phaseId, phaseContractDigest: context.phaseContractDigest,
        baselineSha, inputDigest, transition: context.transition,
        producedAt: now().toISOString(), producer: 'test', result: 'verified'
      }
    };
    current.phases[phaseId] = {
      ...current.phases[phaseId], state: 'verified',
      evidence: [{ phaseId, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }]
    };
    await mkdir(path.join(root, 'governance', 'plans'), { recursive: true });
    await mkdir(path.join(root, 'governance', 'evidence'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'plans', 'discovery.json'), JSON.stringify(plan));
    await writeFile(path.join(root, 'governance', 'evidence', 'discovery.json'), JSON.stringify(record));
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify(current));
    const project = await inspectAssessmentProject(new AssessmentFiles(root));
    expect(project.plans).toHaveLength(1);
    expect(project.approvals).toEqual([]);
    project.bindingBaseline = baselineSha;
    expect(selectBoundAssessmentEvidence(project, phaseId, now())?.evidenceId).toBe(record.evidenceId);
    expect(selectBoundAssessmentEvidence(project, phaseId, now())?.record).toEqual(record);
    project.evidence.unshift({ ...record, payload: { runnerId: 999 } });
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).toBeNull();
    project.evidence.shift();
    await writeFile(path.join(root, 'governance', 'evidence', 'duplicate.json'),
      JSON.stringify({ ...record, payload: { runnerId: 999 } }));
    const duplicated = await inspectAssessmentProject(new AssessmentFiles(root));
    expect(duplicated.evidence.some((entry) => entry.evidenceId === record.evidenceId)).toBe(false);
    expect(duplicated.diagnostics.some((entry) => entry.code === 'ambiguous-evidence')).toBe(true);
    project.state!.phases[phaseId].evidence = [];
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).toBeNull();
    project.bindingBaseline = null;
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).toBeNull();
  });

  it('accepts a valid referenced approval without confusing authority and execution plan digests', async () => {
    const root = await fixture();
    const manifest = await loadManifest(root);
    const current = state();
    current.applicability.privateStagingDast = true;
    const phaseId = 'provider-ready';
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
    const baselineSha = 'a'.repeat(64);
    const inputDigest = 'b'.repeat(64);
    const contexts = Object.fromEntries(phaseIds.map((id) => [id,
      evidenceContextForPhase(id, { repositoryId: current.repository.id, baselineSha, inputDigest, now: now() })
    ])) as GovernanceTransitionInspection['contexts'];
    const authority = transitionPlanForPhase(phase, current, contexts[phaseId].transition);
    const subscriptionId = '00000000-0000-0000-0000-000000000001';
    const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/app/providers/Microsoft.Storage/storageAccounts/app`;
    const approval = {
      schemaVersion: 1, id: 'approved-resources', ...authority,
      approvedAt: '2026-09-04T00:00:00Z', expiresAt: '2026-10-04T00:00:00Z', approver: 'owner',
      resources: [...authority.resources, { type: 'Microsoft.Storage/storageAccounts', identity: resourceId }],
      destinations: [
        ...authority.destinations,
        { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo', subscriptionId: null },
        { type: 'environment' as const, identity: 'staging', repository: 'owner/repo', subscriptionId },
        { type: 'subscription' as const, identity: subscriptionId, repository: 'owner/repo', subscriptionId }
      ]
    };
    const inspection: GovernanceTransitionInspection = {
      projectRoot: root, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash,
      state: current, approvals: [approval], evidence: [], contexts,
      readiness: {
        nextReadyPhase: phaseId,
        phases: Object.fromEntries(phaseIds.map((id) => [id, { state: id === phaseId ? 'ready' : 'blocked', blockers: [] }])) as GovernanceTransitionInspection['readiness']['phases']
      },
      sourceOfTruth: await inspectGovernanceSourceOfTruth({ projectRoot: root, manifest, state: current, evidence: [] })
    };
    const plan = await buildSavedTransitionPlan({ inspection, runner: noCommands, now: now() });
    expect(plan?.approval.evaluation.status).toBe('reused');
    expect(plan?.planDigest).not.toBe(approval.planDigest);
    current.phases[phaseId].approvals = [approval.id];
    const project = await inspectAssessmentProject(new AssessmentFiles(root));
    project.state = current;
    project.bindingBaseline = baselineSha;
    project.plans = [plan!];
    project.approvals = [approval];
    const git = { repository: null, head: null, issues: [], originState: 'none' as const };
    expect(resolveAssessmentLiveScope(project, git, now()).azure).toContainEqual(expect.objectContaining({ resourceId }));
    project.approvals = [{ ...approval, approvedAt: '2026-10-01T00:00:00Z' }];
    expect(resolveAssessmentLiveScope(project, git, now()).azure).toEqual([]);
  });
});

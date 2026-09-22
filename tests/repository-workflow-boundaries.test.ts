import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { supportedStack } from '../src/supported-stack.js';
import { verifyWorkflowBoundaries } from '../scripts/repository-security/workflow-policy.ts';

const actions = [...Object.values(supportedStack.githubActions),
  { repository: 'actions/upload-artifact', commit: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' },
  { repository: 'actions/download-artifact', commit: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c' }];
const checkout = actions.find(action => action.repository === 'actions/checkout')!;

function fixture() {
  return {
    on: { pull_request: null }, permissions: { contents: 'read' },
    concurrency: { group: 'fixture-${{ github.ref }}', 'cancel-in-progress': true },
    jobs: {
      test: {
        'runs-on': 'ubuntu-latest', 'timeout-minutes': 15,
        steps: [{ uses: `actions/checkout@${checkout.commit}`, with: { 'persist-credentials': false } }]
      }
    }
  };
}

describe('checked-in workflow privilege boundaries', () => {
  it('selects the verified installed Windows npm prefix rather than the older setup-node bundled npm', async () => {
    const workflow = parse(await readFile(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
    const steps = workflow.jobs.test.steps;
    const install = steps.findIndex((step: { name?: string }) => step.name === 'Select supported npm');
    const selected = steps[install + 1];
    expect(selected.if).toBe("runner.os == 'Windows'");
    expect(selected.shell).toBe('pwsh');
    expect(selected.run).toContain('npm prefix --global');
    expect(selected.run).toContain('[IO.Path]::IsPathRooted($prefix)');
    expect(selected.run).toContain('node_modules/npm/bin/npm-cli.js');
    expect(selected.run).toContain('node_modules/npm/package.json');
    expect(selected.run).toContain(`$package.version -ne "${supportedStack.packageManagers.npm.version}"`);
    expect(selected.run).toContain('$version = (node $cli --version).Trim()');
    expect(selected.run).toContain('$version -ne $package.version');
    expect(selected.run).toContain('Add-Content -LiteralPath $env:GITHUB_PATH -Value $prefix -Encoding utf8');
    expect(selected.run).toContain('Add-Content -LiteralPath $env:GITHUB_ENV -Value "LIFTOFF_CI_NPM_PREFIX=$prefix" -Encoding utf8');
    expect(selected.run).not.toMatch(/SetEnvironmentVariable|LOCALAPPDATA|APPDATA|continue-on-error/);
    expect(steps[install + 2].name).toBe('Install dependencies');
    expect(workflow.jobs.test['timeout-minutes']).toBe(45);
  });
  it('isolates the single-input module contrast and unchanged controller on three bounded Windows runners', async () => {
    const source = parse(await readFile(path.join(process.cwd(), '.github', 'workflows', 'security-qualification.yml'), 'utf8'));
    const job = source.jobs['windows-bootstrap'];
    expect(job['runs-on']).toBe('windows-latest');
    expect(job['timeout-minutes']).toBe(5);
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job.environment).toBeUndefined();
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { include: [
      { probe: 'exact-baseline', compiler: 'exact', 'module-scope': 'baseline' },
      { probe: 'exact-builtin', compiler: 'exact', 'module-scope': 'builtin-only' },
      { probe: 'controller' }
    ] } });
    expect(job.steps.find((step: { env?: Record<string, string> }) => step.env?.LIFTOFF_COMPILER_MODULE_SCOPE)
      .env.LIFTOFF_COMPILER_MODULE_SCOPE).toBe('${{ matrix.module-scope }}');
    expect(job.steps.find((step: { env?: Record<string, string> }) => step.env?.LIFTOFF_WINDOWS_CONTROLLER_DIAGNOSTIC)
      .run).toBe('npx --no-install vitest run tests/windows-job-diagnostic.test.ts');
    expect(job.steps.at(-1)).toMatchObject({
      if: "matrix.probe == 'controller'",
      env: { LIFTOFF_WINDOWS_WORKSPACE_DIAGNOSTIC: '1' },
      run: 'npx --no-install vitest run tests/windows-workspace-diagnostic.test.ts'
    });
    expect(JSON.stringify(job)).not.toMatch(/continue-on-error|upload-artifact|ExecutionPolicy|Bypass/);
  });
  it('adds only bounded controller diagnostics after an actual Windows boundary failure', async () => {
    const workflow = parse(await readFile(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
    const steps = workflow.jobs.test.steps;
    const boundary = steps.find((step: { id?: string }) => step.id === 'windows-boundaries');
    const diagnostic = steps.find((step: { env?: Record<string, string> }) => step.env?.LIFTOFF_WINDOWS_CONTROLLER_DIAGNOSTIC === '1');
    expect(boundary.run).toContain('tests/windows-job-runner.test.ts');
    expect(diagnostic.if).toBe("${{ failure() && runner.os == 'Windows' && steps.windows-boundaries.conclusion == 'failure' }}");
    expect(diagnostic.run).toBe('npx vitest run tests/windows-job-diagnostic.test.ts');
    expect(diagnostic['continue-on-error']).toBeUndefined();
    expect(workflow.jobs.test['timeout-minutes']).toBe(45);
  });
  it('reuses the canonical four-graph audit for PRs, both scheduled refs and release qualification', async () => {
    const audit = await readFile(path.join(process.cwd(), '.github', 'workflows', 'template-dependency-audit.yml'), 'utf8');
    const release = await readFile(path.join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
    expect(audit).toContain('pull_request:');
    expect(audit).toContain("if: ${{ github.event_name == 'pull_request' }}");
    expect(audit).toContain('run: node scripts/repository-security/dependency-review.ts');
    expect(audit).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(audit).toContain('branches: [develop, main]');
    expect(audit).toContain('fromJSON(\'["develop","main"]\')');
    expect(audit).toContain('ref: ${{ matrix.ref || github.sha }}');
    for (const source of [audit, release]) {
      expect(source).toContain('LIFTOFF_NPM_AUDIT_REGISTRY: https://registry.npmjs.org');
      expect(source).toContain('run: npm run audit:template-dependencies');
      expect(source).not.toContain('continue-on-error');
    }
    expect(release.indexOf('- name: Audit release npm dependency graphs')).toBeLessThan(release.indexOf('- name: Publish to npm'));
  });

  it.each(['ci.yml', 'release.yml', 'template-dependency-audit.yml', 'supported-stack-freshness.yml', 'codeql.yml', 'security-qualification.yml'])(
    'checks actual %s boundary without claiming hosted enforcement or nested-action qualification', async name => {
      const value: unknown = parse(await readFile(path.join(process.cwd(), '.github', 'workflows', name), 'utf8'));
      expect(() => verifyWorkflowBoundaries(value, { actions, ...(name === 'release.yml'
        ? { publisherJob: 'publish', publicationJobs: ['assemble', 'publish', 'finalize'] } : {}),
        ...(name === 'codeql.yml' ? { reportingJobs: { pullRequest: 'report-pr', protectedRef: 'report-protected' } } : {}) }))
        .not.toThrow();
    });

  it('keeps native Linux qualification a bounded read-only fixture rather than a source or release verdict', async () => {
    const source = await readFile(path.join(process.cwd(), '.github/workflows/security-qualification.yml'), 'utf8');
    const value = parse(source), job = value.jobs['linux-osv-network'];
    expect(Object.keys(value.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
    expect(value.on.pull_request.branches).toEqual(['develop', 'main']);
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(15);
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job.environment).toBeUndefined();
    expect(source).not.toMatch(/secrets\.|id-token|upload-artifact|continue-on-error|pull_request_target|workflow_run/);
    expect(source).toContain('npm ci --ignore-scripts');
    expect(source).toContain('env -i PATH="$PATH" HOME="$RUNNER_TEMP"');
    expect(source).toContain('linux-osv-fixture.ts');
  });

  it('rejects excessive default permissions and job-level OIDC for validation', () => {
    const value = fixture();
    expect(() => verifyWorkflowBoundaries({ ...value, permissions: { contents: 'write' } }, { actions }))
      .toThrow('excess-workflow-permissions');
    expect(() => verifyWorkflowBoundaries({
      ...value, jobs: { test: { ...value.jobs.test, permissions: { contents: 'read', 'id-token': 'write' } } }
    }, { actions })).toThrow('excess-workflow-permissions');
  });

  it('isolates source reporting from candidate execution and preserves read-only fork/Dependabot jobs', async () => {
    const value = parse(await readFile(path.join(process.cwd(), '.github', 'workflows', 'codeql.yml'), 'utf8'));
    const policy = { actions, reportingJobs: { pullRequest: 'report-pr', protectedRef: 'report-protected' } };
    expect(value.jobs['report-pr'].permissions).toEqual({ contents: 'read' });
    expect(value.jobs['report-protected'].permissions).toEqual({ contents: 'read', 'security-events': 'write' });
    for (const change of [
      (v: typeof value) => { v.jobs['report-pr'].permissions['security-events'] = 'write'; },
      (v: typeof value) => { v.jobs['report-protected'].if = "${{ always() }}"; },
      (v: typeof value) => { v.jobs['report-pr'].steps[0].with.ref = '${{ inputs.ref }}'; },
      (v: typeof value) => { v.jobs['report-protected'].steps.push({ run: 'node downloaded/candidate.js' }); },
      (v: typeof value) => { v.jobs['report-protected'].environment = 'npm-publisher'; },
      (v: typeof value) => { v.jobs['report-protected'].permissions['id-token'] = 'write'; }
    ]) {
      const altered = structuredClone(value);
      change(altered);
      expect(() => verifyWorkflowBoundaries(altered, policy)).toThrow();
    }
  });

  it('rejects privileged untrusted triggers, secret access and non-ephemeral runners', () => {
    for (const event of ['pull_request_target', 'workflow_run']) {
      expect(() => verifyWorkflowBoundaries({ ...fixture(), on: { [event]: null } }, { actions }))
        .toThrow('unapproved-workflow-event');
    }
    const value = fixture();
    value.jobs.test['runs-on'] = 'self-hosted';
    expect(() => verifyWorkflowBoundaries(value, { actions })).toThrow('unapproved-runner');
    for (const expression of [
      '${{ secrets.PRIVATE }}', "${{ secrets ['PRIVATE'] }}", '${{ toJSON(secrets) }}', '${{ SECRETS.PRIVATE }}',
      "${{ format('}} {0}', secrets.PRIVATE) }}", "${{ format('it''s {0}', secrets.PRIVATE) }}"
    ]) {
      expect(() => verifyWorkflowBoundaries({
        ...fixture(), jobs: { test: { ...fixture().jobs.test, env: { TOKEN: expression } } }
      }, { actions })).toThrow('untrusted-secret-access');
    }
    expect(() => verifyWorkflowBoundaries({
      ...fixture(), jobs: { test: { ...fixture().jobs.test, name: 'Check secrets',
        env: { LABEL: "${{ format('{0}', 'secrets') }}" } } }
    }, { actions })).not.toThrow();
  });

  it('rejects mutable/unselected references, credentials, missing bounds and absent concurrency', () => {
    const mutable = fixture();
    mutable.jobs.test.steps[0]!.uses = 'actions/checkout@v7';
    expect(() => verifyWorkflowBoundaries(mutable, { actions })).toThrow('unapproved-action-reference');
    const persisted = fixture();
    persisted.jobs.test.steps[0]!.with['persist-credentials'] = true;
    expect(() => verifyWorkflowBoundaries(persisted, { actions })).toThrow('persisted-checkout-credentials');
    const unbounded = fixture();
    unbounded.jobs.test['timeout-minutes'] = 0;
    expect(() => verifyWorkflowBoundaries(unbounded, { actions })).toThrow('unbounded-workflow-job');
    expect(() => verifyWorkflowBoundaries({ ...fixture(), concurrency: null }, { actions })).toThrow('invalid-workflow-object');
  });

  it('rejects workflow-level secret access, cloud/write permissions and ignored failures', () => {
    expect(() => verifyWorkflowBoundaries({ ...fixture(), env: { TOKEN: '${{ secrets.TOKEN }}' } }, { actions }))
      .toThrow('untrusted-secret-access');
    for (const permissions of [{ contents: 'write' }, { contents: 'read', deployments: 'write' },
      { contents: 'read', 'security-events': 'write' }, { contents: 'read', 'id-token': 'write' }]) {
      expect(() => verifyWorkflowBoundaries({ ...fixture(), jobs: { test: { ...fixture().jobs.test, permissions } } }, { actions }))
        .toThrow('excess-workflow-permissions');
    }
    for (const value of [
      { ...fixture(), jobs: { test: { ...fixture().jobs.test, 'continue-on-error': true } } },
      { ...fixture(), jobs: { test: { ...fixture().jobs.test, steps: [{ run: 'scan', 'continue-on-error': true }] } } }
    ]) expect(() => verifyWorkflowBoundaries(value, { actions })).toThrow('ignored-workflow-failure');
  });

  it('blocks implicit and cross-domain dependency caches', () => {
    const node = actions.find(action => action.repository === 'actions/setup-node')!;
    for (const inputs of [{ 'node-version': '24' }, { 'package-manager-cache': false, cache: 'npm' }]) {
      expect(() => verifyWorkflowBoundaries({ ...fixture(), jobs: { test: { ...fixture().jobs.test,
        steps: [{ uses: `${node.repository}@${node.commit}`, with: inputs }] } } }, { actions }))
        .toThrow('workflow-cache-not-isolated');
    }
  });

  it('keeps exact release event/ref/environment/producer bindings fail-closed', async () => {
    const source = parse(await readFile(path.join(process.cwd(), '.github/workflows/release.yml'), 'utf8'));
    const policy = { actions, publisherJob: 'publish', publicationJobs: ['assemble', 'publish', 'finalize'] };
    for (const change of [
      (w: typeof source) => { w.on.pull_request = null; },
      (w: typeof source) => { w.jobs.publish.if = "${{ inputs.dry_run == false }}"; },
      (w: typeof source) => { w.jobs.publish.steps[0].with.ref = '${{ inputs.ref }}'; },
      (w: typeof source) => { w.jobs.publish.steps.push({ run: 'node release-candidate/package/install.js' }); },
      (w: typeof source) => { w.jobs.validate.environment = 'npm-publisher'; },
      (w: typeof source) => { w.on.workflow_dispatch.inputs.dry_run.default = false; },
      (w: typeof source) => { w.concurrency['cancel-in-progress'] = true; }
    ]) {
      const candidate = structuredClone(source);
      change(candidate);
      expect(() => verifyWorkflowBoundaries(candidate, policy)).toThrow();
    }
    for (const input of [
      { 'run-id': '${{ inputs.run }}' }, { 'github-token': '${{ github.token }}' },
      { pattern: '*' }, { name: 'latest' }, { 'artifact-ids': '${{ inputs.artifact }}' },
      { path: '${{ github.workspace }}/download' }
    ]) {
      const candidate = structuredClone(source);
      const download = candidate.jobs.publish.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/download-artifact@'));
      Object.assign(download.with, input);
      expect(() => verifyWorkflowBoundaries(candidate, policy)).toThrow('unbound-workflow-artifact');
    }
  });
});

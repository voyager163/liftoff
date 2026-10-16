import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import {
  checkIssueForm, checkPromotion, checkRepositoryPolicy, checkWorkflow,
  communityFiles, workflowFiles, checkIsolatedHclReport, checkIsolatedHclRuntime,
  isolatedHclQualificationJob, isolatedHclTestCommand, checkPluginPathReport, pluginPathTestCommand,
  nativeBundleQualificationJob, nativePlatformQualificationJob,
  checkNativeCustodyQualificationJob, nativeCustodyWorkflowFile
} from '../scripts/check-repository-policy.mjs';

const root = process.cwd();
const fixtures: string[] = [];
const readWorkflow = async (name: string) => parse(await readFile(path.join(root, '.github', 'workflows', name), 'utf8'));

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function pullRequest(base: string, head: string, owner = 'voyager163/liftoff') {
  return { pull_request: {
    base: { ref: base, repo: { full_name: 'voyager163/liftoff' } },
    head: { ref: head, repo: { full_name: owner } }
  } };
}

describe('source repository setup policy', () => {
  it.each(['test-shards', 'coverage-cli'])('selects qualified Node24.21.0 for CLI job %s', async job => {
    const workflow = await readWorkflow('ci.yml');
    const setup = workflow.jobs[job].steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/setup-node@'));
    expect(setup.with['node-version']).toBe('24.21.0');
  });

  it('pins a dispatch-only native custody qualification without changing ordinary CI', async () => {
    const workflow = await readWorkflow(nativeCustodyWorkflowFile);
    expect(workflow.on.workflow_dispatch).toBeNull();
    expect(Object.keys(workflow.jobs)).toEqual(['policy', 'qualify-native-custody']);
    expect(workflow.jobs['qualify-native-custody'].if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(() => checkNativeCustodyQualificationJob(workflow.jobs['qualify-native-custody'])).not.toThrow();
    expect(() => checkWorkflow(nativeCustodyWorkflowFile, workflow)).not.toThrow();
    expect((await readWorkflow('ci.yml')).jobs['qualify-native-custody']).toBeUndefined();
  });
  it.each([
    'trigger', 'runner', 'timeout', 'node', 'architecture', 'npm', 'npm-identity', 'native-budget', 'opentofu',
    'docker-download', 'docker-checksum', 'compose-download', 'compose-checksum', 'compose-layout', 'compose-evidence',
    'openspec', 'openspec-cutoff', 'openspec-profile', 'gateway-install',
    'full-suite-filter', 'coverage-workers', 'coverage-verifier',
    'focused-file', 'package', 'policy', 'clean', 'missing-evidence'
  ])('rejects incomplete hosted native custody qualification: %s', async fault => {
    const workflow = await readWorkflow(nativeCustodyWorkflowFile);
    const job = workflow.jobs['qualify-native-custody'];
    const step = (name: string) => job.steps.find((candidate: { name?: string }) => candidate.name === name);
    if (fault === 'trigger') job.if = "${{ github.event_name == 'push' }}";
    if (fault === 'runner') job['runs-on'] = 'macos-latest';
    if (fault === 'timeout') job['timeout-minutes'] = 60;
    if (fault === 'node') job.steps[1].with['node-version'] = '24.20.0';
    if (fault === 'architecture') job.steps[1].with.architecture = 'x64';
    if (fault === 'npm') step('Select supported npm').run = 'npm install --global npm@latest';
    if (fault === 'npm-identity') {
      step('Verify native toolchain').run = step('Verify native toolchain').run.replace(
        "assert.equal(path.basename(npmLauncher), 'npm-cli.js');",
        ''
      );
    }
    if (fault === 'native-budget') delete job.env.OB1_SUPPORT_REMAINING;
    if (fault === 'opentofu') job.steps[4].with.tofu_version = '1.13.1';
    if (fault === 'docker-download') {
      step('Install qualified Docker and Compose').run =
        step('Install qualified Docker and Compose').run.replace('docker-29.8.2.tgz', 'docker-latest.tgz');
    }
    if (fault === 'docker-checksum') {
      step('Install qualified Docker and Compose').run =
        step('Install qualified Docker and Compose').run.replace('5ffa2bafbabe0734', '0ffa2bafbabe0734');
    }
    if (fault === 'compose-download') {
      step('Install qualified Docker and Compose').run =
        step('Install qualified Docker and Compose').run.replace('v5.5.1', 'v5.6.0');
    }
    if (fault === 'compose-checksum') {
      step('Install qualified Docker and Compose').run =
        step('Install qualified Docker and Compose').run.replace('998735c9b6fe68a4', '098735c9b6fe68a4');
    }
    if (fault === 'compose-layout') {
      step('Install qualified Docker and Compose').run =
        step('Install qualified Docker and Compose').run.replace('cli-plugins/docker-compose', 'plugins/docker-compose');
    }
    if (fault === 'compose-evidence') delete step('Record hosted native qualification evidence').env.NATIVE_COMPOSE_EXECUTABLE;
    if (fault === 'openspec') step('Install pinned OpenSpec').run = 'npm install @fission-ai/openspec@latest';
    if (fault === 'openspec-cutoff') {
      step('Install pinned OpenSpec').run =
        step('Install pinned OpenSpec').run.replace('2026-09-26T23:59:59Z', '2026-09-27T23:59:59Z');
    }
    if (fault === 'openspec-profile') {
      step('Install pinned OpenSpec').run =
        step('Install pinned OpenSpec').run.replace('node scripts/native-custody-qualification.mjs verify-openspec-profile \\\n', '');
    }
    if (fault === 'gateway-install') {
      step('Install dependencies').run =
        step('Install dependencies').run.replace('npm ci --prefix services/telemetry-ingest', '');
    }
    if (fault === 'full-suite-filter') step('Run unfiltered full suite').run += ' -t custody';
    if (fault === 'coverage-workers') {
      step('Run source-complete CLI coverage').run =
        step('Run source-complete CLI coverage').run.replace('--max-workers 1', '--max-workers 2');
    }
    if (fault === 'coverage-verifier') step('Verify source-complete coverage evidence').run = 'true';
    if (fault === 'focused-file') {
      step('Run focused custody and history checks').run =
        step('Run focused custody and history checks').run.replace('tests/contract-baseline.test.ts \\\n', '');
    }
    if (fault === 'package') step('Run package smoke').run = 'npm pack';
    if (fault === 'policy') step('Run repository policy').if = '${{ success() }}';
    if (fault === 'clean') step('Verify final clean bytes').run = 'git diff --check';
    if (fault === 'missing-evidence') job.steps.pop();
    expect(() => checkWorkflow(nativeCustodyWorkflowFile, workflow)).toThrow();
  });
  it('pins the complete runtime-inclusive development qualification without changing release publication', async () => {
    const workflow = await readWorkflow('ci.yml');
    expect(workflow.jobs['qualify-native-bundle']).toEqual(nativeBundleQualificationJob());
    expect(() => checkWorkflow('ci.yml', workflow)).not.toThrow();
    expect((await readWorkflow('release.yml')).jobs['qualify-native-bundle']).toBeUndefined();
  });
  it.each([
    'missing', 'conditional', 'runner', 'node', 'architecture', 'go', 'install', 'download',
    'build', 'filtered', 'unset-bundle', 'unset-migration-bundle', 'wrong-migration-bundle', 'missing-migration-cases',
    'skip-migration-report', 'unset-archive', 'archive-after-tests', 'skip-report', 'conditional-cases', 'missing-upload', 'ignored-report'
  ])('rejects incomplete runtime-inclusive qualification: %s', async fault => {
    const workflow = await readWorkflow('ci.yml'), job = workflow.jobs['qualify-native-bundle'];
    if (fault === 'missing') delete workflow.jobs['qualify-native-bundle'];
    if (fault === 'conditional') job.if = 'false';
    if (fault === 'runner') job['runs-on'] = 'macos-latest';
    if (fault === 'node') job.steps[1].with['node-version'] = '24.20.0';
    if (fault === 'architecture') job.steps[1].with.architecture = 'x64';
    if (fault === 'go') job.steps[2].with['go-version'] = 'latest';
    if (fault === 'install') job.steps[4].run = 'npm install';
    if (fault === 'download') job.steps[5].run += ' || true';
    if (fault === 'build') job.steps[6].run = 'npm run build';
    if (fault === 'filtered') job.steps[7].run = job.steps[7].run.replace('--allowOnly=false', '-t skipped');
    if (fault === 'unset-bundle') job.steps[7].run = job.steps[7].run.replace('LIFTOFF_NATIVE_BUNDLE_ROOT', 'UNSELECTED_BUNDLE');
    if (fault === 'unset-migration-bundle') job.steps[7].run = job.steps[7].run.replace('LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT', 'UNSELECTED_MIGRATION_BUNDLE');
    if (fault === 'wrong-migration-bundle') job.steps[7].run = job.steps[7].run.replace(
      'LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT="$RUNNER_TEMP/liftoff-native-bundle"',
      'LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT="$RUNNER_TEMP/unverified-bundle"');
    if (fault === 'missing-migration-cases') job.steps[7].run = job.steps[7].run.replace(/^  tests\/mac-migration-package.test.ts.*\n/m, '');
    if (fault === 'skip-migration-report') job.steps[7].run = job.steps[7].run.replace(/^node scripts\/mac-migration-package-report.mjs.*\n/m, '');
    if (fault === 'unset-archive') job.steps[7].run = job.steps[7].run.replace('LIFTOFF_NATIVE_ARCHIVE_ROOT', 'UNSELECTED_ARCHIVE');
    if (fault === 'archive-after-tests') {
      const archive = job.steps[7].run.split('\n')[0];
      job.steps[7].run = job.steps[7].run.slice(archive.length + 1) + archive + '\n';
    }
    if (fault === 'skip-report') job.steps[7].run = job.steps[7].run.replace(/^node scripts\/native-bundle.mjs verify-report.*\n/m, '');
    if (fault === 'conditional-cases') job.steps[7].if = 'false';
    if (fault === 'missing-upload') job.steps.pop();
    if (fault === 'ignored-report') job.steps[8].with['if-no-files-found'] = 'ignore';
    expect(() => checkWorkflow('ci.yml', workflow)).toThrow();
  });
  it('pins complete Linux x64/arm64 and Windows native package qualification without enabling publication', async () => {
    const workflow = await readWorkflow('ci.yml');
    expect(workflow.jobs['qualify-native-platform-packages']).toEqual(nativePlatformQualificationJob());
    expect((await readWorkflow('release.yml')).jobs['qualify-native-platform-packages']).toBeUndefined();
  });
  it.each(['qualify-native-bundle', 'qualify-native-platform-packages'])(
    'requires complete release-set failure/recovery contracts in %s', async id => {
      const workflow = await readWorkflow('ci.yml');
      const step = workflow.jobs[id].steps.find((value: { run?: string }) => value.run?.includes('tests/native-release-set.test.ts'));
      expect(step).toBeDefined();
      step.run = step.run.replace('tests/native-release-set.test.ts ', '');
      expect(() => checkWorkflow('ci.yml', workflow)).toThrow();
    });
  it.each(['qualify-native-bundle', 'qualify-native-platform-packages', 'coverage-cli', 'coverage-gateway'])(
    'rejects synthetic-merge or unbound source checkout in %s qualification', async id => {
      const workflow = await readWorkflow('ci.yml');
      delete workflow.jobs[id].steps[0].with.ref;
      expect(() => checkWorkflow('ci.yml', workflow)).toThrow();
    });
  it.each(['missing', 'matrix', 'runner', 'conditional', 'compiler', 'runtime', 'filtered', 'report', 'archive', 'unset-archive', 'upload'])(
    'rejects incomplete native platform packaging: %s', async fault => {
      const workflow = await readWorkflow('ci.yml'), job = workflow.jobs['qualify-native-platform-packages'];
      if (fault === 'missing') delete workflow.jobs['qualify-native-platform-packages'];
      if (fault === 'matrix') job.strategy.matrix.include.pop();
      if (fault === 'runner') job.strategy.matrix.include[0].os = 'ubuntu-latest';
      if (fault === 'conditional') job.if = 'false';
      if (fault === 'compiler') job.steps[4].run += ' || true';
      if (fault === 'runtime') job.steps[1].with['node-version'] = 'latest';
      if (fault === 'filtered') job.steps[6].run += ' -t skipped';
      if (fault === 'report') job.steps[6].run = job.steps[6].run.replace(/^node scripts\/native-package-report.*\n/m, '');
      if (fault === 'archive') job.steps[6].run = job.steps[6].run.replace(/^node scripts\/native-release.*\n/m, '');
      if (fault === 'unset-archive') job.steps[6].run = job.steps[6].run.replace('LIFTOFF_NATIVE_ARCHIVE_ROOT', 'UNSELECTED_ARCHIVE');
      if (fault === 'upload') job.steps[7].with['if-no-files-found'] = 'ignore';
      expect(() => checkWorkflow('ci.yml', workflow)).toThrow();
    });
  it.each([
    'missing-platform', 'conditional-job', 'filtered-command', 'conditional-command',
    'missing-verifier', 'conditional-verifier', 'missing-upload', 'success-only-upload', 'ignored-report'
  ])('rejects incomplete native plugin qualification: %s', async fault => {
    const workflow = await readWorkflow('ci.yml'), job = workflow.jobs['test-shards'];
    const run = job.steps.find((step: { run?: string }) => step.run === pluginPathTestCommand);
    const verify = job.steps.find((step: { run?: string }) => step.run?.includes('--plugin-path-report'));
    const upload = job.steps.find((step: { with?: { path?: string } }) => step.with?.path === 'qualification/plugin-paths.json');
    if (fault === 'missing-platform') job.strategy.matrix.os.pop();
    if (fault === 'conditional-job') job.if = 'false';
    if (fault === 'filtered-command') run.run += ' -t skipped';
    if (fault === 'conditional-command') run.if = 'false';
    if (fault === 'missing-verifier') job.steps.splice(job.steps.indexOf(verify), 1);
    if (fault === 'conditional-verifier') verify.if = 'false';
    if (fault === 'missing-upload') job.steps.splice(job.steps.indexOf(upload), 1);
    if (fault === 'success-only-upload') upload.if = '${{ success() }}';
    if (fault === 'ignored-report') upload.with['if-no-files-found'] = 'ignore';
    expect(() => checkWorkflow('ci.yml', workflow)).toThrow();
  });
  it.each([
    'missing-shard', 'excluded-shard', 'fail-fast', 'conditional-suite', 'filtered-suite',
    'success-only-aggregate', 'missing-dependency', 'ignored-result', 'missing-test-report',
    'success-only-test-report', 'unbounded-timeout'
  ])('rejects incomplete full-suite sharding: %s', async fault => {
    const workflow = await readWorkflow('ci.yml'), shards = workflow.jobs['test-shards'];
    const run = shards.steps.find((step: { name?: string }) => step.name === 'Run package check');
    const upload = shards.steps.find((step: { with?: { path?: string } }) => step.with?.path === 'qualification/platform-tests.json');
    if (fault === 'missing-shard') shards.strategy.matrix.shard.pop();
    if (fault === 'excluded-shard') shards.strategy.matrix.exclude = [{ os: 'windows-latest', shard: 2 }];
    if (fault === 'fail-fast') shards.strategy['fail-fast'] = true;
    if (fault === 'conditional-suite') run.if = 'false';
    if (fault === 'filtered-suite') run.run += ' tests/only-one.test.ts';
    if (fault === 'success-only-aggregate') workflow.jobs.test.if = '${{ success() }}';
    if (fault === 'missing-dependency') delete workflow.jobs.test.needs;
    if (fault === 'ignored-result') workflow.jobs.test.steps[0].run = 'true';
    if (fault === 'missing-test-report') shards.steps.splice(shards.steps.indexOf(upload), 1);
    if (fault === 'success-only-test-report') upload.if = '${{ success() }}';
    if (fault === 'unbounded-timeout') {
      shards['timeout-minutes'] =
        "${{ matrix.os == 'windows-latest' && matrix.shard == 2 && 120 || 45 }}";
    }
    expect(() => checkWorkflow('ci.yml', workflow)).toThrow();
  });
  function pluginReport(platform: string) {
    const suites = [
      ['plugin-native-paths.test.ts', 8], ['plugin-packaged-lookup-native.test.ts', 6],
      ['plugin-generation-parity.test.ts', 166], ['plugin-composition.test.ts', 25]
    ] as const;
    const testResults = suites.map(([name, count]) => ({
      name: `fixture/${name}`,
      assertionResults: Array.from({ length: count }, (_, index) => ({
        title: `case ${index}`, fullName: `suite case ${index}`, status: 'passed'
      }))
    }));
    if (platform !== 'win32') testResults[1].assertionResults[0] = {
      title: `reads a case-variant spelling of the package root (native Windows only; unrun on ${platform})`,
      fullName: `suite Windows-only case`, status: 'skipped'
    };
    return { success: true, numFailedTests: 0, numPendingTests: platform === 'win32' ? 0 : 1,
      numPassedTests: platform === 'win32' ? 205 : 204, numTotalTests: 205, testResults };
  }
  it.each(['win32', 'darwin', 'linux'] as const)('validates native plugin report shape without claiming execution on %s', platform => {
    expect(() => checkPluginPathReport(pluginReport(platform), platform)).not.toThrow();
  });
  it.each([
    'empty', 'missing-suite', 'duplicate-suite', 'filtered', 'duplicate-case', 'failed',
    'link-unavailable', 'windows-skipped', 'wrong-host-skip', 'wrong-count', 'unknown-host'
  ])('rejects incomplete native plugin reports: %s', fault => {
    const report = pluginReport('win32');
    if (fault === 'empty') report.testResults = [];
    if (fault === 'missing-suite') report.testResults.pop();
    if (fault === 'duplicate-suite') report.testResults[1] = report.testResults[0];
    if (fault === 'filtered') report.testResults[0].assertionResults.pop();
    if (fault === 'duplicate-case') report.testResults[0].assertionResults[1] = report.testResults[0].assertionResults[0];
    if (fault === 'failed') report.testResults[0].assertionResults[0].status = 'failed';
    if (fault === 'link-unavailable') report.testResults[0].assertionResults[0].status = 'skipped';
    if (fault === 'windows-skipped') Object.assign(report, pluginReport('darwin'));
    if (fault === 'wrong-host-skip') Object.assign(report, pluginReport('linux'));
    if (fault === 'wrong-count') report.numPassedTests--;
    expect(() => checkPluginPathReport(report, fault === 'unknown-host' ? 'freebsd' :
      fault === 'wrong-host-skip' ? 'darwin' : 'win32')).toThrow();
  });
  it.each(['ci.yml', 'release.yml'])('pins complete native parser qualification in %s', async name => {
    const workflow = await readWorkflow(name);
    expect(workflow.jobs['qualify-isolated-hcl']).toEqual(isolatedHclQualificationJob(name));
    expect(() => checkWorkflow(name, workflow)).not.toThrow();
    if (name === 'release.yml') {
      expect(Object.keys(workflow.jobs).sort()).toEqual(['publish', 'qualify', 'qualify-isolated-hcl']);
      expect(workflow.jobs.qualify.needs).toBe('qualify-isolated-hcl');
      expect(workflow.jobs.publish.needs).toBe('qualify');
    }
  });
  it.each(['ci.yml', 'release.yml'].flatMap(filename => [
    'missing', 'conditional', 'runner', 'node', 'architecture', 'mode', 'no-mode', 'case-command',
    'filtered-cases', 'suppressed-job', 'suppressed-step', 'missing-report', 'conditional-report',
    'upload-success-only', 'ignore-missing-evidence', 'changed-install', 'checkout-credentials'
  ].map(fault => ({ filename, fault }))))('rejects $fault in $filename parser qualification', async ({ filename, fault }) => {
    const workflow = await readWorkflow(filename), job = workflow.jobs['qualify-isolated-hcl'];
    if (fault === 'missing') delete workflow.jobs['qualify-isolated-hcl'];
    if (fault === 'conditional') job.if = 'false';
    if (fault === 'runner') job['runs-on'] = 'macos-latest';
    if (fault === 'node') job.steps[1].with['node-version'] = '24.20.0';
    if (fault === 'architecture') job.steps[1].with.architecture = 'x64';
    if (fault === 'mode') job.env.LIFTOFF_HCL_TEST_LANE = 'portable';
    if (fault === 'no-mode') delete job.env;
    if (fault === 'case-command') job.steps[5].run = 'npx vitest run tests/modern-local-check-plans.test.ts';
    if (fault === 'filtered-cases') job.steps[5].run = isolatedHclTestCommand + ' -t inert';
    if (fault === 'suppressed-job') job['continue-on-error'] = true;
    if (fault === 'suppressed-step') job.steps[5].run += ' || true';
    if (fault === 'missing-report') job.steps.splice(6, 1);
    if (fault === 'conditional-report') job.steps[6].if = 'false';
    if (fault === 'upload-success-only') job.steps[7].if = '${{ success() }}';
    if (fault === 'ignore-missing-evidence') job.steps[7].with['if-no-files-found'] = 'ignore';
    if (fault === 'changed-install') job.steps[3].run = 'npm install';
    if (fault === 'checkout-credentials') job.steps[0].with['persist-credentials'] = true;
    expect(() => checkWorkflow(filename, workflow)).toThrow();
  });
  it.each(['remove-edge', 'wrong-edge', 'extra-job', 'runner-elsewhere'])('rejects release parser bypass %s', async fault => {
    const workflow = await readWorkflow('release.yml');
    if (fault === 'remove-edge') delete workflow.jobs.qualify.needs;
    if (fault === 'wrong-edge') workflow.jobs.qualify.needs = 'unrelated';
    if (fault === 'extra-job') workflow.jobs.extra = structuredClone(workflow.jobs.qualify);
    if (fault === 'runner-elsewhere') workflow.jobs.qualify['runs-on'] = 'macos-15';
    expect(() => checkWorkflow('release.yml', workflow)).toThrow();
  });
  it('rejects native-required mismatch and non-native test modes without claiming another host run', () => {
    const qualified = { platform: 'darwin', arch: 'arm64', versions: { node: '24.21.0' } } as const;
    expect(() => checkIsolatedHclRuntime(qualified, 'native')).not.toThrow();
    for (const runtime of [
      { ...qualified, platform: 'linux' }, { ...qualified, platform: 'win32' },
      { ...qualified, arch: 'x64' }, { ...qualified, versions: { node: '24.20.0' } }
    ] as const) expect(() => checkIsolatedHclRuntime(runtime, 'native')).toThrow();
    for (const lane of ['portable', 'auto', 'invalid']) expect(() => checkIsolatedHclRuntime(qualified, lane)).toThrow();
  });
  it('rejects empty, skipped, filtered or incomplete report-shaped qualification', () => {
    for (const report of [
      {}, { success: true, numFailedTests: 0, numPendingTests: 0, testResults: [] },
      { success: true, numFailedTests: 0, numPendingTests: 1, testResults: [] },
      { success: false, numFailedTests: 1, numPendingTests: 0, testResults: [] },
      { success: true, numFailedTests: 0, numPendingTests: 0,
        testResults: Array.from({ length: 3 }, () => ({ name: 'tests/modern-local-inputs.test.ts', assertionResults: [] })) }
    ]) expect(() => checkIsolatedHclReport(report)).toThrow();
  });
  it('validates the explicitly named repository setup without inspecting application source', async () => {
    await expect(checkRepositoryPolicy(root)).resolves.toBeUndefined();
  });

  it('accepts public contributions and canonical release promotion', () => {
    expect(() => checkPromotion(pullRequest('develop', 'feature/docs', 'contributor/liftoff'))).not.toThrow();
    expect(() => checkPromotion(pullRequest('develop', 'sync/main'))).not.toThrow();
    expect(() => checkPromotion(pullRequest('main', 'develop'))).not.toThrow();
  });

  it('rejects noncanonical promotion and missing PR identity', () => {
    expect(() => checkPromotion(pullRequest('main', 'feature/docs'))).toThrow('Promote canonical develop');
    expect(() => checkPromotion(pullRequest('main', 'develop', 'contributor/liftoff'))).toThrow('fork named develop');
    expect(() => checkPromotion({})).toThrow('Missing PR');
  });

  it.each([
    ['write token', (workflow: ReturnType<typeof parse>) => { workflow.permissions.contents = 'write'; }],
    ['untrusted trigger', (workflow: ReturnType<typeof parse>) => { workflow.on.pull_request_target = null; }],
    ['mutable action', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].uses = 'actions/checkout@v7'; }],
    ['unapproved action', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].uses = `outsider/action@${'a'.repeat(40)}`; }],
    ['persisted credentials', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].with['persist-credentials'] = true; }],
    ['skipped policy', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.if = 'false'; }],
    ['path-filtered PR', (workflow: ReturnType<typeof parse>) => { workflow.on.pull_request = { paths: ['docs/**'] }; }],
    ['secret-bearing step', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].env = { TOKEN: '${{ secrets.TOKEN }}' }; }],
    ['OIDC on contribution job', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.permissions = { 'id-token': 'write' }; }]
  ])('rejects %s in contribution configuration', async (_name, mutate) => {
    const workflow = await readWorkflow('repository.yml');
    mutate(workflow);
    expect(() => checkWorkflow('repository.yml', workflow)).toThrow();
  });

  it.each([
    ['manual publish input', (workflow: ReturnType<typeof parse>) => { workflow.on.workflow_dispatch = { inputs: { publish: { type: 'boolean' } } }; }],
    ['workflow OIDC', (workflow: ReturnType<typeof parse>) => { workflow.permissions['id-token'] = 'write'; }],
    ['missing approval', (workflow: ReturnType<typeof parse>) => { delete workflow.jobs.publish.environment; }],
    ['bypassed qualification', (workflow: ReturnType<typeof parse>) => { delete workflow.jobs.publish.needs; }],
    ['arbitrary-ref publish', (workflow: ReturnType<typeof parse>) => { workflow.jobs.publish.if = '${{ success() }}'; }],
    ['cancellable release', (workflow: ReturnType<typeof parse>) => { workflow.concurrency['cancel-in-progress'] = true; }],
    ['suppressed failure', (workflow: ReturnType<typeof parse>) => { workflow.jobs.qualify.steps[0]['continue-on-error'] = true; }]
  ])('rejects %s in release configuration', async (_name, mutate) => {
    const workflow = await readWorkflow('release.yml');
    mutate(workflow);
    expect(() => checkWorkflow('release.yml', workflow)).toThrow();
  });

  it('rejects duplicate form IDs and labels that were not established', async () => {
    const form = parse(await readFile(path.join(root, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'utf8'));
    form.body.push(form.body[1]);
    expect(() => checkIssueForm(form, 'bug')).toThrow('unique');
    expect(() => checkIssueForm(form, 'unknown-label')).toThrow('established label');
  });

  it('resolves an explicit setup inventory from a directory containing spaces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff repository setup '));
    fixtures.push(directory);
    const files = [
      'package.json', 'README.md', ...communityFiles,
      path.join('.github', 'CODEOWNERS'), path.join('.github', 'PULL_REQUEST_TEMPLATE.md'),
      ...['bug_report.yml', 'feature_request.yml', 'config.yml'].map(file => path.join('.github', 'ISSUE_TEMPLATE', file)),
      ...workflowFiles.map((file: string) => path.join('.github', 'workflows', file)),
      ...['liftoff-hero.svg', 'liftoff-terminal.svg'].map(file => path.join('docs', 'assets', file))
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), await readFile(path.join(root, file)));
    }
    await expect(checkRepositoryPolicy(directory)).resolves.toBeUndefined();
    const hero = path.join(directory, 'docs', 'assets', 'liftoff-hero.svg');
    await writeFile(hero, `${await readFile(hero, 'utf8')}${' '.repeat(300 * 1024)}`);
    await expect(checkRepositoryPolicy(directory)).rejects.toThrow('Hero exceeds');
  });
});

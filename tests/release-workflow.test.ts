import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createRootTestConfig } from '../vitest.config.js';

const execFileAsync = promisify(execFile);
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const fullValidationCondition = "github.event_name != 'workflow_dispatch' || (!inputs.diagnostic_windows_only && !inputs.diagnostic_native_go_only && !inputs.diagnostic_native_posix_locks_only && !inputs.diagnostic_linux_keystore_build_only && !inputs.diagnostic_linux_gnome_persistence_only)";
const keystoreBuildCondition = `${fullValidationCondition} || (github.event_name == 'workflow_dispatch' && inputs.diagnostic_linux_keystore_build_only)`;
const fullValidationJobs = ['test', 'test-shards', 'telemetry-infrastructure', 'standard-node-templates', 'coverage-qualification'];
const defaultSourceJobs = [...fullValidationJobs, 'linux-keystore-build'];

async function scratchDirectory() {
  await mkdir('.cache', { recursive: true });
  return mkdtemp(path.resolve('.cache/ci-sharding-'));
}

describe('read-only coordinated release evidence workflow', () => {
  it('keeps all packaged text-resource families LF-stable under Windows checkout defaults', () => {
    const resources = [
      'assets/templates/components/common/dockerignore.txt', 'assets/templates/catalog.json',
      'assets/skills/catalog.json', 'assets/profiles/catalog.json', 'assets/distribution/native-trust.json',
      'assets/governance/single-maintainer-gitflow/policy.md', 'assets/repair/windows-job-controller.ps1'
    ];
    const fields = execFileSync('git', ['-c', 'core.autocrlf=true', 'check-attr', '-z', 'eol', '--', ...resources], {
      cwd: process.cwd(), encoding: 'utf8'
    }).split('\0').filter(Boolean);
    expect(fields).toEqual(resources.flatMap((file) => [file, 'eol', 'lf']));
  });

  it('fetches immutable release history for source tests without leaving checkout credentials in Git', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    for (const id of ['test', 'test-shards', 'coverage-qualification', 'windows-diagnostics', 'windows-boundary-diagnostics', 'windows-regression-diagnostics', 'windows-private-io-diagnostics', 'native-go-diagnostics', 'native-posix-lock-diagnostics', 'linux-keystore-build', 'linux-gnome-persistence']) {
      const checkout = workflow.jobs[id].steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false });
    }
  });

  it('measures native launcher source fixtures separately on each source host without claiming PE qualification', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs.test;
    expect(job.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    const measurement = job.steps.findIndex((step: any) =>
      step.name === 'Measure Windows launcher source fixtures (not native qualification)');
    expect(measurement).toBeGreaterThanOrEqual(0);
    const step = job.steps[measurement];
    expect(job.steps.slice(0, measurement).some((entry: any) => entry.uses?.startsWith('actions/setup-go@'))).toBe(true);
    expect(step.shell).toBe('bash');
    expect(step.run).toBe('go test -count=1 -coverprofile="$RUNNER_TEMP/liftoff-windows-launcher-source.coverprofile" scripts/distribution/windows-launcher.go scripts/distribution/windows-launcher_test.go');
    expect(step['continue-on-error']).toBeUndefined();
    const retained = job.steps[measurement + 1];
    expect(retained.if).toBe('always()');
    expect(retained.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(retained.with.name).toBe('windows-launcher-source-coverage-${{ matrix.os }}');
    expect(retained.with.path).toBe('${{ runner.temp }}/liftoff-windows-launcher-source.coverprofile');
    expect(retained.with['if-no-files-found']).toBe('error');
  });

  it('shards the entire three-OS suite without filters and reuses Linux tests for V8 coverage', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const shards = workflow.jobs['test-shards'];
    expect(shards.strategy).toEqual({
      'fail-fast': false,
      'max-parallel': 3,
      matrix: {
        os: ['ubuntu-latest', 'macos-latest', 'windows-latest'],
        shard: [1, 2, 3],
        include: [{ os: 'ubuntu-latest', coverage: '--coverage --maxWorkers=2' }]
      }
    });
    expect(shards['timeout-minutes']).toBe(45);
    const run = shards.steps.findIndex((step: any) => step.name === 'Run complete source test shard');
    expect(shards.steps[run].run).toBe(
      'npm test -- --shard=${{ matrix.shard }}/3 ${{ matrix.coverage }} ' +
      '--reporter=default --reporter=blob --outputFile.blob=source-test-blobs/shard-${{ matrix.shard }}.json'
    );
    for (const action of ['actions/setup-python@', 'actions/setup-go@', 'opentofu/setup-opentofu@']) {
      expect(shards.steps.slice(0, run).some((step: any) => step.uses?.startsWith(action))).toBe(true);
    }
    for (const command of [
      'python -m pip install uv==0.12.7 checkov==3.2.495',
      'npm ci', 'npm ci --prefix services/telemetry-ingest', 'npm run build'
    ]) {
      expect(shards.steps.slice(0, run).some((step: any) => step.run === command)).toBe(true);
    }
    const retained = shards.steps.at(-1);
    expect(retained.if).toBeUndefined();
    expect(retained.with.name).toBe('source-tests-${{ matrix.os }}-${{ github.sha }}-${{ github.run_attempt }}-${{ matrix.shard }}');
    expect(retained.with.path).toBe('source-test-blobs/shard-${{ matrix.shard }}.json');
    expect(retained.with['if-no-files-found']).toBe('error');
    const measurements = shards.steps[run + 1];
    expect(measurements.if).toBe("runner.os == 'Linux'");
    expect(measurements.run).toContain('coverage/coverage-final.json');
    expect(measurements.run).toContain('coverage/coverage-summary.json');
  });

  it('requires all same-source shards and measures telemetry independently before the unchanged strict gate', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['coverage-qualification'];
    const steps = job.steps;
    expect(job.needs).toBe('test-shards');
    expect(job.if).toBe(fullValidationCondition);
    expect(job['timeout-minutes']).toBe(45);
    const cli = steps.findIndex((step: any) => step.run === 'npx vitest run --merge-reports=source-test-blobs --coverage --reporter=default');
    const service = steps.findIndex((step: any) => step.run === 'npm run test:coverage --prefix services/telemetry-ingest -- --maxWorkers=2');
    const gate = steps.findIndex((step: any) => step.run === 'npm run gate:coverage');
    expect(cli).toBeGreaterThanOrEqual(0);
    expect(service).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(cli);
    expect(gate).toBeGreaterThan(service);
    const downloads = steps.slice(0, cli).filter((step: any) => step.uses?.startsWith('actions/download-artifact@'));
    expect(downloads.map((step: any) => step.with)).toEqual([1, 2, 3].map((shard) => ({
      name: `source-tests-ubuntu-latest-\${{ github.sha }}-\${{ github.run_attempt }}-${shard}`,
      path: 'source-test-blobs'
    })));
    expect(steps[cli - 1].name).toBe('Require every CLI shard report');
    for (const entry of Object.values(workflow.jobs) as any[]) {
      expect(entry['continue-on-error']).toBeUndefined();
      for (const step of entry.steps) expect(step['continue-on-error']).toBeUndefined();
    }
    expect(steps.at(-1).if).toBe('always()');
    expect(steps.at(-1).with['if-no-files-found']).toBe('error');
    expect(steps.at(-1).with.name).toBe('source-coverage');
    expect(steps.at(-1).with.path).toContain('coverage/coverage-final.json');
    expect(steps.at(-1).with.path).toContain('services/telemetry-ingest/coverage/coverage-final.json');
  });

  it('allows only explicit manual diagnostics without narrowing default, push or PR validation', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    expect(workflow.on.workflow_dispatch.inputs.diagnostic_windows_only).toEqual({
      description: 'Run Windows source diagnostics (not qualification)',
      type: 'boolean', required: false, default: false
    });
    expect(workflow.on.workflow_dispatch.inputs.windows_diagnostic_scope).toEqual({
      description: 'Windows diagnostic scope (requires diagnostic_windows_only)',
      type: 'choice', required: false, default: 'focused', options: ['focused', 'complete-boundary', 'private-io', 'remaining-regressions']
    });
    expect(workflow.on.workflow_dispatch.inputs.diagnostic_native_go_only).toEqual({
      description: 'Run native Go source diagnostics (not qualification)',
      type: 'boolean', required: false, default: false
    });
    expect(workflow.on.workflow_dispatch.inputs.diagnostic_native_posix_locks_only).toEqual({
      description: 'Run Linux POSIX lock source diagnostics (not custody or release qualification)',
      type: 'boolean', required: false, default: false
    });
    expect(workflow.on.workflow_dispatch.inputs.diagnostic_linux_keystore_build_only).toEqual({
      description: 'Build and test Linux keystore synthetic source behavior (not provider or custody qualification)',
      type: 'boolean', required: false, default: false
    });
    expect(workflow.on.workflow_dispatch.inputs.diagnostic_linux_gnome_persistence_only).toEqual({
      description: 'Test pinned GNOME persistence with generated data (not encrypted-host custody)',
      type: 'boolean', required: false, default: false
    });
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(workflow.on).toHaveProperty('pull_request');
    expect(Object.keys(workflow.jobs).sort()).toEqual([...defaultSourceJobs, 'windows-diagnostics', 'windows-boundary-diagnostics', 'windows-regression-diagnostics', 'windows-private-io-diagnostics', 'native-go-diagnostics', 'native-posix-lock-diagnostics', 'linux-gnome-persistence'].sort());
    for (const id of fullValidationJobs) {
      expect(workflow.jobs[id].if).toBe(fullValidationCondition);
    }
    const diagnostic = workflow.jobs['windows-diagnostics'];
    expect(diagnostic.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'focused'");
    expect(diagnostic.name).toContain('not qualification');
    expect(diagnostic['runs-on']).toBe('windows-latest');
    expect(diagnostic['timeout-minutes']).toBe(20);
    expect(diagnostic.needs).toBeUndefined();
    expect(diagnostic.steps.at(-2).run).toBe(
      'npx vitest run tests/windows-job-runner.test.ts tests/windows-job-protocol.test.ts ' +
      'tests/windows-execution-qualification.test.ts tests/repair-workspaces.test.ts tests/update-preview.test.ts tests/windows-native-toolchain.test.ts ' +
      '--maxWorkers=1 --reporter=verbose --reporter=json --outputFile.json=diagnostics/windows-source-tests.json'
    );
    expect(diagnostic.steps.at(-1).if).toBe('always()');
    expect(diagnostic.steps.at(-1).with.name).toBe('windows-source-diagnostics-${{ github.sha }}-${{ github.run_attempt }}');
    expect(diagnostic.steps.at(-1).with.path).toBe('diagnostics/windows-source-tests.json\ndiagnostics/windows-native-toolchain.json\n');
    expect(diagnostic.steps.at(-1).with['if-no-files-found']).toBe('error');
    expect(diagnostic.steps.some((step: any) => step.run?.includes('gate:coverage') || step.run?.includes('gate:release'))).toBe(false);
  });

  it.each([
    { windows: false, go: false, posix: false, build: false, manualJobs: defaultSourceJobs },
    { windows: true, go: false, posix: false, build: false, manualJobs: ['windows-diagnostics'] },
    { windows: false, go: true, posix: false, build: false, manualJobs: ['native-go-diagnostics'] },
    { windows: true, go: true, posix: false, build: false, manualJobs: ['windows-diagnostics', 'native-go-diagnostics'] },
    { windows: false, go: false, posix: true, build: false, manualJobs: ['native-posix-lock-diagnostics'] },
    { windows: true, go: false, posix: true, build: false, manualJobs: ['windows-diagnostics', 'native-posix-lock-diagnostics'] },
    { windows: false, go: true, posix: true, build: false, manualJobs: ['native-go-diagnostics', 'native-posix-lock-diagnostics'] },
    { windows: true, go: true, posix: true, build: false, manualJobs: ['windows-diagnostics', 'native-go-diagnostics', 'native-posix-lock-diagnostics'] },
    { windows: false, go: false, posix: false, build: true, manualJobs: ['linux-keystore-build'] },
    { windows: true, go: false, posix: false, build: true, manualJobs: ['windows-diagnostics', 'linux-keystore-build'] },
    { windows: false, go: true, posix: false, build: true, manualJobs: ['native-go-diagnostics', 'linux-keystore-build'] },
    { windows: true, go: true, posix: false, build: true, manualJobs: ['windows-diagnostics', 'native-go-diagnostics', 'linux-keystore-build'] },
    { windows: false, go: false, posix: true, build: true, manualJobs: ['native-posix-lock-diagnostics', 'linux-keystore-build'] },
    { windows: true, go: false, posix: true, build: true, manualJobs: ['windows-diagnostics', 'native-posix-lock-diagnostics', 'linux-keystore-build'] },
    { windows: false, go: true, posix: true, build: true, manualJobs: ['native-go-diagnostics', 'native-posix-lock-diagnostics', 'linux-keystore-build'] },
    { windows: true, go: true, posix: true, build: true, manualJobs: ['windows-diagnostics', 'native-go-diagnostics', 'native-posix-lock-diagnostics', 'linux-keystore-build'] }
  ].flatMap((selection) => [false, true].map((gnome) => ({
    ...selection, gnome,
    manualJobs: gnome
      ? [...(selection.windows || selection.go || selection.posix || selection.build ? selection.manualJobs : []), 'linux-gnome-persistence']
      : selection.manualJobs
  }))))('routes Windows=$windows, Go=$go, POSIX=$posix, build=$build and GNOME=$gnome without diagnostic success pretending to be full validation', async ({ windows, go, posix, build, gnome, manualJobs }) => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    for (const event of ['workflow_dispatch', 'push', 'pull_request']) {
      for (const windowsScope of ['focused', 'complete-boundary', 'private-io', 'remaining-regressions']) {
        const conditions: Record<string, boolean> = {
          [fullValidationCondition]: event !== 'workflow_dispatch' || (!windows && !go && !posix && !build && !gnome),
          [keystoreBuildCondition]: event !== 'workflow_dispatch' || (!windows && !go && !posix && !build && !gnome) || build,
          "github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'focused'":
            event === 'workflow_dispatch' && windows && windowsScope === 'focused',
          "github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'complete-boundary'":
            event === 'workflow_dispatch' && windows && windowsScope === 'complete-boundary',
          "github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'private-io'":
            event === 'workflow_dispatch' && windows && windowsScope === 'private-io',
          "github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'remaining-regressions'":
            event === 'workflow_dispatch' && windows && windowsScope === 'remaining-regressions',
          "github.event_name == 'workflow_dispatch' && inputs.diagnostic_native_go_only": event === 'workflow_dispatch' && go,
          "github.event_name == 'workflow_dispatch' && inputs.diagnostic_native_posix_locks_only": event === 'workflow_dispatch' && posix,
          "github.event_name == 'workflow_dispatch' && inputs.diagnostic_linux_gnome_persistence_only": event === 'workflow_dispatch' && gnome
        };
        const selected = Object.entries(workflow.jobs).filter(([, job]: [string, any]) => {
          expect(Object.hasOwn(conditions, job.if)).toBe(true);
          return conditions[job.if];
        }).map(([id]) => id);
        const expected = (event === 'workflow_dispatch' ? manualJobs : defaultSourceJobs).map((job) => {
          if (job !== 'windows-diagnostics') return job;
          if (windowsScope === 'complete-boundary') return 'windows-boundary-diagnostics';
          if (windowsScope === 'remaining-regressions') return 'windows-regression-diagnostics';
          return windowsScope === 'private-io' ? 'windows-private-io-diagnostics' : job;
        });
        expect(selected.sort()).toEqual([...expected].sort());
        expect(selected.length).toBeGreaterThan(0);
      }
    }
  });

  it('isolates the three remaining whole-file Windows regressions without changing complete-boundary partitions or deadlines', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['windows-regression-diagnostics'];
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'remaining-regressions'");
    expect(job.name).toContain('not complete-boundary qualification');
    expect(job['runs-on']).toBe('windows-latest');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.strategy).toEqual({
      'fail-fast': false, 'max-parallel': 2,
      matrix: { suite: ['migration-inspection', 'repair-baseline-settings', 'machine-action-continuation-contracts'] }
    });
    expect(job.env).toEqual({
      WINDOWS_REGRESSION_SUITE: '${{ matrix.suite }}', LIFTOFF_WINDOWS_TOOLCHAIN_REPORT: '1'
    });
    const program = job.steps.at(-2).run;
    for (const command of ['npm ci', 'npm run build', 'npm install --global "npm@12.0.2"',
      'python -m pip install uv==0.12.7 checkov==3.2.495']) {
      expect(job.steps.slice(0, -2).some((step: any) => step.run === command)).toBe(true);
    }
    expect(job.steps.find((step: any) => step.uses?.startsWith('opentofu/setup-opentofu@')).with)
      .toEqual({ tofu_version: '1.12.6', tofu_wrapper: false });
    expect(program).toContain("assert.equal(process.platform, 'win32')");
    expect(program).toContain("assert.equal(process.arch, 'x64')");
    expect(program).toContain("maxWorkers: 1, reporters: ['verbose']");
    expect(program).toContain("assert.deepEqual(specs.map((spec) => relative(spec.moduleId)), [file])");
    expect(program).toContain('context.collectTests(specs)');
    expect(program).toContain('context.runTestSpecifications(specs)');
    expect(program).not.toMatch(/testNamePattern|shard:|testTimeout|retry:|failureMessages|stderr|stdout/);
    expect(job.steps.at(-1).with).toEqual({
      name: 'windows-regressions-source-${{ github.sha }}-${{ github.run_attempt }}-${{ matrix.suite }}',
      path: 'diagnostics/windows-regressions-source.json', 'if-no-files-found': 'error', 'retention-days': 7
    });
    expect(job.steps.at(-1).if).toBe('always()');
    const validator = /function validateOutcomes\([\s\S]*?\n\}\n/u.exec(program)?.[0];
    expect(validator).toBeTypeOf('string');
    const assert = await import('node:assert/strict');
    const validate = new Function('assert', `${validator}; return validateOutcomes;`)(assert);
    const inventory = [{ id: 'a', name: 'native check', mode: 'run' }, { id: 'b', name: 'foreign host', mode: 'skip' }];
    const outcomes = [{ id: 'a', name: 'native check', state: 'passed' }, { id: 'b', name: 'foreign host', state: 'skipped' }];
    expect(() => validate(inventory, outcomes, 0)).not.toThrow();
    for (const [cases, results, errors] of [
      [[], [], 0], [inventory, outcomes.slice(1), 0], [inventory, [...outcomes, outcomes[0]], 0],
      [[inventory[0], inventory[0]], outcomes, 0], [inventory, [outcomes[0], outcomes[0]], 0],
      [inventory, [{ ...outcomes[0], state: 'skipped' }, outcomes[1]], 0],
      [inventory, [{ ...outcomes[0], state: 'failed' }, outcomes[1]], 0],
      [inventory, [{ ...outcomes[0], name: 'different case' }, outcomes[1]], 0],
      [[{ ...inventory[0], mode: 'only' }, inventory[1]], outcomes, 0], [inventory, outcomes, 1]
    ]) expect(() => validate(cases, results, errors)).toThrow();
  });

  it('keeps independently pinned Windows private-I/O fixtures in a separate manual-only source lane', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['windows-private-io-diagnostics'];
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'private-io'");
    expect(job.name).toContain('NONSECRET source fixtures');
    expect(job['runs-on']).toBe('windows-latest');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.needs).toBeUndefined();
    expect(job.steps.some((step: any) => step.run === 'npm install --global "npm@12.0.2"')).toBe(true);
    expect(job.steps.some((step: any) => step.run === 'npm ci')).toBe(true);
    const buildIndex = job.steps.findIndex((step: any) => step.run === 'npm run build');
    const hostIndex = job.steps.findIndex((step: any) => step.id === 'host');
    const nativeIndex = job.steps.findIndex((step: any) => step.id === 'native');
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThan(buildIndex);
    expect(nativeIndex).toBeGreaterThan(hostIndex);
    expect(job.steps[nativeIndex].run).toBe(
      'npm test -- tests/state-windows-private-protocol.test.ts tests/state-windows-private-runner.test.ts ' +
      '--maxWorkers=1 --reporter=json --outputFile.json=diagnostics/windows-private-io-tests.json'
    );
    expect(job.steps[nativeIndex].env).toEqual({ LIFTOFF_WINDOWS_PRIVATE_SOURCE_DIAGNOSTICS: '1' });
    const host = job.steps[hostIndex].run;
    expect(host).toContain("assert.equal(process.platform, 'win32')");
    expect(host).toContain("assert.equal(process.arch, 'x64')");
    expect(host).toContain('>= 17763');
    expect(host).toContain('NATIVE_HELPER_INVENTORY');
    expect(host).toContain("['windows-private-process', 'assets/repair/windows-private-process.ps1']");
    expect(host).toContain("['windows-job-controller', 'assets/repair/windows-job-controller.ps1']");
    expect(host).toContain('assert.equal(sha256, declared.expectedDigest)');
    expect(host).toContain("'WindowsPowerShell', 'v1.0', 'powershell.exe'");
    expect(host).toContain('System.Web.Extensions');
    expect(host).toContain("'FullLanguage'");
    expect(job.steps.map((step: any) => step.run ?? '').join('\n'))
      .not.toMatch(/ExecutionPolicy\s+(?:Bypass|Unrestricted)|Set-ExecutionPolicy|\bicacls\b|\bsudo\b|\bwinget\b|--shard|gate:release/);
    const retained = job.steps.at(-1);
    expect(retained.if).toBe('always()');
    expect(retained.with).toEqual({
      name: 'windows-private-io-source-${{ github.sha }}-${{ github.run_attempt }}',
      path: 'diagnostics/windows-private-io-source.json', 'if-no-files-found': 'error', 'retention-days': 7
    });
    expect(workflow.jobs['windows-boundary-diagnostics'].steps.map((step: any) => step.run ?? '').join('\n'))
      .not.toContain('tests/state-windows-private-');
    for (const id of defaultSourceJobs) {
      expect(workflow.jobs[id].steps.some((step: any) => step.run?.includes('tests/state-windows-private-'))).toBe(false);
    }
  });

  it('requires actual private-I/O native cases, allowing only the explicitly inapplicable foreign-host refusal', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const step = workflow.jobs['windows-private-io-diagnostics'].steps.find((entry: any) =>
      entry.name === 'Require native private I/O outcomes and retain only bounded safe metadata');
    expect(step.if).toBe('always()');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await scratchDirectory();
    try {
      await mkdir(path.join(root, 'diagnostics'));
      const marker = 'DO_NOT_UPLOAD_RAW_PRIVATE_FRAMES_OR_STATE';
      const nativeSuite = 'actual Windows private binary pipes and owned jobs (NONSECRET source fixtures, not custody)';
      const host = {
        admitted: true, platform: 'win32', architecture: 'x64', sourceCommit: 'a'.repeat(40), runAttempt: '2',
        windowsRelease: '10.0.26100', nodeVersion: '24.20.0',
        powershell: { version: '5.1.26100.0', languageMode: 'FullLanguage', framework: '4.0.30319', systemWebExtensions: 'loaded', raw: marker },
        helpers: [
          { id: 'windows-private-process', path: 'assets/repair/windows-private-process.ps1', sha256: 'c'.repeat(64), raw: marker },
          { id: 'windows-job-controller', path: 'assets/repair/windows-job-controller.ps1', sha256: 'd'.repeat(64) }
        ],
        raw: marker
      };
      const foreign = {
        fullName: 'Windows private runner source admission, not Windows qualification refuses a foreign host while wiping transferred private input',
        title: 'refuses a foreign host while wiping transferred private input',
        ancestorTitles: ['Windows private runner source admission, not Windows qualification'], status: 'skipped'
      };
      const native = { fullName: `${nativeSuite} binary pipes`, title: 'binary pipes', ancestorTitles: [nativeSuite], status: 'passed', failureMessages: [marker], stdout: marker };
      const result = {
        success: true, numPassedTests: 2, numFailedTests: 0, numPendingTests: 1,
        testResults: [
          { name: path.resolve(root, 'tests/state-windows-private-protocol.test.ts'), assertionResults: [{ fullName: 'protocol', title: 'protocol', ancestorTitles: ['protocol'], status: 'passed' }] },
          { name: path.resolve(root, 'tests/state-windows-private-runner.test.ts'), assertionResults: [native, foreign] }
        ]
      };
      const hostFile = path.join(root, 'diagnostics/windows-private-io-host.json');
      const resultFile = path.join(root, 'diagnostics/windows-private-io-tests.json');
      const output = path.join(root, 'diagnostics/windows-private-io-source.json');
      const rootExitFile = path.join(root, 'diagnostics/windows-private-root-exit.json');
      const rootExit = {
        schemaVersion: 1, classification: 'windows-private-root-exit-nonsecret-source-only',
        fixture: 'detached-child-ipc-ready-before-root-exit', rootPid: 123,
        result: 'rejected', code: 'native-command-failed', exitCode: 0, reason: 6,
        settled: true, processSpawned: true, quiesced: true
      };
      const save = (value: object) => writeFile(resultFile, JSON.stringify(value));
      const run = (overrides: Record<string, string> = {}) => execFileAsync(process.execPath, ['--input-type=module', '-e',
        `Object.defineProperty(process, 'platform', {value:'win32'}); Object.defineProperty(process, 'arch', {value:'x64'});\n${program}`], {
        cwd: root, env: { ...process.env, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ATTEMPT: '2', HOST_OUTCOME: 'success', NATIVE_OUTCOME: 'success', ...overrides }
      });
      await expect(run()).rejects.toThrow();
      await writeFile(hostFile, JSON.stringify(host));
      await expect(run()).rejects.toThrow();
      await save(result);
      await expect(run()).rejects.toThrow();
      expect(JSON.parse(await readFile(output, 'utf8')).rootExitDiagnostic).toEqual({ availability: 'missing' });
      expect(JSON.parse(await readFile(output, 'utf8')).blockerCode).toBe('root-exit-diagnostic-gap');
      await writeFile(rootExitFile, JSON.stringify(rootExit));
      await run();
      const summary = await readFile(output, 'utf8');
      expect(summary).not.toContain(marker);
      expect(JSON.parse(summary)).toMatchObject({
        accepted: true, nativeCases: 1, inapplicable: 1, platform: 'win32', architecture: 'x64',
        custodyQualification: 'not-performed', minimumHostQualification: 'not-performed', installedArtifactQualification: 'not-performed'
      });
      expect(JSON.parse(summary).rootExitDiagnostic).toEqual({ availability: 'present', ...rootExit });
      await expect(run({ NATIVE_OUTCOME: 'failure' })).rejects.toThrow();
      expect(JSON.parse(await readFile(output, 'utf8')).rootExitDiagnostic).toMatchObject({
        availability: 'present', result: 'rejected', reason: 6, exitCode: 0
      });
      for (const invalid of [
        { ...rootExit, payload: marker }, { ...rootExit, processRef: marker },
        { ...rootExit, rootPid: 0 }, { ...rootExit, rootPid: 0x1_0000_0000 },
        { ...rootExit, exitCode: -1 }, { ...rootExit, reason: 8 },
        { ...rootExit, settled: 'false' }, { ...rootExit, code: marker },
        { ...rootExit, result: 'manufactured-success' }
      ]) {
        await writeFile(rootExitFile, JSON.stringify(invalid));
        await expect(run()).rejects.toThrow();
        const blocked = await readFile(output, 'utf8');
        expect(blocked).not.toContain(marker);
        expect(JSON.parse(blocked).rootExitDiagnostic).toEqual({ availability: 'invalid' });
      }
      await writeFile(rootExitFile, ' '.repeat(1025));
      await expect(run()).rejects.toThrow();
      expect(JSON.parse(await readFile(output, 'utf8')).rootExitDiagnostic).toEqual({ availability: 'invalid' });
      await writeFile(rootExitFile, JSON.stringify({ ...rootExit, result: 'not-observed' }));
      await expect(run()).rejects.toThrow();
      await rm(rootExitFile);
      await expect(run({ HOST_OUTCOME: 'failure', NATIVE_OUTCOME: 'skipped' })).rejects.toThrow();
      expect(JSON.parse(await readFile(output, 'utf8')).rootExitDiagnostic).toEqual({ availability: 'missing' });
      await writeFile(rootExitFile, JSON.stringify(rootExit));
      for (const invalid of [
        { ...result, success: false },
        { ...result, numFailedTests: 1 },
        { ...result, numPendingTests: 2 },
        { ...result, testResults: result.testResults.slice(0, 1) },
        { ...result, testResults: [
          result.testResults[0], { ...result.testResults[1], assertionResults: [foreign] }
        ] },
        { ...result, testResults: [
          result.testResults[0], { ...result.testResults[1], assertionResults: [{ ...native, status: 'pending' }, foreign] }
        ] },
        { ...result, testResults: [
          result.testResults[0], { ...result.testResults[1], assertionResults: [{ ...native, status: 'skipped' }, foreign] }
        ] },
        { ...result, testResults: [
          result.testResults[0], { ...result.testResults[1], assertionResults: [native, { ...foreign, status: 'pending' }] }
        ] },
        { ...result, testResults: [
          result.testResults[0], { ...result.testResults[1], assertionResults: [native, { ...foreign, title: 'unexpected skipped case' }] }
        ] }
      ]) {
        await save(invalid);
        await expect(run()).rejects.toThrow();
        expect(JSON.parse(await readFile(output, 'utf8')).accepted).toBe(false);
      }
      await save(result);
      await save({ ...result, testResults: [
        result.testResults[0], { ...result.testResults[1], assertionResults: [native, { ...foreign, status: 'pending' }] }
      ] });
      await expect(run()).rejects.toThrow();
      expect(JSON.parse(await readFile(output, 'utf8')).blockerCode).toBe('unexpected-skipped-or-pending-case');
      await save(result);
      await expect(run({ NATIVE_OUTCOME: 'skipped' })).rejects.toThrow();
      await writeFile(hostFile, JSON.stringify({ ...host, admitted: false }));
      await expect(run()).rejects.toThrow();
      await writeFile(hostFile, JSON.stringify({ ...host, helpers: host.helpers.slice(0, 1) }));
      await expect(run()).rejects.toThrow();
      await writeFile(hostFile, JSON.stringify({ ...host, powershell: { ...host.powershell, languageMode: 'ConstrainedLanguage' } }));
      await expect(run()).rejects.toThrow();
      await writeFile(hostFile, JSON.stringify({ ...host, sourceCommit: 'b'.repeat(40) }));
      await expect(run()).rejects.toThrow();
      await writeFile(hostFile, JSON.stringify(host));
      await writeFile(resultFile, marker.repeat(30000));
      await expect(run()).rejects.toThrow();
      expect(await readFile(output, 'utf8')).not.toContain(marker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches the pinned JSON skip shape observed in private-I/O run 35435527409', async () => {
    const root = await scratchDirectory();
    try {
      const suite = 'Windows private runner source admission, not Windows qualification';
      const title = 'refuses a foreign host while wiping transferred private input';
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
      await writeFile(path.join(root, 'report-shape.test.ts'), `
import { describe, it } from 'vitest';
describe(${JSON.stringify(suite)}, () => {
  it.skip(${JSON.stringify(title)}, () => {});
  it('applicable source case', () => {});
});
`);
      const { createVitest } = await import('vitest/node');
      const context = await createVitest({
        root, config: false, watch: false, cache: false, maxWorkers: 1,
        include: ['report-shape.test.ts'], reporters: ['json'], outputFile: { json: path.join(root, 'report.json') }
      });
      try { await context.start(); } finally { await context.close(); }
      const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
      expect(report).toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1 });
      expect(report.testResults[0].assertionResults.find((test: any) => test.title === title)).toMatchObject({
        title, ancestorTitles: [suite], fullName: `${suite} ${title}`, status: 'skipped'
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves every complete Windows boundary selector across bounded one-worker shards', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['windows-boundary-diagnostics'];
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only && inputs.windows_diagnostic_scope == 'complete-boundary'");
    expect(job['runs-on']).toBe('windows-latest');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.strategy).toEqual({
      'fail-fast': false, 'max-parallel': 3, matrix: { include: [
        { group: 'regular', shard: 1, count: 2 }, { group: 'regular', shard: 2, count: 2 },
        { group: 'migration-inspection', shard: 1, count: 1 },
        ...[1, 2, 3].map((shard) => ({ group: 'reviewed-update', shard, count: 3 })),
        ...[1, 2, 3, 4].map((shard) => ({ group: 'migration-revalidation', shard, count: 4 }))
      ] }
    });
    expect(job.env).toEqual({
      WINDOWS_BOUNDARY_GROUP: '${{ matrix.group }}', WINDOWS_BOUNDARY_SHARD: '${{ matrix.shard }}',
      WINDOWS_BOUNDARY_COUNT: '${{ matrix.count }}', LIFTOFF_WINDOWS_TOOLCHAIN_REPORT: '1'
    });
    const runIndex = job.steps.findIndex((step: any) => step.name === 'Run conserved Windows source specs and evaluated heavy-case partitions');
    for (const action of ['actions/setup-python@', 'actions/setup-go@', 'opentofu/setup-opentofu@']) {
      expect(job.steps.slice(0, runIndex).some((step: any) => step.uses?.startsWith(action))).toBe(true);
    }
    for (const command of [
      'python -m pip install uv==0.12.7 checkov==3.2.495', 'npm install --global "npm@12.0.2"',
      'npm ci', 'npm ci --prefix services/telemetry-ingest', 'npm run build'
    ]) expect(job.steps.slice(0, runIndex).some((step: any) => step.run === command)).toBe(true);
    const program = job.steps[runIndex].run;
    expect(program).toContain("assert.equal(process.platform, 'win32'");
    expect(program).toContain("maxWorkers: 1, reporters: ['verbose', 'json']");
    expect(program).toContain('context.collectTests(selectedSpecs)');
    expect(program).toContain('await context.standalone()');
    expect(program).toContain("group === 'regular' || ordinal % count === index - 1");
    expect(program).toContain('module.toTestSpecification(selectedCases)');
    expect(program).toContain('context.runTestSpecifications(runSpecs)');
    expect(program).toContain('context.config.shard = undefined');
    expect(program).toContain("outcomes.some((test) => test.state === 'failed')) process.exitCode = 1");
    expect(program).not.toMatch(/testNamePattern|staticParse|testTimeout|retry:/);
    const original = workflow.jobs.test.steps.find((step: any) => step.name === 'Run Windows project and packaging boundary coverage').run.trim().split(/\s+/).slice(3);
    const declaredAdditional = /const additional = \[([\s\S]*?)\];/u.exec(program)?.[1] ?? '';
    const additional = [...declaredAdditional.matchAll(/'(tests\/[\w/-]+\.test\.ts)'/gu)].map((match: RegExpMatchArray) => match[1]);
    expect(additional).toEqual([
      'tests/repair-baseline-settings.test.ts', 'tests/repair-manifest-v8.test.ts',
      'tests/repair-preparation.test.ts', 'tests/repair-validation.test.ts',
      'tests/application-preparation-input-boundaries.test.ts',
      'tests/workstation-executables.test.ts', 'tests/workstation-compatibility.test.ts',
      'tests/windows-native-toolchain.test.ts', 'tests/distribution/windows-invocation.test.ts',
      'tests/input-consistency.test.ts', 'tests/machine-action-continuation-contracts.test.ts',
      'tests/continuation-admission.test.ts'
    ]);
    const expected = [...new Set([...original, ...additional])].sort();
    expect(expected).toContain('tests/migration-revalidation.test.ts');
    expect(expected).toContain('tests/migration-inspection.test.ts');
    const { BaseSequencer, createVitest } = await import('vitest/node');
    const context = await createVitest({ ...createRootTestConfig('win32').test, config: false, watch: false, cache: false });
    try {
      const specifications = await context.globTestSpecifications(expected);
      const relative = (spec: { moduleId: string }) => path.relative(process.cwd(), spec.moduleId).split(path.sep).join('/');
      expect(specifications.map(relative).sort()).toEqual(expected);
      const heavy = ['migration-inspection', 'reviewed-update', 'migration-revalidation'].map((name) => `tests/${name}.test.ts`);
      const selected: string[] = [...heavy];
      const regular = specifications.filter((spec) => !heavy.includes(relative(spec)));
      for (const index of [1, 2]) {
        context.config.shard = { index, count: 2 };
        selected.push(...(await new BaseSequencer(context).shard(regular)).map(relative));
      }
      expect(selected.sort()).toEqual(expected);
      expect(new Set(selected).size).toBe(expected.length);
    } finally {
      await context.close();
    }
    expect(job.steps[runIndex + 1].name).toBe('Require complete same-source shard results and actual tool observations');
    expect(job.steps[runIndex + 1].if).toBeUndefined();
    expect(job.steps.at(-1).if).toBe('always()');
    expect(job.steps.at(-1).with).toEqual({
      name: 'windows-boundary-source-${{ github.sha }}-${{ github.run_attempt }}-${{ matrix.group }}-${{ matrix.shard }}',
      path: 'diagnostics/windows-boundary-inventory.json\ndiagnostics/windows-boundary-tests.json\ndiagnostics/windows-boundary-outcomes.json\n' +
        'diagnostics/windows-native-toolchain.json\ndiagnostics/windows-directory-admission.json\n',
      'if-no-files-found': 'error', 'retention-days': 7
    });
  });

  it('rejects missing boundary specs or skipped native tool observations without rejecting existing platform-gated cases elsewhere', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const step = workflow.jobs['windows-boundary-diagnostics'].steps.find((entry: any) =>
      entry.name === 'Require complete same-source shard results and actual tool observations');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await scratchDirectory();
    try {
      await mkdir(path.join(root, 'diagnostics'));
      const selected = ['tests/migration-revalidation.test.ts', 'tests/windows-native-toolchain.test.ts'];
      const inventory = {
        platform: 'win32', architecture: 'x64', sourceCommit: 'a'.repeat(40), runAttempt: '2',
        group: 'regular', shard: 1, shards: 2, selected, caseInventoryDigest: 'c'.repeat(64),
        cases: [
          { file: selected[0], id: 'migration-1', name: 'existing platform contract', mode: 'skip', selected: true },
          { file: selected[1], id: 'native-1', name: 'actual tools', mode: 'run', selected: true }
        ]
      };
      inventory.caseInventoryDigest = createHash('sha256').update(JSON.stringify(
        inventory.cases.map(({ selected: _selected, ...test }) => test))).digest('hex');
      const report = {
        success: true, numFailedTests: 0, numPendingTests: 1,
        testResults: selected.map((file) => ({
          name: path.resolve(root, file),
          assertionResults: file.endsWith('windows-native-toolchain.test.ts')
            ? [{ ancestorTitles: ['native supported Windows toolchain source acceptance'], status: 'passed' }]
            : [{ ancestorTitles: ['existing platform contract'], status: 'pending' }]
        }))
      };
      const observation = {
        platform: 'win32', architecture: 'x64', sourceCommit: 'a'.repeat(40), runAttempt: '2',
        tools: [{ id: 'node' }, { id: 'npm' }], git: { file: { digest: 'b'.repeat(64) } }
      };
      const save = (file: string, value: unknown) => writeFile(path.join(root, 'diagnostics', file), JSON.stringify(value));
      const run = () => execFileAsync(process.execPath, ['--input-type=module', '-e', program!], {
        cwd: root, env: {
          ...process.env, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ATTEMPT: '2',
          WINDOWS_BOUNDARY_GROUP: 'regular', WINDOWS_BOUNDARY_SHARD: '1', WINDOWS_BOUNDARY_COUNT: '2'
        }
      });
      await expect(run()).rejects.toThrow();
      await save('windows-boundary-inventory.json', inventory);
      await save('windows-boundary-tests.json', report);
      await expect(run()).rejects.toThrow();
      const outcomes = {
        caseInventoryDigest: inventory.caseInventoryDigest, unhandledErrors: 0,
        outcomes: inventory.cases.map((test) => ({ file: test.file, id: test.id, name: test.name, state: test.mode === 'run' ? 'passed' : 'skipped' }))
      };
      await save('windows-boundary-outcomes.json', outcomes);
      await save('windows-native-toolchain.json', observation);
      await run();
      await save('windows-boundary-tests.json', { ...report, testResults: report.testResults.slice(1) });
      await expect(run()).rejects.toThrow();
      const skipped = structuredClone(report);
      skipped.testResults[1].assertionResults[0].status = 'pending';
      await save('windows-boundary-tests.json', skipped);
      await expect(run()).rejects.toThrow();
      await save('windows-boundary-tests.json', report);
      await save('windows-boundary-outcomes.json', { ...outcomes, outcomes: outcomes.outcomes.slice(0, 1) });
      await expect(run()).rejects.toThrow();
      await save('windows-boundary-outcomes.json', outcomes);
      await save('windows-native-toolchain.json', { ...observation, sourceCommit: 'c'.repeat(40) });
      await expect(run()).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses evaluated runner IDs to conserve parameterized and duplicate-name cases across partitions', async () => {
    const root = await scratchDirectory();
    try {
      await mkdir(path.join(root, 'tests'));
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
      await writeFile(path.join(root, 'tests/heavy.test.ts'), `
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
it.each(['a', 'b', 'c', 'd'])('parameter %s', (value) => {
  writeFileSync(new URL('../ran-' + value, import.meta.url), value, { flag: 'wx' });
});
it('duplicate name', () => writeFileSync(new URL('../ran-e', import.meta.url), 'e', { flag: 'wx' }));
it('duplicate name', () => writeFileSync(new URL('../ran-f', import.meta.url), 'f', { flag: 'wx' }));
it.skip('existing inapplicable case', () => { throw new Error('Not applicable'); });
`);
      const { createVitest } = await import('vitest/node');
      const selectedIds: string[] = [];
      let inventoryIds: string[] = [];
      for (const index of [1, 2, 3]) {
        const context = await createVitest({
          root, config: false, watch: false, cache: false, maxWorkers: 1, reporters: ['json'],
          outputFile: { json: path.join(root, 'result.json') }, include: ['tests/*.test.ts']
        });
        try {
          await context.standalone();
          const collected = await context.collectTests(await context.globTestSpecifications());
          expect(collected.unhandledErrors).toEqual([]);
          const module = collected.testModules[0];
          const cases = [...module.children.allTests()];
          const definitions = cases.map((test) => ({ id: test.id, mode: test.options.mode }));
          if (index === 1) inventoryIds = definitions.map((test) => test.id);
          else expect(definitions.map((test) => test.id)).toEqual(inventoryIds);
          const selected = cases.filter((_, ordinal) => ordinal % 3 === index - 1);
          selectedIds.push(...selected.map((test) => test.id));
          const result = await context.runTestSpecifications([module.toTestSpecification(selected)]);
          expect(result.unhandledErrors).toEqual([]);
          for (const test of result.testModules[0].children.allTests()) {
            const expected = definitions.find((entry) => entry.id === test.id)!;
            const applies = selected.some((entry) => entry.id === test.id) && expected.mode === 'run';
            expect(test.result().state).toBe(applies ? 'passed' : 'skipped');
          }
          const json = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
          const applicable = selected.filter((test) => definitions.find((entry) => entry.id === test.id)?.mode === 'run');
          expect(json).toMatchObject({ success: true, numPassedTests: applicable.length, numFailedTests: 0 });
        } finally { await context.close(); }
      }
      expect(selectedIds.sort()).toEqual(inventoryIds.sort());
      expect(new Set(selectedIds).size).toBe(inventoryIds.length);
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) expect(await readFile(path.join(root, `ran-${name}`), 'utf8')).toBe(name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('isolates actual GNOME persistence behind its explicit manual flag and exact private source builds', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['linux-gnome-persistence'];
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_linux_gnome_persistence_only");
    expect(job.name).toContain('not encrypted-host custody');
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.needs).toBeUndefined();
    expect(job.strategy).toEqual({
      'fail-fast': false, 'max-parallel': 2,
      matrix: { include: [{ os: 'ubuntu-24.04', arch: 'x64' }, { os: 'ubuntu-24.04-arm', arch: 'arm64' }] }
    });
    expect(job.env).toEqual({
      LIBSECRET_COMMIT: 'a5cd57f103038c06b64d5f6ebfd0e627bb40af4e',
      GNOME_COMMIT: 'da00f9621eaf263d5ed4236df9c22798ea8021d2',
      EXPECTED_ARCH: '${{ matrix.arch }}'
    });
    const normalBuild = workflow.jobs['linux-keystore-build'];
    for (const id of ['source', 'libsecret', 'helper']) {
      expect(job.steps.find((step: any) => step.id === id)).toEqual(normalBuild.steps.find((step: any) => step.id === id));
    }
    expect(job.steps.find((step: any) => step.id === 'python')).toMatchObject({ with: { 'python-version': '3.14.7' } });
    const preparation = job.steps.find((step: any) => step.id === 'python_preparation');
    expect(preparation.env).toEqual({ LIFTOFF_CI_PYTHON_ONLY: '1', LIFTOFF_CI_NODE_COORDINATOR: '1' });
    expect(preparation.run).toBe(workflow.jobs['native-posix-lock-diagnostics'].steps.find((step: any) =>
      step.name === 'Prepare only selected native executable permissions').run);
    const prerequisites = job.steps.find((step: any) => step.id === 'prerequisites').run;
    expect(prerequisites).toContain('libglib2.0-bin');
    expect(prerequisites).toContain('libgcr-3-dev libp11-kit-dev');
    expect(prerequisites).toContain('pkg-config --atleast-version=2.80 glib-2.0 gio-2.0 gobject-2.0');
    expect(prerequisites).toContain('pkg-config --atleast-version=3.3.4 gck-1');
    expect(prerequisites).toContain('pkg-config --atleast-version=3.27.90 gcr-base-3');
    expect(prerequisites).not.toContain('gnome-keyring');
    const source = job.steps.find((step: any) => step.id === 'gnome_source').run;
    expect(source).toContain('mkdir -m 700 "$root"');
    expect(source).toContain('fetch --quiet --no-tags --depth=1 https://gitlab.gnome.org/GNOME/gnome-keyring.git "$GNOME_COMMIT"');
    expect(source).toContain('test "$(git -C "$root/source" rev-parse HEAD)" = "$GNOME_COMMIT"');
    expect(source).toContain('status --porcelain=v1 --untracked-files=all');
    expect(source).toContain('GNOME_SOURCE_DIR=%s\\nGNOME_PREFIX=%s\\nGNOME_BUILD_DIR=%s\\n');
    const build = job.steps.find((step: any) => step.id === 'gnome_build').run;
    for (const option of [
      '--prefix="$GNOME_PREFIX"', '--libdir=lib', '--sysconfdir=etc', '--localstatedir=var', '--wrap-mode=nodownload',
      '-Dssh-agent=false', '-Dpam=false', '-Dsystemd=disabled', '-Dlibcap-ng=disabled', '-Dselinux=disabled',
      '-Ddebug-mode=false', '-Dmanpage=false', '-Dpkcs11-config="$GNOME_PREFIX/etc/pkcs11"',
      '-Dpkcs11-modules="$GNOME_PREFIX/lib/pkcs11"'
    ]) expect(build).toContain(option);
    expect(build).toContain('meson compile -C "$GNOME_BUILD_DIR" --jobs=2 gnome-keyring-daemon');
    expect(build).toContain('install -D -m0755 "$GNOME_BUILD_DIR/daemon/gnome-keyring-daemon" "$GNOME_PREFIX/bin/gnome-keyring-daemon"');
    expect(build).not.toMatch(/meson install|sudo|setcap|systemctl|meson test/);
    expect(job.steps.find((step: any) => step.id === 'gnome_identity').run)
      .toBe('node native/linux-keystore-client/gnome-build-identity.mjs');
    const contractsIndex = job.steps.findIndex((step: any) => step.id === 'contracts');
    expect(job.steps[contractsIndex]).toMatchObject({
      if: "success() && steps.helper.outcome == 'success'",
      env: { LIFTOFF_LINUX_KEYSTORE_SYNTHETIC: '1' },
      run: 'npx vitest run tests/linux-keystore-client-contract.test.ts tests/managed-keystore-key-binding.test.ts tests/state-linux-null-process.test.ts ' +
        '--maxWorkers=1 --reporter=verbose --reporter=json --outputFile.json=diagnostics/gnome-source-interface-tests.json'
    });
    expect(job.steps[contractsIndex].env.LIFTOFF_GNOME_PERSISTENCE_TEST).toBeUndefined();
    expect(job.steps[contractsIndex].env.LIFTOFF_LINUX_READONLY_NULL_TEST).toBeUndefined();
    const persistenceIndex = job.steps.findIndex((step: any) => step.id === 'persistence');
    const readyIndex = job.steps.findIndex((step: any) => step.id === 'contracts_ready');
    expect(readyIndex).toBeGreaterThan(contractsIndex);
    expect(readyIndex).toBeLessThan(job.steps.findIndex((step: any) => step.id === 'gnome_source'));
    expect(persistenceIndex).toBeGreaterThan(contractsIndex);
    expect(persistenceIndex).toBeGreaterThan(job.steps.findIndex((step: any) => step.id === 'gnome_identity'));
    expect(job.steps[persistenceIndex]).toMatchObject({
      if: "success() && steps.contracts_ready.outcome == 'success' && steps.gnome_identity.outcome == 'success'",
      env: { LIFTOFF_GNOME_PERSISTENCE_TEST: '1', LIFTOFF_LINUX_READONLY_NULL_TEST: '1' },
      run: 'npx vitest run tests/state-gnome-persistence.test.ts tests/state-linux-null-process.test.ts --maxWorkers=1 --reporter=verbose --reporter=json ' +
        '--outputFile.json=diagnostics/gnome-persistence-tests.json'
    });
    for (const [id, entry] of Object.entries(workflow.jobs) as [string, any][]) {
      expect(entry.env?.LIFTOFF_GNOME_PERSISTENCE_TEST).toBeUndefined();
      expect(entry.env?.LIFTOFF_LINUX_READONLY_NULL_TEST).toBeUndefined();
      if (id !== 'linux-gnome-persistence') {
        expect(entry.steps.some((step: any) => step.env?.LIFTOFF_GNOME_PERSISTENCE_TEST)).toBe(false);
        expect(entry.steps.some((step: any) => step.env?.LIFTOFF_LINUX_READONLY_NULL_TEST)).toBe(false);
        expect(entry.steps.some((step: any) => step.env?.LIFTOFF_CI_NODE_COORDINATOR)).toBe(false);
      }
    }
    expect(job.steps.at(-1).if).toBe('always()');
    expect(job.steps.at(-1).with).toEqual({
      name: 'gnome-persistence-source-${{ matrix.os }}-${{ runner.arch }}-${{ github.sha }}-${{ github.run_attempt }}',
      path: 'diagnostics/gnome-source-report.json\ndiagnostics/gnome-contract-summary.json\ndiagnostics/gnome-persistence-summary.json\n' +
        'diagnostics/gnome-python-preparation.json\ndiagnostics/gnome-client-build-identity.json\ndiagnostics/gnome-daemon-build-identity.json\n',
      'if-no-files-found': 'error', 'retention-days': 7
    });
  });

  it.skipIf(process.platform === 'win32')('observes and prepares only selected Python and canonical process.execPath for the GNOME guard', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const step = workflow.jobs['linux-gnome-persistence'].steps.find((entry: any) => entry.id === 'python_preparation');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await realpath(await scratchDirectory());
    try {
      const python = path.join(root, 'python');
      const node = path.join(root, 'node');
      const invokedNode = path.join(root, 'node-link');
      const other = path.join(root, 'unrelated-tofu');
      for (const file of [python, node, other]) {
        await writeFile(file, '#!/bin/sh\nexit 0\n');
        await chmod(file, 0o777);
      }
      await symlink(node, invokedNode);
      const originalNode = await lstat(node, { bigint: true });
      const fixtureProgram = `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(invokedNode)} });\n${program}`;
      await execFileAsync(process.execPath, ['--input-type=module', '-e', fixtureProgram], {
        cwd: root, env: {
          ...process.env, ...step.env, LIFTOFF_STATE_PYTHON: python, LIFTOFF_TOFU_EXECUTABLE: other
        }
      });
      const report = JSON.parse(await readFile(path.join(root, 'diagnostics/gnome-python-preparation.json'), 'utf8'));
      expect(report.status).toBe('prepared');
      expect(report.tools).toHaveLength(2);
      expect(report.tools[0]).toMatchObject({ id: 'python', permissionsChanged: true, before: { mode: '0777' }, after: { mode: '0755' } });
      expect(report.tools[0].before.ino).toBe(report.tools[0].after.ino);
      expect(report.tools[0].before.sha256).toBe(report.tools[0].after.sha256);
      expect(report.tools[1]).toMatchObject({
        id: 'node-coordinator', requestedPath: invokedNode, path: node, status: 'prepared', permissionsChanged: true,
        before: { regular: true, uid: String(originalNode.uid), gid: String(originalNode.gid), mode: '0777' },
        after: { regular: true, uid: String(originalNode.uid), gid: String(originalNode.gid), mode: '0755' }
      });
      for (const key of ['dev', 'ino', 'uid', 'gid', 'size', 'mtimeNs', 'sha256']) {
        expect(report.tools[1].after[key]).toBe(report.tools[1].before[key]);
      }
      expect(report.tools[1].before.sha256).toBe(createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex'));
      expect((await lstat(node, { bigint: true })).ino).toBe(originalNode.ino);
      expect((await lstat(other)).mode & 0o777).toBe(0o777);
      await execFileAsync(process.execPath, ['--input-type=module', '-e', fixtureProgram], {
        cwd: root, env: { ...process.env, ...step.env, LIFTOFF_STATE_PYTHON: python }
      });
      const repeated = JSON.parse(await readFile(path.join(root, 'diagnostics/gnome-python-preparation.json'), 'utf8'));
      expect(repeated.tools.every((tool: any) => tool.status === 'prepared' && tool.permissionsChanged === false)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32').each(['non-owner', 'chmod-denied'])('retains observed Node metadata and blocks %s without a fallback', async (scenario) => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const step = workflow.jobs['linux-gnome-persistence'].steps.find((entry: any) => entry.id === 'python_preparation');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await realpath(await scratchDirectory());
    try {
      const python = path.join(root, 'python');
      const node = path.join(root, 'node');
      const bytes = '#!/bin/sh\nexit 0\n';
      await writeFile(python, bytes);
      await writeFile(node, bytes);
      await chmod(python, 0o755);
      await chmod(node, 0o777);
      const original = await lstat(node, { bigint: true });
      const failure = scenario === 'non-owner'
        ? `process.getuid = () => ${process.getuid!() + 1};`
        : `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
           fs.fchmodSync = () => { throw Object.assign(new Error('fixture chmod denied'), { code: 'EPERM' }); };
           syncBuiltinESMExports();`;
      const prefix = `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(node)} });\n${failure}\n`;
      await expect(execFileAsync(process.execPath, ['--input-type=module', '-e', prefix + program], {
        cwd: root, env: { ...process.env, ...step.env, LIFTOFF_STATE_PYTHON: python }
      })).rejects.toThrow('Fixture-preparation blocker (node-coordinator)');
      const report = JSON.parse(await readFile(path.join(root, 'diagnostics/gnome-python-preparation.json'), 'utf8'));
      expect(report.status).toBe('blocked');
      expect(report.tools[0]).toMatchObject({ id: 'python', status: 'prepared', permissionsChanged: false });
      expect(report.tools[1]).toMatchObject({
        id: 'node-coordinator', status: 'blocked', permissionsChanged: false,
        before: {
          uid: String(original.uid), gid: String(original.gid), dev: String(original.dev), ino: String(original.ino),
          mode: '0777', sha256: createHash('sha256').update(bytes).digest('hex')
        }
      });
      expect((await lstat(node)).mode & 0o777).toBe(0o777);
      expect(await readFile(node, 'utf8')).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gates actual GNOME execution on complete preflight reports and retains sanitized bounded persistence evidence', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['linux-gnome-persistence'];
    const script = (name: string) => {
      const step = job.steps.find((entry: any) => entry.id === name || entry.name === name);
      const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
      expect(program).toBeTypeOf('string');
      return program!;
    };
    const preflight = script('contracts_ready');
    const capture = script('Capture bounded generated-data identity and persistence outcomes only');
    const root = await scratchDirectory();
    try {
      await mkdir(path.join(root, 'diagnostics'));
      await mkdir(path.join(root, 'native/linux-keystore-client/build'), { recursive: true });
      const marker = 'DO_NOT_UPLOAD_GENERATED_PASSWORD_KEY_OR_RAW_OUTPUT';
      const contractSuites = [
        'opt-in compiled client against private synthetic Secret Service, not native custody',
        'managed Linux key binding, not native custody or readiness'
      ];
      const nativeSuite = 'opt-in actual pinned GNOME persistence with generated test data, not encrypted host custody';
      const nullSuite = 'opt-in Linux null-sink profile nonsecret fixtures';
      const nativeSuites = [nativeSuite, nullSuite];
      const result = (suites: string[]) => ({
        success: true, numFailedTests: 0, numPendingTests: 0, numPassedTests: suites.length,
        testResults: [{ assertionResults: suites.map((suite) => ({
          fullName: `${suite} fixed public case`, ancestorTitles: [suite], status: 'passed',
          failureMessages: [marker], stdout: marker, privateFixture: marker
        })) }]
      });
      const contractsFile = path.join(root, 'diagnostics/gnome-source-interface-tests.json');
      const persistenceFile = path.join(root, 'diagnostics/gnome-persistence-tests.json');
      const writeContracts = (value: object) => writeFile(contractsFile, JSON.stringify(value));
      const writePersistence = (value: object) => writeFile(persistenceFile, JSON.stringify(value));
      const sha = 'c'.repeat(64);
      const dependency = { library: '/fixture/lib/example.so', sha256: sha, version: '1.0', privateOutput: marker };
      const client = {
        schemaVersion: 1, platform: 'linux', architecture: process.arch,
        libsecretCommit: job.env.LIBSECRET_COMMIT, compiler: 'fixture C11', binarySha256: sha,
        contractProbeLibraryPath: '/fixture/lib', sources: { 'client.c': sha },
        dependencies: { 'libsecret-1': dependency }, qualification: 'compile-only-not-provider-or-runtime-admission',
        password: marker
      };
      const daemon = {
        schemaVersion: 1, kind: 'actual-gnome-persistence-with-generated-test-data-only',
        platform: 'linux', architecture: process.arch, sourceCommit: job.env.GNOME_COMMIT,
        executable: { path: '/fixture/prefix/bin/gnome-keyring-daemon', sha256: sha, key: marker },
        dependencies: { 'glib-2.0': dependency },
        tools: {
          bus: { path: '/usr/bin/dbus-daemon', sha256: sha },
          observer: { path: '/usr/bin/gdbus', sha256: sha }
        },
        libraryPath: '/fixture/lib', fixtureManifestSha256: sha,
        privatePrefixOptions: { 'pkcs11-config': '/fixture/prefix/etc/pkcs11', 'pkcs11-modules': '/fixture/prefix/lib/pkcs11' },
        mesonOptions: { 'ssh-agent': false, pam: false, systemd: 'disabled', 'libcap-ng': 'disabled', selinux: 'disabled', 'debug-mode': false, manpage: false },
        qualification: 'gnome-persistence-source-test-not-encrypted-host-custody-or-release-readiness',
        privateKeyring: marker
      };
      const daemonFile = path.join(root, 'native/linux-keystore-client/build/gnome-build-identity.json');
      await writeFile(path.join(root, 'native/linux-keystore-client/build/build-identity.json'), JSON.stringify(client));
      await writeFile(daemonFile, JSON.stringify(daemon));
      const run = (program: string, outcomes: Record<string, string> = {}, nativePlatform = 'linux') =>
        execFileAsync(process.execPath, ['--input-type=module', '-e',
          `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(nativePlatform)} });\n${program}`], {
          cwd: root,
          env: {
            ...process.env, ...job.env, EXPECTED_ARCH: process.arch, GNOME_PREFIX: '/fixture/prefix',
            GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ATTEMPT: '2',
            PYTHON_PREPARATION_OUTCOME: 'success', PREREQUISITES_OUTCOME: 'success', LIBSECRET_OUTCOME: 'success',
            HELPER_OUTCOME: 'success', CONTRACTS_OUTCOME: 'success', CONTRACTS_READY_OUTCOME: 'success',
            GNOME_BUILD_OUTCOME: 'success', GNOME_IDENTITY_OUTCOME: 'success', PERSISTENCE_OUTCOME: 'success',
            ...outcomes
          }
        });
      await expect(run(preflight)).rejects.toThrow();
      await writeContracts(result(contractSuites));
      await run(preflight);
      for (const invalid of [
        result(contractSuites.slice(0, 1)),
        { ...result(contractSuites), success: false },
        { ...result(contractSuites), numFailedTests: 1 },
        { ...result(contractSuites), numPendingTests: 1 }
      ]) {
        await writeContracts(invalid);
        await expect(run(preflight)).rejects.toThrow();
      }
      await writeContracts(result(contractSuites));
      await expect(run(capture)).rejects.toThrow();
      await writePersistence(result(nativeSuites));
      await run(capture);
      for (const file of [
        'gnome-source-report.json', 'gnome-contract-summary.json', 'gnome-persistence-summary.json',
        'gnome-client-build-identity.json', 'gnome-daemon-build-identity.json'
      ]) expect(await readFile(path.join(root, 'diagnostics', file), 'utf8')).not.toContain(marker);
      expect(JSON.parse(await readFile(path.join(root, 'diagnostics/gnome-persistence-summary.json'), 'utf8'))).toMatchObject({
        accepted: true, requiredSuiteCases: 2, sourceCommit: 'a'.repeat(40), runAttempt: '2',
        platform: 'linux', architecture: process.arch,
        hostEncryptionQualification: 'not-performed', providerQualification: 'not-performed',
        cloudQualification: 'not-performed', releaseQualification: 'not-performed',
        minimumHostQualification: 'not-performed', installedArtifactQualification: 'not-performed'
      });
      for (const invalid of [
        result(['ordinary source suite']),
        result([nativeSuite]),
        result([nullSuite]),
        { ...result(nativeSuites), success: false },
        { ...result(nativeSuites), numFailedTests: 1 },
        { ...result(nativeSuites), numPendingTests: 1 },
        { ...result(nativeSuites), testResults: [{
          assertionResults: nativeSuites.map((suite) => ({
            fullName: 'case', ancestorTitles: [suite], status: suite === nullSuite ? 'pending' : 'passed'
          }))
        }] }
      ]) {
        await writePersistence(invalid);
        await expect(run(capture)).rejects.toThrow();
        expect(JSON.parse(await readFile(path.join(root, 'diagnostics/gnome-persistence-summary.json'), 'utf8')).accepted).toBe(false);
      }
      await writePersistence(result(nativeSuites));
      await expect(run(capture, { CONTRACTS_READY_OUTCOME: 'failure' })).rejects.toThrow();
      await expect(run(capture, {}, 'darwin')).rejects.toThrow();
      await expect(run(capture, { EXPECTED_ARCH: 'wrong-architecture' })).rejects.toThrow();
      await writeFile(daemonFile, JSON.stringify({ ...daemon, sourceCommit: 'b'.repeat(40) }));
      await expect(run(capture)).rejects.toThrow();
      await expect(readFile(path.join(root, 'diagnostics/gnome-daemon-build-identity.json'))).rejects.toThrow();
      await writeFile(daemonFile, JSON.stringify({
        ...daemon, privatePrefixOptions: { ...daemon.privatePrefixOptions, 'pkcs11-config': '/etc/pkcs11' }
      }));
      await expect(run(capture)).rejects.toThrow();
      await writeFile(daemonFile, JSON.stringify(daemon));
      await writeFile(persistenceFile, marker.repeat(30000));
      await expect(run(capture)).rejects.toThrow();
      expect(await readFile(path.join(root, 'diagnostics/gnome-source-report.json'), 'utf8')).not.toContain(marker);
      await writePersistence({ ...result(nativeSuites), success: false, numFailedTests: 1 });
      await run(capture, { PERSISTENCE_OUTCOME: 'failure' });
      expect(JSON.parse(await readFile(path.join(root, 'diagnostics/gnome-persistence-summary.json'), 'utf8')))
        .toMatchObject({ accepted: false, failed: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds exact private libsecret and runs synthetic behavior only after successful compilation on both source hosts', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['linux-keystore-build'];
    expect(job.if).toBe(keystoreBuildCondition);
    expect(job.name).toContain('compile/synthetic-source');
    expect(job.name).toContain('not provider or custody qualification');
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.needs).toBeUndefined();
    expect(job.strategy).toEqual({
      'fail-fast': false, 'max-parallel': 2,
      matrix: { include: [{ os: 'ubuntu-24.04', arch: 'x64' }, { os: 'ubuntu-24.04-arm', arch: 'arm64' }] }
    });
    expect(job.env).toEqual({
      LIBSECRET_COMMIT: 'a5cd57f103038c06b64d5f6ebfd0e627bb40af4e',
      EXPECTED_ARCH: '${{ matrix.arch }}'
    });
    expect(job.steps.find((step: any) => step.uses?.startsWith('actions/setup-node@')).with['node-version']).toBe('24.20.0');
    expect(job.steps.some((step: any) => step.run === 'npm install --global "npm@12.0.2"')).toBe(true);
    expect(job.steps.some((step: any) => step.run === 'npm ci')).toBe(true);
    const prerequisites = job.steps.find((step: any) => step.id === 'prerequisites').run;
    expect(prerequisites).toContain('sudo apt-get install --yes --no-install-recommends build-essential pkg-config libglib2.0-dev libgcrypt20-dev meson ninja-build gettext');
    expect(prerequisites).toContain('pkg-config --atleast-version=2.74 glib-2.0 gio-2.0 gobject-2.0');
    const source = job.steps.find((step: any) => step.id === 'source').run;
    expect(source).toContain('root="$RUNNER_TEMP/liftoff-libsecret-build"');
    expect(source).toContain('mkdir -m 700 "$root"');
    expect(source).toContain('fetch --quiet --no-tags --depth=1 https://gitlab.gnome.org/GNOME/libsecret.git "$LIBSECRET_COMMIT"');
    expect(source).toContain('checkout --quiet --detach FETCH_HEAD');
    expect(source).toContain('test "$(git -C "$root/source" rev-parse HEAD)" = "$LIBSECRET_COMMIT"');
    expect(source).toContain('status --porcelain=v1 --untracked-files=all');
    expect(source).toContain('LIBSECRET_SOURCE_DIR=%s\\nLIBSECRET_PREFIX=%s\\nLIBSECRET_BUILD_DIR=%s\\n');
    const libsecret = job.steps.find((step: any) => step.id === 'libsecret').run;
    expect(libsecret).toContain('--prefix="$LIBSECRET_PREFIX" --libdir=lib --buildtype=release --wrap-mode=nodownload');
    for (const option of [
      '-Dcrypto=libgcrypt', '-Dmanpage=false', '-Dgtk_doc=false', '-Dintrospection=false', '-Dvapi=false',
      '-Dpam=false', '-Dtpm2=false', '-Dbash_completion=disabled', '-Dtest_setup=disabled'
    ]) expect(libsecret).toContain(option);
    expect(libsecret).toContain('meson install -C "$LIBSECRET_BUILD_DIR" --no-rebuild');
    expect(libsecret).toContain('test "$(git -C "$LIBSECRET_SOURCE_DIR" rev-parse HEAD)" = "$LIBSECRET_COMMIT"');
    expect(libsecret).toContain('status --porcelain=v1 --untracked-files=all');
    expect(libsecret).toContain('PKG_CONFIG_PATH="$LIBSECRET_PREFIX/lib/pkgconfig" pkg-config --variable=prefix libsecret-1');
    expect(job.steps.find((step: any) => step.id === 'protocol').run).toBe(
      'npx vitest run tests/linux-keystore-client-contract.test.ts --maxWorkers=1 --reporter=verbose --reporter=json ' +
      '--outputFile.json=diagnostics/linux-keystore-protocol-tests.json'
    );
    expect(job.steps.find((step: any) => step.id === 'helper').run).toBe('node native/linux-keystore-client/build.mjs');
    const helperIndex = job.steps.findIndex((step: any) => step.id === 'helper');
    const fixturePackagesIndex = job.steps.findIndex((step: any) => step.id === 'synthetic-prerequisites');
    const syntheticIndex = job.steps.findIndex((step: any) => step.id === 'synthetic');
    expect(job.steps.findIndex((step: any) => step.id === 'protocol')).toBeLessThan(helperIndex);
    expect(fixturePackagesIndex).toBeGreaterThan(helperIndex);
    expect(syntheticIndex).toBeGreaterThan(fixturePackagesIndex);
    expect(job.steps[fixturePackagesIndex].if).toBe("success() && steps.helper.outcome == 'success'");
    expect(job.steps[fixturePackagesIndex].run).toBe(
      'sudo apt-get install --yes --no-install-recommends dbus-daemon python3 python3-dbus python3-gi gir1.2-glib-2.0\n' +
      'dpkg-query -W dbus-daemon python3 python3-dbus python3-gi gir1.2-glib-2.0 > diagnostics/linux-keystore-synthetic-prerequisites.txt\n'
    );
    expect(job.steps[syntheticIndex]).toMatchObject({
      if: "success() && steps.helper.outcome == 'success'",
      env: { LIFTOFF_LINUX_KEYSTORE_SYNTHETIC: '1' },
      run: 'npx vitest run tests/linux-keystore-client-contract.test.ts --maxWorkers=1 --reporter=verbose --reporter=json ' +
        '--outputFile.json=diagnostics/linux-keystore-synthetic-tests.json'
    });
    expect(job.steps.find((step: any) => step.id === 'protocol').env?.LIFTOFF_LINUX_KEYSTORE_SYNTHETIC).toBeUndefined();
    const commands = job.steps.map((step: any) => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/gnome-keyring|secret-tool|dbus-run-session|--contract|\bmeson test\b|-Dcrypto=disabled|LD_LIBRARY_PATH|gate:release|npm publish/);
    const retained = job.steps.at(-1);
    expect(retained.if).toBe('always()');
    expect(retained.with).toEqual({
      name: 'linux-keystore-compile-${{ matrix.os }}-${{ runner.arch }}-${{ github.sha }}-${{ github.run_attempt }}',
      path: 'diagnostics/linux-keystore-build-report.json\ndiagnostics/linux-keystore-protocol-summary.json\ndiagnostics/linux-keystore-synthetic-summary.json\ndiagnostics/build-identity.json\n',
      'if-no-files-found': 'error', 'retention-days': 7
    });
  });

  it('retains bounded compile/protocol evidence and rejects missing, oversized or mismatched build identities', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['linux-keystore-build'];
    const step = job.steps.find((entry: any) => entry.name === 'Capture bounded compile and synthetic source evidence (not runtime closure)');
    expect(step.if).toBe('always()');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await scratchDirectory();
    try {
      await mkdir(path.join(root, 'native/linux-keystore-client/build'), { recursive: true });
      await mkdir(path.join(root, 'diagnostics'));
      const identity = {
        platform: 'linux', architecture: process.arch, libsecretCommit: job.env.LIBSECRET_COMMIT,
        qualification: 'compile-only-not-provider-or-runtime-admission'
      };
      const identityFile = path.join(root, 'native/linux-keystore-client/build/build-identity.json');
      const protocolFile = path.join(root, 'diagnostics/linux-keystore-protocol-tests.json');
      const writeIdentity = (value: object) => writeFile(identityFile, JSON.stringify(value));
      await writeIdentity(identity);
      await writeFile(protocolFile, JSON.stringify({
        success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
        testResults: [{ assertionResults: [{ fullName: 'dependency-free framing', status: 'passed' }] }]
      }));
      const run = (outcomes: Record<string, string> = {}) => execFileAsync(process.execPath, ['--input-type=module', '-e', program!], {
        cwd: root, env: {
          ...process.env, EXPECTED_ARCH: process.arch, LIBSECRET_COMMIT: job.env.LIBSECRET_COMMIT,
          GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ATTEMPT: '2',
          PREREQUISITES_OUTCOME: 'success', SOURCE_OUTCOME: 'success', LIBSECRET_OUTCOME: 'success',
          PROTOCOL_OUTCOME: 'success', HELPER_OUTCOME: 'success', ...outcomes
        }
      });
      await run();
      expect(JSON.parse(await readFile(path.join(root, 'diagnostics/build-identity.json'), 'utf8'))).toEqual(identity);
      expect(JSON.parse(await readFile(path.join(root, 'diagnostics/linux-keystore-build-report.json'), 'utf8'))).toMatchObject({
        classification: 'compile-and-native-synthetic-source-interface-only', architecture: process.arch, sourceCommit: 'a'.repeat(40), runAttempt: '2',
        helperExecution: 'not-performed', providerQualification: 'not-performed', custodyQualification: 'not-performed',
        runtimeClosure: 'not-performed', issues: []
      });
      expect(JSON.parse(await readFile(path.join(root, 'diagnostics/linux-keystore-protocol-summary.json'), 'utf8')))
        .toMatchObject({ success: true, passed: 1, failed: 0, pending: 0 });
      await writeIdentity({ ...identity, libsecretCommit: 'b'.repeat(40) });
      await expect(run()).rejects.toThrow();
      await expect(readFile(path.join(root, 'diagnostics/build-identity.json'))).rejects.toThrow();
      await writeIdentity({ ...identity, architecture: 'not-the-current-architecture' });
      await expect(run()).rejects.toThrow();
      await writeFile(identityFile, ' '.repeat(128 * 1024 + 1));
      await expect(run()).rejects.toThrow();
      await rm(identityFile);
      await expect(run()).rejects.toThrow();
      await writeIdentity(identity);
      await writeFile(protocolFile, ' '.repeat(256 * 1024 + 1));
      await expect(run()).rejects.toThrow();
      await rm(protocolFile);
      await expect(run()).rejects.toThrow();
      await run({ PROTOCOL_OUTCOME: 'skipped', HELPER_OUTCOME: 'failure' });
      await expect(readFile(path.join(root, 'diagnostics/build-identity.json'))).rejects.toThrow();
      expect(JSON.parse(await readFile(path.join(root, 'diagnostics/linux-keystore-build-report.json'), 'utf8')).stages)
        .toMatchObject({ protocol: 'skipped', helper: 'failure' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires actual synthetic-suite execution with no failed/skipped cases and retains only bounded allowlisted outcomes', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['linux-keystore-build'];
    const step = job.steps.find((entry: any) => entry.name === 'Capture bounded compile and synthetic source evidence (not runtime closure)');
    expect(step.env.SYNTHETIC_OUTCOME).toBe('${{ steps.synthetic.outcome }}');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await scratchDirectory();
    try {
      await mkdir(path.join(root, 'native/linux-keystore-client/build'), { recursive: true });
      await mkdir(path.join(root, 'diagnostics'));
      await writeFile(path.join(root, 'native/linux-keystore-client/build/build-identity.json'), JSON.stringify({
        platform: 'linux', architecture: process.arch, libsecretCommit: job.env.LIBSECRET_COMMIT,
        qualification: 'compile-only-not-provider-or-runtime-admission'
      }));
      const suite = 'opt-in compiled client against private synthetic Secret Service, not native custody';
      const testCase = {
        fullName: `${suite} verifies fixture behavior`, ancestorTitles: [suite], status: 'passed',
        failureMessages: ['DO_NOT_UPLOAD_RAW_DIAGNOSTIC'], consoleOutput: 'DO_NOT_UPLOAD_RAW_PROTOCOL'
      };
      const reportFile = path.join(root, 'diagnostics/linux-keystore-synthetic-tests.json');
      const validReport = {
        success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
        testResults: [{ assertionResults: [testCase] }]
      };
      const writeReport = (value: object) => writeFile(reportFile, JSON.stringify(value));
      const run = (overrides: Record<string, string> = {}) => execFileAsync(process.execPath, ['--input-type=module', '-e', program!], {
        cwd: root, env: {
          ...process.env, EXPECTED_ARCH: process.arch, LIBSECRET_COMMIT: job.env.LIBSECRET_COMMIT,
          GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ATTEMPT: '2',
          HELPER_OUTCOME: 'success', PROTOCOL_OUTCOME: 'skipped', SYNTHETIC_OUTCOME: 'success',
          SYNTHETIC_PREREQUISITES_OUTCOME: 'success', ...overrides
        }
      });
      await expect(run()).rejects.toThrow();
      await writeReport(validReport);
      await run();
      const summaryFile = path.join(root, 'diagnostics/linux-keystore-synthetic-summary.json');
      const summary = await readFile(summaryFile, 'utf8');
      expect(summary).not.toContain('DO_NOT_UPLOAD_RAW');
      expect(JSON.parse(summary)).toMatchObject({
        classification: 'native-compiled-client-private-synthetic-behavior-only',
        architecture: process.arch, sourceCommit: 'a'.repeat(40), runAttempt: '2',
        success: true, passed: 1, failed: 0, pending: 0, syntheticCases: 1,
        enrollmentQualification: 'not-performed', installedArtifactQualification: 'not-performed',
        cases: [{ name: testCase.fullName, status: 'passed' }]
      });
      for (const invalid of [
        { ...validReport, success: false },
        { ...validReport, numFailedTests: 1 },
        { ...validReport, numPendingTests: 1 },
        { ...validReport, testResults: [{ assertionResults: [{ ...testCase, ancestorTitles: ['ordinary source suite'] }] }] },
        { ...validReport, testResults: [{ assertionResults: [{ ...testCase, status: 'pending' }] }] },
        { ...validReport, testResults: [{ assertionResults: [] }] }
      ]) {
        await writeReport(invalid);
        await expect(run()).rejects.toThrow();
      }
      await writeReport(validReport);
      await expect(run({ HELPER_OUTCOME: 'failure' })).rejects.toThrow();
      await writeFile(reportFile, ' '.repeat(256 * 1024 + 1));
      await expect(run()).rejects.toThrow();
      await writeReport({ ...validReport, success: false, numFailedTests: 1 });
      await run({ SYNTHETIC_OUTCOME: 'failure' });
      expect(JSON.parse(await readFile(summaryFile, 'utf8'))).toMatchObject({ success: false, failed: 1 });
      const buildReport = JSON.parse(await readFile(path.join(root, 'diagnostics/linux-keystore-build-report.json'), 'utf8'));
      expect(buildReport).toMatchObject({
        helperExecution: 'synthetic-fixture-suite-attempted', providerQualification: 'not-performed',
        custodyQualification: 'not-performed', stages: { synthetic: 'failure' }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs POSIX lock source diagnostics on explicit Linux x64 and arm64 hosts without custody or privileged host changes', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['native-posix-lock-diagnostics'];
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_native_posix_locks_only");
    expect(job.name).toContain('not custody or release qualification');
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.needs).toBeUndefined();
    expect(job.strategy).toEqual({
      'fail-fast': false,
      'max-parallel': 2,
      matrix: { include: [{ os: 'ubuntu-24.04', arch: 'x64' }, { os: 'ubuntu-24.04-arm', arch: 'arm64' }] }
    });
    expect(job.steps.find((step: any) => step.uses?.startsWith('actions/setup-node@')).with['node-version']).toBe('24.20.0');
    expect(job.steps.find((step: any) => step.uses?.startsWith('actions/setup-python@'))).toMatchObject({
      id: 'python', with: { 'python-version': '3.14.7' }
    });
    expect(job.steps.find((step: any) => step.uses?.startsWith('opentofu/setup-opentofu@')).with)
      .toEqual({ tofu_version: '1.12.6', tofu_wrapper: false });
    const resolved = job.steps.find((step: any) => step.name === 'Resolve selected native tools');
    expect(resolved.env).toEqual({ SELECTED_PYTHON: '${{ steps.python.outputs.python-path }}' });
    expect(resolved.shell).toBe('bash');
    expect(resolved.run).toBe([
      'python_path="$(realpath -- "$SELECTED_PYTHON")"',
      'tofu_path="$(realpath -- "$(command -v tofu)")"',
      'test -x "$python_path"',
      'test -x "$tofu_path"',
      'printf \'LIFTOFF_STATE_PYTHON=%s\\nLIFTOFF_TOFU_EXECUTABLE=%s\\n\' "$python_path" "$tofu_path" >> "$GITHUB_ENV"',
      ''
    ].join('\n'));
    for (const command of ['npm install --global "npm@12.0.2"', 'npm ci', 'npm run build']) {
      expect(job.steps.slice(0, -2).some((step: any) => step.run === command)).toBe(true);
    }
    expect(job.steps.at(-2)).toEqual({
      name: 'Run native POSIX lock and readonly guard source diagnostics (not custody or release qualification)',
      env: { LIFTOFF_POSIX_NATIVE_LOCK_QUALIFICATION: '1', LIFTOFF_LINUX_READONLY_PROCESS_TEST: '1' },
      run: 'npx vitest run tests/state-posix-platform.test.ts tests/state-linux-readonly-process.test.ts --maxWorkers=1 --reporter=verbose --reporter=json ' +
        '--outputFile.json=diagnostics/native-posix-lock-tests.json'
    });
    expect(job.steps.at(-1).if).toBe('always()');
    expect(job.steps.at(-1).uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(job.steps.at(-1).with).toEqual({
      name: 'native-posix-lock-source-diagnostics-${{ matrix.os }}-${{ runner.arch }}-${{ github.sha }}-${{ github.run_attempt }}',
      path: 'diagnostics/native-posix-lock-host.json\ndiagnostics/native-posix-tool-preparation.json\ndiagnostics/native-posix-lock-tests.json\n',
      'if-no-files-found': 'error', 'retention-days': 7
    });
    const commands = job.steps.map((step: any) => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/\bsudo\b|\bchmod\b|\bmount\b|\bfscrypt\b|\bsecret-tool\b|gate:coverage|gate:release/);
  });

  it('records actual POSIX diagnostic host facts and rejects an unsupported or mismatched architecture', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['native-posix-lock-diagnostics'];
    const step = job.steps.find((entry: any) => entry.name === 'Record and verify actual diagnostic host');
    expect(step.env).toEqual({ EXPECTED_ARCH: '${{ matrix.arch }}' });
    expect(step.shell).toBe('bash');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await scratchDirectory();
    try {
      const run = (expected: string, runner: string) => execFileAsync(process.execPath, ['--input-type=module', '-e', program!], {
        cwd: root,
        env: {
          ...process.env, EXPECTED_ARCH: expected, RUNNER_OS: process.platform === 'linux' ? 'Linux' : 'NonLinux',
          RUNNER_ARCH: runner, GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ATTEMPT: '2'
        }
      });
      const observed = run(process.arch, process.arch.toUpperCase());
      if (process.platform === 'linux') await observed;
      else await expect(observed).rejects.toThrow('Native Linux is required');
      const report = JSON.parse(await readFile(path.join(root, 'diagnostics/native-posix-lock-host.json'), 'utf8'));
      expect(report).toMatchObject({
        scope: 'synthetic-local-state-locks-and-nonsecret-readonly-guard-only', platform: process.platform, architecture: process.arch,
        runnerArchitecture: process.arch.toUpperCase(), expectedArchitecture: process.arch,
        sourceCommit: 'a'.repeat(40), runAttempt: '2',
        encryptedCustodyQualification: 'not-performed', releaseQualification: 'not-performed'
      });
      const other = process.arch === 'arm64' ? 'x64' : 'arm64';
      await expect(run(other, process.arch.toUpperCase())).rejects.toThrow();
      await expect(run(process.arch, other.toUpperCase())).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('prepares only runner-owned selected tool modes without replacing or changing executable bytes', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['native-posix-lock-diagnostics'];
    const prepareIndex = job.steps.findIndex((step: any) => step.name === 'Prepare only selected native executable permissions');
    expect(prepareIndex).toBeGreaterThan(job.steps.findIndex((step: any) => step.name === 'Resolve selected native tools'));
    expect(prepareIndex).toBeLessThan(job.steps.length - 2);
    const step = job.steps[prepareIndex];
    expect(step.shell).toBe('bash');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await realpath(await scratchDirectory());
    try {
      const python = path.join(root, 'python');
      const tofu = path.join(root, 'tofu');
      const unrelated = path.join(root, 'unrelated');
      const bytes = '#!/bin/sh\nexit 0\n';
      for (const file of [python, tofu, unrelated]) await writeFile(file, bytes);
      await chmod(python, 0o777);
      await chmod(tofu, 0o755);
      await chmod(unrelated, 0o777);
      const original = await lstat(python, { bigint: true });
      const run = () => execFileAsync(process.execPath, ['--input-type=module', '-e', program!], {
        cwd: root, env: { ...process.env, LIFTOFF_STATE_PYTHON: python, LIFTOFF_TOFU_EXECUTABLE: tofu }
      });
      await run();
      const report = JSON.parse(await readFile(path.join(root, 'diagnostics/native-posix-tool-preparation.json'), 'utf8'));
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(report).toMatchObject({
        status: 'prepared', scope: 'ephemeral-selected-source-test-tools-only',
        platform: process.platform, architecture: process.arch, runnerUid: process.getuid!()
      });
      expect(report.tools[0]).toMatchObject({
        id: 'python', path: python, status: 'prepared', permissionsChanged: true,
        before: { uid: String(original.uid), gid: String(original.gid), mode: '0777', sha256: digest },
        after: { uid: String(original.uid), gid: String(original.gid), mode: '0755', sha256: digest }
      });
      expect(report.tools[1]).toMatchObject({ id: 'tofu', status: 'prepared', permissionsChanged: false });
      for (const key of ['dev', 'ino', 'uid', 'gid', 'size', 'mtimeNs', 'sha256']) {
        expect(report.tools[0].after[key]).toBe(report.tools[0].before[key]);
      }
      expect((await lstat(python, { bigint: true })).ino).toBe(original.ino);
      expect(await readFile(python, 'utf8')).toBe(bytes);
      expect((await lstat(unrelated)).mode & 0o777).toBe(0o777);
      await run();
      const repeated = JSON.parse(await readFile(path.join(root, 'diagnostics/native-posix-tool-preparation.json'), 'utf8'));
      expect(repeated.tools.every((tool: any) => tool.status === 'prepared' && tool.permissionsChanged === false)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32').each([
    'non-owner', 'not-executable', 'directory', 'symlink', 'chmod-denied', 'changed-bytes', 'replaced-path'
  ])('retains a fixture-preparation blocker for %s without a broader permission fallback', async (scenario) => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const step = workflow.jobs['native-posix-lock-diagnostics'].steps.find((entry: any) =>
      entry.name === 'Prepare only selected native executable permissions');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = await realpath(await scratchDirectory());
    try {
      const python = path.join(root, 'python');
      const tofu = path.join(root, 'tofu');
      const other = path.join(root, 'unrelated');
      const bytes = '#!/bin/sh\nexit 0\n';
      for (const file of [python, tofu, other]) {
        await writeFile(file, bytes);
        await chmod(file, 0o777);
      }
      let prefix = '';
      if (scenario === 'non-owner') prefix = `process.getuid = () => ${process.getuid!() + 1};\n`;
      if (scenario === 'not-executable') await chmod(python, 0o666);
      if (scenario === 'directory' || scenario === 'symlink') {
        await rm(python);
        if (scenario === 'directory') await mkdir(python);
        else await symlink(other, python);
      }
      if (['chmod-denied', 'changed-bytes', 'replaced-path'].includes(scenario)) {
        const hook = scenario === 'chmod-denied'
          ? "throw Object.assign(new Error('fixture chmod denied'), { code: 'EPERM' });"
          : scenario === 'changed-bytes'
            ? "originalChmod(fd, mode); fs.writeFileSync(process.env.LIFTOFF_STATE_PYTHON, 'changed bytes');"
            : `originalChmod(fd, mode);
               const file = process.env.LIFTOFF_STATE_PYTHON;
               const bytes = fs.readFileSync(file);
               fs.renameSync(file, file + '.original');
               fs.writeFileSync(file, bytes, { mode: 0o755 });`;
        prefix = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalChmod = fs.fchmodSync;
fs.fchmodSync = (fd, mode) => { ${hook} };
syncBuiltinESMExports();
`;
      }
      await expect(execFileAsync(process.execPath, ['--input-type=module', '-e', prefix + program], {
        cwd: root, env: { ...process.env, LIFTOFF_STATE_PYTHON: python, LIFTOFF_TOFU_EXECUTABLE: tofu }
      })).rejects.toThrow('Fixture-preparation blocker (python)');
      const report = JSON.parse(await readFile(path.join(root, 'diagnostics/native-posix-tool-preparation.json'), 'utf8'));
      expect(report.status).toBe('blocked');
      expect(report.tools[0]).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('Fixture-preparation blocker (python)') });
      expect(report.tools[1]).toMatchObject({ id: 'tofu', status: 'not-inspected', permissionsChanged: false });
      expect((await lstat(tofu)).mode & 0o777).toBe(0o777);
      expect((await lstat(other)).mode & 0o777).toBe(0o777);
      expect(await readFile(other, 'utf8')).toBe(bytes);
      if (scenario === 'non-owner' || scenario === 'chmod-denied') {
        expect(report.tools[0].permissionsChanged).toBe(false);
        expect((await lstat(python)).mode & 0o777).toBe(0o777);
        expect(await readFile(python, 'utf8')).toBe(bytes);
      }
      if (scenario === 'changed-bytes') expect(report.tools[0].after.sha256).not.toBe(report.tools[0].before.sha256);
      if (scenario === 'replaced-path') expect(report.tools[0].blocker).toContain('path inode changed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs bounded native Go diagnostics on both POSIX hosts with exact pins and retained source-only reports', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['native-go-diagnostics'];
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_native_go_only");
    expect(job.name).toContain('not qualification');
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(job['timeout-minutes']).toBe(20);
    expect(job.needs).toBeUndefined();
    expect(job.strategy).toEqual({
      'fail-fast': false, 'max-parallel': 2, matrix: { os: ['ubuntu-latest', 'macos-latest'] }
    });
    expect(job.steps.find((step: any) => step.uses?.startsWith('actions/setup-node@')).with['node-version']).toBe('24.20.0');
    expect(job.steps.find((step: any) => step.uses?.startsWith('actions/setup-go@')).with['go-version']).toBe('1.27.0');
    for (const command of ['npm install --global "npm@12.0.2"', 'npm ci', 'npm run build']) {
      expect(job.steps.slice(0, -2).some((step: any) => step.run === command)).toBe(true);
    }
    expect(job.steps.find((step: any) => step.name === 'Harden tool permissions'))
      .toEqual(workflow.jobs.test.steps.find((step: any) => step.name === 'Harden tool permissions'));
    expect(job.steps.at(-2)).toEqual({
      name: 'Run isolated native Go source diagnostics (not qualification)',
      env: { LIFTOFF_REPAIR_PREPARATION_NATIVE: '1' },
      run: "npx vitest run tests/repair-preparation-native.test.ts -t 'prepares actual Go module/checksum inputs' " +
        '--maxWorkers=1 --reporter=verbose --reporter=json --outputFile.json=diagnostics/native-go-tests.json'
    });
    expect(job.steps.at(-1).if).toBe('always()');
    expect(job.steps.at(-1).uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(job.steps.at(-1).with).toEqual({
      name: 'native-go-source-diagnostics-${{ matrix.os }}-${{ github.sha }}-${{ github.run_attempt }}',
      path: 'diagnostics/native-go-tests.json', 'if-no-files-found': 'error', 'retention-days': 7
    });
    expect(job.steps.some((step: any) => step.run?.includes('gate:coverage') || step.run?.includes('gate:release'))).toBe(false);
  });

  it('applies the diagnostic one-worker override to both Windows projects', async () => {
    const { createVitest } = await import('vitest/node');
    const context = await createVitest({
      ...createRootTestConfig('win32').test, config: false, watch: false, cache: false, maxWorkers: 1
    });
    try {
      expect(context.projects.map((project) => [project.name, project.config.maxWorkers])).toEqual([
        ['root-tests', 1], ['migration-inspection', 1]
      ]);
    } finally {
      await context.close();
    }
  });

  it('preserves separately bounded native integration, packaging, infrastructure and template lanes', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const integration = workflow.jobs.test;
    expect(integration['timeout-minutes']).toBe(45);
    expect(integration.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    for (const [name, condition, env, command] of [
      ['Run pinned framework integration smoke', "runner.os == 'Linux'", { LIFTOFF_FRAMEWORK_SMOKE: '1' }, 'npx vitest run tests/framework-smoke.test.ts'],
      ['Validate local repair with native OpenTofu', undefined, { LIFTOFF_REPAIR_NATIVE: '1' }, 'npx vitest run tests/repair-command.test.ts -t "native backend-disabled"'],
      ['Validate locked preparation and framework qualification with native toolchains', "runner.os != 'Windows'", { LIFTOFF_REPAIR_PREPARATION_NATIVE: '1' }, 'npx vitest run tests/repair-preparation-native.test.ts tests/repair-framework.test.ts']
    ]) {
      expect(integration.steps.find((step: any) => step.name === name)).toEqual({
        name, ...(condition ? { if: condition } : {}), env, run: command
      });
    }
    for (const run of ['npm run check:supported-stack', 'npm run check --prefix services/telemetry-ingest', 'npm run smoke:package']) {
      expect(integration.steps.some((step: any) => step.run === run)).toBe(true);
    }
    expect(integration.steps.find((step: any) => step.run === 'npm run verify:generated-containers').if).toBe("runner.os == 'Linux'");
    expect(integration.steps.find((step: any) => step.name === 'Run Windows project and packaging boundary coverage').if).toBe("runner.os == 'Windows'");
    expect(integration.steps.some((step: any) => step.run === 'npm run check')).toBe(false);
    expect(workflow.jobs['telemetry-infrastructure']['timeout-minutes']).toBe(20);
    for (const run of [
      'npm run smoke:container --prefix services/telemetry-ingest',
      'tofu -chdir=infrastructure/opentofu/telemetry fmt -check',
      'tofu -chdir=infrastructure/opentofu/telemetry init -backend=false',
      'tofu -chdir=infrastructure/opentofu/telemetry validate',
      'npx vitest run tests/telemetry-infrastructure.test.ts'
    ]) expect(workflow.jobs['telemetry-infrastructure'].steps.some((step: any) => step.run === run)).toBe(true);
    const templates = workflow.jobs['standard-node-templates'];
    expect(templates['timeout-minutes']).toBe(30);
    expect(templates.strategy.matrix.include).toEqual([
      { 'node-version': '22.12.0', 'npm-version': '10.9.4' },
      { 'node-version': '24.20.0', 'npm-version': '12.0.2' }
    ]);
    expect(templates.steps.at(-1).run).toBe('npm run verify:standard-node-templates');
  });

  it.each(['linux', 'darwin', 'win32'] as const)('conserves the actual complete %s spec inventory across built-in shards', async (platform) => {
    const { BaseSequencer, createVitest } = await import('vitest/node');
    const context = await createVitest({
      ...createRootTestConfig(platform).test, config: false, watch: false, cache: false
    });
    try {
      const specifications = await context.globTestSpecifications();
      const expected = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'tests'], { encoding: 'utf8' })
        .split('\n').filter((file) => file.endsWith('.test.ts')).sort();
      const relative = (spec: { moduleId: string }) => path.relative(process.cwd(), spec.moduleId).split(path.sep).join('/');
      expect(specifications.map(relative).sort()).toEqual(expected);
      const selected = [];
      for (const index of [1, 2, 3]) {
        context.config.shard = { index, count: 3 };
        const sequencer = new BaseSequencer(context);
        const shard = await sequencer.shard(specifications);
        expect(shard.length).toBeGreaterThan(0);
        if (platform === 'win32') {
          expect(shard.every((spec) => spec.project.config.maxWorkers === 2)).toBe(true);
          const sorted = await sequencer.sort(shard);
          if (shard.some((spec) => spec.project.name === 'migration-inspection')) {
            expect(sorted.at(-1)?.project.name).toBe('migration-inspection');
            expect(sorted.slice(0, -1).every((spec) => spec.project.config.sequence.groupOrder === 0)).toBe(true);
          }
        }
        selected.push(...shard);
      }
      expect(selected.map(relative).sort()).toEqual(expected);
      expect(new Set(selected.map(relative)).size).toBe(expected.length);
      const migration = selected.filter((spec) => relative(spec) === 'tests/migration-inspection.test.ts');
      expect(migration).toHaveLength(1);
      if (platform === 'win32') {
        expect(migration[0].project.name).toBe('migration-inspection');
        expect(migration[0].project.config.sequence.groupOrder).toBe(1);
      }
    } finally {
      await context.close();
    }
  });

  it('fails the executable report guards for missing, empty or unexpected shard reports', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const guards = [
      workflow.jobs['test-shards'].steps.find((step: any) => step.name === 'Require CLI shard measurements'),
      workflow.jobs['coverage-qualification'].steps.find((step: any) => step.name === 'Require every CLI shard report')
    ];
    const root = await scratchDirectory();
    try {
      const programs = guards.map((step: any) => {
        const program = /^node --input-type=module -e "([\s\S]*)"$/.exec(step.run)?.[1];
        expect(program).toBeTypeOf('string');
        return program!;
      });
      const run = (program: string) => execFileAsync(process.execPath, ['--input-type=module', '-e', program], { cwd: root });
      await expect(run(programs[0])).rejects.toThrow();
      await mkdir(path.join(root, 'coverage'));
      await writeFile(path.join(root, 'coverage/coverage-final.json'), '{}');
      await expect(run(programs[0])).rejects.toThrow();
      await writeFile(path.join(root, 'coverage/coverage-summary.json'), '');
      await expect(run(programs[0])).rejects.toThrow();
      await writeFile(path.join(root, 'coverage/coverage-summary.json'), '{}');
      await run(programs[0]);
      await expect(run(programs[1])).rejects.toThrow();
      await mkdir(path.join(root, 'source-test-blobs'));
      for (const index of [1, 2]) await writeFile(path.join(root, `source-test-blobs/shard-${index}.json`), '{}');
      await expect(run(programs[1])).rejects.toThrow();
      await writeFile(path.join(root, 'source-test-blobs/shard-3.json'), '');
      await expect(run(programs[1])).rejects.toThrow();
      await writeFile(path.join(root, 'source-test-blobs/shard-3.json'), '{}');
      await run(programs[1]);
      await writeFile(path.join(root, 'source-test-blobs/shard-4.json'), '{}');
      await expect(run(programs[1])).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses real V8 blob merging to retain unimported files and both frozen reader denominators', async () => {
    const root = await scratchDirectory();
    const configUrl = new URL('../vitest.config.ts', import.meta.url).href;
    const sources = {
      'src/choice.ts': 'export function choice(value: boolean) { if (value) return 1; return 2; }\n',
      'src/unimported.ts': 'export function unimported() { return 3; }\n',
      'assets/governance/single-maintainer-gitflow/activation-v3-reader/reader.js': 'export function historical() { return 4; }\n',
      'assets/governance/single-maintainer-gitflow/activation-v4-policy7-reader/reader.js': 'export function priorCandidate() { return 5; }\n',
      'tests/first.test.ts': "import { it, expect } from 'vitest'; import { choice } from '../src/choice.js'; it('first branch', () => expect(choice(true)).toBe(1));\n",
      'tests/second.test.ts': "import { it, expect } from 'vitest'; import { choice } from '../src/choice.js'; it('second branch', () => expect(choice(false)).toBe(2));\n",
      'tests/migration-inspection.test.ts': "import { it, expect } from 'vitest'; import { choice } from '../src/choice.js'; it('later project', () => expect(choice(true)).toBe(1));\n"
    };
    try {
      for (const [file, source] of Object.entries(sources)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), source);
      }
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
      await writeFile(path.join(root, 'vitest.config.mjs'), `
import config, { createRootTestConfig } from ${JSON.stringify(configUrl)};
export default {
  root: ${JSON.stringify(root)},
  test: { ...createRootTestConfig('win32').test, coverage: { ...config.test.coverage, reporter: ['json', 'json-summary'] } }
};
`);
      const run = (...args: string[]) => execFileAsync(process.execPath, [vitestCli, 'run', ...args], { cwd: root });
      for (const index of [1, 2, 3]) {
        await run(`--shard=${index}/3`, '--coverage', '--reporter=blob', `--outputFile.blob=source-test-blobs/shard-${index}.json`);
      }
      await run('--merge-reports=source-test-blobs', '--coverage', '--reporter=json', '--outputFile.json=merged-tests.json');
      const merged = JSON.parse(await readFile(path.join(root, 'coverage/coverage-summary.json'), 'utf8'));
      const report = JSON.parse(await readFile(path.join(root, 'merged-tests.json'), 'utf8'));
      expect(report).toMatchObject({ success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0 });
      expect(Object.keys(merged).filter((key) => key !== 'total').map((key) => path.relative(root, key).split(path.sep).join('/')).sort())
        .toEqual(Object.keys(sources).filter((key) => !key.startsWith('tests/')).sort());
      for (const [file, metrics] of Object.entries(merged) as [string, any][]) {
        if (file === 'total' || file.endsWith('choice.ts')) continue;
        expect(metrics.lines.covered).toBe(0);
        expect(metrics.lines.total).toBeGreaterThan(0);
      }
      await run('--coverage', '--reporter=json', '--outputFile.json=complete-tests.json');
      const complete = JSON.parse(await readFile(path.join(root, 'coverage/coverage-summary.json'), 'utf8'));
      expect(merged).toEqual(complete);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('separates three-OS source validation from actual six-target native/evidence admission', async () => {
    const text = await readFile(path.join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const workflow = parse(text);
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toEqual(['source-validation', 'evidence-validation', 'prepare-action', 'approve-action', 'qualify-records']);
    expect(workflow.on.workflow_dispatch.inputs.source_commit.required).toBe(true);
    for (const input of ['evidence_run_id', 'evidence_run_attempt', 'evidence_artifact_id']) {
      expect(workflow.on.workflow_dispatch.inputs[input].type).toBe('string');
    }
    expect(workflow.jobs.source.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    expect(workflow.jobs.source.name).toContain('not native qualification');
    expect(workflow.jobs.evidence.needs).toBe('source');
    expect(workflow.jobs.evidence.if).toBe("inputs.mode == 'evidence-validation'");
    expect(text).toContain('"$SOURCE_COMMIT" != "$GITHUB_SHA"');
    expect(text).toContain('persist-credentials: false');
    expect(text).toContain('capture-source --source-commit "$SOURCE_COMMIT" --output build/source-validation/report.json');
    expect(workflow.jobs.source.steps.at(-1).with['if-no-files-found']).toBe('error');
    expect(workflow.jobs.source.steps.some((step: any) => step.run?.includes('release-gate.mjs --evidence'))).toBe(false);
  });

  it('collects exact authenticated public evidence before invoking the real final gate without publication authority', async () => {
    const text = await readFile('.github/workflows/release.yml', 'utf8');
    const workflow = parse(text);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.evidence.permissions).toEqual({ contents: 'read', actions: 'read', attestations: 'read' });
    const steps = workflow.jobs.evidence.steps;
    const collect = steps.findIndex((step: any) => step.name === 'Collect authenticated previously authorized evidence');
    const gate = steps.findIndex((step: any) => step.name === 'Validate coordinated publication release gate');
    expect(collect).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(collect);
    expect(steps[collect].run).toContain('--source-commit "$SOURCE_COMMIT"');
    expect(steps[collect].run).toContain('--run-id "$EVIDENCE_RUN_ID"');
    expect(steps[collect].run).toContain('--run-attempt "$EVIDENCE_RUN_ATTEMPT"');
    expect(steps[collect].run).toContain('--artifact-id "$EVIDENCE_ARTIFACT_ID"');
    expect(steps[gate].run).toBe('node scripts/release-gate.mjs --evidence build/release-evidence/release-evidence.json');
    for (const forbidden of ['npm publish', 'dist-tag', 'dry_run', 'npm pack', 'registry-url:', 'verified: true', 'publicationApproval', 'contents: write', 'continue-on-error', 'gh release create', 'environment:']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain('Missing prerequisite: exact completed trusted evidence run');
    expect(text).not.toContain('verify:published');
  });

  it('separates explicit Liftoff action dispatch from environment reviewer gates and provider execution', async () => {
    const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8'));
    expect(workflow.on.workflow_dispatch.inputs.approval_purpose.options).toEqual(['none', 'publication', 'liveQualification', 'dashboard', 'telemetryGateway']);
    expect(workflow.on.workflow_dispatch.inputs.approval_purpose.default).toBe('none');
    const producer = workflow.jobs.produce;
    expect(producer.needs).toBe('source');
    expect(producer.permissions).toEqual({ contents: 'read', actions: 'read', attestations: 'write', 'id-token': 'write' });
    expect(producer.environment).toBeUndefined();
    const production = producer.steps.findIndex((step: any) => step.name === 'Produce exact request, action receipt, or verified execution aggregate');
    const attestation = producer.steps.findIndex((step: any) => step.name === 'Attest only the successfully verified report bytes');
    expect(production).toBeLessThan(attestation);
    expect(producer.steps[production].env.LIFTOFF_RELEASE_MODE).toBe('${{ inputs.mode }}');
    expect(producer.steps[production].run).toContain('scripts/produce-release-evidence.mjs');
    expect(producer.steps[attestation].uses).toMatch(/^actions\/attest-build-provenance@[a-f0-9]{40}$/);
    expect(producer.steps[attestation].with['subject-path']).toBe('${{ env.REPORT_PATH }}');
    expect(producer.steps.at(-1).with.path).toBe('${{ env.REPORT_PATH }}');
    expect(producer.env.REPORT_PATH).not.toContain('*');
    expect(producer.steps.some((step: any) => step.run?.includes('gh workflow run') || step.run?.includes('az deployment'))).toBe(false);
  });

  it('preserves independently selected historical npm verification tooling', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const historical = await readFile('scripts/verify-published-package.mjs', 'utf8');
    expect(packageJson.scripts['verify:published']).toContain('scripts/verify-published-package.mjs');
    expect(historical).toMatch(/version|args/);
    const source = await readFile('scripts/collect-release-evidence.mjs', 'utf8');
    expect(source).toContain('SOURCE_ONLY_NOT_QUALIFIED');
    expect(source).not.toContain('QUALIFIED_FOR_PUBLICATION');
  });
});

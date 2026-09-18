import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createRootTestConfig } from '../vitest.config.js';

const execFileAsync = promisify(execFile);
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const fullValidationCondition = "github.event_name != 'workflow_dispatch' || (!inputs.diagnostic_windows_only && !inputs.diagnostic_native_go_only)";
const fullValidationJobs = ['test', 'test-shards', 'telemetry-infrastructure', 'standard-node-templates', 'coverage-qualification'];

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
    for (const id of ['test', 'test-shards', 'coverage-qualification', 'windows-diagnostics', 'native-go-diagnostics']) {
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
    expect(workflow.on.workflow_dispatch.inputs.diagnostic_native_go_only).toEqual({
      description: 'Run native Go source diagnostics (not qualification)',
      type: 'boolean', required: false, default: false
    });
    expect(workflow.on.push).toEqual({ branches: ['main'] });
    expect(workflow.on).toHaveProperty('pull_request');
    expect(Object.keys(workflow.jobs).sort()).toEqual([...fullValidationJobs, 'windows-diagnostics', 'native-go-diagnostics'].sort());
    for (const id of fullValidationJobs) {
      expect(workflow.jobs[id].if).toBe(fullValidationCondition);
    }
    const diagnostic = workflow.jobs['windows-diagnostics'];
    expect(diagnostic.if).toBe("github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only");
    expect(diagnostic.name).toContain('not qualification');
    expect(diagnostic['runs-on']).toBe('windows-latest');
    expect(diagnostic['timeout-minutes']).toBe(20);
    expect(diagnostic.needs).toBeUndefined();
    expect(diagnostic.steps.at(-2).run).toBe(
      'npx vitest run tests/windows-job-runner.test.ts tests/windows-job-protocol.test.ts ' +
      'tests/windows-execution-qualification.test.ts tests/repair-workspaces.test.ts tests/update-preview.test.ts ' +
      '--maxWorkers=1 --reporter=verbose --reporter=json --outputFile.json=diagnostics/windows-source-tests.json'
    );
    expect(diagnostic.steps.at(-1).if).toBe('always()');
    expect(diagnostic.steps.at(-1).with.name).toBe('windows-source-diagnostics-${{ github.sha }}-${{ github.run_attempt }}');
    expect(diagnostic.steps.at(-1).with.path).toBe('diagnostics/windows-source-tests.json');
    expect(diagnostic.steps.at(-1).with['if-no-files-found']).toBe('error');
    expect(diagnostic.steps.some((step: any) => step.run?.includes('gate:coverage') || step.run?.includes('gate:release'))).toBe(false);
  });

  it.each([
    { windows: false, go: false, manualJobs: fullValidationJobs },
    { windows: true, go: false, manualJobs: ['windows-diagnostics'] },
    { windows: false, go: true, manualJobs: ['native-go-diagnostics'] },
    { windows: true, go: true, manualJobs: ['windows-diagnostics', 'native-go-diagnostics'] }
  ])('routes Windows=$windows and Go=$go without a diagnostic-only success pretending to be full validation', async ({ windows, go, manualJobs }) => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    for (const event of ['workflow_dispatch', 'push', 'pull_request']) {
      const conditions: Record<string, boolean> = {
        [fullValidationCondition]: event !== 'workflow_dispatch' || (!windows && !go),
        "github.event_name == 'workflow_dispatch' && inputs.diagnostic_windows_only": event === 'workflow_dispatch' && windows,
        "github.event_name == 'workflow_dispatch' && inputs.diagnostic_native_go_only": event === 'workflow_dispatch' && go
      };
      const selected = Object.entries(workflow.jobs).filter(([, job]: [string, any]) => {
        expect(Object.hasOwn(conditions, job.if)).toBe(true);
        return conditions[job.if];
      }).map(([id]) => id);
      expect(selected.sort()).toEqual([...(event === 'workflow_dispatch' ? manualJobs : fullValidationJobs)].sort());
      expect(selected.length).toBeGreaterThan(0);
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

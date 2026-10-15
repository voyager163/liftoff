import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  executeWorkflowActionReferenceValidator, executeWorkflowComposeConfigValidator,
  executeWorkflowContextValidator, executeWorkflowTofuComponentFormatValidator, parseWorkflowContextValidatorArgs,
  type WorkflowTofuFormatComponent
} from '../src/workflow-context-validator.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';
import * as boundFiles from '../src/adapters/filesystem/bound-project-files.js';
import { observeModernLocalTools } from '../src/adapters/process/modern-local-tools.js';
import { inspectModernLocalRuntime, planModernLocalRuntime } from '../src/application/governance/modern-local-inputs.js';
import { NodeCommandRunner } from '../src/process-runner.js';

describe('release-owned real context validator bodies, not phase qualification', () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-context-validator-test-')));
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', `core.hooksPath=${os.devNull}`, '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Isolated validator fixture', '-c', 'user.email=validator@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  }
  async function fixture(testSource = '', frontend = false, workflow: 'manual' | 'spec-kit' = 'manual',
    apiStack: 'node-fastify' | 'go-huma' = 'node-fastify') {
    const projectRoot = await mkdtemp(path.join(root, 'project-'));
    const seed = await writeModernInstalledProject(projectRoot, workflow, 'single-maintainer-gitflow', { frontend, apiStack });
    const source = resolveModernManifestV8SourceContract({ selection: seed.input.selection, recordedPlugins: seed.input.plugins });
    const components = new Map(source.layoutDescriptor.components.map(component => [component, ['source', component.replace(':', '-')]]));
    const value = await writeModernInstalledProject(projectRoot, workflow, 'single-maintainer-gitflow', {
      frontend, apiStack,
      activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
        ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
        { kind: 'artifact', logicalName: 'docker-compose', pathParts: ['compose.yml'] }
      ] }
    });
    await writeModernLocalFixtureInputs(value.input.selection, components, ['compose.yml'], value.write);
    const backend = components.get('backend')!;
    if (apiStack === 'node-fastify') {
      await value.write([...backend, 'source.js'], 'export function double(value) { return value * 2; }\n');
      await value.write([...backend, 'unused.js'], 'export const selectedSource = "committed application input";\n');
      await value.write([...backend, 'tests', 'source.test.js'], [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { double } from "../source.js";',
        'test("the real function doubles its input", () => { assert.equal(double(3), 6); });',
        testSource
      ].join('\n'));
    } else {
      await value.write([...backend, 'go.mod'], 'module example.local/source\n\ngo 1.27\n');
      await value.write([...backend, 'source.go'], 'package source\n\nfunc Double(value int) int { return value * 2 }\n');
      await value.write([...backend, 'tests', 'source_test.go'], [
        'package tests', 'import (', '  "testing"', '  source "example.local/source"', ')',
        'func TestDouble(t *testing.T) {',
        '  if actual := source.Double(3); actual != 6 { t.Fatalf("Double(3) = %d; want 6", actual) }',
        '}', testSource
      ].join('\n'));
    }
    if (frontend) {
      const parts = components.get('frontend')!;
      await value.write([...parts, 'package.json'], JSON.stringify({
        name: 'actual-build-fixture', version: '1.0.0', type: 'module', scripts: { build: 'node build.js' }
      }));
      await value.write([...parts, 'source.json'], '[1,2,3]\n');
      await value.write([...parts, 'build.js'], [
        'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'import assert from "node:assert/strict";',
        'const values = JSON.parse(readFileSync("source.json", "utf8"));',
        'assert(values.length > 0 && values.every(value => typeof value === "number"));',
        'mkdirSync("dist", { recursive: true });',
        'writeFileSync("dist/result.json", JSON.stringify({ total: values.reduce((sum, value) => sum + value, 0) }));'
      ].join('\n'));
    }
    git(projectRoot, 'init', '--quiet');
    git(projectRoot, 'remote', 'add', 'origin', 'https://github.com/fixture-owner/fixture-repo.git');
    git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '--quiet', '-m', 'Isolated real validator source');
    return { ...value, backend, components, sourceSha: git(projectRoot, 'rev-parse', 'HEAD') };
  }

  it('parses only the finite literal subject and exact commit, without caller command or proof values', () => {
    expect(parseWorkflowContextValidatorArgs(['--validator', 'backend-tests', '--source-sha', 'a'.repeat(40)]))
      .toEqual({ validator: 'backend-tests', sourceSha: 'a'.repeat(40) });
    for (const argv of [
      [], ['--validator', 'echo', '--source-sha', 'a'.repeat(40)],
      ['--validator', 'infrastructure', '--source-sha', 'a'.repeat(40)],
      ['--validator', 'action-references', '--source-sha', 'a'.repeat(40)],
      ['--validator', 'compose-config', '--source-sha', 'a'.repeat(40)],
      ['--validator', 'source-integrity', '--source-sha', 'main'],
      ['--validator', 'source-integrity', '--source-sha', 'a'.repeat(40), '--execute'],
      ['--source-sha', 'a'.repeat(40), '--validator', 'source-integrity']
    ]) expect(() => parseWorkflowContextValidatorArgs(argv)).toThrow();
  });

  it('validates actual selected committed source without executing project commands or issuing phase proof', async () => {
    const value = await fixture();
    const result = await executeWorkflowContextValidator(value.root, { validator: 'source-integrity', sourceSha: value.sourceSha });
    expect(result).toMatchObject({
      status: 'passed', workloadExecution: false, command: null, phaseProof: 'not-issued',
      retainedExecutionDirectory: null, executionBoundary: 'not-a-sandbox',
      graphHash: value.api!.identity.phaseGraphHash
    });
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('uses the same actual test command for genuine passing and broken committed application source', async () => {
    const value = await fixture();
    const green = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    expect(green).toMatchObject({ status: 'passed', workloadExecution: true,
      command: { status: 0, processTreeSettled: true }, retainedExecutionDirectory: null, phaseProof: 'not-issued' });
    await value.write([...value.backend, 'source.js'], 'export function double(value) { return value * 3; }\n');
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Break the actual doubling implementation');
    const red = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: git(value.root, 'rev-parse', 'HEAD') });
    expect(red).toMatchObject({ status: 'failed', code: 'validator-command',
      command: { status: 1, processTreeSettled: true }, retainedExecutionDirectory: null, phaseProof: 'not-issued' });
    expect(red.message).not.toContain('AssertionError');
  });

  it.each(['passing', 'broken'] as const)('runs the real Go backend tests against %s committed application logic', async variant => {
    const value = await fixture('', false, 'manual', 'go-huma');
    if (variant === 'broken') {
      await value.write([...value.backend, 'source.go'], 'package source\n\nfunc Double(value int) int { return value * 3 }\n');
      git(value.root, 'add', '--', [...value.backend, 'source.go'].join('/'));
      git(value.root, 'commit', '--quiet', '-m', 'Break the actual Go doubling implementation');
    }
    const report = await executeWorkflowContextValidator(value.root, {
      validator: 'backend-tests', sourceSha: git(value.root, 'rev-parse', 'HEAD')
    });
    expect(report).toMatchObject({
      status: variant === 'passing' ? 'passed' : 'failed',
      code: variant === 'passing' ? 'validator-passed' : 'validator-command',
      workloadExecution: true, command: { status: variant === 'passing' ? 0 : 1, processTreeSettled: true },
      retainedExecutionDirectory: null, phaseProof: 'not-issued'
    });
    expect(JSON.stringify(report)).not.toContain('Double(3)');
  });

  it('refuses a different commit before running project code', async () => {
    const value = await fixture();
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: 'a'.repeat(40) });
    expect(report).toMatchObject({ status: 'failed', code: 'validator-source-binding', workloadExecution: false, command: null });
  });

  it('does not let a real local Git replacement redefine the reviewed commit source', async () => {
    const value = await fixture();
    await value.write([...value.backend, 'source.js'], 'export function double(value) { return value * 3; }\n');
    git(value.root, 'add', '.');
    git(value.root, 'commit', '--quiet', '-m', 'Different actual application source');
    const replacement = git(value.root, 'rev-parse', 'HEAD');
    git(value.root, 'replace', value.sourceSha, replacement);
    git(value.root, 'update-ref', 'HEAD', value.sourceSha);
    expect(await executeWorkflowContextValidator(value.root, {
      validator: 'source-integrity', sourceSha: value.sourceSha
    })).toMatchObject({
      status: 'failed', code: 'validator-source-mismatch', workloadExecution: false, command: null
    });
  });

  it('refuses uncommitted application bytes before project code can execute', async () => {
    const value = await fixture();
    await value.write([...value.backend, 'source.js'], 'export function double(value) { return value * 3; }\n');
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    expect(report).toMatchObject({ status: 'failed', code: 'validator-source-mismatch', workloadExecution: false, command: null });
  });

  it('detects project code changing a selected committed input even if the test process exits zero', async () => {
    const value = await fixture([
      'import { writeFileSync } from "node:fs";',
      'test("fixture mutates source after its assertion", () => {',
      '  writeFileSync(new URL("../source.js", import.meta.url), "export function double(value) { return 0; }\\n");',
      '});'
    ].join('\n'));
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    expect(report).toMatchObject({ status: 'failed', code: 'validator-source-mismatch', workloadExecution: true,
      command: { status: 0, processTreeSettled: true } });
  });

  it('refuses a deleted committed application member before running project code', async () => {
    const value = await fixture();
    await rm(path.join(value.root, ...value.backend, 'unused.js'));
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    expect(report).toMatchObject({ status: 'failed', code: 'validator-source-membership', workloadExecution: false, command: null });
  });

  it('detects a test deleting a committed member despite its original process exiting zero', async () => {
    const value = await fixture([
      'import { unlinkSync } from "node:fs";',
      'test("fixture deletes a separate committed input", () => {',
      '  unlinkSync(new URL("../unused.js", import.meta.url));',
      '});'
    ].join('\n'));
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    expect(report).toMatchObject({ status: 'failed', code: 'validator-source-membership', workloadExecution: true,
      command: { status: 0, processTreeSettled: true } });
  });

  it('withholds inherited tokens and tool configuration and removes only its settled owned execution home', async () => {
    vi.stubEnv('LIFTOFF_CONTEXT_TEST_TOKEN', 'isolated-fixture-only');
    const value = await fixture([
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'test("runner environment is not an authority or credential carrier", () => {',
      '  assert.equal(process.env.LIFTOFF_CONTEXT_TEST_TOKEN, undefined);',
      '  assert.equal(process.env.GITHUB_TOKEN, undefined);',
      '  assert.equal(process.env.GH_TOKEN, undefined);',
      '  mkdirSync(new URL("../build/", import.meta.url), { recursive: true });',
      '  writeFileSync(new URL("../build/home.txt", import.meta.url), process.env.HOME);',
      '});'
    ].join('\n'));
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    expect(report).toMatchObject({ status: 'passed', retainedExecutionDirectory: null, phaseProof: 'not-issued' });
    const owned = await readFile(path.join(value.root, ...value.backend, 'build/home.txt'), 'utf8');
    expect(path.basename(owned)).toMatch(/^liftoff-workflow-validator-/u);
    await expect(lstat(owned)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a replacement real HOME directory and refuses false cleanup success after a settled child', async () => {
    const parent = await mkdtemp(path.join(root, 'execution-parent-'));
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, parent);
    const value = await fixture([
      'import { mkdirSync, renameSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'test("fixture replaces its allocated home without failing its test", () => {',
      '  const allocated = process.env.HOME, moved = `${allocated}-moved`;',
      '  writeFileSync(path.join(allocated, "original.txt"), "original allocated home");',
      '  renameSync(allocated, moved);',
      '  mkdirSync(allocated, { mode: 0o700 });',
      '  writeFileSync(path.join(allocated, "replacement.txt"), "replacement must survive");',
      '  mkdirSync(new URL("../build/", import.meta.url), { recursive: true });',
      '  writeFileSync(new URL("../build/home-replacement.json", import.meta.url), JSON.stringify({ allocated, moved }));',
      '});'
    ].join('\n'));
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    const observed = JSON.parse(await readFile(path.join(value.root, ...value.backend, 'build/home-replacement.json'), 'utf8'));
    const replacement = await readFile(path.join(observed.allocated, 'replacement.txt'), 'utf8').catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    const original = await readFile(path.join(observed.moved, 'original.txt'), 'utf8');
    expect({ report, replacement, original }).toMatchObject({
      report: { status: 'blocked', code: 'validator-cleanup', workloadExecution: true,
        command: { status: 0, processTreeSettled: true }, retainedExecutionDirectory: observed.allocated },
      replacement: 'replacement must survive', original: 'original allocated home'
    });
    expect(path.dirname(observed.allocated)).toBe(parent);
  });

  it('does not replace an omitted frontend or worker with a vacuous successful validator', async () => {
    const value = await fixture();
    for (const validator of ['frontend-build', 'worker-tests', 'framework-source'] as const) {
      expect(await executeWorkflowContextValidator(value.root, { validator, sourceSha: value.sourceSha }))
        .toMatchObject({ status: 'blocked', code: 'validator-inputs', workloadExecution: false, command: null });
    }
  });

  it('performs the actual frontend build and fails on invalid committed build input rather than an injected exit', async () => {
    const value = await fixture('', true), frontend = value.components.get('frontend')!;
    const green = await executeWorkflowContextValidator(value.root, { validator: 'frontend-build', sourceSha: value.sourceSha });
    expect(green).toMatchObject({ status: 'passed', workloadExecution: true, command: { status: 0, processTreeSettled: true } });
    expect(JSON.parse(await readFile(path.join(value.root, ...frontend, 'dist/result.json'), 'utf8'))).toEqual({ total: 6 });
    await value.write([...frontend, 'source.json'], '["not a numeric build input"]\n');
    git(value.root, 'add', '--', [...frontend, 'source.json'].join('/'));
    git(value.root, 'commit', '--quiet', '-m', 'Break actual frontend build input');
    const red = await executeWorkflowContextValidator(value.root, { validator: 'frontend-build', sourceSha: git(value.root, 'rev-parse', 'HEAD') });
    expect(red).toMatchObject({ status: 'failed', code: 'validator-command', command: { status: 1, processTreeSettled: true } });
  });

  it('validates the real Spec Kit document contract without substituting an echo or framework completion receipt', async () => {
    const value = await fixture('', false, 'spec-kit');
    expect(await executeWorkflowContextValidator(value.root, { validator: 'framework-source', sourceSha: value.sourceSha }))
      .toMatchObject({ status: 'passed', workloadExecution: false, command: null, phaseProof: 'not-issued' });
    await value.write(['specs', '000-liftoff-bootstrap', 'tasks.md'], 'Bootstrap identity: `000-liftoff-bootstrap`\n- [ ] B001 Incomplete actual task inventory.\n');
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Remove required Spec Kit bootstrap task identities');
    expect(await executeWorkflowContextValidator(value.root, { validator: 'framework-source', sourceSha: git(value.root, 'rev-parse', 'HEAD') }))
      .toMatchObject({ status: 'blocked', code: 'validator-inputs', workloadExecution: false, command: null, phaseProof: 'not-issued' });
  });

  it('bounds real project output and refuses success after its original process tree is stopped', async () => {
    const value = await fixture('test("fixture exceeds the real output limit", () => { process.stdout.write("x".repeat(2 * 1024 * 1024)); });');
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: value.sourceSha });
    expect(report).toMatchObject({ status: 'failed', code: 'validator-command', workloadExecution: true,
      command: { outputLimitExceeded: true, processTreeSettled: true }, retainedExecutionDirectory: null });
    expect(JSON.stringify(report).length).toBeLessThan(2048);
  });

  async function actionFixture() {
    const value = await fixture();
    const action = ['scripts', 'node-setup', 'action.yml'];
    const metadata = {
      name: 'Actual Node setup', description: 'Reusable project runtime setup',
      runs: { using: 'composite', steps: [{ uses: `actions/setup-node@${'a'.repeat(40)}` }] }
    };
    await value.write(action, JSON.stringify(metadata));
    await value.write(['.github', 'workflows', 'source.yml'], JSON.stringify({
      on: { push: {} }, jobs: { test: { 'runs-on': 'ubuntu-latest', steps: [
        { uses: `actions/checkout@${'b'.repeat(40)}` }, { uses: './scripts/node-setup' }
      ] } }
    }));
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual declared workflow and composite action');
    return { ...value, action, metadata, sourceSha: git(value.root, 'rev-parse', 'HEAD') };
  }

  it('checks the real recursive committed action closure and detects an actual single-file pinning violation', async () => {
    const value = await actionFixture();
    const green = await executeWorkflowActionReferenceValidator(value.root, value.sourceSha);
    expect(green).toMatchObject({
      validator: 'action-references', status: 'passed', code: 'validator-actions-passed',
      workloadExecution: false, command: null, phaseProof: 'not-issued', graphHash: value.api!.identity.phaseGraphHash
    });
    expect(Object.keys(green).sort()).toEqual(Object.keys(await executeWorkflowContextValidator(value.root, {
      validator: 'source-integrity', sourceSha: value.sourceSha
    })).sort());
    value.metadata.runs.steps[0]!.uses = 'actions/setup-node@main';
    await value.write(value.action, JSON.stringify(value.metadata));
    git(value.root, 'add', '--', value.action.join('/'));
    git(value.root, 'commit', '--quiet', '-m', 'Replace the existing setup action pin with a mutable reference');
    expect(git(value.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe(value.action.join('/'));
    const red = await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD'));
    expect(red).toMatchObject({
      status: 'failed', code: 'validator-actions-unpinned', workloadExecution: false, command: null, phaseProof: 'not-issued'
    });
    expect(red.inputDigest).not.toBe(green.inputDigest);
    expect(JSON.stringify(red)).not.toContain('actions/setup-node@main');
  });

  it('does not pass an empty workflow inventory vacuously', async () => {
    const value = await fixture();
    expect(await executeWorkflowActionReferenceValidator(value.root, value.sourceSha))
      .toMatchObject({ status: 'blocked', code: 'validator-actions-membership', workloadExecution: false });
  });

  it('does not renew its original absolute source-observation cutoff after real initial validation', async () => {
    const value = await actionFixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(180_001);
    try {
      expect(await executeWorkflowActionReferenceValidator(value.root, value.sourceSha))
        .toMatchObject({ status: 'blocked', code: 'validator-actions-deadline',
          workloadExecution: false, command: null, phaseProof: 'not-issued' });
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['deleted', 'untracked'] as const)('refuses a real %s workflow instead of selecting a partial source closure', async variant => {
    const value = await actionFixture();
    if (variant === 'deleted') await rm(path.join(value.root, '.github', 'workflows', 'source.yml'));
    else await value.write(['.github', 'workflows', 'untracked.yml'], '{"jobs":{}}\n');
    expect(await executeWorkflowActionReferenceValidator(value.root, value.sourceSha))
      .toMatchObject({ status: 'blocked', code: 'validator-actions-membership', workloadExecution: false });
  });

  it('refuses modified uncommitted local-action bytes against the original exact source', async () => {
    const value = await actionFixture();
    value.metadata.runs.steps[0]!.uses = 'actions/setup-node@main';
    await value.write(value.action, JSON.stringify(value.metadata));
    expect(await executeWorkflowActionReferenceValidator(value.root, value.sourceSha))
      .toMatchObject({ status: 'failed', code: 'validator-actions-source', workloadExecution: false });
  });

  it('refuses an actual composite-action cycle without running either action', async () => {
    const value = await actionFixture();
    value.metadata.runs.steps[0]!.uses = './scripts/node-setup';
    await value.write(value.action, JSON.stringify(value.metadata));
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual cyclic composite-action reference');
    expect(await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD')))
      .toMatchObject({ status: 'blocked', code: 'validator-actions-cycle', workloadExecution: false });
  });

  it('does not turn an official SLSA tag or a copied approval into a current exception grant', async () => {
    const value = await actionFixture();
    await value.write(['.github', 'workflows', 'source.yml'], JSON.stringify({
      on: { push: {} }, jobs: { provenance: {
        uses: 'slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.1.0'
      } }
    }));
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual tag-based official SLSA generator source');
    const report = await Reflect.apply(executeWorkflowActionReferenceValidator, undefined, [
      value.root, git(value.root, 'rev-parse', 'HEAD'),
      { status: 'approved', expiresAt: '2099-01-01T00:00:00.000Z' }
    ]);
    expect(report).toMatchObject({ status: 'blocked', code: 'validator-actions-exception-unavailable',
      workloadExecution: false, command: null, phaseProof: 'not-issued' });
  });

  it('refuses dynamic references and missing local metadata instead of guessing a successful closure', async () => {
    const value = await actionFixture();
    for (const reference of ['${{ inputs.action }}', './scripts/absent']) {
      value.metadata.runs.steps[0]!.uses = reference;
      await value.write(value.action, JSON.stringify(value.metadata));
      git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Unprovable actual action-reference source');
      const report = await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD'));
      expect(report.status).toBe('blocked');
      expect(report.workloadExecution).toBe(false);
    }
  });

  it('interprets real local reusable workflow calls and refuses their actual cycles', async () => {
    const value = await actionFixture();
    const reusable = ['.github', 'workflows', 'reusable.yml'];
    await value.write(reusable, JSON.stringify({
      on: { workflow_call: {} }, jobs: { test: { 'runs-on': 'ubuntu-latest',
        steps: [{ uses: './scripts/node-setup' }] } }
    }));
    await value.write(['.github', 'workflows', 'source.yml'], JSON.stringify({
      on: { push: {} }, jobs: { test: { uses: './.github/workflows/reusable.yml' } }
    }));
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Real local reusable workflow reference');
    expect(await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD')))
      .toMatchObject({ status: 'passed', code: 'validator-actions-passed', workloadExecution: false, command: null });
    await value.write(reusable, JSON.stringify({
      on: { workflow_call: {} }, jobs: { cycle: { uses: './.github/workflows/source.yml' } }
    }));
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Real reusable workflow cycle');
    expect(await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD')))
      .toMatchObject({ status: 'blocked', code: 'validator-actions-cycle', workloadExecution: false });
  });

  it.each([
    { using: 'composite', steps: [] },
    { using: 'composite', steps: [{}] },
    { using: 'composite', steps: [{ run: 'node --version' }] },
    { using: 'composite', steps: [{ run: 'node --version', shell: 'bash', uses: `actions/setup-node@${'a'.repeat(40)}` }] },
    { using: 'node24' },
    { using: 'docker' },
    { using: { toString: 'not-callable' }, main: 'index.js' },
    { using: 'unknown-runtime', main: 'index.js' }
  ])('blocks uninterpretable actual local metadata %j', async runs => {
    const value = await actionFixture();
    await value.write(value.action, JSON.stringify({ name: 'Actual malformed local action', runs }));
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual unsupported local-action metadata');
    expect(await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD')))
      .toMatchObject({ status: 'blocked', code: 'validator-actions-local', workloadExecution: false });
  });

  it.each(['ambiguous', 'untracked', 'traversal'] as const)('blocks %s local-action metadata explicitly', async variant => {
    const value = await actionFixture();
    if (variant === 'ambiguous') {
      await value.write(['scripts', 'node-setup', 'action.yaml'], JSON.stringify(value.metadata));
    } else if (variant === 'untracked') {
      git(value.root, 'rm', '--cached', '--', value.action.join('/'));
    } else {
      value.metadata.runs.steps[0]!.uses = './../outside';
      await value.write(value.action, JSON.stringify(value.metadata));
    }
    git(value.root, 'add', ...(variant === 'untracked' ? ['--update'] : ['.']));
    git(value.root, 'commit', '--quiet', '-m', 'Unprovable actual local-action closure');
    expect(await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD')))
      .toMatchObject({ status: 'blocked', workloadExecution: false, command: null });
  });

  it.each([
    { runs: { using: 'node24', main: 'index.js' }, status: 'passed' },
    { runs: { using: 'composite', steps: [{ run: 'node --version', shell: 'bash' }] }, status: 'passed' },
    { runs: { using: 'docker', image: `docker://fixture.invalid/action@sha256:${'c'.repeat(64)}` }, status: 'passed' },
    { runs: { using: 'docker', image: 'docker://fixture.invalid/action:latest' }, status: 'failed' },
    { runs: { using: 'docker', image: 'Dockerfile' }, status: 'blocked' }
  ] as const)('interprets only supported declared local runtime references %j', async ({ runs, status }) => {
    const value = await actionFixture();
    await value.write(value.action, JSON.stringify({ name: 'Actual declared runtime metadata', runs }));
    await value.write(['scripts', 'node-setup', 'index.js'], 'export const actualLocalActionSource = true;\n');
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual declared local runtime reference');
    expect(await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD')))
      .toMatchObject({ status, workloadExecution: false, command: null, phaseProof: 'not-issued' });
  });

  it.each(['symlink', 'hardlink', 'executable-mode', 'malformed-yaml'] as const)(
    'refuses actual local-action %s source without leaking its contents', async variant => {
      const value = await actionFixture(), file = path.join(value.root, ...value.action);
      if (variant === 'symlink') {
        const copy = path.join(value.root, 'actual-action-copy.yml');
        await value.write(['actual-action-copy.yml'], JSON.stringify(value.metadata));
        await rm(file); await symlink(copy, file);
      } else if (variant === 'hardlink') {
        await link(file, path.join(value.root, 'actual-action-copy.yml'));
      } else if (variant === 'executable-mode') {
        git(value.root, 'update-index', '--chmod=+x', '--', value.action.join('/'));
        git(value.root, 'commit', '--quiet', '-m', 'Actual committed executable metadata mode differs from the working file');
      } else {
        await value.write(value.action, 'runs: [isolated-sensitive-fixture: [\n');
        git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual malformed committed metadata');
      }
      const report = await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD'));
      expect(report.status).not.toBe('passed');
      expect(report.workloadExecution).toBe(false);
      expect(report.command).toBeNull();
      expect(JSON.stringify(report)).not.toContain('isolated-sensitive-fixture');
    }
  );

  it.each(['missing', 'modified', 'untracked-pre', 'symlink-post'] as const)(
    'does not call an actual %s Node action entrypoint committed source', async variant => {
      const value = await actionFixture();
      const directory = ['scripts', 'node-setup'];
      await value.write(value.action, JSON.stringify({
        name: 'Actual Node entrypoints', runs: { using: 'node24', main: 'index.js',
          ...(variant === 'untracked-pre' ? { pre: 'pre.js' } : {}),
          ...(variant === 'symlink-post' ? { post: 'post.js' } : {}) }
      }));
      if (variant !== 'missing') await value.write([...directory, 'index.js'], 'export const actualEntrypoint = true;\n');
      if (variant === 'symlink-post') await value.write([...directory, 'post.js'], 'export const actualPost = true;\n');
      git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual Node action source declaration');
      if (variant === 'modified') await value.write([...directory, 'index.js'], 'export const actualEntrypoint = false;\n');
      if (variant === 'untracked-pre') await value.write([...directory, 'pre.js'], 'export const untrackedPre = true;\n');
      if (variant === 'symlink-post') {
        const post = path.join(value.root, ...directory, 'post.js');
        await rm(post); await symlink(path.join(value.root, ...directory, 'index.js'), post);
      }
      const report = await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD'));
      expect(report.status).not.toBe('passed');
      expect(report.workloadExecution).toBe(false);
      expect(report.command).toBeNull();
    }
  );

  it.each(['mutable', 'symlink'] as const)(
    'refuses an actual untracked %s action.yml shadow beside committed action.yaml', async variant => {
      const value = await actionFixture();
      const yml = path.join(value.root, ...value.action);
      const yaml = path.join(value.root, 'scripts', 'node-setup', 'action.yaml');
      await rename(yml, yaml);
      git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual committed safe action.yaml metadata');
      const sourceSha = git(value.root, 'rev-parse', 'HEAD');
      expect(await executeWorkflowActionReferenceValidator(value.root, sourceSha))
        .toMatchObject({ status: 'passed', workloadExecution: false, command: null });
      if (variant === 'symlink') await symlink(yaml, yml);
      else {
        value.metadata.runs.steps[0]!.uses = 'actions/setup-node@main';
        await value.write(value.action, JSON.stringify(value.metadata));
      }
      const report = await executeWorkflowActionReferenceValidator(value.root, sourceSha);
      expect(report.status).toBe('blocked');
      expect(report.workloadExecution).toBe(false);
      expect(report.command).toBeNull();
    }
  );

  it.each(['node20', 'node24'])('binds all actual declared %s entrypoints without running them', async using => {
    const value = await actionFixture();
    await value.write(value.action, JSON.stringify({
      name: 'Actual complete Node entrypoints', runs: { using, main: './index.js', pre: 'before.js', post: 'after.js' }
    }));
    for (const file of ['index.js', 'before.js', 'after.js']) {
      await value.write(['scripts', 'node-setup', file], 'export const declaredLocalActionInput = true;\n');
    }
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual complete committed Node action entrypoints');
    expect(await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD')))
      .toMatchObject({ status: 'passed', workloadExecution: false, command: null, phaseProof: 'not-issued' });
  });

  it('reobserves actual metadata membership after interpretation instead of retaining its initial safe inventory', async () => {
    const value = await actionFixture(), yaml = ['scripts', 'node-setup', 'action.yaml'];
    await rename(path.join(value.root, ...value.action), path.join(value.root, ...yaml));
    git(value.root, 'add', '.'); git(value.root, 'commit', '--quiet', '-m', 'Actual initial safe alternate metadata');
    const original = boundFiles.readBoundProjectFileSnapshot;
    let metadataReads = 0, shadowWritten = false;
    const reads = vi.spyOn(boundFiles, 'readBoundProjectFileSnapshot').mockImplementation(async (...args) => {
      const captured = await original(...args);
      if (args[0] === value.root && args[1].join('/') === yaml.join('/') && ++metadataReads === 2) {
        value.metadata.runs.steps[0]!.uses = 'actions/setup-node@main';
        await value.write(value.action, JSON.stringify(value.metadata));
        shadowWritten = true;
      }
      return captured;
    });
    try {
      const report = await executeWorkflowActionReferenceValidator(value.root, git(value.root, 'rev-parse', 'HEAD'));
      expect(shadowWritten).toBe(true);
      expect(report).toMatchObject({ status: 'blocked', code: 'validator-actions-local',
        workloadExecution: false, command: null, phaseProof: 'not-issued' });
    } finally {
      reads.mockRestore();
    }
  });

  it('runs the same real Compose configuration command for valid source and an actual missing-service dependency', async () => {
    const value = await fixture();
    const green = await executeWorkflowComposeConfigValidator(value.root, value.sourceSha);
    expect(green).toMatchObject({
      validator: 'compose-config', status: 'passed', workloadExecution: true,
      command: { status: 0, processTreeSettled: true }, retainedExecutionDirectory: null, phaseProof: 'not-issued'
    });
    await value.write(['compose.yml'], [
      'services:', '  app:', '    image: fixture.invalid/local:source',
      '    depends_on:', '      - missing-service'
    ].join('\n'));
    git(value.root, 'add', '--', 'compose.yml');
    git(value.root, 'commit', '--quiet', '-m', 'Introduce a genuine unresolved Compose service dependency');
    const red = await executeWorkflowComposeConfigValidator(value.root, git(value.root, 'rev-parse', 'HEAD'));
    expect(red).toMatchObject({
      status: 'failed', code: 'validator-command', workloadExecution: true,
      command: { status: expect.any(Number), processTreeSettled: true },
      retainedExecutionDirectory: null, phaseProof: 'not-issued'
    });
    expect(red.command!.status).not.toBe(0);
    expect(JSON.stringify(red)).not.toContain('missing-service');
  });

  it('refuses changed uncommitted Compose source before running its configuration validator', async () => {
    const value = await fixture();
    await value.write(['compose.yml'], 'services:\n  app:\n    image: fixture.invalid/changed:source\n');
    expect(await executeWorkflowComposeConfigValidator(value.root, value.sourceSha))
      .toMatchObject({ status: 'failed', code: 'validator-source-mismatch', workloadExecution: false, command: null });
  });

  it('does not read a real untracked dotenv file or implicit Compose override into its closed configuration check', async () => {
    const value = await fixture();
    await value.write(['.env'], 'PRIVATE_FIXTURE_VALUE="unterminated\n');
    await value.write(['compose.override.yml'], 'services:\n  app:\n    depends_on:\n      - missing-implicit-service\n');
    const report = await executeWorkflowComposeConfigValidator(value.root, value.sourceSha);
    expect(report).toMatchObject({
      status: 'passed', workloadExecution: true, command: { status: 0, processTreeSettled: true },
      retainedExecutionDirectory: null, phaseProof: 'not-issued'
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_FIXTURE_VALUE');
  });

  it('does not admit the private Compose subcheck through public execution or accept a nonliteral source commit', async () => {
    const value = await fixture(), run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    try {
      // @ts-expect-error The public validator inventory deliberately excludes this private subcheck.
      await expect(executeWorkflowContextValidator(value.root, { validator: 'compose-config', sourceSha: value.sourceSha }))
        .rejects.toMatchObject({ code: 'validator-request' });
      await expect(executeWorkflowComposeConfigValidator(value.root, 'develop'))
        .rejects.toMatchObject({ code: 'validator-request' });
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it('refuses actual copied plugin drift after a successful settled configuration child without changing installed host programs', async () => {
    const value = await fixture(), planned = await planModernLocalRuntime(await inspectModernLocalRuntime(value.root));
    const check = planned.localPlan!.checks.find(candidate => candidate.id === 'compose-config')!;
    const observed = (await observeModernLocalTools(value.root, [check], [])).find(tool => tool.id === 'docker')!;
    const bundle = await mkdtemp(path.join(root, 'copied-compose-tools-'));
    await mkdir(path.join(bundle, 'bin'));
    await mkdir(path.join(bundle, 'cli-plugins'));
    const plugin = path.join(bundle, 'cli-plugins', 'docker-compose');
    await copyFile(observed.files[0]!.path, path.join(bundle, 'bin', 'docker'));
    await copyFile(observed.executablePath, plugin);
    vi.stubEnv('PATH', [path.join(bundle, 'bin'), process.env.PATH].join(path.delimiter));
    const original = NodeCommandRunner.prototype.run;
    let home = '', changed = false;
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
      const result = await original.call(this, command, options);
      if (command.executable === plugin && command.args.includes('config') && result.status === 0 &&
          result.processTreeSettled === true) {
        const actualHome = options?.env?.HOME;
        if (!actualHome) throw new Error('The actual configuration child has no private HOME.');
        home = actualHome;
        await appendFile(plugin, '\n');
        changed = true;
      }
      return result;
    });
    try {
      await expect(executeWorkflowComposeConfigValidator(value.root, value.sourceSha))
        .rejects.toThrow('Installed local tool bytes or physical identity changed.');
      expect(changed).toBe(true);
      expect(path.basename(home)).toMatch(/^liftoff-workflow-validator-/u);
      await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      run.mockRestore();
    }
  });

  it('formats every actual selected OpenTofu component through explicit captured-file commands only', async () => {
    const value = await fixture();
    const components = [...value.components.keys()].filter((id): id is WorkflowTofuFormatComponent => id.startsWith('opentofu-'));
    expect(components.length).toBeGreaterThan(0);
    const original = NodeCommandRunner.prototype.run;
    const commands: string[][] = [];
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(function (this: NodeCommandRunner, command, options) {
      if (command.args[0] === 'fmt') commands.push([...command.args]);
      return original.call(this, command, options);
    });
    try {
      for (const component of components) {
        expect(await executeWorkflowTofuComponentFormatValidator(value.root, value.sourceSha, component)).toMatchObject({
          validator: `tofu-format:${component}`, status: 'passed', workloadExecution: true,
          command: { status: 0, processTreeSettled: true }, retainedExecutionDirectory: null, phaseProof: 'not-issued'
        });
      }
      expect(commands).toEqual(components.map(() => ['fmt', '-check', '-write=false', './main.tf']));
    } finally { run.mockRestore(); }
  });

  it('uses the same real explicit formatter for formatted source and a genuinely unformatted committed HCL file', async () => {
    const value = await fixture(), component = 'opentofu-application';
    expect(await executeWorkflowTofuComponentFormatValidator(value.root, value.sourceSha, component))
      .toMatchObject({ status: 'passed', command: { status: 0, processTreeSettled: true } });
    const parts = [...value.components.get(component)!, 'main.tf'];
    const unformatted = 'locals {\n enabled    =    true\n}\n';
    await value.write(parts, unformatted);
    git(value.root, 'add', '--', parts.join('/'));
    git(value.root, 'commit', '--quiet', '-m', 'Introduce genuine HCL formatting drift');
    vi.stubEnv('TF_CLI_ARGS_fmt', '-write=true');
    const report = await executeWorkflowTofuComponentFormatValidator(value.root, git(value.root, 'rev-parse', 'HEAD'), component);
    expect(report).toMatchObject({
      status: 'failed', code: 'validator-command', workloadExecution: true,
      command: { status: expect.any(Number), processTreeSettled: true }, retainedExecutionDirectory: null, phaseProof: 'not-issued'
    });
    expect(report.command!.status).not.toBe(0);
    expect(await readFile(path.join(value.root, ...parts), 'utf8')).toBe(unformatted);
    expect(JSON.stringify(report)).not.toContain('enabled');
  });

  it('passes every captured nested .tf file as an explicit nonrecursive argument', async () => {
    const value = await fixture(), parts = value.components.get('opentofu-application')!;
    await value.write([...parts, 'nested', 'additional.tf'], 'locals {\n  additional = true\n}\n');
    git(value.root, 'add', '--', [...parts, 'nested', 'additional.tf'].join('/'));
    git(value.root, 'commit', '--quiet', '-m', 'Include another actual captured HCL input');
    const original = NodeCommandRunner.prototype.run;
    let actual: readonly string[] | undefined;
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(function (this: NodeCommandRunner, command, options) {
      if (command.args[0] === 'fmt') actual = [...command.args];
      return original.call(this, command, options);
    });
    try {
      expect(await executeWorkflowTofuComponentFormatValidator(value.root, git(value.root, 'rev-parse', 'HEAD'), 'opentofu-application'))
        .toMatchObject({ status: 'passed', command: { status: 0, processTreeSettled: true }, phaseProof: 'not-issued' });
      expect(actual).toEqual(['fmt', '-check', '-write=false', './main.tf', './nested/additional.tf']);
    } finally { run.mockRestore(); }
  });

  it('retains existing excluded-directory scope blockers instead of substituting an incomplete format check', async () => {
    const value = await fixture(), parts = value.components.get('opentofu-application')!;
    await value.write([...parts, 'nested', 'additional.tf'], 'locals {\n  additional = true\n}\n');
    git(value.root, 'add', '--', [...parts, 'nested', 'additional.tf'].join('/'));
    git(value.root, 'commit', '--quiet', '-m', 'Include another actual captured HCL input');
    await value.write([...parts, '.terraform', 'ignored.tf'], 'not valid HCL {{{\n');
    const planned = await planModernLocalRuntime(await inspectModernLocalRuntime(value.root));
    expect(planned.localPlan!.checks.find(check => check.id === 'tofu-format:opentofu-application'))
      .toMatchObject({
        status: 'blocked',
        reasons: ['Recursive OpenTofu format scope contains excluded inputs; Liftoff exclusions do not establish command-level ignore semantics.']
      });
    const original = NodeCommandRunner.prototype.run;
    let formatCalls = 0;
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(function (this: NodeCommandRunner, command, options) {
      if (command.args[0] === 'fmt') formatCalls++;
      return original.call(this, command, options);
    });
    try {
      expect(await executeWorkflowTofuComponentFormatValidator(value.root, git(value.root, 'rev-parse', 'HEAD'), 'opentofu-application'))
        .toMatchObject({ status: 'blocked', code: 'validator-inputs', workloadExecution: false, command: null, phaseProof: 'not-issued' });
      expect(formatCalls).toBe(0);
      expect(await readFile(path.join(value.root, ...parts, '.terraform', 'ignored.tf'), 'utf8')).toBe('not valid HCL {{{\n');
    } finally { run.mockRestore(); }
  });

  it('refuses uncommitted format input instead of formatting different bytes under an original commit', async () => {
    const value = await fixture();
    await value.write([...value.components.get('opentofu-application')!, 'main.tf'], 'locals {\n enabled    =    true\n}\n');
    expect(await executeWorkflowTofuComponentFormatValidator(value.root, value.sourceSha, 'opentofu-application'))
      .toMatchObject({ status: 'failed', code: 'validator-source-mismatch', workloadExecution: false, command: null });
  });

  it('cannot select the private formatter publicly or accept a nonliteral source or non-OpenTofu component', async () => {
    const value = await fixture(), run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    try {
      // @ts-expect-error The public selector inventory deliberately excludes component formatting.
      await expect(executeWorkflowContextValidator(value.root, { validator: 'tofu-format:opentofu-application', sourceSha: value.sourceSha }))
        .rejects.toMatchObject({ code: 'validator-request' });
      await expect(executeWorkflowTofuComponentFormatValidator(value.root, 'main', 'opentofu-application'))
        .rejects.toMatchObject({ code: 'validator-request' });
      // @ts-expect-error A backend component is not a finite OpenTofu component selector.
      await expect(executeWorkflowTofuComponentFormatValidator(value.root, value.sourceSha, 'backend'))
        .rejects.toMatchObject({ code: 'validator-format-component' });
      expect(run).not.toHaveBeenCalled();
    } finally { run.mockRestore(); }
  });

  it('retains unsupported component requests as blockers without executing an arbitrary cwd or command', async () => {
    const value = await fixture(), original = NodeCommandRunner.prototype.run;
    let formatCalls = 0;
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(function (this: NodeCommandRunner, command, options) {
      if (command.args[0] === 'fmt') formatCalls++;
      return original.call(this, command, options);
    });
    try {
      // @ts-expect-error Untrusted JavaScript cannot expand the actual selected component inventory.
      expect(await executeWorkflowTofuComponentFormatValidator(value.root, value.sourceSha, 'opentofu-../../outside'))
        .toMatchObject({ status: 'blocked', code: 'validator-inputs', workloadExecution: false, command: null });
      expect(formatCalls).toBe(0);
    } finally { run.mockRestore(); }
  });

  it('refuses copied formatter drift after a real successful settled child without modifying the host tool', async () => {
    const value = await fixture(), planned = await planModernLocalRuntime(await inspectModernLocalRuntime(value.root));
    const check = planned.localPlan!.checks.find(candidate => candidate.id === 'tofu-format:opentofu-application')!;
    const observed = (await observeModernLocalTools(value.root, [check], [])).find(tool => tool.id === 'tofu')!;
    const bin = await mkdtemp(path.join(root, 'copied-format-tool-')), executable = path.join(bin, 'tofu');
    await copyFile(observed.executablePath, executable);
    vi.stubEnv('PATH', [bin, process.env.PATH].join(path.delimiter));
    const original = NodeCommandRunner.prototype.run;
    let home = '', changed = false;
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
      const result = await original.call(this, command, options);
      if (command.executable === executable && command.args[0] === 'fmt' && result.status === 0 &&
          result.processTreeSettled === true) {
        const actualHome = options?.env?.HOME;
        if (!actualHome) throw new Error('The actual formatter child has no private HOME.');
        home = actualHome;
        await appendFile(executable, '\n');
        changed = true;
      }
      return result;
    });
    try {
      await expect(executeWorkflowTofuComponentFormatValidator(value.root, value.sourceSha, 'opentofu-application'))
        .rejects.toThrow('Installed local tool bytes or physical identity changed.');
      expect(changed).toBe(true);
      expect(path.basename(home)).toMatch(/^liftoff-workflow-validator-/u);
      await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { run.mockRestore(); }
  });
});

import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  executeWorkflowContextValidator, parseWorkflowContextValidatorArgs
} from '../src/workflow-context-validator.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';

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
  async function fixture(testSource = '', frontend = false, workflow: 'manual' | 'spec-kit' = 'manual') {
    const projectRoot = await mkdtemp(path.join(root, 'project-'));
    const seed = await writeModernInstalledProject(projectRoot, workflow, 'single-maintainer-gitflow', { frontend });
    const source = resolveModernManifestV8SourceContract({ selection: seed.input.selection, recordedPlugins: seed.input.plugins });
    const components = new Map(source.layoutDescriptor.components.map(component => [component, ['source', component.replace(':', '-')]]));
    const value = await writeModernInstalledProject(projectRoot, workflow, 'single-maintainer-gitflow', {
      frontend,
      activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
        ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
        { kind: 'artifact', logicalName: 'docker-compose', pathParts: ['compose.yml'] }
      ] }
    });
    await writeModernLocalFixtureInputs(value.input.selection, components, ['compose.yml'], value.write);
    const backend = components.get('backend')!;
    await value.write([...backend, 'source.js'], 'export function double(value) { return value * 2; }\n');
    await value.write([...backend, 'unused.js'], 'export const selectedSource = "committed application input";\n');
    await value.write([...backend, 'tests', 'source.test.js'], [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { double } from "../source.js";',
      'test("the real function doubles its input", () => { assert.equal(double(3), 6); });',
      testSource
    ].join('\n'));
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

  it('refuses a different commit before running project code', async () => {
    const value = await fixture();
    const report = await executeWorkflowContextValidator(value.root, { validator: 'backend-tests', sourceSha: 'a'.repeat(40) });
    expect(report).toMatchObject({ status: 'failed', code: 'validator-source-binding', workloadExecution: false, command: null });
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
});

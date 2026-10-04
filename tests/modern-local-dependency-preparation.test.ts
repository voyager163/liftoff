import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { buildArtifacts } from '../src/templates.js';
import type { ApiStackId, ManifestLayoutComponentId } from '../src/domain/project/contracts.js';
import type { ApplicationPreparationRequest } from '../src/application/repair/application-preparation-types.js';
import { prepareModernLocalExecution, approveModernLocalExecution, inspectModernLocalExecution, captureLocalExecutionPreviewRuntime } from '../src/application/governance/modern-local-approval.js';
import { executeModernLocalExecution } from '../src/application/governance/modern-local-execution.js';
import { inspectModernLocalRuntime, planModernLocalRuntime } from '../src/application/governance/modern-local-inputs.js';
import { createLocalExecutionRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { modernLocalBounds, modernLocalRequiredInputClosurePolicy } from '../src/domain/governance/activation/modern-local-inputs.js';
import { localExecutionDigest, type LocalExecutionPreview } from '../src/domain/governance/activation/modern-local-runtime.js';
import { hclComputationPolicy } from '../src/adapters/hcl/parser-child.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';

const requested = process.env.LIFTOFF_MODERN_PREPARATION_NATIVE === '1';
const qualified = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.21.0';
if (process.env.LIFTOFF_MODERN_PREPARATION_NATIVE !== undefined &&
    !['0', '1'].includes(process.env.LIFTOFF_MODERN_PREPARATION_NATIVE)) throw new Error('Invalid native preparation selection.');
if (requested && !qualified) throw new Error('Modern native preparation requires the qualified macOS ARM64/Node 24.21.0 host.');
const nativeIt = it.skipIf(!requested);
const executed: string[] = [];
const roots: { root: string; dev: number; ino: number }[] = [];
beforeEach(({ task }) => { executed.push(task.name); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owned of roots.splice(0)) {
    const actual = await lstat(owned.root);
    expect(actual.isDirectory() && !actual.isSymbolicLink()).toBe(true);
    expect([actual.dev, actual.ino]).toEqual([owned.dev, owned.ino]);
    await rm(owned.root, { recursive: true });
  }
});
afterAll(() => {
  if (requested) expect(executed).toHaveLength(13);
  console.info('MODERN_DEPENDENCY_PREPARATION_INVENTORY ' + JSON.stringify({
    requested, qualified, executed,
    claim: requested ? 'Actual owned fixture execution on the selected native host; no other-host qualification.' :
      'Native dependency network execution unrun; explicit selection required.'
  }));
});
const scopes = {
  projectCode: true as const, hostCapabilitiesAcknowledged: true as const,
  dependencyPreparation: true, dependencyNetwork: true,
  workflowFinalization: false as const, publishLocalRecords: false as const
};

async function fixture(stack: ApiStackId = 'node-fastify', network = true, frontend = false,
  python: { generated?: boolean; rootBinding?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'modern prepared source ')));
  const identity = await lstat(directory);
  roots.push({ root: directory, dev: identity.dev, ino: identity.ino });
  const root = path.join(directory, 'Project Space');
  await mkdir(root);
  const initial = await writeModernInstalledProject(root, 'manual', 'none', { apiStack: stack, frontend });
  const source = resolveModernManifestV8SourceContract({ selection: initial.input.selection, recordedPlugins: initial.input.plugins });
  const components = new Map<ManifestLayoutComponentId, readonly string[]>(
    source.layoutDescriptor.components.map(component => [component,
      component === 'backend' && python.rootBinding ? ['backend'] : ['Source Space', component.replace(':', ' ')]])
  );
  const compose = ['compose.yml'];
  const f = await writeModernInstalledProject(root, 'manual', 'none', {
    apiStack: stack, frontend, activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
      ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts: [...pathParts] })),
      { kind: 'artifact', logicalName: 'docker-compose', pathParts: compose }
    ] }
  });
  await writeModernLocalFixtureInputs(f.input.selection, components, compose, f.write);
  const backend = components.get('backend');
  if (!backend) throw new Error('Preparation fixture requires an actual selected backend.');
  const plan = buildProjectPlan({
    projectName: 'prepared-custom-application', projectType: 'standard', apiStack: stack,
    includeFrontend: frontend, cloud: 'azure', region: 'eastus', environments: ['dev'],
    specWorkflow: 'openspec', agents: ['github-copilot'], governanceProfile: 'none'
  }, { requireProjectName: true });
  let generatedPythonConfig: string | undefined;
  for (const artifact of buildArtifacts(plan)) {
    if (artifact.lifecycle === 'project' && ['backend', 'frontend'].includes(artifact.pathParts[0])) {
      const component = artifact.pathParts[0] === 'backend' ? backend : components.get('frontend');
      if (!component) throw new Error('Generated component must be selected in the fixture layout.');
      if (stack === 'python-fastapi' && artifact.pathParts[0] === 'backend') {
        if (!python.generated && (artifact.pathParts.length !== 2 || !['pyproject.toml', 'uv.lock'].includes(artifact.pathParts[1]))) continue;
        if (artifact.pathParts.length === 2 && artifact.pathParts[1] === 'pyproject.toml') {
          generatedPythonConfig = artifact.content;
          expect(generatedPythonConfig).toContain('pythonpath = [".."]');
          if (!python.generated) {
            await f.write([...component, 'pyproject.toml'], generatedPythonConfig.replace('pythonpath = [".."]', 'pythonpath = ["."]'));
            continue;
          }
        }
      }
      await f.write([...component, ...artifact.pathParts.slice(1)], artifact.content);
    }
  }
  if (stack === 'python-fastapi' && !python.generated) {
    await f.write([...backend, 'confined_app.py'],
      'from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/ready")\ndef ready():\n    return {"ready": True}\n');
    await f.write([...backend, 'tests', 'test_dependencies.py'],
      'from fastapi.testclient import TestClient\nfrom confined_app import app\n\ndef test_real_prepared_dependencies():\n    response = TestClient(app).get("/ready")\n    assert response.status_code == 200\n    assert response.json() == {"ready": True}\n');
  }
  if (stack === 'python-fastapi' && python.generated) {
    await f.write([...backend, 'tests', 'conftest.py'],
      'import os\n\nos.environ["DATABASE_URL"] = "postgresql://127.0.0.1:1/liftoff-test"\n' +
      'os.environ["REDIS_URL"] = "redis://127.0.0.1:1/0"\n');
  }
  const preparation: ApplicationPreparationRequest = {
    provider: stack === 'node-fastify' ? 'npm-ci' : stack === 'python-fastapi' ? 'uv-locked-sync' : 'go-mod-download',
    version: 1, cwdPathParts: [...backend],
    packageSource: stack === 'node-fastify' ? 'npmjs' : stack === 'python-fastapi' ? 'pypi' : 'go-proxy',
    network, lifecycle: 'disabled'
  };
  const preparationRequests = [preparation];
  if (frontend) preparationRequests.push({
    provider: 'npm-ci', version: 1, cwdPathParts: [...components.get('frontend')!],
    packageSource: 'npmjs', network, lifecycle: 'disabled'
  });
  return { ...f, backend, preparation, preparationRequests, generatedPythonConfig };
}

async function capturedSource(root: string) {
  const inspection = await inspectModernLocalRuntime(root);
  if (inspection.status !== 'observed' || inspection.local.status !== 'modern-observed') {
    throw new Error('Expected complete actual fixture source observation.');
  }
  return inspection.local.snapshot.files;
}

function captureBackendOutput(preview: LocalExecutionPreview): string[] {
  const check = preview.checks.find(check => check.id === 'backend-tests');
  const tool = preview.tools.find(tool => tool.id === check?.command?.executable);
  if (!tool || !check?.command) throw new Error('Expected the exact approved backend check command.');
  const approved = JSON.stringify([tool.executablePath, [...tool.prefixArgs, ...check.command.args]]);
  const execute = NodeCommandRunner.prototype.run, output: string[] = [];
  vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
    const result = await execute.call(this, command, options);
    if (JSON.stringify([command.executable, command.args]) === approved) output.push(result.stdout + result.stderr);
    return result;
  });
  return output;
}

describe('actual modern locked dependency preparation', () => {
  nativeIt.each([
    ['node-fastify', false], ['node-fastify', true], ['python-fastapi', false], ['go-huma', false]
  ] as const)(
    'prepares real %s dependency locks with frontend %s and verifies the declared bounded source', async (stack, frontend) => {
      const f = await fixture(stack, true, frontend), before = await capturedSource(f.root);
      const preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: f.preparationRequests });
      await approveModernLocalExecution(f.root, preview.fingerprint, scopes);
      const execute = NodeCommandRunner.prototype.run;
      const checkEnvironments: NodeJS.ProcessEnv[] = [];
      const checkCommands = preview.checks.filter(check =>
        check.status !== 'inapplicable' && ['backend-tests', 'frontend-build'].includes(check.id)
      ).map(check => {
        const tool = preview.tools.find(tool => tool.id === check.command?.executable);
        if (!tool || !check.command) throw new Error('Expected the exact approved project check command.');
        return JSON.stringify([tool.executablePath, [...tool.prefixArgs, ...check.command.args]]);
      });
      expect(checkCommands).toHaveLength(frontend ? 2 : 1);
      vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
        // uv preparation also contains "--extra test"; only the full approved check argv identifies a check.
        if (checkCommands.includes(JSON.stringify([command.executable, command.args]))) checkEnvironments.push({ ...options?.env });
        return execute.call(this, command, options);
      });
      const result = await executeModernLocalExecution(f.root, preview.fingerprint);
      expect(result.status, JSON.stringify(result)).toBe('checks-verified');
      expect(result.complete).toBe(true);
      expect(result.preparation.length).toBe(stack === 'python-fastapi' || frontend ? 2 : 1);
      expect(result.preparation.every(command => command.status === 'passed' && command.processTreeSettled)).toBe(true);
      expect(checkEnvironments).toHaveLength(checkCommands.length);
      for (const env of checkEnvironments) expect(env).toMatchObject({
        LIFTOFF_APPLICATION_NETWORK: 'not-authorized', PIP_NO_INDEX: '1', UV_OFFLINE: '1',
        npm_config_offline: 'true', GOPROXY: 'off', GOSUMDB: 'off'
      });
      expect(result.cleanupComplete).toBe(true);
      expect(result.retainedWorkspace).toBeNull();
      expect(await capturedSource(f.root)).toEqual(before);
      expect((await inspectModernLocalExecution(f.root, preview.fingerprint)).result).toEqual(result);
      for (const request of f.preparationRequests) {
        for (const name of ['node_modules', '.venv', 'dist']) {
          await expect(lstat(path.join(f.root, ...request.cwdPathParts, name))).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
      await expect(lstat(path.join(f.root, '.liftoff', 'local-completion.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }, 660_000
  );

  nativeIt.each([false, true])('verifies unchanged generated Python package imports with root binding %s', async rootBinding => {
    const f = await fixture('python-fastapi', true, false, { generated: true, rootBinding });
    const before = await capturedSource(f.root);
    expect(await readFile(path.join(f.root, ...f.backend, 'pyproject.toml'), 'utf8')).toBe(f.generatedPythonConfig);
    const preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: f.preparationRequests });
    await approveModernLocalExecution(f.root, preview.fingerprint, scopes);
    const output = captureBackendOutput(preview);
    const result = await executeModernLocalExecution(f.root, preview.fingerprint);
    expect(result.status, JSON.stringify(result) + '\n' + output.join('\n')).toBe('checks-verified');
    expect(output).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.preparation).toHaveLength(2);
    expect(result.preparation.every(command => command.status === 'passed' && command.processTreeSettled)).toBe(true);
    expect(result.checks.find(check => check.id === 'backend-tests')).toMatchObject({ status: 'passed', processTreeSettled: true });
    expect(result.cleanupComplete).toBe(true);
    expect(result.retainedWorkspace).toBeNull();
    expect(await capturedSource(f.root)).toEqual(before);
    expect((await inspectModernLocalExecution(f.root, preview.fingerprint)).result).toEqual(result);
    await expect(lstat(path.join(f.root, ...f.backend, '.venv'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(f.root, '.liftoff', 'local-completion.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 660_000);

  nativeIt('does not copy or silently qualify a Python import from an unselected sibling', async () => {
    const f = await fixture('python-fastapi', true, false, { generated: true });
    const sibling = [...f.backend.slice(0, -1), 'unselected_sibling.py'];
    await f.write(sibling, 'value = 17\n');
    await f.write([...f.backend, 'tests', 'test_unselected.py'], 'from unselected_sibling import value\n\ndef test_sibling():\n    assert value == 17\n');
    const before = await capturedSource(f.root);
    expect(before.some(file => file.pathParts.join('/') === sibling.join('/'))).toBe(false);
    const preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: f.preparationRequests });
    await approveModernLocalExecution(f.root, preview.fingerprint, scopes);
    const output = captureBackendOutput(preview);
    const result = await executeModernLocalExecution(f.root, preview.fingerprint);
    expect(result.complete).toBe(false);
    expect(result.preparation.every(command => command.status === 'passed' && command.processTreeSettled)).toBe(true);
    expect(result.checks.find(check => check.id === 'backend-tests')).toMatchObject({ status: 'failed', code: 'nonzero-exit' });
    expect(output).toHaveLength(1);
    expect(output.join('\n')).toContain("No module named 'unselected_sibling'");
    expect(result.cleanupComplete).toBe(true);
    expect(await capturedSource(f.root)).toEqual(before);
    expect(await readFile(path.join(f.root, ...sibling), 'utf8')).toBe('value = 17\n');
  }, 660_000);

  nativeIt('refuses a saved prior-policy recipe and its genuine consent before an execution claim', async () => {
    const f = await fixture('python-fastapi'), before = await capturedSource(f.root);
    const preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: f.preparationRequests });
    const { plan } = await captureLocalExecutionPreviewRuntime(f.root, preview);
    if (!plan.localPlan) throw new Error('Expected the actual complete recipe.');
    const { pythonPackageSearchPaths: _namespace, ...priorPolicy } = modernLocalRequiredInputClosurePolicy;
    const recipe = {
      kind: 'liftoff-local-recipe-values', schemaVersion: 1, inputBounds: modernLocalBounds,
      computationPolicy: hclComputationPolicy, requiredInputClosurePolicy: { ...priorPolicy, revision: 2 },
      policy: { installedToolIdentity: 'not-observed', projectCode: 'requires-separate-authorization',
        preparation: 'never-implicit', network: 'not-isolated-by-offline-flags', stateAndHistoryExecutionPreflight: 'requires-mr2' },
      checks: plan.localPlan.checks
    };
    expect(canonicalSha256({ ...recipe, requiredInputClosurePolicy: modernLocalRequiredInputClosurePolicy })).toBe(preview.recipeDigest);
    const recipeDigest = canonicalSha256(recipe);
    expect(recipeDigest).not.toBe(preview.recipeDigest);
    const { fingerprint: _current, ...body } = preview;
    const prior = { ...body, recipeDigest, fingerprint: localExecutionDigest({ ...body, recipeDigest }) };
    const store = createLocalExecutionRecordStore(f.root);
    await store.write('preview', prior.fingerprint, prior);
    await approveModernLocalExecution(f.root, prior.fingerprint, scopes);
    const runner = vi.spyOn(NodeCommandRunner.prototype, 'run');
    await expect(executeModernLocalExecution(f.root, prior.fingerprint)).rejects.toThrow(/complete recipes changed/);
    expect(runner).not.toHaveBeenCalled();
    expect(await store.readState(prior.fingerprint)).toBeNull();
    expect(await capturedSource(f.root)).toEqual(before);
  });

  nativeIt('keeps recursive Python test inputs outside selected roots blocked despite the parent search namespace', async () => {
    const f = await fixture('python-fastapi');
    if (!f.generatedPythonConfig) throw new Error('Expected the unmodified generated Python configuration.');
    expect(f.generatedPythonConfig).toContain('testpaths = ["tests"]');
    const unsupported = f.generatedPythonConfig.replace('testpaths = ["tests"]', 'testpaths = [".."]');
    await f.write([...f.backend, 'pyproject.toml'], unsupported);
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    const plan = await planModernLocalRuntime(await inspectModernLocalRuntime(f.root));
    expect(plan.status).toBe('blocked');
    expect(plan.localPlan?.checks.find(check => check.id === 'backend-tests')?.reasons.join(' ')).toContain('reference escapes the explicitly selected input roots');
    await expect(prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [f.preparation] })).rejects.toThrow(/unblocked runtime plan/);
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.root, ...f.backend, 'pyproject.toml'), 'utf8')).toBe(unsupported);
  }, 60_000);

  nativeIt('rejects missing network consent before creating an execution claim or running a command', async () => {
    const f = await fixture(), preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [f.preparation] });
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    await expect(approveModernLocalExecution(f.root, preview.fingerprint, { ...scopes, dependencyNetwork: false })).rejects.toThrow(/separate/);
    await expect(executeModernLocalExecution(f.root, preview.fingerprint)).rejects.toThrow(/consent/i);
    expect(run).not.toHaveBeenCalled();
    expect(await inspectModernLocalExecution(f.root, preview.fingerprint)).toMatchObject({ status: 'absent' });
  }, 60_000);

  nativeIt('reports a real fresh-cache offline failure without a network fallback or project checks', async () => {
    const f = await fixture('node-fastify', false), before = await capturedSource(f.root);
    const preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [f.preparation] });
    await approveModernLocalExecution(f.root, preview.fingerprint, { ...scopes, dependencyNetwork: false });
    const result = await executeModernLocalExecution(f.root, preview.fingerprint);
    expect(result.status).toBe('failed');
    expect(result.complete).toBe(false);
    expect(result.preparation).toHaveLength(1);
    expect(result.preparation[0]).toMatchObject({ status: 'failed', code: 'nonzero-exit', processTreeSettled: true });
    expect(result.checks.every(check => check.status === 'blocked' || check.status === 'inapplicable')).toBe(true);
    expect(result.cleanupComplete).toBe(true);
    expect(await capturedSource(f.root)).toEqual(before);
  }, 240_000);

  nativeIt('preserves changed original source and refuses the stale consent before effects', async () => {
    const f = await fixture(), preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [f.preparation] });
    await approveModernLocalExecution(f.root, preview.fingerprint, scopes);
    const parts = [...f.backend, 'new-source.txt'];
    await f.write(parts, 'Concurrent project change.\n');
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    await expect(executeModernLocalExecution(f.root, preview.fingerprint)).rejects.toThrow(/changed/);
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.root, ...parts), 'utf8')).toBe('Concurrent project change.\n');
    expect(await inspectModernLocalExecution(f.root, preview.fingerprint)).toMatchObject({ status: 'absent' });
  }, 60_000);

  nativeIt('retains actual completed preparation when a later original-source change prevents checks', async () => {
    const f = await fixture(), preview = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [f.preparation] });
    await approveModernLocalExecution(f.root, preview.fingerprint, scopes);
    const execute = NodeCommandRunner.prototype.run;
    let changed = false;
    const parts = [...f.backend, 'concurrent-source.txt'];
    vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
      const result = await execute.call(this, command, options);
      if (!changed && command.args.includes('ci') && result.status === 0) {
        changed = true;
        await f.write(parts, 'Preserve the later original edit.\n');
      }
      return result;
    });
    const result = await executeModernLocalExecution(f.root, preview.fingerprint);
    expect(changed).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.inputsUnchanged).toBe(false);
    expect(result.preparation[0]).toMatchObject({ status: 'passed', processTreeSettled: true });
    expect(result.checks.every(check => check.status === 'blocked' || check.status === 'inapplicable')).toBe(true);
    expect(result.cleanupComplete).toBe(true);
    expect(await readFile(path.join(f.root, ...parts), 'utf8')).toBe('Preserve the later original edit.\n');
  }, 240_000);
});

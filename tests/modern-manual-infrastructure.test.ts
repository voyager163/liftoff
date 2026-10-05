import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  manualInfrastructureEnvironment, manualInfrastructurePolicy, validateManualInfrastructureInputs,
  manualInfrastructureOutputPaths, validateManualInfrastructureOutput,
  type ManualInfrastructureInputs, type ManualInfrastructureOutput
} from '../src/domain/governance/activation/modern-manual-infrastructure.js';
import { runSettledFixtureCommand } from './fixtures/settled-command.js';
import {
  manualInfrastructureWireInput as input, manualInfrastructureWireOutput as syntheticOutput
} from './fixtures/modern-manual-records.js';
import { deriveManualInfrastructureInputs } from '../src/application/governance/modern-manual-infrastructure.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { modernLocalBounds, rawLocalDigest, type ModernLocalFile } from '../src/domain/governance/activation/modern-local-inputs.js';
import { parseIsolatedHcl } from '../src/adapters/hcl/isolated-parser.js';
import { createManualInfrastructureEnvironment } from '../src/application/governance/modern-manual-preparation.js';
import { createApplicationEnvironment } from '../src/application/repair/application-environment.js';
import { observeModernLocalTools, assertModernLocalToolsCurrent } from '../src/adapters/process/modern-local-tools.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { writeArtifacts } from '../src/file-system.js';
import { modernLocalInputExclusion } from '../src/domain/governance/activation/modern-local-exclusions.js';
import * as boundFiles from '../src/adapters/filesystem/bound-project-files.js';

const lane = process.env.LIFTOFF_HCL_TEST_LANE ?? 'auto';
if (!['auto', 'portable', 'native'].includes(lane)) throw new Error('Unknown Manual infrastructure qualification lane.');
const qualified = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.21.0';
if (lane === 'native' && !qualified) throw new Error('Native infrastructure parsing requires the qualified runtime.');
const nativeIt = it.skipIf(lane === 'portable' || !qualified);
const providerLane = process.env.LIFTOFF_MANUAL_PROVIDER_TEST_LANE ?? 'off';
if (!['off', 'native'].includes(providerLane) || providerLane === 'native' && (!qualified || lane === 'portable')) {
  throw new Error('Native provider diagnostics require the explicit qualified native lane.');
}
const providerIt = it.skipIf(providerLane !== 'native');
const reader = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });

function capturedFile(parts: readonly string[], text: string): ModernLocalFile {
  return { pathParts: [...parts], scope: 'application', content: Buffer.from(text).toString('base64'),
    mode: 0o600, bytes: Buffer.byteLength(text), digest: rawLocalDigest(text) };
}
function generated(workload: object, environments: readonly string[] = ['dev', 'staging', 'prod']) {
  const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
    ...workload, projectName: 'Manual Infrastructure', specWorkflow: 'manual', agents: [],
    governanceProfile: 'none', includeFrontend: true, environments: [...environments]
  }, { requireProjectName: true }));
  const manifest = reader.parseManifestV8(JSON.parse(artifacts.find(artifact => artifact.pathParts.join('/') === 'liftoff.manifest.json')!.content));
  const files = new Map(artifacts.map(artifact => [artifact.pathParts.join('/'), capturedFile(artifact.pathParts, artifact.content)]));
  return { manifest, files, artifacts };
}
async function parsedFiles(files: ReadonlyMap<string, ModernLocalFile>) {
  const hcl = [...files].filter(([filename]) => filename.endsWith('.tf'));
  const parsed = await parseIsolatedHcl(hcl.map(([, file]) => Buffer.from(file.content!, 'base64').toString('utf8')));
  return new Map(hcl.map(([name], index) => [name, parsed[index]!]));
}

describe('Manual output wire-format validation, not native qualification', () => {
  function validate(value: ManualInfrastructureOutput) {
    return validateManualInfrastructureOutput(value, input(), 'a'.repeat(64), 'b'.repeat(64), path.resolve('workspace'));
  }
  it('copies only a complete bounded shape without granting approval or completion', () => {
    const value = syntheticOutput(), result = validate(value);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(result).not.toHaveProperty('complete');
    expect(result).not.toHaveProperty('approved');
  });
  it('rejects disconnected source, tool, environment, root and incomplete output inventories', () => {
    const value = syntheticOutput();
    for (const bad of [
      { ...value, sourceDigest: 'd'.repeat(64) }, { ...value, toolDigest: 'd'.repeat(64) },
      { ...value, inputDigest: 'd'.repeat(64) }, { ...value, environmentDigest: 'd'.repeat(64) },
      { ...value, component: 'unmapped' }, { ...value, dataPathParts: ['cache', 'unmapped'] },
      { ...value, entries: value.entries.slice(1) }, { ...value, outputDigest: 'd'.repeat(64) }
    ]) expect(() => validate(bad)).toThrow();
  });
  it.each(['duplicate', 'unlisted', 'writable', 'hardlink', 'foreign-owner', 'empty-index', 'oversized-index', 'empty-binary'] as const)(
    'rejects %s metadata even with a recomputed inventory digest', change => {
      const value = syntheticOutput();
      const index = value.entries.findIndex(entry => change === 'empty-binary'
        ? entry.pathParts.at(-1) === manualInfrastructurePolicy.providerBinary : entry.pathParts.join('/') === 'modules/modules.json');
      const entries = value.entries.map(entry => ({ ...entry, pathParts: [...entry.pathParts] }));
      const entry = entries[index]!, physical = entry.physical.split(':');
      if (change === 'duplicate') entry.pathParts = [];
      if (change === 'unlisted') entry.pathParts = ['unlisted'];
      if (change === 'writable') { entry.mode = 0o666; physical[2] = String(0o100666); }
      if (change === 'hardlink') physical[3] = '2';
      if (change === 'foreign-owner') physical[5] = '2';
      if (change === 'empty-index' || change === 'empty-binary' || change === 'oversized-index') {
        entry.bytes = change === 'oversized-index' ? manualInfrastructurePolicy.moduleIndexBytes + 1 : 0;
        physical[4] = String(entry.bytes);
      }
      entry.physical = physical.join(':');
      expect(() => validate({ ...value, entries, outputDigest: canonicalSha256(entries) })).toThrow();
    }
  );
});

describe('owned Manual output rejection without provider execution', () => {
  async function controls() {
    const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-manual-control-negative-')));
    await mkdir(path.join(workspace, 'cache'), { mode: 0o700 });
    await mkdir(path.join(workspace, 'scratch'), { mode: 0o700 });
    const source = input(), control = await createManualInfrastructureEnvironment(workspace, source);
    return { workspace, control, source, component: source.roots[0]!.component,
      data: path.join(workspace, ...source.roots[0]!.dataPathParts) };
  }
  nativeIt.each(['configuration', 'replaced-root', 'extra-control', 'dirty-root', 'unknown-file', 'link',
    'hardlink', 'writable-file', 'oversized-file'] as const)('rejects %s before reading any provider-output payload', async change => {
    const fixture = await controls(), digest = vi.spyOn(boundFiles, 'readBoundProjectFileDigest');
    try {
      if (change === 'configuration') await writeFile(path.join(fixture.workspace, 'cache', 'manual-init', 'tofu.rc'), 'changed');
      else if (change === 'replaced-root') {
        await rename(fixture.data, path.join(fixture.workspace, 'replaced-data'));
        await mkdir(fixture.data, { mode: 0o700 });
      } else if (change === 'extra-control') await writeFile(path.join(fixture.workspace, 'cache', 'manual-init', 'unexpected'), '');
      else if (change === 'dirty-root' || change === 'unknown-file') await writeFile(path.join(fixture.data, 'unknown'), 'unread');
      else {
        await mkdir(path.join(fixture.data, 'modules'));
        const filename = path.join(fixture.data, 'modules', 'modules.json');
        const outside = path.join(fixture.workspace, 'owned-unread-target');
        if (change === 'link' || change === 'hardlink') {
          await writeFile(outside, 'unread');
          if (change === 'link') await symlink(outside, filename);
          else await link(outside, filename);
        } else {
          await writeFile(filename, 'unread', { mode: 0o600 });
          if (change === 'writable-file') await chmod(filename, 0o666);
          else await truncate(filename, manualInfrastructurePolicy.outputBytes + 1);
        }
      }
      const operation = ['configuration', 'replaced-root', 'extra-control'].includes(change) ? fixture.control.assertControls()
        : change === 'dirty-root' ? fixture.control.assertFresh(fixture.component)
        : fixture.control.capture(fixture.component, 'a'.repeat(64), 'b'.repeat(64));
      await expect(operation).rejects.toThrow();
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
      await rm(fixture.workspace, { recursive: true });
    }
  });
  nativeIt.each(['native-header', 'invalid-json', 'wrong-module-graph'] as const)(
    'rejects synthetic %s output without producing an initialization receipt', async change => {
      const fixture = await controls();
      try {
        for (const [name, kind] of manualInfrastructureOutputPaths()) {
          if (!name) continue;
          const target = path.join(fixture.data, ...name.split('/'));
          if (kind === 'directory') { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const binary = name.endsWith(`/${manualInfrastructurePolicy.providerBinary}`);
          const content = name === 'modules/modules.json' ? Buffer.from(change === 'invalid-json' ? '{' : '{"Modules":[]}')
            : binary ? Buffer.from(change === 'native-header' ? '0000000000000000' : 'cffaedfe0c000001', 'hex') : Buffer.alloc(0);
          await writeFile(target, content, { mode: binary ? 0o700 : 0o600 });
        }
        await expect(fixture.control.capture(fixture.component, 'a'.repeat(64), 'b'.repeat(64)))
          .rejects.toThrow(change === 'native-header' ? /executable format/ : change === 'invalid-json' ? /valid JSON/ : /application graph/);
      } finally { await rm(fixture.workspace, { recursive: true }); }
    }
  );
});

describe('separately identified Manual infrastructure input contract', () => {
  it('copies bounded source mappings without granting execution or modifying caller data', () => {
    const source = input(), parsed = validateManualInfrastructureInputs(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed.roots).not.toBe(source.roots);
    expect(parsed).not.toHaveProperty('approved');
  });

  it('uses a short relative path to the same owned scratch directory even under a long workspace', () => {
    const source = input(), workspace = path.resolve('long-workspace-segment-'.repeat(9));
    const environment = manualInfrastructureEnvironment(workspace, source, source.roots[0]!.component);
    expect(environment.TMPDIR).toBe('../../../../../../scratch');
    expect(Buffer.byteLength(environment.TMPDIR!)).toBeLessThanOrEqual(manualInfrastructurePolicy.temporaryDirectoryBytes);
    expect(path.resolve(workspace, 'project', ...source.roots[0]!.cwdPathParts, environment.TMPDIR!)).toBe(path.join(workspace, 'scratch'));
    expect(environment.TF_DATA_DIR).toBe(path.join(workspace, 'cache', 'manual-init', '0'));
    expect(environment.TF_CLI_CONFIG_FILE).toBe(path.join(workspace, 'cache', 'manual-init', 'tofu.rc'));
    expect(manualInfrastructurePolicy.initArgs).toEqual(['init', '-backend=false', '-input=false', '-no-color', '-lockfile=readonly']);
  });

  it('rejects stale policy, disconnected module, aliased roots and unbound cache/lock paths', () => {
    const source = input(), root = source.roots[0]!;
    const invalid: ManualInfrastructureInputs[] = [
      { ...source, policyDigest: 'b'.repeat(64) },
      { ...source, roots: [] },
      { ...source, roots: [root, { ...root, dataPathParts: ['cache', 'manual-init', '1'] }] },
      { ...source, roots: [{ ...root, dataPathParts: ['cache', 'borrowed'] }] },
      { ...source, roots: [{ ...root, lockPathParts: [...root.cwdPathParts, 'other.lock'] }] },
      { ...source, roots: [{ ...root, lockDigest: 'invalid' }] },
      { ...source, roots: [{ ...root, module: { ...root.module, source: 'https://example.invalid/module' } }] },
      { ...source, roots: [{ ...root, module: { ...root.module, pathParts: ['other'] } }] },
      { ...source, roots: [{ ...root, module: { ...root.module, key: '../escape' } }] }
    ];
    for (const value of invalid) expect(() => validateManualInfrastructureInputs(value)).toThrow();
  });

  it('rejects accessors before reading values and cannot select an unmapped command cwd', () => {
    const getter = vi.fn(), bad = Object.defineProperty({ ...input() }, 'roots', { enumerable: true, get: getter });
    expect(() => validateManualInfrastructureInputs(bad)).toThrow(/accessors/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => manualInfrastructureEnvironment('relative-workspace', input(), 'opentofu-environment:dev')).toThrow(/canonical/);
    expect(() => manualInfrastructureEnvironment(path.resolve('workspace'), input(), 'unapproved')).toThrow(/mapping/);
  });

  it('enforces the exact socket-parent bound during input admission, before allocating execution storage', () => {
    function deep(depth: number): ManualInfrastructureInputs {
      const source = input(), root = source.roots[0]!, cwdPathParts = Array.from({ length: depth }, (_, index) => `level-${index}`);
      return { ...source, roots: [{ ...root, cwdPathParts, lockPathParts: [...cwdPathParts, '.terraform.lock.hcl'],
        module: { ...root.module, source: path.posix.relative(cwdPathParts.join('/'), source.modulePathParts.join('/')) } }] };
    }
    const admitted = deep(modernLocalBounds.depth - 1);
    const environment = manualInfrastructureEnvironment(path.resolve('workspace'), admitted, admitted.roots[0]!.component);
    expect(Buffer.byteLength(environment.TMPDIR!)).toBe(manualInfrastructurePolicy.temporaryDirectoryBytes);
    expect(() => validateManualInfrastructureInputs(deep(modernLocalBounds.depth))).toThrow(/socket-parent bound/);
  });
});

describe('captured generated Manual provider and module relationships', () => {
  nativeIt.each([
    { projectType: 'standard', apiStack: 'node-fastify' },
    { projectType: 'standard', apiStack: 'python-fastapi' },
    { projectType: 'standard', apiStack: 'go-huma' },
    ...projectCatalog.patterns.map(pattern => ({ projectType: 'genai', pattern: pattern.id }))
  ])('binds actual generated locks and one application module from every selected environment for %j', async workload => {
    const { manifest, files } = generated(workload);
    const before = canonicalSha256([...files]);
    const result = deriveManualInfrastructureInputs(manifest, files, await parsedFiles(files));
    expect(result.roots).toHaveLength(3);
    expect(result.roots.map(root => root.component)).toEqual(
      manifest.project.workload.environments.map(id => `opentofu-environment:${id}`));
    expect(result.roots.every(root => root.module.key === 'application' && root.module.source === '../../modules/application')).toBe(true);
    expect(canonicalSha256([...files])).toBe(before);
    expect(result).not.toHaveProperty('approved');
  }, 30_000);

  nativeIt.each([
    ['changed lock', 'provider-lock', 'provider "registry.opentofu.org/hashicorp/azurerm" { version = "9.0.0" }\n', /qualified packaged baseline/],
    ['provider credentials', 'providers', 'provider "azurerm" {\n features {}\n client_secret = "not-a-real-credential"\n}\n', /qualified packaged baseline/],
    ['remote module', 'main', 'module "application" { source = "https://example.invalid/module" }\n', /resolve exactly/],
    ['unreferenced application', 'main', 'locals { unused = true }\n', /actual local module reference/],
    ['multiple modules', 'main', 'module "application" { source = "../../modules/application" }\nmodule "second" { source = "../../modules/application" }\n', /exactly one/],
    ['cloud control', 'main', 'terraform {\n cloud {\n organization = "example"\n }\n}\n', /Cloud integration/],
    ['external program', 'main', 'data "external" "process" { program = ["never-executed"] }\n', /locked AzureRM/],
    ['local provisioner', 'main', 'resource "azurerm_resource_group" "example" {\n provisioner "local-exec" {\n command = "never-executed"\n }\n}\n', /provisioner/]
  ] as const)('rejects actual parsed %s without executing project/provider code', async (_label, role, text, expected) => {
    const { manifest, files } = generated({ projectType: 'standard', apiStack: 'node-fastify' });
    const binding = manifest.activeLayout.bindings.find(binding => binding.kind === 'artifact' && binding.logicalName === `opentofu-dev-${role}`)!;
    files.set(binding.pathParts.join('/'), capturedFile(binding.pathParts, text));
    const documents = await parsedFiles(files), before = canonicalSha256([...files]);
    expect(() => deriveManualInfrastructureInputs(manifest, files, documents)).toThrow(expected);
    expect(canonicalSha256([...files])).toBe(before);
  }, 30_000);
});

providerIt('captures and rechecks real locked provider outputs in a long workspace using its existing relative scratch role', async () => {
  const { manifest, files, artifacts } = generated({ projectType: 'standard', apiStack: 'node-fastify' }, ['dev']);
  const initialization = deriveManualInfrastructureInputs(manifest, files, await parsedFiles(files));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-manual-owned-provider-')));
  const identity = await lstat(root, { bigint: true }), deadline = performance.now() + 240_000;
  const project = path.join(root, 'original'), workspace = path.join(root, 'long-owned-workspace');
  const staged = artifacts.filter(artifact => !modernLocalInputExclusion(artifact.pathParts));
  let complete = false, settled = true;
  try {
    await writeArtifacts(project, artifacts);
    await mkdir(workspace, { mode: 0o700 });
    await writeArtifacts(path.join(workspace, 'project'), staged);
    const base = await createApplicationEnvironment(process.env, project, workspace, workspace);
    settled = false;
    const tools = await observeModernLocalTools(project, [{
      id: 'native-provider-diagnostic', status: 'planned', command: { executable: 'tofu', args: ['version'] },
      inputPaths: [], reasons: [], cwdPathParts: [], env: {}, prerequisites: [], effects: ['diagnostic only']
    }], []);
    settled = true;
    const tool = tools.find(tool => tool.id === 'tofu')!;
    expect(tool.version).toBe(manualInfrastructurePolicy.tofuVersion);
    const preparation = await createManualInfrastructureEnvironment(workspace, initialization);
    const selected = initialization.roots[0]!, cwd = path.join(workspace, 'project', ...selected.cwdPathParts);
    const environment = { ...base, ...preparation.environment(selected.component) };
    expect(Buffer.byteLength(path.join(workspace, 'scratch'))).toBeGreaterThan(104);
    expect(await realpath(path.resolve(cwd, environment.TMPDIR!))).toBe(path.join(workspace, 'scratch'));
    const runner = new NodeCommandRunner();
    const ownership = { root, retain() { settled = false; } };
    async function run(args: string[], env = environment) {
      await assertModernLocalToolsCurrent(project, workspace, tools);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Owned native diagnostic deadline exhausted before dispatch.');
      return runSettledFixtureCommand(runner, { executable: tool.executablePath, args }, {
        cwd, env, timeoutMs: Math.min(180_000, remaining), maxOutputBytes: 65_536, ensureProcessTreeSettled: true, stream: false
      }, ownership);
    }
    const missingData = path.join(workspace, 'cache', 'missing-provider-control');
    await mkdir(missingData, { mode: 0o700 });
    const missing = await run([...manualInfrastructurePolicy.validateArgs], { ...environment, TF_DATA_DIR: missingData });
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}\n${missing.stderr}`).toMatch(/Module not installed|Missing required provider|Required plugins are not installed/iu);
    await preparation.assertFresh(selected.component);
    const initialized = await run([...manualInfrastructurePolicy.initArgs]);
    expect(initialized, initialized.stderr).toMatchObject({ status: 0, timedOut: false, processTreeSettled: true });
    const sourceDigest = canonicalSha256([...files]);
    const before = await preparation.capture(selected.component, sourceDigest, tool.digest);
    await expect(preparation.assertFresh(selected.component)).rejects.toThrow(/fresh empty/);
    const validation = await run([...manualInfrastructurePolicy.validateArgs]);
    expect(validation, validation.stderr).toMatchObject({ status: 0, timedOut: false, processTreeSettled: true });
    expect(await preparation.capture(selected.component, sourceDigest, tool.digest)).toEqual(before);
    for (const artifact of artifacts) expect(await readFile(path.join(project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
    for (const artifact of staged) expect(await readFile(path.join(workspace, 'project', ...artifact.pathParts), 'utf8')).toBe(artifact.content);
    await assertModernLocalToolsCurrent(project, workspace, tools);
    console.info('LIFTOFF_MANUAL_PROVIDER_OBSERVATION', JSON.stringify({
      qualification: 'owned-preparation-primitives-not-public-execution', output: before,
      missingStatus: missing.status, initializationStatus: initialized.status, validationStatus: validation.status,
      processTreesSettled: true, originalAndStagedInputsUnchanged: true
    }));
    complete = true;
  } finally {
    const current = await lstat(root, { bigint: true });
    if (complete && settled && current.isDirectory() && !current.isSymbolicLink() &&
        current.dev === identity.dev && current.ino === identity.ino && current.uid === identity.uid) {
      await rm(root, { recursive: true });
    } else console.error(`Owned provider diagnostic retained without a cleanup claim: ${root}`);
  }
}, 300_000);

describe('native diagnostic fixture settlement bookkeeping', () => {
  it('retains ownership on thrown or unsettled dispatch, not on a known unspawned failure', async () => {
    const command = { executable: 'non-executing-test-double', args: [] };
    const retain = vi.fn(), ownership = { root: 'synthetic-no-filesystem-root', retain };
    await expect(runSettledFixtureCommand({ run: async () => { throw new Error('injected dispatch failure'); } },
      command, {}, ownership)).rejects.toThrow(/fixture retained/);
    expect(retain).toHaveBeenCalledOnce();
    retain.mockClear();
    const result = { command, displayCommand: command.executable, status: null, signal: null, stdout: '', stderr: '',
      timedOut: true, processTreeSettled: false, processSpawned: true };
    await expect(runSettledFixtureCommand({ run: async () => result }, command, {}, ownership)).rejects.toThrow(/fixture retained/);
    expect(retain).toHaveBeenCalledOnce();
    retain.mockClear();
    await expect(runSettledFixtureCommand({ run: async () => ({ ...result, processSpawned: false }) },
      command, {}, ownership)).resolves.toMatchObject({ processSpawned: false });
    expect(retain).not.toHaveBeenCalled();
  });
});

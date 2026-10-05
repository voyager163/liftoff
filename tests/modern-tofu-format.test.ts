import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { explicitTofuFormatCommand, explicitTofuFormatPolicy } from '../src/domain/governance/activation/modern-tofu-format.js';
import { rawLocalDigest, type ModernLocalFile } from '../src/domain/governance/activation/modern-local-inputs.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';
import {
  inspectModernLocalVerification, planClosedManualLocalInputs, planModernLocalVerification,
  inspectModernLocalRuntime, planManualNativeLocalRuntime
} from '../src/application/governance/modern-local-inputs.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { createApplicationEnvironment } from '../src/application/repair/application-environment.js';
import { observeModernLocalTools } from '../src/adapters/process/modern-local-tools.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { runSettledFixtureCommand } from './fixtures/settled-command.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function file(parts: string[], content = 'locals {\n  enabled = true\n}\n'): ModernLocalFile {
  return { pathParts: parts, scope: 'application', content: Buffer.from(content).toString('base64'),
    mode: 0o600, bytes: Buffer.byteLength(content), digest: rawLocalDigest(content) };
}
const lane = process.env.LIFTOFF_HCL_TEST_LANE ?? 'auto';
if (!['auto', 'portable', 'native'].includes(lane)) throw new Error('Unknown native formatting qualification lane.');
const qualified = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.21.0';
if (lane === 'native' && !qualified) throw new Error('Native formatting qualification requires the qualified runtime.');
const nativeIt = it.skipIf(lane === 'portable' || !qualified);

describe('explicit captured OpenTofu formatting scope', () => {
  it('names only present captured .tf files, with literal option-safe paths and no recursion', () => {
    const command = explicitTofuFormatCommand(['Infra Space'], [
      file(['Infra Space', 'nested', 'second.tf']), file(['Infra Space', '-first.tf']),
      file(['Infra Space', 'dev.tfvars']), file(['Infra Space', 'source.tf.json']), file(['other', 'main.tf'])
    ]);
    expect(command).toEqual({
      executable: 'tofu', args: ['fmt', '-check', '-write=false', './-first.tf', './nested/second.tf']
    });
    expect(command.args).not.toContain('-recursive');
  });

  it('rejects protected paths, case aliases, changed bytes and an empty scope', () => {
    expect(() => explicitTofuFormatCommand(['infra'], [file(['infra', '.terraform', 'main.tf'])])).toThrow(/protected/);
    expect(() => explicitTofuFormatCommand(['infra'], [file(['infra', 'main.tf']), file(['infra', 'MAIN.tf'])])).toThrow(/ambiguous/);
    expect(() => explicitTofuFormatCommand(['infra'], [{ ...file(['infra', 'main.tf']), digest: '0'.repeat(64) }])).toThrow(/digest/);
    expect(() => explicitTofuFormatCommand(['infra'], [])).toThrow(/nonempty/);
  });

  it('enforces the exact file count rather than truncating its formatting scope', () => {
    const files = Array.from({ length: explicitTofuFormatPolicy.files }, (_, index) => file(['infra', `source-${index}.tf`]));
    expect(explicitTofuFormatCommand(['infra'], files).args).toHaveLength(files.length + explicitTofuFormatPolicy.args.length);
    expect(() => explicitTofuFormatCommand(['infra'], [...files, file(['infra', 'extra.tf'])])).toThrow(/bounded/);
  });

  it('enforces the exact argument-byte ceiling without truncation or shell concatenation', () => {
    const files = Array.from({ length: explicitTofuFormatPolicy.files }, (_, index) =>
      file(['infra', 'd'.repeat(255), `${String(index).padStart(2, '0')}${'x'.repeat(195)}.tf`]));
    let remaining = explicitTofuFormatPolicy.argumentsBytes -
      Buffer.byteLength(explicitTofuFormatCommand(['infra'], files).args.join('\0'));
    for (const [index, entry] of files.entries()) {
      const name = entry.pathParts.at(-1)!;
      const extra = Math.min(remaining, 255 - name.length);
      files[index] = { ...entry, pathParts: [...entry.pathParts.slice(0, -1), `${name.slice(0, -3)}${'x'.repeat(extra)}.tf`] };
      remaining -= extra;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(explicitTofuFormatCommand(['infra'], files).args.join('\0'))).toBe(explicitTofuFormatPolicy.argumentsBytes);
    const spareIndex = files.findIndex(entry => entry.pathParts.at(-1)!.length < 255);
    const spare = files[spareIndex]!;
    files[spareIndex] = { ...spare, pathParts: [...spare.pathParts.slice(0, -1), `x${spare.pathParts.at(-1)}`] };
    expect(() => explicitTofuFormatCommand(['infra'], files)).toThrow(/argument-byte/);
  });

  it.each([
    { projectType: 'standard', apiStack: 'node-fastify' },
    { projectType: 'standard', apiStack: 'python-fastapi' },
    { projectType: 'standard', apiStack: 'go-huma' },
    ...projectCatalog.patterns.map(pattern => ({ projectType: 'genai', pattern: pattern.id }))
  ])('derives distinct read-only generated Manual inputs for %j without promoting provider readiness', async workload => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-closed-manual-plan-')));
    roots.push(root);
    const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
      ...workload, projectName: 'Closed Manual', specWorkflow: 'manual',
      agents: [], governanceProfile: 'none', includeFrontend: true, environments: ['dev']
    }, { requireProjectName: true }));
    await writeArtifacts(root, artifacts);
    const inspection = await inspectModernLocalVerification(root);
    expect(inspection.status).toBe('modern-observed');
    const closed = await planClosedManualLocalInputs(inspection);
    const composeCheck = closed.checks.find(check => check.id === 'compose-config');
    expect(composeCheck, JSON.stringify(composeCheck?.reasons)).toMatchObject({ status: 'planned' });
    const formatting = closed.checks.filter(check => check.id.startsWith('tofu-format:'));
    expect(formatting.length).toBeGreaterThan(0);
    for (const check of formatting) {
      expect(check.status).toBe('planned');
      expect(check.command?.args.slice(0, 3)).toEqual(['fmt', '-check', '-write=false']);
      expect(check.command?.args.some(value => value.endsWith('.tfvars'))).toBe(false);
    }
    expect(closed.status).toBe('blocked');
    expect(closed.execution).toBe('not-authorized');
    expect(closed.checks.filter(check => check.id.startsWith('tofu-validate:')).every(check => check.status === 'blocked')).toBe(true);
    if ('apiStack' in workload && workload.apiStack === 'node-fastify') {
      const historical = await planModernLocalVerification(inspection);
      expect(historical.recipeSet.digest).not.toBe(closed.recipeSet.digest);
      expect(historical.checks.find(check => check.id === 'compose-config')?.reasons).toContain('Compose interpolation is not bound to captured local input.');
    }
    for (const artifact of artifacts) expect(await readFile(path.join(root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
  });

  it.each([
    '    build:\n      context: ${BUILD_CONTEXT-.}\n      dockerfile: Dockerfile\n',
    '    build:\n      context: .\n      dockerfile: README.md\n',
    '    build:\n      context: ..\n      dockerfile: Dockerfile\n',
    '    volumes: [".:/data"]\n',
    '    env_file: .env\n',
    '    label_file: labels.txt\n',
    '    credential_spec:\n      file: credentials.json\n'
  ])('does not widen root-context admission into dynamic, unrelated or private input authority: %s', async declaration => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-closed-compose-negative-')));
    roots.push(root);
    const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
      projectName: 'Closed Manual', projectType: 'standard', apiStack: 'node-fastify', specWorkflow: 'manual',
      agents: [], governanceProfile: 'none', includeFrontend: false, environments: ['dev']
    }, { requireProjectName: true }));
    await writeArtifacts(root, artifacts);
    const source = `services:\n  app:\n    image: example\n${declaration}`;
    await writeFile(path.join(root, 'docker-compose.yml'), source);
    const plan = await planClosedManualLocalInputs(await inspectModernLocalVerification(root));
    expect(plan.checks.find(check => check.id === 'compose-config')?.status).toBe('blocked');
    expect(plan.execution).toBe('not-authorized');
    expect(await readFile(path.join(root, 'docker-compose.yml'), 'utf8')).toBe(source);
  });

  nativeIt.each([
    { projectType: 'standard', apiStack: 'node-fastify' },
    { projectType: 'standard', apiStack: 'python-fastapi' },
    { projectType: 'standard', apiStack: 'go-huma' },
    ...projectCatalog.patterns.map(pattern => ({ projectType: 'genai', pattern: pattern.id }))
  ])('independently derives installed Manual native input prerequisites for %j without execution authority', async workload => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-manual-native-plan-')));
    roots.push(root);
    const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
      ...workload, projectName: 'Manual Native', specWorkflow: 'manual',
      agents: [], governanceProfile: 'none', includeFrontend: true, environments: ['dev']
    }, { requireProjectName: true }));
    await writeArtifacts(root, artifacts);
    const { plan, infrastructure, composeInputs } = await planManualNativeLocalRuntime(await inspectModernLocalRuntime(root));
    expect(plan.status, JSON.stringify(plan.blockers)).toBe('planned');
    expect(plan.execution).toBe('not-authorized');
    expect(plan.publication).toBe('codec-unavailable-not-authorized');
    expect(infrastructure?.roots.map(root => root.component)).toEqual(['opentofu-environment:dev']);
    expect(composeInputs?.kind).toBe('liftoff-closed-compose-inputs');
    expect(plan.localPlan?.checks.find(check => check.id === 'tofu-initialize:opentofu-environment:dev')).toMatchObject({
      status: 'planned', command: { executable: 'tofu', args: ['init', '-backend=false', '-input=false', '-no-color', '-lockfile=readonly'] }
    });
    expect(plan.localPlan?.checks.find(check => check.id === 'tofu-validate:opentofu-application')).toMatchObject({
      status: 'inapplicable', command: null
    });
    for (const artifact of artifacts) expect(await readFile(path.join(root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
  }, 30_000);

  nativeIt.each([
    ['uncaptured file', 'file("/never-read/private-input")'],
    ['dynamic file', 'file(var.environment)'],
    ['nested template', 'templatefile("relative-template", {})'],
    ['environment-sensitive function', 'timestamp()']
  ])('keeps %s outside native input closure despite approved provider declarations', async (_name, expression) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-native-hcl-negative-')));
    roots.push(root);
    await writeArtifacts(root, buildCurrentArtifacts(buildCurrentProjectPlan({
      projectType: 'standard', apiStack: 'node-fastify', projectName: 'Manual Native', specWorkflow: 'manual',
      agents: [], governanceProfile: 'none', includeFrontend: false, environments: ['dev']
    }, { requireProjectName: true })));
    const target = path.join(root, 'infrastructure', 'opentofu', 'azure', 'modules', 'application', 'additional.tf');
    const source = `locals {\n  additional = ${expression}\n}\n`;
    await writeFile(target, source);
    const { plan, infrastructure } = await planManualNativeLocalRuntime(await inspectModernLocalRuntime(root));
    expect(plan.status).toBe('blocked');
    expect(plan.execution).toBe('not-authorized');
    expect(infrastructure).toBeNull();
    expect(plan.localPlan?.checks.find(check => check.id === 'source-consistency')?.status).toBe('blocked');
    expect(await readFile(target, 'utf8')).toBe(source);
  }, 30_000);

  nativeIt('checks literal captured files with native OpenTofu while malformed excluded files remain untouched', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-explicit-format-')));
    roots.push(root);
    const project = path.join(root, 'project');
    await mkdir(project);
    const sources = [file(['Infra Space', '-main.tf']), file(['Infra Space', 'nested', 'child.tf'])];
    for (const source of sources) {
      const target = path.join(project, ...source.pathParts);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(source.content!, 'base64'));
    }
    const excluded = path.join(project, 'Infra Space', 'private.auto.tfvars');
    await writeFile(excluded, 'malformed excluded = {{{\n', { mode: 0o600 });
    const command = explicitTofuFormatCommand(['Infra Space'], sources);
    const tools = await observeModernLocalTools(project, [{
      id: 'tofu-format', status: 'planned', command, inputPaths: [], reasons: [], cwdPathParts: ['Infra Space'],
      env: {}, prerequisites: [], effects: ['read-only formatting']
    }], []);
    const tool = tools.find(tool => tool.id === 'tofu')!;
    const environment = await createApplicationEnvironment(process.env, project, root, root);
    Object.assign(environment, { TF_CLI_ARGS: '', TF_CLI_ARGS_fmt: '', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' });
    const runner = new NodeCommandRunner();
    const ownership = { root, retain() { const index = roots.indexOf(root); if (index >= 0) roots.splice(index, 1); } };
    const result = await runSettledFixtureCommand(runner, { ...command, executable: tool.executablePath }, {
      cwd: path.join(project, 'Infra Space'), env: environment, timeoutMs: 15_000,
      maxOutputBytes: 65_536, ensureProcessTreeSettled: true, stream: false
    }, ownership);
    expect(result).toMatchObject({ status: 0, signal: null, timedOut: false, processTreeSettled: true });
    const recursive = await runSettledFixtureCommand(runner, {
      executable: tool.executablePath, args: ['fmt', '-check', '-write=false', '-recursive']
    }, {
      cwd: path.join(project, 'Infra Space'), env: environment, timeoutMs: 15_000,
      maxOutputBytes: 65_536, ensureProcessTreeSettled: true, stream: false
    }, ownership);
    expect(recursive.status).not.toBe(0);
    expect(recursive).toMatchObject({ signal: null, timedOut: false, processTreeSettled: true });
    expect(await readFile(excluded, 'utf8')).toBe('malformed excluded = {{{\n');
    for (const source of sources) expect(await readFile(path.join(project, ...source.pathParts), 'utf8')).toBe(Buffer.from(source.content!, 'base64').toString());
  }, 60_000);
});

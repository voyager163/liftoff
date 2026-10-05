import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectModernComposeInputs, modernComposeEnvironment } from '../src/application/governance/modern-compose.js';
import { modernComposeInputPolicy, validateModernComposeInputs } from '../src/domain/governance/activation/modern-compose.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { rawLocalDigest } from '../src/domain/governance/activation/modern-local-inputs.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';
import { observeModernLocalTools } from '../src/adapters/process/modern-local-tools.js';
import { createApplicationEnvironment } from '../src/application/repair/application-environment.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import type { ModernLocalCheck } from '../src/domain/governance/activation/modern-local-inputs.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import { runSettledFixtureCommand } from './fixtures/settled-command.js';

const compose = (value: string) => `services:\n  app:\n    image: example\n    environment:\n      VALUE: ${JSON.stringify(value)}\n`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const lane = process.env.LIFTOFF_HCL_TEST_LANE ?? 'auto';
if (!['auto', 'portable', 'native'].includes(lane)) throw new Error('Unknown native Compose qualification lane.');
const qualified = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.21.0';
if (lane === 'native' && !qualified) throw new Error('Native Compose qualification requires the qualified runtime.');
const nativeIt = it.skipIf(lane === 'portable' || !qualified);

describe('closed current Compose input interpretation', () => {
  it.each(['node', 'python', 'go'] as const)('binds actual generated Manual %s Compose without reading environment values', apiStack => {
    const plan = buildCurrentProjectPlan({
      projectName: 'Current Native', projectType: 'standard', apiStack, specWorkflow: 'manual',
      agents: [], governanceProfile: 'none', includeFrontend: false, environments: ['dev']
    }, { requireProjectName: true });
    const source = buildCurrentArtifacts(plan).find(artifact => artifact.logicalName === 'docker-compose')!.content;
    const result = inspectModernComposeInputs(source);
    expect(result.inputs).toMatchObject({
      kind: 'liftoff-closed-compose-inputs', schemaVersion: 1,
      sourceDigest: rawLocalDigest(source), policyDigest: canonicalSha256(modernComposeInputPolicy)
    });
    expect(result.inputs.unsetEnvironment).toContain('APP_ENV');
    expect(result.inputs).not.toHaveProperty('values');
  });

  it.each(projectCatalog.patterns.map(pattern => pattern.id))(
    'interprets actual generated %s anchors and literal-default interpolation', pattern => {
      const source = buildCurrentArtifacts(buildCurrentProjectPlan({
        projectName: 'Current Native', projectType: 'genai', apiStack: 'python', pattern,
        specWorkflow: 'manual', agents: [], governanceProfile: 'none', includeFrontend: false, environments: ['dev']
      }, { requireProjectName: true })).find(artifact => artifact.logicalName === 'docker-compose')!.content;
      const result = inspectModernComposeInputs(source);
      expect(result.inputs.unsetEnvironment).toContain('OPENAI_API_KEY');
      expect(result.inputs.unsetEnvironment).toContain('LANGFUSE_SECRET_KEY');
      expect(result.document.services).toBeDefined();
      expect(result.inputs.sourceDigest).toBe(rawLocalDigest(source));
    }
  );

  it('binds absence rather than empty or inherited values for both default operators', () => {
    const result = inspectModernComposeInputs(compose('${APP_VALUE-first} ${APP_VALUE:-second} $OTHER ${THIRD+ignored}'));
    expect(result.inputs.unsetEnvironment).toEqual(['APP_VALUE', 'OTHER', 'THIRD']);
    expect(JSON.stringify(result.document)).toContain('${APP_VALUE-first}');
  });

  it('does not reinterpret escaped container-shell dollars as host interpolation', () => {
    expect(inspectModernComposeInputs(compose('$$HOME $${PATH} $5')).inputs.unsetEnvironment).toEqual([]);
  });

  it('binds implicit environment and build-argument lookups, not only dollar expressions', () => {
    const source = 'services:\n  app:\n    image: example\n    environment: [APP_VALUE, "LITERAL=value"]\n' +
      '    build:\n      context: .\n      args:\n        BUILD_VALUE:\n        LITERAL: value\n';
    expect(inspectModernComposeInputs(source).inputs.unsetEnvironment).toEqual(['APP_VALUE', 'BUILD_VALUE']);
    expect(() => inspectModernComposeInputs(source.replace('APP_VALUE', 'HOME'))).toThrow(/execution controls/);
    expect(() => inspectModernComposeInputs(source.replace('BUILD_VALUE', 'PATH'))).toThrow(/execution controls/);
  });

  it.each(['${APP:?required}', '${APP?required}', '${APP-${OTHER}}', '${APP', '${1BAD}'])(
    'blocks unsupported interpolation %s without echoing values', value => {
      expect(() => inspectModernComposeInputs(compose(value))).toThrow(/simple optional interpolation/);
    }
  );

  it.each(['PATH', 'Path', 'HOME', 'COMPOSE_FILE', 'DOCKER_CONTEXT', 'LD_PRELOAD', 'NODE_OPTIONS', 'NPM_CONFIG_USERCONFIG', 'GODEBUG', 'LIFTOFF_APPLICATION_NETWORK'])(
    'never unsets or substitutes the execution control %s', name => {
      expect(() => inspectModernComposeInputs(compose(`\${${name}-value}`))).toThrow(/execution controls/);
    }
  );

  it('rejects case-aliased variable names rather than changing Windows semantics', () => {
    expect(() => inspectModernComposeInputs(compose('$APP_VALUE $app_value'))).toThrow(/alias on Windows/);
  });

  it('rejects cycles, unresolved aliases and repeated anchors', () => {
    for (const source of [
      'services: &cycle\n  app: *cycle\n',
      'services:\n  app: *unknown\n',
      'first: &repeated {}\nsecond: &repeated {}\nservices: {}\n'
    ]) expect(() => inspectModernComposeInputs(source)).toThrow();
  });

  it('enforces exact alias and AST-node bounds before expansion', () => {
    const aliases = (count: number) => `services: {}\nx-base: &base value\nx-values: [${Array.from({ length: count }, () => '*base').join(',')}]\n`;
    expect(inspectModernComposeInputs(aliases(modernComposeInputPolicy.aliases)).inputs.unsetEnvironment).toEqual([]);
    expect(() => inspectModernComposeInputs(aliases(modernComposeInputPolicy.aliases + 1))).toThrow(/bounded references/);
    const amplified = 'x-a: &a [value]\nx-b: &b [*a,*a,*a,*a]\nx-c: &c [*b,*b,*b,*b]\nx-expanded: *c\nservices: {}\n';
    expect(() => inspectModernComposeInputs(amplified)).toThrow(/expanded within the declared bound/);
    const nodes = (count: number) => `services: {}\nx-values: [${Array.from({ length: count - 5 }, () => '0').join(',')}]\n`;
    expect(inspectModernComposeInputs(nodes(modernComposeInputPolicy.nodes)).inputs.unsetEnvironment).toEqual([]);
    expect(() => inspectModernComposeInputs(nodes(modernComposeInputPolicy.nodes + 1))).toThrow(/node or depth bound/);
    expect(() => inspectModernComposeInputs(`services: {}\nx-deep: ${'['.repeat(modernComposeInputPolicy.depth)}0${']'.repeat(modernComposeInputPolicy.depth)}\n`)).toThrow(/depth bound/);
  });

  it.each([
    'services: {}\nservices: {}\n',
    'services:\n  app: !unknown value\n',
    'services:\n  ? [complex, key]\n  : value\n'
  ])('rejects ambiguous keys or tags without treating warnings as valid data', source => {
    expect(() => inspectModernComposeInputs(source)).toThrow();
  });

  it('enforces the exact variable and source-byte bounds', () => {
    const variables = Array.from({ length: modernComposeInputPolicy.variables }, (_, index) => `$APP_${index}`);
    expect(inspectModernComposeInputs(compose(variables.join(' '))).inputs.unsetEnvironment).toHaveLength(variables.length);
    expect(() => inspectModernComposeInputs(compose(`${variables.join(' ')} $ONE_MORE`))).toThrow(/variable bound/);
    const prefix = 'services: {}\n#';
    const exact = prefix + 'x'.repeat(modernComposeInputPolicy.sourceBytes - Buffer.byteLength(prefix));
    expect(inspectModernComposeInputs(exact).inputs.sourceDigest).toBe(rawLocalDigest(exact));
    expect(() => inspectModernComposeInputs(`${exact}x`)).toThrow(/bounded UTF-8/);
  });

  it('rejects non-round-tripping text and overlong variable names', () => {
    expect(() => inspectModernComposeInputs(`services: {}\n#\ud800`)).toThrow(/UTF-8/);
    expect(() => inspectModernComposeInputs(`services: {}\n#\0`)).toThrow(/NUL/);
    const exact = 'A'.repeat(modernComposeInputPolicy.variableBytes);
    expect(inspectModernComposeInputs(compose(`$${exact}`)).inputs.unsetEnvironment).toEqual([exact]);
    expect(() => inspectModernComposeInputs(compose(`$${exact}B`))).toThrow(/variable-name bound/);
  });

  it('clears captured project names while retaining private execution controls and leaving caller data unchanged', () => {
    const inputs = inspectModernComposeInputs(compose('${APP_VALUE-default}')).inputs;
    const base = { HOME: '/private/owned/home', APP_VALUE: 'ambient', app_value: 'case-aliased' };
    const environment = modernComposeEnvironment(base, inputs);
    expect(environment).toMatchObject({
      HOME: base.HOME, APP_VALUE: undefined, app_value: undefined,
      COMPOSE_DISABLE_ENV_FILE: '1', COMPOSE_ENV_FILES: ''
    });
    expect(base.APP_VALUE).toBe('ambient');
    expect(inputs.unsetEnvironment).toEqual(['APP_VALUE']);
  });

  it('rejects forged, reordered, aliased or execution-control environment descriptors', () => {
    const inputs = inspectModernComposeInputs(compose('$APP_VALUE $OTHER')).inputs;
    for (const unsetEnvironment of [['HOME'], ['OTHER', 'APP_VALUE'], ['APP_VALUE', 'app_value'], ['APP_VALUE', 'APP_VALUE']]) {
      expect(() => modernComposeEnvironment({}, { ...inputs, unsetEnvironment })).toThrow(/environment names/);
    }
    expect(() => validateModernComposeInputs({ ...inputs, policyDigest: '0'.repeat(64) })).toThrow(/identity/);
    const getter = vi.fn();
    const bad = Object.defineProperty({ ...inputs }, 'unsetEnvironment', { enumerable: true, get: getter });
    expect(() => validateModernComposeInputs(bad)).toThrow(/accessors/);
    expect(getter).not.toHaveBeenCalled();
  });

  nativeIt('configures actual generated Compose on the bound native plugin without inherited project values or dotenv', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-closed-compose-')));
    roots.push(root);
    const project = path.join(root, 'project');
    await mkdir(project);
    const check: ModernLocalCheck = {
      id: 'compose-config', status: 'planned', inputPaths: [], reasons: [],
      command: { executable: 'docker', args: ['compose', 'config', '-q'] }, cwdPathParts: [],
      env: {}, prerequisites: [], effects: ['configuration only']
    };
    const tools = await observeModernLocalTools(project, [check], []);
    const tool = tools.find(candidate => candidate.id === 'docker')!;
    expect(tool.versions.compose).toBe('5.5.1');
    const base = await createApplicationEnvironment(process.env, project, root, root);
    Object.assign(base, {
      DOCKER_CONFIG: path.join(root, 'home', 'docker'),
      DOCKER_HOST: `unix://${path.join(root, 'scratch', 'no-daemon.sock')}`,
      APP_VALUE: 'INHERITED_SENTINEL', PASSTHROUGH: 'INHERITED_SENTINEL'
    });
    const runner = new NodeCommandRunner();
    const ownership = { root, retain() { const index = roots.indexOf(root); if (index >= 0) roots.splice(index, 1); } };
    const sentinelSource = 'services:\n  app:\n    image: example\n    environment:\n' +
      '      VALUE: ${APP_VALUE-fallback}\n      COLON: ${APP_VALUE:-second}\n      PASSTHROUGH:\n';
    await writeFile(path.join(project, 'compose.yml'), sentinelSource);
    const dotenv = 'APP_VALUE=DOTENV_SENTINEL\nPASSTHROUGH=DOTENV_SENTINEL\n';
    await writeFile(path.join(project, '.env'), dotenv, { mode: 0o600 });
    const result = await runSettledFixtureCommand(runner, {
      executable: tool.executablePath,
      args: ['--project-directory', project, '-f', path.join(project, 'compose.yml'), 'config', '--format', 'json']
    }, {
      cwd: project, env: modernComposeEnvironment(base, inspectModernComposeInputs(sentinelSource).inputs),
      timeoutMs: 15_000, maxOutputBytes: 65_536, ensureProcessTreeSettled: true, stream: false
    }, ownership);
    expect(result).toMatchObject({ status: 0, signal: null, timedOut: false, processTreeSettled: true });
    const resolved = JSON.parse(result.stdout);
    expect(resolved.services.app.environment.VALUE).toBe('fallback');
    expect(resolved.services.app.environment.COLON).toBe('second');
    expect(resolved.services.app.environment.PASSTHROUGH == null).toBe(true);
    expect(result.stdout).not.toContain('SENTINEL');
    expect(await readFile(path.join(project, '.env'), 'utf8')).toBe(dotenv);
    expect(await readFile(path.join(project, 'compose.yml'), 'utf8')).toBe(sentinelSource);

    const workloads: ProjectOptions[] = [
      ...['node-fastify', 'python-fastapi', 'go-huma'].map(apiStack => ({ projectType: 'standard', apiStack })),
      ...projectCatalog.patterns.map(pattern => ({ projectType: 'genai', pattern: pattern.id }))
    ];
    for (const [index, workload] of workloads.entries()) {
      const directory = path.join(project, `generated-${index}`);
      const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
        ...workload, projectName: 'Current Native', specWorkflow: 'manual', agents: [],
        governanceProfile: 'none', includeFrontend: true, environments: ['dev']
      }, { requireProjectName: true }));
      await writeArtifacts(directory, artifacts);
      const artifact = artifacts.find(candidate => candidate.logicalName === 'docker-compose')!;
      const observed = await runSettledFixtureCommand(runner, {
        executable: tool.executablePath,
        args: ['--project-directory', path.dirname(path.join(directory, ...artifact.pathParts)),
          '-f', path.join(directory, ...artifact.pathParts), 'config', '-q']
      }, {
        cwd: directory, env: modernComposeEnvironment(base, inspectModernComposeInputs(artifact.content).inputs),
        timeoutMs: 15_000, maxOutputBytes: 65_536, ensureProcessTreeSettled: true, stream: false
      }, ownership);
      expect(observed, `generated ${workload.apiStack ?? workload.pattern}`).toMatchObject({
        status: 0, signal: null, timedOut: false, processTreeSettled: true
      });
      for (const file of artifacts) expect(await readFile(path.join(directory, ...file.pathParts), 'utf8')).toBe(file.content);
    }
  }, 120_000);
});

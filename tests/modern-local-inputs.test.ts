import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectModernLocalVerification, planModernLocalVerification, reinspectModernLocalVerification,
  inspectModernLocalRuntime, planModernLocalRuntime, reinspectModernLocalRuntime
} from '../src/application/governance/modern-local-inputs.js';
import { createModernActivationRecordContract } from '../src/domain/governance/activation/modern-records.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  modernLocalBounds, modernLocalRequiredInputClosurePolicy, rawLocalDigest
} from '../src/domain/governance/activation/modern-local-inputs.js';
import { hclComputationPolicy } from '../src/adapters/hcl/parser-child.js';
import { parseIsolatedHcl, type HclExpression } from '../src/adapters/hcl/isolated-parser.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { ManifestActiveLayout, ManifestLayoutComponentId } from '../src/domain/project/contracts.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedRepairTransactionPathParts,
  reviewedUpdateTransactionPathParts
} from '../src/domain/project/reviewed-update-artifacts.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function resolveHclTestLane(value: string | undefined, runtime: { platform: string; arch: string; node: string }) {
  const mode = value ?? 'auto';
  if (!['auto', 'portable', 'native'].includes(mode)) throw new Error('Invalid LIFTOFF_HCL_TEST_LANE; expected auto, portable or native.');
  const qualified = runtime.platform === 'darwin' && runtime.arch === 'arm64' && runtime.node === '24.21.0';
  if (mode === 'native' && !qualified) throw new Error('Native HCL qualification requires actual darwin/arm64/Node24.21.0; no cases were qualified.');
  return { mode, qualified, native: mode !== 'portable' && qualified };
}
const testLane = resolveHclTestLane(process.env.LIFTOFF_HCL_TEST_LANE, {
  platform: process.platform, arch: process.arch, node: process.versions.node
});
const nativeIt = it.skipIf(!testLane.native);
const nativeCaseTemplates = [
  "reparses real local HCL module and file references within selected scopes",
  "blocks nested templatefile input references that are not independently captured",
  "blocks unsupported template closure for $expression",
  "preserves captured literal %s and local module relationships",
  "keeps complete captured recursive source coverage planned",
  "plans from captured HCL while the project root is unavailable, without a project reader",
  "blocks unsupported real HCL without an empty fallback: %s",
  "enforces actual2048 HCL file references plus %i",
  "contains original500000-visit construction plus %i and recovers",
  "enforces500000 cumulative visits plus %i through actual isolated planner admission",
  "plans supported jsonencode over a literal populated object",
  "counts all actual static key/value occurrences at500000 visits plus %i despite memoization",
  "plans supported literal keys and fully captured values: %s",
  "still rejects escaping %s value dependencies inside static objects",
  "does not turn unrepresented key %s into dependency-free metadata"
];
const executedCaseNames: string[] = [];
beforeEach(({ task }) => { executedCaseNames.push(task.name); });
afterAll(() => {
  if (testLane.mode === 'native') {
    expect(nativeCaseTemplates.length).toBeGreaterThan(0);
    for (const title of ["reparses real local HCL module and file references within selected scopes","plans supported jsonencode over a literal populated object"]) expect(executedCaseNames).toContain(title);
  }
  console.info('LIFTOFF_HCL_TEST_INVENTORY ' + JSON.stringify({
    file: 'tests/modern-local-inputs.test.ts', lane: testLane.mode,
    actualRuntime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    nativeSelected: testLane.native, nativeUnrunTemplates: testLane.native ? [] : nativeCaseTemplates,
    executedCaseNames, claim: testLane.mode === 'portable' && testLane.qualified
      ? 'Forced-portable routing and synthetic runtime rejection only; not Linux/Windows/Node24.20 qualification.'
      : 'Current-host test evidence only.'
  }));
});

let rejectionScopeActive = false;
async function withPortableRejection<T>(operation: () => Promise<T>): Promise<T> {
  if (testLane.native) return operation();
  if (rejectionScopeActive) throw new Error('Portable runtime-rejection scopes must not overlap.');
  rejectionScopeActive = true;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const spawned = vi.mocked(spawn).mock.calls.length;
  try {
    if (testLane.mode === 'portable' && testLane.qualified) {
      Object.defineProperty(process, 'arch', { ...descriptor, value: 'portable-test-unqualified' });
    }
    return await operation();
  } finally {
    Object.defineProperty(process, 'arch', descriptor);
    rejectionScopeActive = false;
    expect(vi.mocked(spawn).mock.calls.length).toBe(spawned);
    expect(Object.getOwnPropertyDescriptor(process, 'arch')).toEqual(descriptor);
  }
}
async function testPlan(inspection: Parameters<typeof planModernLocalVerification>[0]) {
  const plan = await withPortableRejection(() => planModernLocalVerification(inspection));
  if (!testLane.native) {
    for (const check of plan.checks.filter(check => check.id.startsWith('tofu-'))) {
      expect(check.status).toBe('blocked');
      if (check.id.startsWith('tofu-validate:')) expect(check.reasons).toEqual(['OpenTofu source/reference prerequisites are incomplete.']);
    }
  }
  return plan;
}
async function testReinspect(root: string, prior: Parameters<typeof reinspectModernLocalVerification>[1]) {
  return withPortableRejection(() => reinspectModernLocalVerification(root, prior));
}
function expectCompleteLocalPlan(plan: Awaited<ReturnType<typeof planModernLocalVerification>>) {
  if (testLane.native) {
    expect(plan.blockers, canonicalJson(plan.checks)).toEqual([]);
    expect(plan.status).toBe('planned');
  } else {
    expect(plan.status).toBe('blocked');
    const independent = plan.checks.filter(check => !check.id.startsWith('tofu-'));
    expect(independent.length).toBeGreaterThan(0);
    for (const check of independent) expect(check.status, `${check.id}: ${check.reasons.join(' ')}`).not.toBe('blocked');
    const formats = plan.checks.filter(check => check.id.startsWith('tofu-format:'));
    expect(formats.length).toBeGreaterThan(0);
    for (const check of formats) expect(check.reasons).toEqual([
      'Isolated HCL computation is unavailable: this runtime is not the qualified darwin/arm64 Node24.21.0 tuple.'
    ]);
  }
}

const cleanups: string[] = [];
afterEach(async () => { for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const contracts = { catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract };
const profiles = ['single-maintainer-gitflow', 'team-gitflow', 'none'] as const;
const workflows = ['openspec', 'spec-kit', 'manual'] as const;
async function fixture(options: {
  profile?: typeof profiles[number]; workflow?: typeof workflows[number]; custom?: boolean;
  agents?: string[]; stack?: string; pattern?: string; frontend?: boolean; layout?: 'partial' | 'unresolved';
} = {}) {
  const profile = options.profile ?? 'single-maintainer-gitflow', workflow = options.workflow ?? 'manual';
  const agents = options.agents ?? (workflow === 'manual' ? [] : ['github-copilot']);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mr1-local-'))); cleanups.push(root);
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: { name: 'Observed Local Source', workload: {
      kind: options.pattern ? 'genai' : 'standard', ...(options.pattern ? { pattern: options.pattern } : {}),
      apiStack: options.pattern ? 'python-fastapi' : options.stack ?? 'node-fastify',
      cloud: 'azure', region: 'eastus', frontend: options.frontend ?? false, environments: ['prod', 'dev']
    }, specWorkflow: workflow, agents, ...(workflow === 'spec-kit' && agents.length ? { defaultAgent: agents.at(-1) } : {}) },
    framework: workflow === 'manual' ? { state: 'not-required' } : {
      state: agents.length ? 'initialized' : 'legacy', adapter: workflow,
      ...(agents.length ? { contractVersion: projectCatalog.getFrameworkDefinition(workflow).version } : {})
    }
  });
  const workload = leaf.project.workload;
  const composition = composeModernManifestPlugins({
    workload: workload.kind, ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    stack: workload.apiStack, cloud: workload.cloud, workflow, agents: leaf.project.agents,
    frontend: workload.frontend ? 'included' : 'omitted', governanceProfile: profile, environments: workload.environments
  }, { safeProjectName: toSafeProjectName(leaf.project.name) });
  const plugins = readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins },
    { stack: workload.apiStack, cloud: workload.cloud, workflow, agents: leaf.project.agents });
  const selection = { ...leaf, profile }, source = resolveModernManifestV8SourceContract({ selection, recordedPlugins: plugins });
  const components = new Map<ManifestLayoutComponentId, string[]>();
  for (const id of source.layoutDescriptor.components) {
    components.set(id, options.custom ? ['Custom Sources', id.replace(':', ' ')] :
      id === 'opentofu-application' ? ['infrastructure', 'opentofu', 'azure', 'modules', 'application'] :
        id.startsWith('opentofu-environment:') ? ['infrastructure', 'opentofu', 'azure', 'environments', id.split(':')[1]] :
          id === 'function-worker' ? ['functions', `${options.pattern}-worker`] : [id]);
  }
  const compose = options.custom ? ['Config Space', 'compose.yml'] : ['docker-compose.yml'];
  const layout: ManifestActiveLayout = options.layout === 'unresolved' ? { schemaVersion: 1, state: 'unresolved', bindings: [] } : {
    schemaVersion: 1, state: 'bound', bindings: [
      ...[...components].filter(([id]) => options.layout !== 'partial' || id === 'backend').map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
      { kind: 'artifact', logicalName: 'docker-compose', pathParts: compose }
    ]
  };
  const input = { selection, plugins, activeLayout: layout }, core = buildModernManagedCore(input);
  const context = profile === 'none' ? undefined : createModernGovernanceContextContract(contracts).buildModernGovernanceContext(input);
  const initial = createManifestV8Reader(contracts).parseManifestV8({
    artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion: modernActivationSourceContracts()[0].identity.liftoffVersion,
    project: leaf.project, framework: leaf.framework, plugins, activeLayout: layout,
    governance: context ? { profile, policyVersion: context.governance.policyVersion, state: 'handoff-generated', activationIdentity: context.governance.activationIdentity } :
      { profile: 'none', state: 'disabled' },
    managedArtifacts: core.map(file => ({ logicalName: file.logicalName, category: file.category, pathParts: file.pathParts, contentHash: `sha256:${rawLocalDigest(file.content)}` })),
    projectArtifacts: [], adoptionObservations: []
  });
  const candidate = createManifestV8Candidate({ origin: 'maintenance', source: initial, managed: core.map(file => ({ kind: 'retain', logicalName: file.logicalName })) });
  async function write(parts: readonly string[], content: string | Buffer): Promise<void> {
    await mkdir(path.dirname(path.join(root, ...parts)), { recursive: true });
    await writeFile(path.join(root, ...parts), content);
  }
  await write(['liftoff.manifest.json'], candidate.content);
  for (const file of core) await write(file.pathParts, file.content);
  const tasks = await writeModernLocalFixtureInputs(leaf, components, compose, write);
  return { root, manifest: candidate.manifest, components, compose, write, tasks };
}
async function planned(options: Parameters<typeof fixture>[0] = {}) {
  const result = await fixture(options), inspection = await inspectModernLocalVerification(result.root);
  expect(inspection.status, canonicalJson(inspection)).toBe('modern-observed');
  const plan = await testPlan(inspection);
  expectCompleteLocalPlan(plan);
  return { ...result, inspection, plan };
}

describe('installed current runtime bridge without MR1 bypass', () => {
  it('preserves native-path descendant identity fields instead of treating them as ancestors', async () => {
    const f = await fixture(), inspection = await inspectModernLocalVerification(f.root);
    expect(inspection.status, canonicalJson(inspection)).toBe('modern-observed');
    if (inspection.status !== 'modern-observed') throw new Error('Expected actual source capture.');
    const target = path.join(f.root, 'liftoff.manifest.json'), details = await lstat(target, { bigint: true });
    expect(inspection.snapshot.physical.find(entry => entry.path === target)?.identity).toBe([
      details.dev, details.ino, details.mode, details.nlink, details.size,
      details.mtimeNs, details.ctimeNs, details.birthtimeNs
    ].join(':'));
    const ancestor = inspection.snapshot.physical.find(entry => entry.path === path.dirname(f.root));
    expect(ancestor?.identity?.split(':').slice(3, 7)).toEqual(['0', '0', '0', '0']);
  });

  async function installedFixture(profile: 'single-maintainer-gitflow' | 'team-gitflow', workflow: 'manual' | 'openspec' | 'spec-kit') {
    const f = await fixture({ profile, workflow });
    if (f.manifest.governance.profile === 'none') throw new Error('Expected governed fixture.');
    const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:f.manifest.project,framework:f.manifest.framework});
    const api = createModernActivationRecordContract(projectCatalog, {
      recordedIdentity:f.manifest.governance.activationIdentity,profile,policyVersion:f.manifest.governance.policyVersion,
      selection:{...leaf,profile},pluginResolutionDigest:f.manifest.plugins.resolutionDigest,
      activeLayoutDigest:f.manifest.governance.activationIdentity.activeLayoutDigest
    });
    const state = api.createInitialState({
      repository:{id:'local:11111111-1111-4111-8111-111111111111',name:f.manifest.project.name,defaultBranch:'develop'},
      applicability:{statePath:'none',privateStagingDast:'unknown',credentialRequired:'unknown'},createdAt:'2026-09-01T12:00:00.000Z'
    });
    await f.write(['governance','activation-state.json'],canonicalJson(state));
    return {...f,state};
  }
  it.each((['single-maintainer-gitflow','team-gitflow'] as const).flatMap(profile=>workflows.map(workflow=>({profile,workflow}))))(
    'observes installed $profile/$workflow only through independent preflight',async({profile,workflow})=>{
      const f=await installedFixture(profile,workflow);
      expect((await inspectModernLocalVerification(f.root)).status).toBe('blocked');
      const inspection=await inspectModernLocalRuntime(f.root);
      expect(inspection).toMatchObject({status:'observed',installed:{classification:'current',current:{state:f.state}}});
      const plan=await withPortableRejection(()=>planModernLocalRuntime(inspection));
      expect(plan.execution).toBe('not-authorized');expect(plan.publication).toBe('codec-unavailable-not-authorized');
      if(!plan.localPlan)throw new Error('Actual captured local plan required.');
      expectCompleteLocalPlan(plan.localPlan);
      expect((await withPortableRejection(()=>reinspectModernLocalRuntime(f.root,plan))).status).toBe('observed');
    }
  );
  it('rejects forged summaries and changed installed bytes on fresh reinspection',async()=>{
    const f=await installedFixture('single-maintainer-gitflow','manual'),inspection=await inspectModernLocalRuntime(f.root);
    if(inspection.status!=='observed')throw new Error(JSON.stringify(inspection));
    const plan=await withPortableRejection(()=>planModernLocalRuntime(inspection));
    const changed=structuredClone(inspection);
    Reflect.set(changed.installed,'classification','fresh');
    await expect(planModernLocalRuntime(changed)).rejects.toThrow(/summary/);
    await f.write(['governance','activation-state.json'],JSON.stringify(f.state,null,2)+'\n');
    expect((await withPortableRejection(()=>reinspectModernLocalRuntime(f.root,plan))).status).toBe('blocked');
  });
  it('copies installed snapshot/prior-plan fields before every async reconstruction',async()=>{
    const f=await installedFixture('team-gitflow','manual'),inspection=await inspectModernLocalRuntime(f.root);
    if(inspection.status!=='observed')throw new Error(JSON.stringify(inspection));
    const getter=vi.fn(()=>{throw new Error('late installed input hook');});
    const pending=withPortableRejection(()=>planModernLocalRuntime(inspection));
    Object.defineProperty(inspection.installed.snapshot.files[0],'content',{enumerable:true,get:getter});
    const plan=await pending;
    expect(plan.localPlan).not.toBeNull();
    const prior=structuredClone(plan),reinspection=withPortableRejection(()=>reinspectModernLocalRuntime(f.root,prior));
    Object.defineProperty(prior,'inspection',{enumerable:true,get:getter});
    expect((await reinspection).status).toBe('observed');expect(getter).not.toHaveBeenCalled();
  });
});

describe('actual modern local source and literal plans', () => {
  it('restores rejection-only runtime scoping after a rejected operation', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'arch');
    await expect(withPortableRejection(async () => { throw new Error('test-only failure'); })).rejects.toThrow('test-only failure');
    expect(Object.getOwnPropertyDescriptor(process, 'arch')).toEqual(descriptor);
    expect(rejectionScopeActive).toBe(false);
  });
  it('rejects invalid lanes and native mismatch rather than skipping all qualification', () => {
    expect(() => resolveHclTestLane('invalid', { platform: process.platform, arch: process.arch, node: process.versions.node })).toThrow(/Invalid/);
    expect(() => resolveHclTestLane('native', { platform: 'unqualified-test-host', arch: process.arch, node: process.versions.node })).toThrow(/requires actual/);
  });
  it.each(profiles.flatMap(profile => workflows.map(workflow => ({ profile, workflow }))))(
    'observes $profile/$workflow without execution or invented state', async options => {
      const { root, plan, manifest } = await planned(options);
      expect(plan.execution).toBe('not-authorized');
      expect(plan.context?.kind).toBe(options.profile === 'none' ? 'governance-none' : 'governed');
      if (plan.context?.kind === 'governed') expect(plan.context.identity).toEqual(manifest.governance.profile === 'none' ? undefined : manifest.governance.activationIdentity);
      expect(plan.checks.find(check => check.id === 'framework-source')?.status).toBe(options.workflow === 'manual' ? 'inapplicable' : 'planned');
      expect(plan.checks.some(check => check.command?.args.includes('init'))).toBe(false);
      await expect(lstat(path.join(root, 'governance', 'activation-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await testReinspect(root, plan)).status).toBe('modern-observed');
    }, 60_000
  );
  it.each([
    ...['python-fastapi', 'node-fastify', 'go-huma'].map(stack => ({ stack })),
    ...projectCatalog.patterns.map(({ id }) => ({ pattern: id }))
  ])('uses actual custom scopes for $stack/$pattern', async options => {
    const { plan, components } = await planned({ ...options, custom: true, frontend: true });
    const backend = components.get('backend')!;
    const backendCheck = plan.checks.find(check => check.id === 'backend-tests')!;
    if (backendCheck.command?.executable === 'uv') expect(backendCheck.command.args).toContain(backend.join('/'));
    else expect(backendCheck.cwdPathParts).toEqual(backend);
    expect(plan.checks.filter(check => check.id.startsWith('tofu-validate:')).map(check => check.id)).toContain('tofu-validate:opentofu-environment:prod');
    expect(new Set(plan.checks.map(check => check.id)).size).toBe(plan.checks.length);
  }, 60_000);
  it.each(['partial', 'unresolved'] as const)('does not equate valid %s layout with complete input', async layout => {
    const { root } = await fixture({ layout }), result = await testPlan(await inspectModernLocalVerification(root));
    expect(result.status).toBe('blocked');
    expect(result.blockers.join(' ')).toMatch(/binding|unresolved/);
  });
  it.each(['openspec', 'spec-kit'] as const)('keeps none+legacy %s distinct from Manual', async workflow => {
    const { root } = await fixture({ profile: 'none', workflow, agents: [] });
    const plan = await testPlan(await inspectModernLocalVerification(root));
    expect(plan.checks.find(check => check.id === 'framework-source')).toMatchObject({ status: 'blocked' });
    expect(plan.context?.kind).toBe('governance-none');
  });
});

describe('captured configuration relationships and raw freshness', () => {
  nativeIt('reparses real local HCL module and file references within selected scopes', async () => {
    const f = await fixture({ custom: true }), application = f.components.get('opentofu-application')!, env = f.components.get('opentofu-environment:dev')!;
    await f.write([...application, 'policy.json'], '{"local":true}\n');
    await f.write([...application, 'main.tf'], 'locals {\n  policy = file("./policy.json")\n}\n');
    await f.write([...env, 'main.tf'], `module "application" {\n  source = "${path.posix.relative(env.join('/'), application.join('/'))}"\n}\n`);
    const inspection = await inspectModernLocalVerification(f.root), plan = await testPlan(inspection);
    expect(plan.blockers).toEqual([]);
    expect((await testReinspect(f.root, plan)).status).toBe('modern-observed');
  });

  describe('parent independent required-input closure', () => {
    it.each([false, true])('admits the captured Python package parent without selecting sibling source, custom=%s', async custom => {
      const f = await fixture({ stack: 'python-fastapi', custom }), backend = f.components.get('backend')!;
      const config = [...backend, 'pyproject.toml'], sibling = [...backend.slice(0, -1), 'unselected_sibling.py'];
      const original = await readFile(path.join(f.root, ...config), 'utf8');
      await f.write(config, original + '\n[tool.pytest.ini_options]\npythonpath = [".."]\ntestpaths = ["tests"]\n');
      await f.write(sibling, 'raise RuntimeError("Unselected source must not be copied.")\n');
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      if (inspection.status !== 'modern-observed') throw new Error('Expected real selected source capture.');
      expect(inspection.snapshot.files.some(file => file.pathParts.join('/') === sibling.join('/'))).toBe(false);
      const plan = await testPlan(inspection);
      expectCompleteLocalPlan(plan);
      expect(plan.checks.find(check => check.id === 'backend-tests')?.status).toBe('planned');
      expect(plan.execution).toBe('not-authorized');
      await f.write([...backend.slice(0, -1), 'new_sibling.py'], 'value = 1\n');
      expect((await testReinspect(f.root, plan)).status).toBe('blocked');
      expect(await readFile(path.join(f.root, ...sibling), 'utf8')).toContain('Unselected source must not be copied.');
    });

    it.each([
      ['tool.pytest.ini_options', 'testpaths', '..'],
      ['tool.unrelated', 'pythonpath', '..'],
      ['tool.pytest.ini_options', 'pythonpath', '../..'],
      ['tool.pytest.ini_options', 'pythonpath', '../'],
      ['tool.pytest.ini_options', 'pythonpath', './../'],
      ['tool.pytest.ini_options', 'pythonpath', '../unselected'],
      ['tool.pytest.ini_options', 'pythonpath', '/outside']
    ])('does not broaden %s %s=%s into an input root', async (table, field, value) => {
      const f = await fixture({ stack: 'python-fastapi', custom: true }), backend = f.components.get('backend')!;
      const config = [...backend, 'pyproject.toml'];
      const original = await readFile(path.join(f.root, ...config), 'utf8');
      await f.write(config, `${original}\n[${table}]\n${field} = [${JSON.stringify(value)}]\n`);
      const plan = await testPlan(await inspectModernLocalVerification(f.root));
      expect(plan.checks.find(check => check.id === 'backend-tests')?.status).toBe('blocked');
      expect(plan.execution).toBe('not-authorized');
    });

    it.each(projectCatalog.patterns.map(({ id }) => id))('uses the same Python namespace interpretation for the %s backend and selected worker', async pattern => {
      const f = await fixture({ pattern, custom: true }), backend = f.components.get('backend')!;
      const config = [...backend, 'pyproject.toml'];
      await f.write(config, (await readFile(path.join(f.root, ...config), 'utf8')) +
        '\n[tool.pytest.ini_options]\npythonpath = [".."]\ntestpaths = ["tests"]\n');
      const plan = await testPlan(await inspectModernLocalVerification(f.root));
      expectCompleteLocalPlan(plan);
      expect(plan.checks.find(check => check.id === 'backend-tests')?.status).toBe('planned');
      expect(plan.checks.find(check => check.id === 'worker-tests')?.status).toBe(
        f.components.has('function-worker') ? 'planned' : 'inapplicable'
      );
    });

    it('requires the Python search parent to exist in the captured directory inventory', async () => {
      const f = await fixture({ stack: 'python-fastapi', custom: true }), backend = f.components.get('backend')!;
      const config = [...backend, 'pyproject.toml'];
      await f.write(config, (await readFile(path.join(f.root, ...config), 'utf8')) +
        '\n[tool.pytest.ini_options]\npythonpath = [".."]\n');
      const inspection = await inspectModernLocalVerification(f.root);
      if (inspection.status !== 'modern-observed') throw new Error('Expected real source capture.');
      const captured = { ...inspection, snapshot: { ...inspection.snapshot,
        directories: inspection.snapshot.directories.filter(directory =>
          directory.pathParts.join('/') !== backend.slice(0, -1).join('/'))
      } };
      const plan = await testPlan(captured);
      expect(plan.checks.find(check => check.id === 'backend-tests')).toMatchObject({
        status: 'blocked', reasons: ['Python package search parent is missing, protected or uncaptured.']
      });
    });

    it.each([0, 1])('counts Python search namespaces against the original reference bound plus %s', async excess => {
      const f = await fixture({ stack: 'python-fastapi' }), backend = f.components.get('backend')!;
      const config = [...backend, 'pyproject.toml'];
      await f.write(config, (await readFile(path.join(f.root, ...config), 'utf8')) +
        '\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ' +
        JSON.stringify(Array.from({ length: modernLocalBounds.references - 1 + excess }, () => '..')) + '\n');
      const plan = await testPlan(await inspectModernLocalVerification(f.root));
      const check = plan.checks.find(check => check.id === 'backend-tests');
      expect(check?.status).toBe(excess ? 'blocked' : 'planned');
      if (excess) expect(check?.reasons).toEqual(['Local configuration exceeds the reference count bound.']);
    });

    it('blocks inherited TypeScript config references outside the captured scopes', async () => {
      const f = await planned(), backend = f.components.get('backend')!;
      await f.write([...backend, 'tsconfig.json'], '{"extends":"./config/base.json"}\n');
      await f.write([...backend, 'config', 'base.json'], '{"extends":"../../../unobserved-tsconfig.json"}\n');
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      const plan = await testPlan(inspection);
      expect(plan.checks.find(check => check.id === 'backend-tests')?.status).toBe('blocked');
    });
    it('blocks unobserved Compose label_file configuration inputs', async () => {
      const f = await planned();
      await f.write(f.compose, 'services:\n  app:\n    image: example/local:source\n    label_file: ../unobserved-labels.env\n');
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      const plan = await testPlan(inspection);
      expect(plan.checks.find(check => check.id === 'compose-config')?.status).toBe('blocked');
    });
    nativeIt('blocks nested templatefile input references that are not independently captured', async () => {
      const f = await planned(), application = f.components.get('opentofu-application')!;
      await f.write([...application, 'main.tf'], 'locals { policy = templatefile("./policy.tftpl", {}) }\n');
      await f.write([...application, 'policy.tftpl'], '${file("../../../../unobserved-template-input.txt")}\n');
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      const plan = await testPlan(inspection);
      expect(plan.checks.find(check => check.id === 'tofu-format:opentofu-application')?.status).toBe('blocked');
    });
    it('does not admit recursive OpenTofu formatting over an excluded source subtree', async () => {
      const f = await planned(), application = f.components.get('opentofu-application')!;
      await f.write([...application, 'secrets', 'hidden.tf'], 'locals { hidden = file("/unobserved-secret-input") }\n');
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      if (inspection.status === 'modern-observed') {
        expect(inspection.snapshot.files.some(file => file.pathParts.at(-1) === 'hidden.tf')).toBe(false);
      }
      const plan = await testPlan(inspection);
      expect(plan.checks.find(check => check.id === 'tofu-format:opentofu-application')?.status).toBe('blocked');
    });
  });

  describe('captured TypeScript configuration graph', () => {
    it.each(['backend', 'frontend'] as const)('follows multi-level arbitrary config names, shared targets and directory projects for %s', async component => {
      const f = await fixture({ custom: true, frontend: true }), parts = f.components.get(component)!;
      await f.write([...parts, 'tsconfig.json'], '{"extends":"./config/base","references":[{"path":"./Project Space"}]}\n');
      await f.write([...parts, 'config', 'base.json'], '{"extends":"./shared.json","references":[{"path":"./project.json"}]}\n');
      await f.write([...parts, 'config', 'project.json'], '{"extends":"./shared.json"}\n');
      await f.write([...parts, 'Project Space', 'tsconfig.json'], '{"extends":"../config/shared.json"}\n');
      await f.write([...parts, 'config', 'shared.json'], JSON.stringify({
        compilerOptions: { rootDir: '../src' }, files: ['../src/source.ts'], include: ['../src/**/*.ts'], exclude: ['../src/excluded/**']
      }) + '\n');
      await f.write([...parts, 'src', 'source.ts'], 'export const captured = true;\n');
      await f.write([...parts, 'src', 'excluded', 'source.ts'], 'export const excluded = true;\n');
      const inspection = await inspectModernLocalVerification(f.root), plan = await testPlan(inspection);
      expectCompleteLocalPlan(plan);
      expect(plan.checks.find(check => check.id === (component === 'backend' ? 'backend-tests' : 'frontend-build'))?.status).toBe('planned');
      expect((await testReinspect(f.root, plan)).status).toBe('modern-observed');
      const inherited = [...parts, 'config', 'shared.json'];
      await f.write(inherited, (await readFile(path.join(f.root, ...inherited), 'utf8')).replaceAll('\n', '\r\n'));
      const changed = await testPlan(await inspectModernLocalVerification(f.root));
      expectCompleteLocalPlan(changed);
      expect(changed.observationDigest).not.toBe(plan.observationDigest);
      expect(changed.baselineDigest).not.toBe(plan.baselineDigest);
      expect((await testReinspect(f.root, plan)).status).toBe('blocked');
    });

    const edges = [
      { label: 'missing inheritance', config: { extends: './missing.json' }, reason: /missing|not captured/ },
      { label: 'escaping inheritance', config: { extends: '../../../outside.json' }, reason: /escape|portable|path/ },
      { label: 'external inheritance', config: { extends: '@unobserved/config' }, reason: /External|unsupported/ },
      { label: 'excluded inheritance', config: { extends: '../secrets/hidden.json' }, reason: /protected/ },
      { label: 'cyclic inheritance', config: { extends: './base.json' }, reason: /cycle/ },
      { label: 'missing project', config: { references: [{ path: './missing-project.json' }] }, reason: /missing|not captured/ },
      { label: 'escaping project', config: { references: [{ path: '../../../outside.json' }] }, reason: /escape|portable|path/ },
      { label: 'external project', config: { references: [{ path: 'https://example.invalid/config.json' }] }, reason: /absolute|unsupported/ },
      { label: 'excluded project', config: { references: [{ path: '../secrets/hidden.json' }] }, reason: /protected/ },
      { label: 'cyclic project', config: { references: [{ path: './base.json' }] }, reason: /cycle/ }
    ];
    it.each((['backend', 'frontend'] as const).flatMap(component => edges.map(edge => ({ component, ...edge }))))(
      'blocks reached $label for $component without uncaptured reads', async ({ component, config, reason }) => {
        const f = await fixture({ frontend: true }), parts = f.components.get(component)!;
        await f.write([...parts, 'tsconfig.json'], '{"extends":"./config/base.json"}\n');
        await f.write([...parts, 'config', 'base.json'], JSON.stringify(config));
        await f.write([...parts, 'secrets', 'hidden.json'], 'Private config not an input.\n');
        await chmod(path.join(f.root, ...parts, 'secrets', 'hidden.json'), 0);
        const inspection = await inspectModernLocalVerification(f.root);
        expect(inspection.status).toBe('modern-observed');
        if (inspection.status === 'modern-observed') expect(inspection.snapshot.files.some(file => file.pathParts.at(-1) === 'hidden.json')).toBe(false);
        const result = await testPlan(inspection);
        const check = result.checks.find(check => check.id === (component === 'backend' ? 'backend-tests' : 'frontend-build'))!;
        expect(check.status).toBe('blocked'); expect(check.reasons.join(' ')).toMatch(reason);
      }
    );
    it.each([
      { files: ['../../../outside.ts'] },
      { include: ['../../../outside/**/*.ts'] },
      { exclude: ['../../../outside/**/*'] },
      { compilerOptions: { rootDir: '../../../outside' } },
      { compilerOptions: { paths: { external: ['../../../outside.ts'] } } },
      { compilerOptions: { typeRoots: ['../../../outside'] } },
      { compilerOptions: { rootDirs: ['../../../outside'] } },
      { compilerOptions: { baseUrl: '../../../outside' } },
      { compilerOptions: [] }
    ])('applies the same input-root interpreter to reached arbitrary names %#', async config => {
      const f = await fixture({ frontend: true }), parts = f.components.get('frontend')!;
      await f.write([...parts, 'tsconfig.json'], '{"references":[{"path":"./config/custom.json"}]}\n');
      await f.write([...parts, 'config', 'custom.json'], JSON.stringify(config));
      const result = await testPlan(await inspectModernLocalVerification(f.root));
      expect(result.checks.find(check => check.id === 'frontend-build')?.status).toBe('blocked');
    });
    it('keeps shared configuration memoization separate from global edge admission', async () => {
      const f = await fixture({ frontend: true }), backend = f.components.get('backend')!, frontend = f.components.get('frontend')!;
      await f.write([...backend, 'config', 'shared.json'], '{}\n');
      await f.write([...backend, 'tsconfig.json'], JSON.stringify({ references: Array.from({ length: 1024 }, () => ({ path: './config/shared.json' })) }));
      const sharedFromFrontend = path.posix.relative(frontend.join('/'), [...backend, 'config', 'shared.json'].join('/'));
      await f.write([...frontend, 'tsconfig.json'], JSON.stringify({ references: Array.from({ length: 1024 }, () => ({ path: sharedFromFrontend })) }));
      const result = await testPlan(await inspectModernLocalVerification(f.root));
      expectCompleteLocalPlan(result);
      await f.write([...frontend, 'tsconfig.json'], JSON.stringify({ references: Array.from({ length: 1025 }, () => ({ path: sharedFromFrontend })) }));
      const excess = await testPlan(await inspectModernLocalVerification(f.root));
      expect(excess.checks.find(check => check.id === 'frontend-build')).toMatchObject({ status: 'blocked', reasons: [expect.stringContaining('reference count')] });
    }, 60_000);
    it('traverses a deep captured graph iteratively and still detects its terminal cycle', async () => {
      const f = await fixture(), backend = f.components.get('backend')!;
      await f.write([...backend, 'tsconfig.json'], '{"extends":"./config/level-0.json"}\n');
      for (let index = 0; index < 80; index++) {
        await f.write([...backend, 'config', `level-${index}.json`], index === 79 ? '{}' : JSON.stringify({ extends: `./level-${index + 1}.json` }));
      }
      expectCompleteLocalPlan(await testPlan(await inspectModernLocalVerification(f.root)));
      await f.write([...backend, 'config', 'level-79.json'], '{"references":[{"path":"./level-0.json"}]}\n');
      const result = await testPlan(await inspectModernLocalVerification(f.root));
      expect(result.checks.find(check => check.id === 'backend-tests')).toMatchObject({
        status: 'blocked', reasons: [expect.stringContaining('cycle')]
      });
    }, 60_000);
    it('reconstructs inherited graph semantics solely from copied captured bytes', async () => {
      const f = await fixture(), parts = f.components.get('backend')!;
      await f.write([...parts, 'tsconfig.json'], '{"extends":"./settings/base.json"}\n');
      await f.write([...parts, 'settings', 'base.json'], '{"compilerOptions":{"strict":true}}\n');
      const inspection = await inspectModernLocalVerification(f.root);
      if (inspection.status !== 'modern-observed') throw new Error('Expected captured inputs.');
      const pending = testPlan(inspection);
      const getter = vi.fn(() => { throw new Error('Late inherited config getter.'); });
      const inherited = inspection.snapshot.files.find(file => file.pathParts.at(-1) === 'base.json')!;
      Object.defineProperty(inherited, 'content', { get: getter, enumerable: true });
      const moved = `${f.root}-captured`;
      await rename(f.root, moved); cleanups.push(moved);
      expectCompleteLocalPlan(await pending);
      expect(getter).not.toHaveBeenCalled();
    });
  });

  describe('unsupported secondary Compose and HCL source declarations', () => {
    it.each([
      'label_file: ../private-labels.env',
      'label_file: [../private-labels.env, ./another.env]',
      'credential_spec:\n      file: ../private-credential.json',
      'credential_spec:\n      registry: private-spec',
      'credential_spec: file://../private-credential.json'
    ])('blocks unsupported Compose source form %s without reading it', async declaration => {
      const f = await fixture();
      await f.write(['private-labels.env'], 'Private labels.\n');
      await f.write(['private-credential.json'], 'Private credentials.\n');
      await chmod(path.join(f.root, 'private-labels.env'), 0);
      await chmod(path.join(f.root, 'private-credential.json'), 0);
      await f.write(f.compose, `services:\n  app:\n    image: example/local:source\n    ${declaration}\n`);
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      if (inspection.status === 'modern-observed') {
        expect(inspection.snapshot.files.some(file => file.pathParts.some(part => part.startsWith('private-')))).toBe(false);
      }
      const plan = await testPlan(inspection), check = plan.checks.find(check => check.id === 'compose-config')!;
      expect(check.status).toBe('blocked');
      expect(check.reasons.join(' ')).toMatch(declaration.includes('credential_spec') ? /credential_spec/ : /label_file/);
    });
    it('retains ordinary labels and captured literal Compose config/build inputs', async () => {
      const f = await fixture({ custom: true }), backend = f.components.get('backend')!;
      await f.write([...backend, 'local-config.json'], '{"local":true}\n');
      await f.write([...backend, 'Dockerfile'], 'FROM scratch\n');
      const relative = path.posix.relative(path.posix.dirname(f.compose.join('/')), backend.join('/'));
      await f.write(f.compose, `services:\n  app:\n    image: example/local:source\n    labels:\n      role: local\n    configs: [local]\n    build:\n      context: "${relative}"\n      dockerfile: Dockerfile\nconfigs:\n  local:\n    file: "${relative}/local-config.json"\n`);
      const plan = await testPlan(await inspectModernLocalVerification(f.root));
      expectCompleteLocalPlan(plan);
    });
    it('does not inspect protected local label or credential source files', async () => {
      const f = await fixture(), backend = f.components.get('backend')!;
      await f.write([...backend, 'secrets', 'labels.env'], 'Private local labels.\n');
      await f.write([...backend, 'secrets', 'credential.json'], 'Private local credential.\n');
      for (const file of ['labels.env', 'credential.json']) await chmod(path.join(f.root, ...backend, 'secrets', file), 0);
      for (const source of [
        `label_file: ${[...backend, 'secrets', 'labels.env'].join('/')}`,
        `credential_spec:\n      file: ${[...backend, 'secrets', 'credential.json'].join('/')}`
      ]) {
        await f.write(f.compose, `services:\n  app:\n    image: example/local:source\n    ${source}\n`);
        const inspection = await inspectModernLocalVerification(f.root);
        expect(inspection.status).toBe('modern-observed');
        if (inspection.status === 'modern-observed') expect(inspection.snapshot.files.some(file => file.pathParts.includes('secrets'))).toBe(false);
        expect((await testPlan(inspection)).checks.find(check => check.id === 'compose-config')?.status).toBe('blocked');
      }
    });
    nativeIt.each([
      { expression: 'templatefile("./policy.tftpl", {})', reason: 'templatefile is unsupported' },
      { expression: 'templatefile("./policy.tftpl", var.bindings)', reason: 'templatefile is unsupported' },
      { expression: 'templatefile(var.template_path, {})', reason: 'templatefile is unsupported' },
      { expression: 'templatefile("./policy.tftpl", { label = "actual" })', reason: 'templatefile is unsupported' }
    ])('blocks unsupported template closure for $expression', async ({ expression, reason }) => {
      const f = await fixture(), application = f.components.get('opentofu-application')!;
      await f.write([...application, 'main.tf'], `locals { policy = ${expression} }\n`);
      await f.write([...application, 'policy.tftpl'], '${file("../../../../private-template-input.txt")}\n');
      await f.write(['private-template-input.txt'], 'Do not read this nested source.\n');
      await chmod(path.join(f.root, 'private-template-input.txt'), 0);
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      if (inspection.status === 'modern-observed') expect(inspection.snapshot.files.some(file => file.pathParts.at(-1) === 'private-template-input.txt')).toBe(false);
      const plan = await testPlan(inspection);
      expect(plan.checks.find(check => check.id === 'tofu-format:opentofu-application')).toMatchObject({
        status: 'blocked', reasons: [expect.stringContaining(reason)]
      });
      expect(plan.checks.find(check => check.id === 'tofu-validate:opentofu-application')?.status).toBe('blocked');
    });
    nativeIt.each(['file', 'filebase64'])('preserves captured literal %s and local module relationships', async operation => {
      const f = await fixture({ custom: true }), application = f.components.get('opentofu-application')!, environment = f.components.get('opentofu-environment:dev')!;
      await f.write([...application, 'policy.json'], '{"local":true}\n');
      await f.write([...application, 'main.tf'], `locals { policy = ${operation}("./policy.json") }\n`);
      await f.write([...environment, 'main.tf'], `module "application" {\n source = "${path.posix.relative(environment.join('/'), application.join('/'))}"\n}\n`);
      const plan = await testPlan(await inspectModernLocalVerification(f.root));
      expectCompleteLocalPlan(plan);
    });
  });

  describe('recursive OpenTofu input coverage and policy identity', () => {
    it.each(['secrets', 'build', 'dist', '.terraform'])('blocks uncaptured %s subtree without weakening recursive format', async excluded => {
      const f = await planned(), application = f.components.get('opentofu-application')!;
      await f.write([...application, excluded, 'hidden.tf'], 'locals { hidden = file("/private/unobserved") }\n');
      await chmod(path.join(f.root, ...application, excluded, 'hidden.tf'), 0);
      const inspection = await inspectModernLocalVerification(f.root);
      expect(inspection.status).toBe('modern-observed');
      if (inspection.status === 'modern-observed') {
        expect(inspection.snapshot.files.some(file => file.pathParts.at(-1) === 'hidden.tf')).toBe(false);
        expect(inspection.snapshot.exclusions).toContainEqual({
          pathParts: [...application, excluded], kind: 'directory', reason: 'dependency-output-state-or-credential-tree'
        });
      }
      const plan = await testPlan(inspection), format = plan.checks.find(check => check.id === 'tofu-format:opentofu-application')!;
      expect(format.status).toBe('blocked');
      expect(format.reasons.join(' ')).toContain('excluded inputs');
      expect(format.command?.args).toEqual(['fmt', '-check', '-recursive']);
      expect(plan.checks.find(check => check.id === 'tofu-validate:opentofu-application')?.status).toBe('blocked');
      expect(plan.checks.find(check => check.id === 'tofu-format:opentofu-environment:dev')?.status).toBe(testLane.native ? 'planned' : 'blocked');
      expect((await testReinspect(f.root, f.plan)).status).toBe('blocked');
    });
    nativeIt('keeps complete captured recursive source coverage planned', async () => {
      const f = await fixture(), application = f.components.get('opentofu-application')!;
      await f.write([...application, 'nested', 'ordinary.tf'], 'locals { captured = true }\n');
      const plan = await testPlan(await inspectModernLocalVerification(f.root));
      expectCompleteLocalPlan(plan);
      expect(plan.checks.find(check => check.id === 'tofu-format:opentofu-application')?.command?.args).toContain('-recursive');
    });
    it('binds the fixed closure revision separately from unchanged parser resource policy', async () => {
      const { plan } = await planned();
      const legacyRecipe = {
        kind: 'liftoff-local-recipe-values', schemaVersion: 1, inputBounds: modernLocalBounds,
        computationPolicy: hclComputationPolicy,
        policy: { installedToolIdentity: 'not-observed', projectCode: 'requires-separate-authorization',
          preparation: 'never-implicit', network: 'not-isolated-by-offline-flags', stateAndHistoryExecutionPreflight: 'requires-mr2' },
        checks: plan.checks
      };
      expect(plan.recipeSet.digest).not.toBe(canonicalSha256(legacyRecipe));
      expect(plan.recipeSet.digest).toBe(canonicalSha256({ ...legacyRecipe, requiredInputClosurePolicy: modernLocalRequiredInputClosurePolicy }));
      expect(Object.isFrozen(modernLocalRequiredInputClosurePolicy)).toBe(true);
      expect(modernLocalRequiredInputClosurePolicy.revision).toBe(3);
      const { pythonPackageSearchPaths: _search, ...oldPolicy } = modernLocalRequiredInputClosurePolicy;
      expect(plan.recipeSet.digest).not.toBe(canonicalSha256({
        ...legacyRecipe, requiredInputClosurePolicy: { ...oldPolicy, revision: 2 }
      }));
      expect(plan.execution).toBe('not-authorized');
    });
  });
  nativeIt('plans from captured HCL while the project root is unavailable, without a project reader', async () => {
    const f = await planned(), moved = `${f.root}-captured`;
    await rename(f.root, moved); cleanups.push(moved);
    const reconstructed = await testPlan(f.inspection);
    expect(reconstructed).toEqual(f.plan);
  });
  nativeIt.each([
    'locals { value = file("../outside.json") }',
    'locals { value = file(var.path) }',
    'locals { value = timestamp() }',
    'module "remote" { source = "https://example.invalid/module" }',
    'terraform { backend "azurerm" {} }',
    'provider "azurerm" {}',
    'locals { broken = '
  ])('blocks unsupported real HCL without an empty fallback: %s', async content => {
    const f = await fixture(); await f.write([...f.components.get('opentofu-application')!, 'main.tf'], content);
    const plan = await testPlan(await inspectModernLocalVerification(f.root));
    expect(plan.status).toBe('blocked');
    expect(plan.checks.find(check => check.id === 'tofu-format:opentofu-application')?.status).toBe('blocked');
  });
  it.each([
    'services:\n  app:\n    image: ${UNOBSERVED}\n',
    'services:\n  app:\n    env_file: .env\n',
    'include: another.yml\nservices: {}\n',
    'services:\n  app:\n    build: ../../outside\n'
  ])('blocks unbound Compose inputs without opening them', async content => {
    const f = await fixture(); await f.write(f.compose, content);
    await f.write(['.env'], 'SHOULD_NOT_BE_CAPTURED=private\n');
    const inspection = await inspectModernLocalVerification(f.root);
    expect(inspection.status).toBe('modern-observed');
    if (inspection.status === 'modern-observed') expect(inspection.snapshot.files.some(file => file.pathParts.join('/') === '.env')).toBe(false);
    expect((await testPlan(inspection)).checks.find(check => check.id === 'compose-config')?.status).toBe('blocked');
  });
  it.for(['bytes', 'mode', 'membership', 'absent', 'inode'] as const)('rejects changed %s with a fresh reader', async (fault, { skip }) => {
    if (fault === 'mode' && process.platform === 'win32') skip('POSIX mode-change identity is unqualified on Windows.');
    const f = await planned({ workflow: 'openspec' }), backend = f.components.get('backend')!;
    const target = [...backend, 'tests', 'source.txt'], absolute = path.join(f.root, ...target);
    if (fault === 'bytes') await f.write(target, 'Changed.\n');
    if (fault === 'mode') await chmod(absolute, 0o600);
    if (fault === 'membership') await f.write([...backend, 'new-source.ts'], 'export const changed = true;\n');
    if (fault === 'absent') await f.write(['openspec', 'specs', 'node-fastify-application-baseline', 'spec.md'], 'Now present.\n');
    if (fault === 'inode') { const bytes = await readFile(absolute); await rm(absolute); await writeFile(absolute, bytes); }
    expect((await testReinspect(f.root, f.plan)).status).toBe('blocked');
  });
  it('rejects a replaced root with identical files and modes', async () => {
    const f = await planned(), previous = `${f.root}-original`;
    await rename(f.root, previous); cleanups.push(previous);
    await cp(previous, f.root, { recursive: true, preserveTimestamps: true });
    expect((await testReinspect(f.root, f.plan)).status).toBe('blocked');
  });
  it('separates real bootstrap checkbox/CRLF baseline normalization from raw replay', async () => {
    const f = await planned({ workflow: 'spec-kit' });
    await f.write(f.tasks!, (await readFile(path.join(f.root, ...f.tasks!), 'utf8')).replaceAll('[ ]', '[x]').replaceAll('\n', '\r\n'));
    const next = await testPlan(await inspectModernLocalVerification(f.root));
    expect(next.baselineDigest).toBe(f.plan.baselineDigest);
    expect(next.observationDigest).not.toBe(f.plan.observationDigest);
    expect((await testReinspect(f.root, f.plan)).status).toBe('blocked');
  });
  it('requires a concrete archive/main source relationship before logical baseline equivalence', async () => {
    const f = await planned({ workflow: 'openspec' }), name = 'bootstrap-observed-local-source';
    const source = ['openspec', 'changes', name], archive = ['openspec', 'changes', 'archive', `20260929-${name}`];
    await mkdir(path.join(f.root, 'openspec', 'changes', 'archive'), { recursive: true });
    await rename(path.join(f.root, ...source), path.join(f.root, ...archive));
    const main = ['openspec', 'specs', 'node-fastify-application-baseline', 'spec.md'];
    const archivedSpec = await readFile(path.join(f.root, ...archive, 'specs', 'node-fastify-application-baseline', 'spec.md'), 'utf8');
    await f.write(main, '# Main specification\n\n' + archivedSpec.replace('## ADDED Requirements', '## Requirements'));
    const next = await testPlan(await inspectModernLocalVerification(f.root));
    expectCompleteLocalPlan(next);
    expect(next.baselineDigest).toBe(f.plan.baselineDigest);
    expect(next.checks.find(check => check.id === 'framework-source')?.command?.args).toEqual(['validate', '--all', '--strict']);
    expect((await testReinspect(f.root, f.plan)).status).toBe('blocked');
    await f.write(main, '## Purpose\n\nUnrelated content.\n\n## Requirements\n');
    expect((await testPlan(await inspectModernLocalVerification(f.root))).checks.find(check => check.id === 'framework-source')?.status).toBe('blocked');
  });
  it('keeps arbitrary application checkboxes and line endings raw-sensitive', async () => {
    const f = await planned(), source = [...f.components.get('backend')!, 'tests', 'source.txt'];
    await f.write(source, '- [ ] Application text.\n');
    const first = await testPlan(await inspectModernLocalVerification(f.root));
    await f.write(source, '- [x] Application text.\r\n');
    const second = await testPlan(await inspectModernLocalVerification(f.root));
    expect(second.baselineDigest).not.toBe(first.baselineDigest);
  });
  it('rejects changed control bytes even when the root retains matching managed declarations', async () => {
    const f = await fixture(), artifact = f.manifest.managedArtifacts[0];
    await f.write(artifact.pathParts, 'Changed actual managed bytes.\n');
    expect((await inspectModernLocalVerification(f.root)).status).toBe('blocked');
  });
  it('does not open private configuration or irrelevant trees', async () => {
    const f = await fixture(), backend = f.components.get('backend')!;
    await f.write([...backend, '.env'], 'SECRET=not-an-input\n');
    await chmod(path.join(f.root, ...backend, '.env'), 0);
    await f.write(['Unselected', 'nested', 'liftoff.manifest.json'], 'not a selected project');
    const result = await inspectModernLocalVerification(f.root);
    expect(result.status).toBe('modern-observed');
    if (result.status === 'modern-observed') {
      expect(result.snapshot.files.some(file => file.pathParts.includes('.env') || file.pathParts.includes('Unselected'))).toBe(false);
    }
  });
  it.for(['symlink', 'hardlink', 'nested'] as const)('rejects %s boundaries rather than following them', async (fault, { skip }) => {
    const f = await fixture(), backend = f.components.get('backend')!, original = path.join(f.root, ...backend, 'tests', 'source.txt');
    if (fault === 'symlink') {
      try { await symlink(original, path.join(f.root, ...backend, 'linked.txt')); }
      catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          skip('This Windows host does not grant the symlink capability.');
        }
        throw error;
      }
    }
    if (fault === 'hardlink') await link(original, path.join(f.root, ...backend, 'linked.txt'));
    if (fault === 'nested') await f.write([...backend, 'inner', 'liftoff.manifest.json'], '{}');
    expect((await inspectModernLocalVerification(f.root)).status).toBe('blocked');
  });
  it.each([
    reviewedUpdateTransactionPathParts,
    reviewedRepairTransactionPathParts,
    reviewedAdoptionTransactionPathParts
  ].map(parts => [parts]))('checks actual pending transaction %j without an approval store', async parts => {
    const f = await fixture(); await f.write(parts, '{}');
    expect((await inspectModernLocalVerification(f.root)).status).toBe('blocked');
  });
  it('copies every nested inspection/prior field before its first await', async () => {
    const f = await planned();
    const inspection = structuredClone(f.inspection), getter = vi.fn(() => { throw new Error('late getter'); });
    const pending = testPlan(inspection);
    Object.defineProperty(inspection, 'snapshot', { enumerable: true, get: getter });
    expectCompleteLocalPlan(await pending);
    const prior = structuredClone(f.plan), reinspection = testReinspect(f.root, prior);
    Object.defineProperty(prior, 'inspection', { enumerable: true, get: getter });
    expect((await reinspection).status).toBe('modern-observed');
    expect(getter).not.toHaveBeenCalled();
  });
  it('does not reread late nested HCL bytes, paths, arrays or getters', async () => {
    const f = await planned(), inspection = structuredClone(f.inspection), getter = vi.fn(() => { throw new Error('late nested getter'); });
    if (inspection.status !== 'modern-observed') throw new Error('Expected captured source.');
    const hcl = inspection.snapshot.files.find(file => file.pathParts.at(-1) === 'main.tf')!;
    const pending = testPlan(inspection);
    Object.defineProperty(hcl, 'content', { enumerable: true, get: getter });
    Object.defineProperty(hcl.pathParts, '0', { enumerable: true, get: getter });
    Object.defineProperty(inspection.snapshot, 'directories', { enumerable: true, get: getter });
    expect(await pending).toEqual(f.plan);
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects missing, duplicated and substituted check recipes on direct replay', async () => {
    const f = await planned();
    for (const variant of ['missing', 'duplicate', 'substitute', 'policy'] as const) {
      const altered = JSON.parse(JSON.stringify(f.plan));
      if (variant === 'missing') altered.checks.pop();
      if (variant === 'duplicate') altered.checks.push(altered.checks[0]);
      if (variant === 'substitute') altered.checks[1].command.args = ['install'];
      if (variant === 'policy') altered.recipeSet.digest = '0'.repeat(64);
      await expect(testReinspect(f.root, altered)).rejects.toThrow(/reconstructed/);
    }
  });
  it.each([0, 1])('enforces actual inclusive application file bytes plus %i', async excess => {
    const f = await fixture(), backend = f.components.get('backend')!;
    await f.write([...backend, 'bounded.txt'], Buffer.alloc(modernLocalBounds.fileBytes + excess, 0x61));
    expect((await inspectModernLocalVerification(f.root)).status).toBe(excess ? 'blocked' : 'modern-observed');
  });
  it.each([0, 1])('enforces actual aggregate application bytes plus %i across selected scopes', async excess => {
    const f = await fixture(), before = await inspectModernLocalVerification(f.root);
    if (before.status !== 'modern-observed') throw new Error('Expected captured source.');
    const used = before.snapshot.files.filter(file => file.scope === 'application').reduce((sum, file) => sum + file.bytes, 0);
    let remaining = modernLocalBounds.totalBytes - used + excess, index = 0;
    const roots = [...f.components.values()];
    while (remaining > 0) {
      const bytes = Math.min(remaining, modernLocalBounds.fileBytes);
      await f.write([...roots[index % roots.length], `aggregate-${index}.txt`], Buffer.alloc(bytes, 0x61));
      remaining -= bytes; index += 1;
    }
    expect((await inspectModernLocalVerification(f.root)).status).toBe(excess ? 'blocked' : 'modern-observed');
  }, 60_000);
  it.each([0, 1])('enforces actual512 file admission plus %i', async excess => {
    const f = await fixture(), before = await inspectModernLocalVerification(f.root);
    if (before.status !== 'modern-observed') throw new Error('Expected captured source.');
    const used = before.snapshot.files.filter(file => file.scope === 'application').length;
    for (let index = 0; index < modernLocalBounds.files - used + excess; index += 1) {
      await f.write([...f.components.get('backend')!, `bucket-${Math.floor(index / 128)}`, `file-${index}.txt`], '');
    }
    const result = await inspectModernLocalVerification(f.root);
    expect(result.status).toBe(excess ? 'blocked' : 'modern-observed');
    if (result.status === 'modern-observed') expect(result.snapshot.files.filter(file => file.scope === 'application')).toHaveLength(512);
  }, 60_000);
  it.each([0, 1])('enforces actual256 directories plus %i', async excess => {
    const f = await fixture(), base = [...f.components.get('backend')!, 'bounded-directories'];
    await mkdir(path.join(f.root, ...base));
    const before = await inspectModernLocalVerification(f.root);
    if (before.status !== 'modern-observed') throw new Error('Expected captured source.');
    for (let index = 0; index < modernLocalBounds.directories - before.snapshot.directories.length + excess; index += 1) {
      await mkdir(path.join(f.root, ...base, `directory-${index}`));
    }
    const result = await inspectModernLocalVerification(f.root);
    expect(result.status).toBe(excess ? 'blocked' : 'modern-observed');
    if (result.status === 'modern-observed') expect(result.snapshot.directories).toHaveLength(256);
  }, 60_000);
  it.each([0, 1])('enforces actual256 directory entries plus %i', async excess => {
    const f = await fixture(), backend = f.components.get('backend')!, before = await inspectModernLocalVerification(f.root);
    if (before.status !== 'modern-observed') throw new Error('Expected captured source.');
    const count = before.snapshot.directories.find(directory => directory.pathParts.join('/') === backend.join('/'))!.entries.length;
    for (let index = 0; index < modernLocalBounds.directoryEntries - count + excess; index += 1) await f.write([...backend, `entry-${index}.txt`], '');
    expect((await inspectModernLocalVerification(f.root)).status).toBe(excess ? 'blocked' : 'modern-observed');
  }, 60_000);
  it.each([0, 1])('enforces actual12-part depth plus %i', async excess => {
    const f = await fixture(), backend = f.components.get('backend')!;
    const target = [...backend, ...Array.from({ length: modernLocalBounds.depth - backend.length - 1 + excess }, () => 'nested'), 'source.txt'];
    await f.write(target, 'Bounded depth.\n');
    expect((await inspectModernLocalVerification(f.root)).status).toBe(excess ? 'blocked' : 'modern-observed');
  });
  it.each([0, 1])('enforces actual8MiB manifest bytes plus %i without fake managed hashes', async excess => {
    const f = await fixture(), manifest = await readFile(path.join(f.root, 'liftoff.manifest.json'));
    await f.write(['liftoff.manifest.json'], Buffer.concat([manifest, Buffer.alloc(modernLocalBounds.controlFileBytes - manifest.length + excess, 0x20)]));
    expect((await inspectModernLocalVerification(f.root)).status).toBe(excess ? 'blocked' : 'modern-observed');
  }, 60_000);
  nativeIt.each([0, 1])('enforces actual2048 HCL file references plus %i', async excess => {
    const f = await fixture(), application = f.components.get('opentofu-application')!;
    await f.write([...application, 'policy.json'], '{"local":true}\n');
    const references = Array.from({ length: modernLocalBounds.references + excess }, () => 'file("./policy.json")').join(',\n');
    await f.write([...application, 'main.tf'], `locals {\n  policies = [${references}]\n}\n`);
    const result = await testPlan(await inspectModernLocalVerification(f.root));
    expect(result.status, result.blockers.join(' ')).toBe(excess ? 'blocked' : 'planned');
    if (excess) expect(result.blockers.join(' ')).toContain('reference count');
  }, 60_000);
  nativeIt.each([0, 1])('contains original500000-visit construction plus %i and recovers', async excess => {
    const f = await fixture(), application = f.components.get('opentofu-application')!;
    // Four structural nodes for the large locals list, eight for the two other
    // locals files, and four Compose nodes accompany the actual numeric values.
    const values = Array.from({ length: modernLocalBounds.tokens - 16 + excess }, () => '1').join(',');
    await f.write([...application, 'main.tf'], `locals {\n  values = [${values}]\n}\n`);
    const result = await testPlan(await inspectModernLocalVerification(f.root));
    expect(result.status).toBe('blocked');
    expect(result.blockers.join(' ')).toMatch(/Isolated HCL computation is unavailable/);
    await f.write([...application, 'main.tf'], 'locals { recovered = true }\n');
    expectCompleteLocalPlan(await testPlan(await inspectModernLocalVerification(f.root)));
  }, 60_000);
  nativeIt.each([0, 1])('enforces500000 cumulative visits plus %i through actual isolated planner admission', async excess => {
    const f = await fixture(), application = f.components.get('opentofu-application')!;
    for (let index = 0; index < 25; index++) {
      const count = 20000 - 4 - (index === 0 ? 16 : 0) + (index === 24 ? excess : 0);
      await f.write([...application, `bounded-${String(index).padStart(2, '0')}.tf`],
        `locals {\n values = [${Array.from({ length: count }, () => 'true').join(',')}]\n}\n`);
    }
    const result = await testPlan(await inspectModernLocalVerification(f.root));
    expect(result.status, result.blockers.join(' ')).toBe(excess ? 'blocked' : 'planned');
    if (excess) expect(result.blockers.join(' ')).toContain('node');
  }, 60_000);
  it('does not read live variable inputs or installed activation payloads', async () => {
    const f = await fixture(), application = f.components.get('opentofu-application')!;
    await f.write([...application, 'terraform.tfvars'], 'secret = "do-not-read"\n');
    await chmod(path.join(f.root, ...application, 'terraform.tfvars'), 0);
    const captured = await inspectModernLocalVerification(f.root);
    expect(captured.status).toBe('modern-observed');
    expect((await testPlan(captured)).checks.find(check => check.id === 'tofu-format:opentofu-application')).toMatchObject({
      status: 'blocked', reasons: [expect.stringContaining('Live OpenTofu variable inputs are excluded')]
    });
    await f.write(['governance', 'activation-state.json'], 'An installed payload must not be opened.');
    await chmod(path.join(f.root, 'governance', 'activation-state.json'), 0);
    expect((await inspectModernLocalVerification(f.root)).status).toBe('blocked');
  });
});

describe('parent supported configuration positives', () => {
  it.each(['label_file', 'credential_spec'])('treats ordinary label key %s as literal data, not a source declaration', async name => {
    const f = await planned();
    await f.write(f.compose, `services:\n  app:\n    image: example/local:source\n    labels:\n      ${name}: ordinary-metadata\n`);
    const inspection = await inspectModernLocalVerification(f.root);
    expect(inspection.status).toBe('modern-observed');
    const plan = await testPlan(inspection);
    expect(plan.checks.find(check => check.id === 'compose-config')?.status).toBe('planned');
  });
  nativeIt('plans supported jsonencode over a literal populated object', async () => {
    const f = await planned(), application = f.components.get('opentofu-application')!;
    await f.write([...application, 'main.tf'], 'locals { payload = jsonencode({ label = "actual" }) }\n');
    const inspection = await inspectModernLocalVerification(f.root);
    expect(inspection.status).toBe('modern-observed');
    const plan = await testPlan(inspection);
    expectCompleteLocalPlan(plan);
  });
});

describe('source-bound object keys and Compose service positions', () => {
  nativeIt.each([0, 1])('counts all actual static key/value occurrences at500000 visits plus %i despite memoization', async excess => {
    const f=await fixture(),application=f.components.get('opentofu-application')!;
    const source='locals { payloads = [jsonencode({ "label" = "actual" }), jsonencode({ "label" = "actual" })] }\n';
    const actual=(await parseIsolatedHcl([source]))[0];
    expect(actual.expressions.size).toBe(1);
    function astCount(node: HclExpression): number { return 1+node.children.reduce((sum,child)=>sum+astCount(child),0); }
    function visits(value: unknown): number {
      if(typeof value==='string'&&(value.includes('${')||value.includes('%{'))) {
        const ast=actual.expressions.get(value);
        if(!ast)throw new Error('Actual expression missing.');
        return 1+astCount(ast);
      }
      if(Array.isArray(value))return 1+value.reduce((sum,child)=>sum+visits(child),0);
      if(value!==null&&typeof value==='object')return 1+Object.values(value).reduce((sum:number,child)=>sum+visits(child),0);
      return 1;
    }
    const objectVisits=visits(actual.parsed);
    expect(objectVisits).toBeGreaterThan(4);
    await f.write([...application,'main.tf'],source);
    for(let index=0;index<25;index++){
      const length=20000-4-(index===0?16+objectVisits-4:0)+(index===24?excess:0);
      await f.write([...application,`counted-${index}.tf`],`locals {\n values = [${Array.from({length},()=>'true').join(',')}]\n}\n`);
    }
    const result=await testPlan(await inspectModernLocalVerification(f.root));
    expect(result.status,result.blockers.join(' ')).toBe(excess?'blocked':'planned');
    if(excess)expect(result.blockers.join(' ')).toContain('node');
  },60_000);
  nativeIt.each([
    'jsonencode({ "label" = "actual", other = 1 })',
    'jsonencode({ a = { nested = "actual" }, b = [ { nested = true } ] })',
    'merge({ prefix = "é🌍" }, { "clé" = "value", later = "q\\"uote" })',
    'merge({ first = file("./policy.json") }, { second = filebase64("./policy.json") })'
  ])('plans supported literal keys and fully captured values: %s', async expression => {
    const f = await fixture(), application = f.components.get('opentofu-application')!;
    await f.write([...application,'policy.json'],'{"local":true}\n');
    await f.write([...application,'main.tf'],`locals { payload = ${expression} }\n`);
    const plan = await testPlan(await inspectModernLocalVerification(f.root));
    expectCompleteLocalPlan(plan);
    expect((await testReinspect(f.root,plan)).status).toBe('modern-observed');
    await f.write([...application,'main.tf'],`locals { payload = ${expression} }\r\n`);
    expect((await testReinspect(f.root,plan)).status).toBe('blocked');
  });
  nativeIt.each(['file','filebase64'])('still rejects escaping %s value dependencies inside static objects', async name => {
    const f = await fixture(), application = f.components.get('opentofu-application')!;
    await f.write([...application,'main.tf'],`locals { payload = jsonencode({ label = ${name}("/unobserved/private-value") }) }\n`);
    const plan = await testPlan(await inspectModernLocalVerification(f.root));
    expect(plan.checks.find(check=>check.id==='tofu-format:opentofu-application')).toMatchObject({
      status:'blocked',reasons:[expect.stringContaining('reference')]
    });
  });
  nativeIt.each([
    '(file("./secrets/private-key.txt"))',
    '"${file("./secrets/private-key.txt")}"',
    '(filebase64("./secrets/private-key.txt"))',
    '(templatefile("./secrets/private-key.txt", {}))',
    '(var.key)',
    '("literal")',
    '"a\\\\b"'
  ])('does not turn unrepresented key %s into dependency-free metadata', async keyExpression => {
    const f = await fixture(), application = f.components.get('opentofu-application')!;
    await f.write([...application,'main.tf'],`locals { payload = jsonencode({ ${keyExpression} = "actual" }) }\n`);
    const inspection = await inspectModernLocalVerification(f.root);
    expect(inspection.status).toBe('modern-observed');
    if (inspection.status==='modern-observed') expect(inspection.snapshot.files.some(file=>file.pathParts.includes('private-key.txt'))).toBe(false);
    const plan=await testPlan(inspection);
    expect(plan.checks.find(check=>check.id==='tofu-format:opentofu-application')?.status).toBe('blocked');
    expect(plan.checks.find(check=>check.id==='tofu-validate:opentofu-application')?.status).toBe('blocked');
  });
  it.each(['labels','environment','x-literal-data'])('keeps %s data keys distinct from service sources', async field => {
    const f=await fixture();
    await f.write(f.compose,`services:\n  app:\n    image: example/local:source\n    ${field}:\n      label_file: ordinary-metadata\n      credential_spec: ordinary-metadata\n`);
    const plan=await testPlan(await inspectModernLocalVerification(f.root));
    expectCompleteLocalPlan(plan);
  });
  it('preserves a nested non-service label_file property as data', async () => {
    const f=await fixture();
    await f.write(f.compose,'services:\n  app:\n    image: example/local:source\n    deploy:\n      label_file: ../literal-not-a-service-declaration\n');
    const plan=await testPlan(await inspectModernLocalVerification(f.root));
    expect(plan.checks.find(check=>check.id==='compose-config')?.status).toBe('planned');
  });
  it.each([
    'label_file: ../private-labels.env',
    'label_file: [../private-labels.env]',
    'credential_spec:\n      file: ../private-credential.json'
  ])('blocks real service %s even when ordinary labels coexist', async declaration => {
    const f=await fixture();
    await f.write(f.compose,`services:\n  app:\n    image: example/local:source\n    labels:\n      label_file: ordinary-metadata\n      credential_spec: ordinary-metadata\n    ${declaration}\n`);
    const plan=await testPlan(await inspectModernLocalVerification(f.root));
    expect(plan.checks.find(check=>check.id==='compose-config')?.status).toBe('blocked');
  });
});

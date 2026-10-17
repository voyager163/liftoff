import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  modernActivationSourceContractForFamily, modernActivationSourceContracts,
  preWorkflowModernActivationSourceContracts, preCustodyModernActivationSourceContracts,
  readableModernActivationSourceContracts, modernActivationSourceIdentityTables
} from '../src/domain/governance/policy/identity.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { resolveModernManifestV8Source, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { resolveModernProjectSourceContext } from '../src/application/project/source-context.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { modernSourceRegistry, modernPreWorkflowRegistry, modernPreAssessmentRegistry } from '../src/application/project/modern-plugins.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import { FileSystemError } from '../src/domain/project/errors.js';
import { inspectModernInstalledActivation } from '../src/application/governance/modern-installed-preflight.js';
import { installedLocalBinding } from '../src/domain/governance/activation/modern-local-runtime.js';
import { selectedSourceCases, countSourceClones } from './fixtures/modern-selected-source-contract.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';

const tracking = vi.hoisted(() => ({
  collect: false, cold: false, refuseRow: false, mode: 'selected' as 'selected' | 'legacy',
  resolutions: 0, reads: [] as string[],
  lookups: [] as { family: string; profile: string; workflow: string; arrayCalls: number; rowCalls: number; graphRows: number }[],
  builds: [] as { version: number; profile: string; workflow: string; disposal: string }[]
}));
vi.mock('../src/domain/governance/activation/modern-graph.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/domain/governance/activation/modern-graph.js')>();
  return { ...actual, buildModernPhaseGraph: (...args: Parameters<typeof actual.buildModernPhaseGraph>) => {
    if (tracking.cold) tracking.builds.push({
      version: args[0].activationContractVersion, profile: args[1].profile,
      workflow: args[2], disposal: args[3] ?? 'protected-custody'
    });
    return actual.buildModernPhaseGraph(...args);
  } };
});
vi.mock('../src/domain/governance/policy/identity.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/domain/governance/policy/identity.js')>();
  return { ...actual, modernActivationSourceContractForFamily:
    (...args: Parameters<typeof actual.modernActivationSourceContractForFamily>) => {
      if (!tracking.collect && !tracking.refuseRow) return actual.modernActivationSourceContractForFamily(...args);
      const observed = countSourceClones(() => {
        if (tracking.refuseRow) return undefined;
        if (tracking.mode === 'selected') return actual.modernActivationSourceContractForFamily(...args);
        const [family, profile, workflow] = args;
        const rows = family === 'current' ? actual.modernActivationSourceContracts() :
          family === 'preWorkflow' ? actual.preWorkflowModernActivationSourceContracts() :
            actual.preCustodyModernActivationSourceContracts();
        return rows.find(row => row.identity.profile === profile && row.identity.workflow === workflow);
      });
      tracking.lookups.push({ family: args[0], profile: args[1], workflow: args[2],
        arrayCalls: observed.counts.arrayCalls, rowCalls: observed.counts.rowCalls, graphRows: observed.counts.graphRows });
      return observed.value;
    } };
});
vi.mock('../src/application/project/manifest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/application/project/manifest.js')>();
  return { ...actual,
    resolveModernManifestV8SourceContract: (...args: Parameters<typeof actual.resolveModernManifestV8SourceContract>) => {
      if (tracking.collect) tracking.resolutions++;
      return actual.resolveModernManifestV8SourceContract(...args);
    },
    resolveModernManifestV8Source: (...args: Parameters<typeof actual.resolveModernManifestV8Source>) => {
      if (tracking.collect) tracking.resolutions++;
      return actual.resolveModernManifestV8Source(...args);
    } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const record = (operation: string, target: unknown) => {
    if (tracking.collect) tracking.reads.push(`${operation}:${String(target)}`);
  };
  return { ...actual,
    open: (...args: Parameters<typeof actual.open>) => { record('open', args[0]); return actual.open(...args); },
    lstat: (...args: Parameters<typeof actual.lstat>) => { record('lstat', args[0]); return actual.lstat(...args); },
    opendir: (...args: Parameters<typeof actual.opendir>) => { record('opendir', args[0]); return actual.opendir(...args); },
    realpath: (...args: Parameters<typeof actual.realpath>) => { record('realpath', args[0]); return actual.realpath(...args); }
  };
});

const families = [
  { family: 'current', getter: modernActivationSourceContracts, registry: modernSourceRegistry, version: 5, disposal: 'protected-custody' },
  { family: 'preWorkflow', getter: preWorkflowModernActivationSourceContracts, registry: modernPreWorkflowRegistry, version: 4, disposal: 'protected-custody' },
  { family: 'preCustody', getter: preCustodyModernActivationSourceContracts, registry: modernPreAssessmentRegistry, version: 4, disposal: 'local-bootstrap' }
] as const;
const cases = selectedSourceCases();
const rows = families.flatMap(family => family.getter().map(source => ({ ...family, source })));
const measured: { family: string; hash: string; baseline: ReturnType<typeof countSourceClones>['counts'];
  selected: ReturnType<typeof countSourceClones>['counts'] }[] = [];
const cold: { family: string; initialBuilds: typeof tracking.builds; totalBuilds: number }[] = [];
const registryCopies: {
  mode: string; imports: { arrayCalls: number; rowCalls: number; graphRows: number };
  getters: { family: string; counts: { arrayCalls: number; rowCalls: number; graphRows: number } }[];
}[] = [];
const inspections: {
  mode: string; resolutions: number; reads: string[]; lookups: typeof tracking.lookups;
  observation: Awaited<ReturnType<typeof inspectModernInstalledActivation>>;
  startedAt: number; completedAt: number;
}[] = [];
const snapshots: { family: string; source: (typeof rows)[number]['source']; rowDigest: string }[] = [];
const roots: string[] = [], pending = new Set<Promise<unknown>>();
async function settled<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  try { return await work; } finally { pending.delete(work); }
}
afterEach(async () => {
  await Promise.allSettled(pending);
  tracking.collect = false; tracking.cold = false; tracking.refuseRow = false; tracking.mode = 'selected';
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  const output = process.env.LIFTOFF_FAMILY_SOURCE_OUTPUT;
  if (!output) return;
  await fs.writeFile(output, JSON.stringify({
    snapshots, measured, cold, registryCopies, inspections,
    full: { current: modernActivationSourceContracts(), preWorkflow: preWorkflowModernActivationSourceContracts(),
      preCustody: preCustodyModernActivationSourceContracts(), readable: readableModernActivationSourceContracts() },
    scalar: modernActivationSourceIdentityTables()
  }, null, 2) + '\n', { flag: 'wx' });
});

function request(value: (typeof rows)[number], profile: 'none' | (typeof rows)[number]['source']['identity']['profile'] = value.source.identity.profile) {
  const input = cases.find(entry => entry.source.identity.phaseGraphHash === value.source.identity.phaseGraphHash)!.input;
  const selection = { ...input.selection, profile }, work = selection.project.workload;
  const resolution = composeModernManifestPlugins({
    workload: work.kind, ...(work.kind === 'genai' ? { variant: work.pattern } : {}),
    stack: work.apiStack, cloud: work.cloud, workflow: selection.project.specWorkflow,
    agents: selection.project.agents, frontend: work.frontend ? 'included' : 'omitted',
    environments: work.environments, governanceProfile: profile
  }, { safeProjectName: toSafeProjectName(selection.project.name) }, value.registry()).resolution;
  const recordedPlugins = readManifestPluginMetadata({
    schemaVersion: 1, resolutionDigest: resolution.digest, selections: resolution.plugins
  }, { stack: work.apiStack, cloud: work.cloud, workflow: selection.project.specWorkflow, agents: selection.project.agents });
  return { selection, recordedPlugins };
}
function independent(left: unknown, right: unknown) {
  if (typeof left !== 'object' || left === null) return;
  expect(left).not.toBe(right);
  expect(Object.isFrozen(left)).toBe(true);
  for (const key of Object.keys(left)) independent(Reflect.get(left, key), Reflect.get(Object(right), key));
}
function resetObservation(mode: 'selected' | 'legacy') {
  tracking.mode = mode; tracking.resolutions = 0; tracking.reads = []; tracking.lookups = []; tracking.collect = true;
}
function compareFreshObservations(
  before: Extract<Awaited<ReturnType<typeof inspectModernInstalledActivation>>, { status: 'observed' }>,
  after: Extract<Awaited<ReturnType<typeof inspectModernInstalledActivation>>, { status: 'observed' }>
) {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const key of Object.keys(before)) {
    if (key !== 'snapshot') expect(Reflect.get(after, key)).toEqual(Reflect.get(before, key));
  }
  expect(Object.keys(after.snapshot).sort()).toEqual(Object.keys(before.snapshot).sort());
  expect(Object.keys(before.snapshot)).toContain('observedAt');
  for (const key of Object.keys(before.snapshot)) {
    if (key !== 'observedAt') expect(Reflect.get(after.snapshot, key)).toEqual(Reflect.get(before.snapshot, key));
  }
  // The physical/content binding excludes observedAt; each read validates its own unmodified timestamp.
  for (const capture of inspections) {
    if (capture.observation.status !== 'observed') throw new Error('Expected the complete raw installed observation.');
    const observedAt = Date.parse(capture.observation.snapshot.observedAt);
    expect(observedAt).toBeGreaterThanOrEqual(capture.startedAt);
    expect(observedAt).toBeLessThanOrEqual(capture.completedAt);
    expect(capture.observation.binding).toBe(installedLocalBinding(capture.observation.snapshot));
  }
  expect(Date.parse(after.snapshot.observedAt)).toBeGreaterThanOrEqual(Date.parse(before.snapshot.observedAt));
}

describe.each(rows)('selected full family $family/$source.identity.profile/$source.identity.workflow', value => {
  it('copies one complete detached row instead of six, while both use one clone invocation', () => {
    const { source, family, getter } = value, { profile, workflow } = source.identity;
    const baseline = countSourceClones(() => getter().find(row => row.identity.profile === profile && row.identity.workflow === workflow));
    const selected = countSourceClones(() => modernActivationSourceContractForFamily(family, profile, workflow));
    expect(baseline.value).toEqual(source); expect(selected.value).toEqual(source);
    expect(canonicalSha256(selected.value)).toBe(canonicalSha256(source));
    expect(baseline.counts).toMatchObject({ arrayCalls: 1, rowCalls: 0, graphRows: 6 });
    expect(selected.counts).toMatchObject({ arrayCalls: 0, rowCalls: 1, graphRows: 1,
      hashes: { [source.identity.phaseGraphHash]: 1 } });
    measured.push({ family, hash: source.identity.phaseGraphHash, baseline: baseline.counts, selected: selected.counts });
  });
  it('does not expose a private graph or alias any caller or prior/full-reader result', () => {
    const { source, family } = value, { profile, workflow } = source.identity;
    const first = modernActivationSourceContractForFamily(family, profile, workflow)!;
    const second = modernActivationSourceContractForFamily(family, profile, workflow)!;
    independent(first, second); independent(first, source);
    expect(Reflect.set(first.identity, 'policyVersion', 'changed')).toBe(false);
    expect(Reflect.set(first.graph.phases, '0', {})).toBe(false);
    expect(modernActivationSourceContractForFamily(family, profile, workflow)).toEqual(source);
  });
  it('preserves actual current and retained manifest family selection after complete validation', () => {
    for (const family of families) family.registry();
    const input = request(value), before = structuredClone(input);
    const baseline = countSourceClones(() => resolveModernManifestV8SourceContract(input));
    expect(baseline.counts.graphRows).toBe(1);
    expect(baseline.value.governanceSource).toEqual(value.source);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input.recordedPlugins)).toBe(true);
    if (!('identity' in baseline.value.governanceSource)) throw new Error('Expected the complete enabled source row.');
    snapshots.push({ family: value.family, source: baseline.value.governanceSource, rowDigest: canonicalSha256(baseline.value.governanceSource) });
  });
  it('retains exact family identity and capability guidance through shared source metadata', () => {
    const input = request(value);
    const resolved = resolveModernManifestV8Source(input);
    const releases = { current: 'current', preWorkflow: 'pre-workflow', preCustody: 'pre-assessment' } as const;
    expect(resolved.release).toBe(releases[value.family]);
    expect(resolved.contract.governanceSource).toEqual(value.source);
    const sourceInput = {
      selection: input.selection, plugins: input.recordedPlugins,
      activeLayout: { schemaVersion: 1, state: 'unresolved', bindings: [] }
    };
    const context = resolveModernProjectSourceContext(sourceInput);
    expect(context.sourceRelease).toBe(resolved.release);
    expect(context.source).toEqual(resolved.contract);
    const guide = buildModernManagedCore(sourceInput).find(file => file.logicalName === 'repository-governance-guide');
    if (!guide) throw new Error('Expected the selected family governance guide.');
    expect(guide.content.includes('`liftoff capabilities --json`')).toBe(value.family !== 'preCustody');
    expect(guide.content).toContain(`Activation contract: ${value.source.identity.activationContractVersion};`);
  });
});

it.each(families)('initializes only the requested cold $family table, without preinitializing the other two', async family => {
  vi.resetModules();
  const fresh = await vi.importActual<typeof import('../src/domain/governance/policy/identity.js')>(
    '../src/domain/governance/policy/identity.js'
  );
  tracking.builds = []; tracking.cold = true;
  const source = fresh.modernActivationSourceContractForFamily(family.family, 'single-maintainer-gitflow', 'manual')!;
  const initialBuilds = [...tracking.builds];
  expect(initialBuilds).toHaveLength(6);
  expect(initialBuilds.every(build => build.version === family.version && build.disposal === family.disposal)).toBe(true);
  expect(initialBuilds.map(build => `${build.profile}/${build.workflow}`).sort()).toEqual(
    rows.filter(row => row.family === family.family)
      .map(row => `${row.source.identity.profile}/${row.source.identity.workflow}`).sort()
  );
  expect(source).toEqual(rows.find(row => row.family === family.family &&
    row.source.identity.profile === 'single-maintainer-gitflow' && row.source.identity.workflow === 'manual')!.source);
  expect(fresh.modernActivationSourceContractForFamily(family.family, 'team-gitflow', 'openspec')).toBeDefined();
  expect(tracking.builds).toHaveLength(6);
  fresh.modernActivationSourceContracts(); fresh.preWorkflowModernActivationSourceContracts(); fresh.preCustodyModernActivationSourceContracts();
  expect(tracking.builds).toHaveLength(18);
  cold.push({ family: family.family, initialBuilds, totalBuilds: tracking.builds.length });
  tracking.cold = false;
});

it('separately discloses unchanged cold module and registry copies without retaining cloned arguments', async () => {
  vi.doUnmock('../src/domain/governance/policy/identity.js');
  for (const mode of ['legacy', 'selected'] as const) {
    tracking.mode = mode;
    vi.resetModules();
    const original = globalThis.structuredClone;
    const counts = { arrayCalls: 0, rowCalls: 0, graphRows: 0 };
    const row = (value: unknown) => typeof value === 'object' && value !== null &&
      Object.hasOwn(value, 'identity') && Object.hasOwn(value, 'graph');
    const observe: typeof globalThis.structuredClone = (value, options) => {
      if (Array.isArray(value)) {
        let copied = 0;
        for (const entry of value) if (row(entry)) copied++;
        if (copied) { counts.arrayCalls++; counts.graphRows += copied; }
      } else if (row(value)) { counts.rowCalls++; counts.graphRows++; }
      return original(value, options);
    };
    globalThis.structuredClone = observe;
    try {
      const fresh = await import('../src/application/project/modern-plugins.js');
      const imports = { ...counts }, getters: (typeof registryCopies)[number]['getters'] = [];
      expect(imports).toEqual({ arrayCalls: 0, rowCalls: 0, graphRows: 0 });
      for (const [family, registry] of [
        ['current', fresh.modernSourceRegistry], ['preWorkflow', fresh.modernPreWorkflowRegistry],
        ['preCustody', fresh.modernPreAssessmentRegistry]
      ] as const) {
        counts.arrayCalls = 0; counts.rowCalls = 0; counts.graphRows = 0;
        registry();
        getters.push({ family, counts: { ...counts } });
      }
      expect(getters[0].counts.graphRows).toBe(6);
      registryCopies.push({ mode, imports, getters });
    } finally { globalThis.structuredClone = original; }
  }
  expect(registryCopies[0].imports).toEqual(registryCopies[1].imports);
  expect(registryCopies[0].getters).toEqual(registryCopies[1].getters);
});

it('preserves profile-none early return and invalid-selection/plugin rejection before any row lookup', () => {
  for (const family of families) family.registry();
  for (const value of families.map(family => rows.find(row => row.family === family.family)!)) {
    const input = request(value, 'none');
    resetObservation('selected');
    const observed = countSourceClones(() => resolveModernManifestV8SourceContract(input));
    expect(observed.value.governanceSource).toEqual({ profile: 'none' });
    expect(observed.counts.graphRows).toBe(0); expect(tracking.lookups).toEqual([]);
  }
  const valid = request(rows[0]);
  for (const input of [
    { ...valid, selection: { ...valid.selection, profile: 'unknown' } },
    { ...valid, recordedPlugins: { ...valid.recordedPlugins, resolutionDigest: `sha256:${'0'.repeat(64)}` } }
  ]) {
    resetObservation('selected'); tracking.refuseRow = true;
    expect(() => resolveModernManifestV8SourceContract(input)).toThrow();
    expect(tracking.lookups).toEqual([]);
  }
  resetObservation('selected'); tracking.refuseRow = true;
  expect(() => resolveModernManifestV8SourceContract(valid)).toThrow(FileSystemError);
  expect(() => resolveModernManifestV8SourceContract(valid))
    .toThrow('No authoritative modern governance source matches the selected profile and workflow.');
});

it('retains unmatched-row semantics and rejects an unknown family without exposing a table', () => {
  const observed = countSourceClones(() =>
    Reflect.apply(modernActivationSourceContractForFamily, undefined, ['current', 'unregistered-profile', 'manual']));
  expect(observed.value).toBeUndefined(); expect(observed.counts.graphRows).toBe(0);
  expect(() => Reflect.apply(modernActivationSourceContractForFamily, undefined,
    ['unknown-family', 'single-maintainer-gitflow', 'manual'])).toThrow('Unknown modern activation source family.');
});

it('reuses one validated source per managed-core operation while retaining four fresh resolutions and reads per independent inspection', async () => {
  for (const family of families) family.registry();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'selected-family-inspection-'))); roots.push(root);
  const fixture = await settled(writeModernInstalledProject(root));
  await fixture.write(['governance', 'activation-state.json'], canonicalJson(fixture.state));
  resetObservation('legacy');
  const legacyStartedAt = Date.now();
  const original = await settled(inspectModernInstalledActivation(root));
  const legacy = {
    mode: tracking.mode, resolutions: tracking.resolutions, reads: [...tracking.reads], lookups: [...tracking.lookups],
    observation: original, startedAt: legacyStartedAt, completedAt: Date.now()
  };
  expect(original.status).toBe('observed');
  if (original.status !== 'observed' || !original.current) throw new Error('Expected independently read enabled current state.');
  expect(legacy.resolutions).toBe(4); expect(legacy.lookups).toHaveLength(4);
  expect(legacy.lookups.reduce((sum, lookup) => sum + lookup.graphRows, 0)).toBe(24);
  expect(legacy.lookups.every(lookup => lookup.arrayCalls === 1 && lookup.rowCalls === 0)).toBe(true);
  expect(legacy.reads.filter(read => read.startsWith('open:')).length).toBeGreaterThan(0);
  resetObservation('selected');
  const selectedStartedAt = Date.now();
  const current = await settled(inspectModernInstalledActivation(root));
  const selected = {
    mode: tracking.mode, resolutions: tracking.resolutions, reads: [...tracking.reads], lookups: [...tracking.lookups],
    observation: current, startedAt: selectedStartedAt, completedAt: Date.now()
  };
  inspections.push(legacy, selected);
  expect(current.status).toBe('observed');
  if (current.status !== 'observed' || !current.current) throw new Error('Expected independently read enabled current state.');
  expect(selected.startedAt).toBeGreaterThanOrEqual(legacy.completedAt);
  expect(current.snapshot).not.toBe(original.snapshot);
  expect(current.snapshot.files).not.toBe(original.snapshot.files);
  expect(current.snapshot.directories).not.toBe(original.snapshot.directories);
  compareFreshObservations(original, current);
  expect(selected.resolutions).toBe(4);
  expect(selected.lookups).toHaveLength(4);
  expect(selected.lookups.reduce((sum, lookup) => sum + lookup.graphRows, 0)).toBe(4);
  expect(selected.lookups.every(lookup => lookup.arrayCalls === 0 && lookup.rowCalls === 1)).toBe(true);
  expect(selected.reads).toEqual(legacy.reads);
  expect(selected.reads.filter(read => read.startsWith('open:')).length).toBeGreaterThan(0);
});

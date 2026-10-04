import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as storage from '../src/adapters/filesystem/update-previews.js';
import * as transactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { prepareModernLocalExecution, prepareModernArchivedOpenSpecExecution, approveModernLocalExecution } from '../src/application/governance/modern-local-approval.js';
import { executeModernLocalExecution } from '../src/application/governance/modern-local-execution.js';
import { prepareModernSuccessorRevalidation, loadRevalidationResult, validateRevalidationConstruction } from '../src/application/update/modern-revalidation-records.js';
import { inspectModernInstalledActivation } from '../src/application/governance/modern-installed-preflight.js';
import {
  approveModernSuccessorRevalidationPublication, publishModernSuccessorRevalidation, recoverModernSuccessorRevalidation,
  inspectModernSuccessorRevalidationPublication
} from '../src/application/update/modern-revalidation-publication.js';
import { prepareModernLocalFinalization } from '../src/application/governance/modern-local-finalization.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import type { ManifestActiveLayout, ManifestLayoutComponentId } from '../src/domain/project/contracts.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { rawLocalDigest } from '../src/domain/governance/activation/modern-local-inputs.js';
import { revalidationPublicationFingerprint, type LocalRevalidationArtifact } from '../src/domain/governance/activation/modern-revalidation-publication.js';
import { completionPreconditions } from '../src/adapters/filesystem/modern-local-publication-inputs.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { completedSpecKitTasks } from '../src/governance-activation/spec-kit-seed.js';
import { fixture, inventory, write } from './fixtures/manifest-update.js';
import { selected, writeModernHistoricalSource, writeModernSuccessor } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';
import {spec,originalFiles} from './modern-openspec-fixtures.js';

const lane = process.env.LIFTOFF_HCL_TEST_LANE ?? 'auto';
const qualified = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.21.0';
if (!['native', 'portable', 'auto'].includes(lane) || lane === 'native' && !qualified) throw new Error('Invalid successor native qualification host/lane.');
const nativeIt = it.skipIf(lane === 'portable' || !qualified);
const archivedRequested=process.env.LIFTOFF_OPENSPEC_ARCHIVE_TESTS==='1';
if(archivedRequested&&lane!=='portable'&&!qualified)throw new Error('Archived successor native qualification requires the recorded runtime.');
const archivedNativeIt=it.skipIf(!archivedRequested||lane==='portable'||!qualified);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function project(completed = true, version: 1 | 2 | 3 = 3, retained = false, workflow:'spec-kit'|'openspec'='spec-kit') {
  const f = await fixture();
  await writeModernHistoricalSource(f.root, version, retained, workflow==='spec-kit'?workflow:undefined);
  const manifest = parseManifest(JSON.parse(await fs.readFile(path.join(f.root, 'liftoff.manifest.json'), 'utf8')));
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
  const selection = selected(leaf, 'single-maintainer-gitflow');
  const source = resolveModernManifestV8SourceContract({ selection: selection.selection, recordedPlugins: selection.plugins });
  const components = new Map<ManifestLayoutComponentId, string[]>(source.layoutDescriptor.components.map(id => [id, ['Source Space', id.replace(':', ' ')]]));
  const compose = ['compose.yml'], layout: ManifestActiveLayout = { schemaVersion: 1, state: 'bound', bindings: [
    ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
    { kind: 'artifact', logicalName: 'docker-compose', pathParts: compose }
  ] };
  const successor = await writeModernSuccessor(f.root, version, retained, false, false, { layout, ...(workflow==='spec-kit'?{workflow}:{}) });
  const put = (parts: readonly string[], content: string | Buffer) => write(f.root, parts, content);
  let tasks = await writeModernLocalFixtureInputs(leaf, components, compose, put);
  if (!tasks) throw new Error('Expected initialized framework source fixture.');
  if(workflow==='openspec'){
    const base=tasks.slice(0,-1),workload=leaf.project.workload,
      capability=`${workload.kind==='genai'?workload.pattern:workload.apiStack}-application-baseline`,
      archived=['openspec','changes','archive',`2026-10-01-${base[2]}`];
    await put(['openspec','config.yaml'],'schema: spec-driven\ncontext: Preserve the existing successor source and original history.\n');
    await put([...base,'proposal.md'],`## Why\nPreserve local inputs.\n\n## What Changes\nObserve readonly source.\n\n## Capabilities\n\n### New Capabilities\n- \`${capability}\`: Preserve source.\n\n## Impact\nLocal observation only.\n`);
    await put([...base,'design.md'],'## Context\nExisting source.\n\n## Goals / Non-Goals\nNo historical execution claim.\n\n## Decisions\nPreserve source.\n\n## Risks / Trade-offs\nNo sandbox claim.\n');
    await put([...base,'specs',capability,'spec.md'],spec('Preserve '+capability,true));
    await put(['openspec','specs',capability,'spec.md'],spec('Preserve '+capability));
    await put(tasks,`- [${completed?'x':' '}] 1.1 Existing historical task, not prior execution proof.\r\n`);
    await fs.mkdir(path.join(f.root,'openspec','changes','archive'),{recursive:true});
    await fs.rename(path.join(f.root,...base),path.join(f.root,...archived));
    tasks=[...archived,'tasks.md'];
  }else if(completed)await put(tasks,completedSpecKitTasks(await fs.readFile(path.join(f.root,...tasks),'utf8')));
  return { ...f, successor, tasks, put, components };
}

const scopes = { projectCode: true as const, hostCapabilitiesAcknowledged: true as const, dependencyPreparation: false,
  dependencyNetwork: false, workflowFinalization: false as const, publishLocalRecords: false as const };

async function reviewed(completed = true, version: 1 | 2 | 3 = 3, retained = false) {
  const f = await project(completed, version, retained), native = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [] });
  await approveModernLocalExecution(f.root, native.fingerprint, scopes);
  const execution = await executeModernLocalExecution(f.root, native.fingerprint);
  expect(execution.complete).toBe(true);
  const result = await prepareModernSuccessorRevalidation(f.root, { kind: 'revalidate-successor', executionFingerprint: native.fingerprint });
  return { ...f, native, execution, result };
}
const approval = (result: Awaited<ReturnType<typeof prepareModernSuccessorRevalidation>>) => ({
  publishExactLocalBytes: true as const, intentFingerprint: result.fingerprint, candidateBinding: result.candidateBinding, targetSetDigest: result.targetSetDigest
});

describe('successor native record construction', () => {
  archivedNativeIt.each([1,2,3] as const)('publishes fresh archived OpenSpec validation for history v%s without rewriting original identities or source',async version=>{
    const f=await project(true,version,version===2,'openspec'),before=await inventory(f.root),
      sourceBefore=await originalFiles(path.join(f.root,'openspec')),
      native=await prepareModernArchivedOpenSpecExecution(f.root,{kind:'verify-openspec-archived',preparation:[]});
    expect(native.schemaVersion).toBe(5);
    await approveModernLocalExecution(f.root,native.fingerprint,scopes);
    const execution=await executeModernLocalExecution(f.root,native.fingerprint);
    expect(execution.complete,JSON.stringify(execution)).toBe(true);expect(execution.schemaVersion).toBe(4);
    const result=await prepareModernSuccessorRevalidation(f.root,{kind:'revalidate-successor',executionFingerprint:native.fingerprint});
    expect(result.phases.map(phase=>phase.status)).toEqual(['complete','complete','complete']);
    expect(result.originalTransitionDigest).toBe(f.successor.prepared.journal.semanticTransitionDigest);
    expect(result.originalPreparationDigest).toBe(canonicalSha256(f.successor.prepared.journal.preparation));
    expect(result.targets).toHaveLength(8);
    expect(result.targets.every(target=>target.pathParts[0]==='governance')).toBe(true);
    expect(await inventory(f.root)).toEqual(before);
    await expect(publishModernSuccessorRevalidation(f.root,result.publicationFingerprint)).rejects.toThrow(/consent/);
    await approveModernSuccessorRevalidationPublication(f.root,result.publicationFingerprint,approval(result));
    const published=await publishModernSuccessorRevalidation(f.root,result.publicationFingerprint);
    expect(published.status).toBe('revalidation-complete-current');
    expect(published.committed).toBe(true);expect(published.readbackDigest).toMatch(/^[a-f0-9]{64}$/);
    const after=await inventory(f.root),targets=new Set(result.targets.map(target=>target.pathParts.join('/')));
    for(const [key,value] of Object.entries(before))if(!targets.has(key))expect(after[key],key).toEqual(value);
    expect(await originalFiles(path.join(f.root,'openspec'))).toEqual(sourceBefore);
    const installed=await inspectModernInstalledActivation(f.root);
    expect(installed.status).toBe('observed');
    expect((await inspectModernSuccessorRevalidationPublication(f.root,result.publicationFingerprint)).status).toBe('revalidation-complete-current');
  },300000);

  it('requires actual completed native provenance, not a supplied success or guessed receipt', async () => {
    const f = await project(), before = await inventory(f.root), home = await inventory(f.home);
    await expect(prepareModernSuccessorRevalidation(f.root, { kind: 'revalidate-successor', executionFingerprint: 'a'.repeat(64) }))
      .rejects.toThrow(/original preview, consent, result and progress/);
    await expect(Reflect.apply(prepareModernSuccessorRevalidation, undefined, [f.root, {
      kind: 'revalidate-successor', executionFingerprint: 'a'.repeat(64), complete: true
    }])).rejects.toThrow(/exactly the required fields/);
    expect(await inventory(f.root)).toEqual(before);
    expect(await inventory(f.home)).toEqual(home);
  });

  nativeIt.each([false, true])('constructs actual proof while preserving original identities and completed=%s source', async completed => {
    const f = await project(completed), before = await inventory(f.root);
    const native = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [] });
    await approveModernLocalExecution(f.root, native.fingerprint, scopes);
    const execution = await executeModernLocalExecution(f.root, native.fingerprint);
    expect(execution.complete).toBe(true);
    const result = await prepareModernSuccessorRevalidation(f.root, { kind: 'revalidate-successor', executionFingerprint: native.fingerprint });
    const loaded = await loadRevalidationResult(f.root, result.publicationFingerprint);
    expect(loaded.result).toEqual(result);
    expect(result.execution.resultDigest).toBe(execution.resultDigest);
    expect(result.originalTransitionDigest).toBe(f.successor.prepared.journal.semanticTransitionDigest);
    expect(result.originalPreparationDigest).toBe(canonicalSha256(f.successor.prepared.journal.preparation));
    expect(result.phases.map(phase => phase.status)).toEqual(['complete', 'complete', completed ? 'complete' : 'blocked']);
    expect(result.targets).toHaveLength(completed ? 8 : 7);
    expect(result.targets.some(target => target.pathParts.join('/') === f.tasks.join('/'))).toBe(false);
    expect(result.targets.some(target => target.pathParts.join('/') === '.liftoff/local-completion.json')).toBe(false);
    const journalMutation = loaded.mutations.find(item => item.pathParts.join('/') === 'governance/migration-state.json');
    if (!journalMutation || journalMutation.type !== 'write') throw new Error('Missing exact journal target.');
    const journal = JSON.parse(Buffer.from(journalMutation.content).toString('utf8'));
    expect(journal.semanticInput).toEqual(f.successor.prepared.journal.semanticInput);
    expect(journal.preparation).toEqual(f.successor.prepared.journal.preparation);
    expect(journal.successor).toEqual(f.successor.prepared.journal.successor);
    expect(journal.revalidation.status).toBe(completed ? 'complete' : 'blocked');
    expect(await inventory(f.root)).toEqual(before);
    await expect(prepareModernLocalFinalization(f.root, { kind: 'finalize-local', executionFingerprint: native.fingerprint }))
      .rejects.toThrow(/separate reconciliation grant/);
    await f.put([...f.components.get('backend')!, 'tests', 'source.test.js'], 'throw new Error("changed source");\n');
    const changed = await inventory(f.root);
    await expect(prepareModernSuccessorRevalidation(f.root, { kind: 'revalidate-successor', executionFingerprint: native.fingerprint }))
      .rejects.toThrow(/no longer corresponds/);
    expect(await inventory(f.root)).toEqual(changed);
  }, 120000);
});

describe('actual successor revalidation publication', () => {
  nativeIt('does not manufacture verified progress from an actually failed native check', async () => {
    const f = await project();
    await f.put([...f.components.get('backend')!, 'tests', 'source.test.js'], 'throw new Error("actual failed successor verification");\n');
    const before = await inventory(f.root), native = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [] });
    await approveModernLocalExecution(f.root, native.fingerprint, scopes);
    const result = await executeModernLocalExecution(f.root, native.fingerprint);
    expect(result.complete).toBe(false);
    expect(result.checks.some(check => check.status === 'failed')).toBe(true);
    const store = vi.spyOn(storage, 'createLocalRevalidationRecordStore');
    await expect(prepareModernSuccessorRevalidation(f.root, { kind: 'revalidate-successor', executionFingerprint: native.fingerprint }))
      .rejects.toThrow(/complete coverage/);
    expect(store).not.toHaveBeenCalled();
    expect(await inventory(f.root)).toEqual(before);
  }, 120000);

  nativeIt('refreshes a changed local baseline with new native proof while retaining original history and earlier records', async () => {
    const f = await reviewed();
    await approveModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint, approval(f.result));
    expect((await publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).status).toBe('revalidation-complete-current');
    const prior = await inventory(f.root);
    await f.put([...f.components.get('backend')!, 'tests', 'source.test.js'], 'import test from "node:test";\ntest("new actual baseline", () => {});\n');
    const native = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [] });
    await approveModernLocalExecution(f.root, native.fingerprint, scopes);
    expect((await executeModernLocalExecution(f.root, native.fingerprint)).complete).toBe(true);
    const result = await prepareModernSuccessorRevalidation(f.root, { kind: 'revalidate-successor', executionFingerprint: native.fingerprint });
    expect(result.execution.baselineDigest).not.toBe(f.result.execution.baselineDigest);
    expect(result.originalTransitionDigest).toBe(f.result.originalTransitionDigest);
    expect(result.originalPreparationDigest).toBe(f.result.originalPreparationDigest);
    await approveModernSuccessorRevalidationPublication(f.root, result.publicationFingerprint, approval(result));
    expect((await publishModernSuccessorRevalidation(f.root, result.publicationFingerprint)).status).toBe('revalidation-complete-current');
    const state = JSON.parse(await fs.readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8'));
    expect(state.baselineAnchor).toBe(result.execution.baselineDigest);
    expect(state.repository.id).toBe(f.successor.prepared.journal.successor.repositoryId);
    expect(state.createdAt).toBe(f.successor.prepared.journal.successor.createdAt);
    for (const phase of result.phases) {
      expect(state.phases[phase.phaseId].evidence.map((ref: { evidenceId: string }) => ref.evidenceId))
        .toEqual(expect.arrayContaining([phase.evidenceId, f.result.phases.find(old => old.phaseId === phase.phaseId)!.evidenceId]));
    }
    const after = await inventory(f.root);
    for (const [name, bytes] of Object.entries(prior)) if (/^governance\/(?:history|evidence|plans)\//u.test(name)) expect(after[name], name).toEqual(bytes);
  }, 120000);

  nativeIt('preserves retained v2 source payloads and original due times without renewing custody', async () => {
    const f = await project(true, 2, true);
    await f.put(['protected', 'state.enc'], 'Synthetic owned encrypted-state fixture; not a deployed state.\n');
    await f.put(['protected', 'key'], 'Synthetic owned key fixture; not a credential.\n');
    const before = await inventory(f.root);
    const native = await prepareModernLocalExecution(f.root, { kind: 'verify-local', preparation: [] });
    await approveModernLocalExecution(f.root, native.fingerprint, scopes);
    expect((await executeModernLocalExecution(f.root, native.fingerprint)).complete).toBe(true);
    const result = await prepareModernSuccessorRevalidation(f.root, { kind: 'revalidate-successor', executionFingerprint: native.fingerprint });
    await approveModernSuccessorRevalidationPublication(f.root, result.publicationFingerprint, approval(result));
    expect((await publishModernSuccessorRevalidation(f.root, result.publicationFingerprint)).status).toBe('revalidation-complete-current');
    const after = await inventory(f.root);
    for (const [name, value] of Object.entries(before)) if (name.startsWith('protected/') || name.startsWith('governance/history/')) expect(after[name], name).toEqual(value);
    const observed = await inspectModernInstalledActivation(f.root);
    expect(observed.status).toBe('observed');
    if (observed.status !== 'observed') throw new Error('Missing independent retained-source readback.');
    expect(observed.retention).toEqual(expect.arrayContaining([expect.objectContaining({
      retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z', authority: 'preservation-only'
    })]));
  }, 120000);

  nativeIt('independently reconstructs protected membership and root identity rather than trusting private digest claims', async () => {
    const f = await reviewed(), loaded = await loadRevalidationResult(f.root, f.result.publicationFingerprint), before = await inventory(f.root);
    const reduced = structuredClone(loaded);
    reduced.index.files = reduced.index.files.filter(file => file.pathParts.join('/') !== f.tasks.join('/'));
    expect(reduced.index.files.length).toBe(loaded.index.files.length - 1);
    reduced.intent.protectedSetDigest = canonicalSha256(reduced.index);
    const { fingerprint: _old, ...body } = reduced.intent;
    reduced.intent.fingerprint = canonicalSha256(body);
    await expect(validateRevalidationConstruction(reduced)).rejects.toThrow(/protected capture or root identity/);
    const foreignRoot = structuredClone(loaded);
    foreignRoot.intent.execution.rootIdentity = '9:9:9:9:9:9:9:9';
    await expect(validateRevalidationConstruction(foreignRoot)).rejects.toThrow(/protected capture or root identity/);
    expect(await inventory(f.root)).toEqual(before);
  }, 120000);

  nativeIt.each([false, true])('publishes and independently reads back completed=%s without replay or workflow writes', async completed => {
    const f = await reviewed(completed), before = await inventory(f.root), run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    expect((await inspectModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint)).status).toBe('awaiting-consent');
    await expect(publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).rejects.toThrow(/consent is missing/);
    expect(await inventory(f.root)).toEqual(before);
    const consent = await approveModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint, approval(f.result));
    expect(consent.scopes).toEqual({ publishLocalRecords: true, workflowWrites: false, projectCode: false, dependencyPreparation: false,
      dependencyNetwork: false, protectedStateAccess: false, providerAccess: false });
    expect((await inspectModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint)).status).toBe('awaiting-publication');
    const published = await publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint);
    expect(published).toMatchObject({ status: completed ? 'revalidation-complete-current' : 'revalidation-incomplete', committed: true, authority: 'local-only' });
    expect(published.readbackDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(published.rollbackFailures).toEqual([]); expect(published.cleanupFailures).toEqual([]);
    const after = await inventory(f.root), targets = new Set(f.result.targets.map(target => target.pathParts.join('/')));
    for (const [name, value] of Object.entries(before)) if (!targets.has(name)) expect(after[name], name).toEqual(value);
    expect(Object.keys(after).filter(name => !(name in before)).every(name => targets.has(name))).toBe(true);
    expect(after[f.tasks.join('/')]).toEqual(before[f.tasks.join('/')]);
    expect(after['.liftoff/local-completion.json']).toBeUndefined();
    expect(await inspectModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint)).toMatchObject({
      status: published.status, committed: true, readbackDigest: published.readbackDigest
    });
    expect(await recoverModernSuccessorRevalidation(f.root, { publicationFingerprint: f.result.publicationFingerprint }))
      .toMatchObject({ status: published.status, committed: true, readbackDigest: published.readbackDigest });
    await expect(publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).rejects.toThrow(/already claimed/);
    await expect(approveModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint, approval(f.result))).rejects.toThrow(/already claimed/);
    expect(await inventory(f.root)).toEqual(after);
    expect(run).not.toHaveBeenCalled();
  }, 120000);

  nativeIt('rejects graph-valid but altered exact target bytes before recording consent or mutating the successor', async () => {
    const f = await reviewed(), review = await loadRevalidationResult(f.root, f.result.publicationFingerprint), before = await inventory(f.root);
    const target = review.result.targets.find(target => target.purpose === 'state')!, store = storage.createLocalRevalidationRecordStore(f.root);
    const saved = await store.read('artifact', target.artifactKey);
    const original = saved!.value as LocalRevalidationArtifact, raw = JSON.parse(Buffer.from(original.contentBase64, 'base64').toString('utf8'));
    raw.repository.name = 'An unrelated rewritten repository name';
    const content = Buffer.from(JSON.stringify(raw)), artifact = { ...original, contentBase64: content.toString('base64'), bytes: content.length, rawDigest: rawLocalDigest(content) };
    const artifactKey = canonicalSha256(artifact);
    await store.write('artifact', artifactKey, artifact);
    const targets = review.result.targets.map(item => item === target ? { ...item, artifactKey, target: { ...item.target, rawDigest: artifact.rawDigest, bytes: artifact.bytes } } : item);
    const mutations = review.mutations.map(item => item.pathParts.join('/') === target.pathParts.join('/') ? { type: 'write' as const, pathParts: item.pathParts, content, mode: original.mode! } : item);
    const candidate = await transactions.inspectLocalVerificationCandidate(f.root, mutations, await completionPreconditions(review.index, targets));
    const { publicationFingerprint: _fingerprint, resultDigest: _digest, ...base } = review.result;
    const changed = { ...base, targets, targetSetDigest: canonicalSha256(targets), candidateBinding: candidate.binding, candidateSize: candidate.size };
    const body = { ...changed, publicationFingerprint: revalidationPublicationFingerprint(changed) };
    const forged = { ...body, resultDigest: canonicalSha256(body) };
    await store.write('result', forged.publicationFingerprint, forged);
    await expect(approveModernSuccessorRevalidationPublication(f.root, forged.publicationFingerprint, approval(forged)))
      .rejects.toThrow(/independently reconstructed current proof/);
    expect(await store.read('publication-consent', forged.publicationFingerprint)).toBeNull();
    expect(await store.readState(f.result.fingerprint)).toBeNull();
    expect(await inventory(f.root)).toEqual(before);
  }, 120000);

  nativeIt('rolls back actual precommit writes and never reports the successor itself as rolled back', async () => {
    const f = await reviewed(), before = await inventory(f.root), apply = transactions.applyLocalVerificationTransaction;
    await approveModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint, approval(f.result));
    vi.spyOn(transactions, 'applyLocalVerificationTransaction').mockImplementation((root, mutations, options) => apply(root, mutations, {
      ...options, validateCurrentInputs: async stage => {
        await options.validateCurrentInputs(stage);
        if (stage === 'before-commit') throw new Error('Injected before revalidation commit, after actual local writes.');
      }
    }));
    await expect(publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).rejects.toThrow(/Injected before revalidation commit.*All attributable changes were rolled back/);
    expect(await inspectModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint)).toMatchObject({ status: 'rolled-back', committed: false });
    expect(await inventory(f.root)).toEqual(before);
    expect(JSON.parse(await fs.readFile(path.join(f.root, 'liftoff.manifest.json'), 'utf8')).artifactVersion).toBe(8);
    expect((await recoverModernSuccessorRevalidation(f.root, { publicationFingerprint: f.result.publicationFingerprint })).status).toBe('rolled-back');
    await expect(publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).rejects.toThrow(/already claimed/);
  }, 120000);

  nativeIt('recovers an actual committed journal after commit-observation persistence failed without native replay', async () => {
    const f = await reviewed(), create = storage.createLocalRevalidationRecordStore;
    await approveModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint, approval(f.result));
    let deny = true;
    vi.spyOn(storage, 'createLocalRevalidationRecordStore').mockImplementation((root, options) => {
      const store = create(root, options);
      return { ...store, compareExchangeState: async (key, digest, value) => {
        if (deny && value && typeof value === 'object' && 'phase' in value && value.phase === 'committed-readback-pending') {
          throw new Error('Injected persistence failure after actual commit observation.');
        }
        return store.compareExchangeState(key, digest, value);
      } };
    });
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    expect(await publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).toMatchObject({ status: 'committed-cleanup-pending', committed: true });
    expect((await transactions.inspectLocalVerificationTransaction(f.root, { authorityStore: storage.createLocalVerificationTransactionAuthorityStore(f.root) })).status).toBe('committed');
    deny = false;
    expect(await recoverModernSuccessorRevalidation(f.root, { publicationFingerprint: f.result.publicationFingerprint }))
      .toMatchObject({ status: 'revalidation-complete-current', committed: true });
    expect((await inspectModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint)).status).toBe('revalidation-complete-current');
    expect(run).not.toHaveBeenCalled();
  }, 120000);

  nativeIt('does not infer successful cleanup from absent journal and matching target bytes', async () => {
    const f = await reviewed(), create = storage.createLocalRevalidationRecordStore;
    await approveModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint, approval(f.result));
    vi.spyOn(storage, 'createLocalRevalidationRecordStore').mockImplementation((root, options) => {
      const store = create(root, options);
      return { ...store, compareExchangeState: async (key, digest, value) => {
        if (value && typeof value === 'object' && 'phase' in value && value.phase === 'committed-readback-pending' &&
            'cleanupPending' in value && value.cleanupPending === false) throw new Error('Injected lost durable cleanup observation.');
        return store.compareExchangeState(key, digest, value);
      } };
    });
    await expect(publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).rejects.toThrow(/lost durable cleanup/);
    expect((await transactions.inspectLocalVerificationTransaction(f.root, { authorityStore: storage.createLocalVerificationTransactionAuthorityStore(f.root) })).status).toBe('absent');
    const before = await inventory(f.root);
    expect((await inspectModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint)).status).toBe('committed-cleanup-pending');
    expect(await recoverModernSuccessorRevalidation(f.root, { publicationFingerprint: f.result.publicationFingerprint }))
      .toMatchObject({ status: 'committed-cleanup-pending', committed: true, readbackDigest: null });
    expect(await inventory(f.root)).toEqual(before);
  }, 120000);

  nativeIt('refuses expired publication consent without claiming or changing files', async () => {
    const f = await reviewed(), before = await inventory(f.root);
    await approveModernSuccessorRevalidationPublication(f.root, f.result.publicationFingerprint, approval(f.result));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(f.result.reviewExpiresAt));
    await expect(publishModernSuccessorRevalidation(f.root, f.result.publicationFingerprint)).rejects.toThrow(/expired/);
    expect(await storage.createLocalRevalidationRecordStore(f.root).readState(f.result.fingerprint)).toBeNull();
    expect(await inventory(f.root)).toEqual(before);
  }, 120000);
});

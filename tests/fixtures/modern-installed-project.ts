import * as fs from 'node:fs/promises';
import path from 'node:path';
import { projectCatalog } from '../../src/application/project/catalog.js';
import { parseManifest } from '../../src/application/project/manifest.js';
import { composeModernManifestPlugins } from '../../src/application/project/plugins.js';
import { buildModernManagedCore } from '../../src/application/project/modern-managed-core.js';
import { createManifestV8Candidate } from '../../src/application/project/manifest-writer.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from '../../src/domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from '../../src/domain/project/manifest/plugins.js';
import { toSafeProjectName } from '../../src/domain/project/planning.js';
import type { ManifestActiveLayout } from '../../src/domain/project/contracts.js';
import { canonicalJson, canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import type { createModernActivationRecordContract, ModernPlanInput } from '../../src/domain/governance/activation/modern-records.js';
import { parseHistoryJson, historyRecord } from '../../src/governance-activation/history-contracts.js';
import { readModernActivationSuccessorSource, planModernActivationSuccessor, prepareActivationHistorySuccessor } from '../../src/governance-activation/migration-history.js';
import { createModernHistoryContract } from '../../src/governance-activation/modern-history-contracts.js';
import { historicalV2EvidenceBodyDigest, historicalV2PhaseContractDigest, validateHistoricalV2EvidenceRecord } from '../../src/governance-activation/historical-v2.js';
import { capturedV3Records, capturedV3Successor, writeCapturedV3Successor, writeFixtureBytes } from './activation-v3/fixture.js';

export function localInputsPlanFixture(api: ReturnType<typeof createModernActivationRecordContract>): ModernPlanInput {
  const id = 'local-inputs-valid', phase = api.graph.phases.find(phase => phase.id === id)!;
  return {
    phaseId: id, createdAt: '2026-09-01T12:00:00.000Z', expiresAt: '2026-09-01T13:00:00.000Z',
    stateHash: null, baselineDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64), transitionDigest: 'c'.repeat(64), operations: [],
    approval: { gateKind: 'none', required: false, envelopeId: null, envelopeHash: null,
      evaluation: { phaseId: id, gateKind: 'none', questionKind: null, approvalRequired: false, status: 'not-required',
        envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
    rollbackPlan: { phaseId: id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
    noSecrets: true
  };
}

export function selected(leaf: ManifestV8ProjectLeaf, profile: 'none' | 'single-maintainer-gitflow' | 'team-gitflow') {
  const work = leaf.project.workload;
  const resolution = composeModernManifestPlugins({
    workload: work.kind, ...(work.kind === 'genai' ? { variant: work.pattern } : {}), stack: work.apiStack, cloud: work.cloud,
    workflow: leaf.project.specWorkflow, agents: leaf.project.agents, frontend: work.frontend ? 'included' : 'omitted',
    environments: work.environments, governanceProfile: profile
  }, { safeProjectName: toSafeProjectName(leaf.project.name) }).resolution;
  const plugins = readManifestPluginMetadata({ schemaVersion: 1, resolutionDigest: resolution.digest, selections: resolution.plugins },
    { stack: work.apiStack, cloud: work.cloud, workflow: leaf.project.specWorkflow, agents: leaf.project.agents });
  return { selection: { ...leaf, profile }, plugins, activeLayout: { schemaVersion: 1 as const, state: 'unresolved' as const, bindings: [] as const } };
}

export async function writeModernHistoricalSource(directory: string, version: 1 | 2 | 3, retained = false, workflow?: 'spec-kit') {
  const sample = capturedV3Successor(version === 1 ? 1 : 2);
  let manifest = version === 3 ? capturedV3Records().manifest : parseHistoryJson(sample.files.get('liftoff.manifest.json')!, 'original manifest');
  if (workflow) {
    const raw = historyRecord(manifest, 'synthetic workflow source'), original = parseManifest(raw);
    manifest = {
      ...raw, project: { ...historyRecord(raw.project, 'synthetic workflow project'), specWorkflow: workflow,
        agents: original.project.agents, defaultAgent: original.project.agents[0] },
      framework: { state: 'initialized', adapter: workflow, contractVersion: projectCatalog.getFrameworkDefinition(workflow).version }
    };
    parseManifest(manifest);
  }
  const state = structuredClone(version === 3 ? historyRecord(sample.state, 'state') :
    historyRecord(parseHistoryJson(sample.files.get('governance/activation-state.json')!, 'state'), 'state'));
  for (const field of ['bootstrapState', 'successorHistory', 'phaseOutputs', 'taskProjection', 'activationInputs']) delete state[field];
  state.activeChange = null;
  for (const value of Object.values(historyRecord(state.phases, 'phases'))) {
    const phase = historyRecord(value, 'phase');
    Object.assign(phase, { state: 'pending', evidence: [], approvals: [], blockers: [] });
    delete phase.operation; delete phase.executionPlanDigest;
  }
  if (retained) {
    if (version !== 2) throw new Error('This retention fixture is exact v2.');
    const file = sample.index.files.find(file => file.kind === 'evidence')!;
    const original = validateHistoricalV2EvidenceRecord(parseHistoryJson(sample.files.get(file.originalPathParts.join('/'))!, 'proof'));
    const id = 'remote-import-verified', payload = { kind: `${id}.v1` };
    const header = {
      ...original.header, phaseId: id, phaseContractDigest: historicalV2PhaseContractDigest(id),
      transition: { ...original.header.transition, phaseId: id }, result: 'verified',
      producer: 'original-retention-format-fixture', bodyDigest: historicalV2EvidenceBodyDigest(payload)
    };
    const proof = { evidenceId: 'original-import', header, payload };
    await writeFixtureBytes(directory, ['governance', 'evidence', 'original-import.json'], canonicalJson(proof));
    state.bootstrapState = {
      status: 'retained', remoteImportEvidenceId: 'original-import', remoteImportEvidenceDigest: canonicalSha256(header),
      retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z',
      encryptedStatePathParts: [['protected', 'state.enc']], encryptionKeyPathParts: [['protected', 'key']]
    };
  }
  await writeFixtureBytes(directory, ['liftoff.manifest.json'], JSON.stringify(manifest, null, '\t') + '\r\n', 0o640);
  await writeFixtureBytes(directory, ['governance', 'activation-state.json'], canonicalJson(state), 0o600);
  return directory;
}

/** Constructs record/storage fixtures; this does not qualify approved publication or native execution. */
export async function writeModernSuccessor(directory: string, version: 1 | 2 | 3, retained = false, nested = false, overlap = false,
  options: { layout?: ManifestActiveLayout; workflow?: 'spec-kit' } = {}) {
  if (nested && options.workflow) throw new Error('A nested historical fixture cannot be relabeled as another workflow.');
  if (nested) await writeCapturedV3Successor(directory, 2);
  else await writeModernHistoricalSource(directory, version, retained, options.workflow);
  const original = await readModernActivationSuccessorSource(directory);
  const originalManifest = parseManifest(parseHistoryJson(original.captures.find(file => file.pathParts.join('/') === 'liftoff.manifest.json')!.content!, 'source manifest'));
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: originalManifest.project, framework: originalManifest.framework });
  const selection = selected(leaf, 'single-maintainer-gitflow');
  const activeLayout: ManifestActiveLayout = options.layout ?? (overlap
    ? { schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['protected'] }] } : selection.activeLayout);
  const input = { ...selection, activeLayout }, core = buildModernManagedCore(input);
  const managed = [
    ...core.map(({ logicalName, category, pathParts, content }) => ({ kind: 'bytes' as const, logicalName, category, pathParts, content })),
    ...originalManifest.managedArtifacts.filter(file => !core.some(target => target.logicalName === file.logicalName))
      .map(file => ({ kind: 'retire-alias' as const, logicalName: file.logicalName }))
  ];
  const plan = await planModernActivationSuccessor(original, { ...input, managed });
  const originalState = historyRecord(parseHistoryJson(original.captures.find(file => file.pathParts.join('/') === 'governance/activation-state.json')!.content!, 'original state'), 'original state');
  const anchor = String(historyRecord(originalState.repository, 'repository').id);
  const preparation = {
    schemaVersion: 1 as const, preparationId: '22222222-2222-4222-8222-222222222222', preparedAt: '2026-09-01T12:00:00.000Z',
    localRepositoryId: anchor.startsWith('local:') ? anchor : 'local:11111111-1111-4111-8111-111111111111'
  };
  const prepared = await prepareActivationHistorySuccessor(plan, Buffer.from(plan.manifest.content), preparation, '2026-09-02T00:00:00.000Z');
  for (const mutation of prepared.mutations) {
    if (mutation.type === 'write') await writeFixtureBytes(directory, mutation.pathParts, mutation.content, mutation.mode);
    else await fs.rm(path.join(directory, ...mutation.pathParts), { force: true });
  }
  for (const file of core) await writeFixtureBytes(directory, file.pathParts, file.content);
  await writeFixtureBytes(directory, ['liftoff.manifest.json'], prepared.manifestBytes);
  return { root: directory, prepared, plan };
}

/** Builds an independently valid prior-target record fixture, not a permitted production rewrite of T. */
export async function writePriorRepairOriginalTarget(fixture: Awaited<ReturnType<typeof writeModernSuccessor>>, bytes: string) {
  const { plan, prepared, root } = fixture, source = plan.manifest.manifest;
  const repair = buildModernManagedCore({
    selection: plan.target.selection, plugins: plan.target.plugins, activeLayout: plan.target.activeLayout
  }).find(file => file.logicalName.includes('repair'));
  if (!repair || !source.sourceManifestHistory) throw new Error('Expected original successor repair identity and history.');
  const manifest = createManifestV8Candidate({
    origin: 'maintenance', source,
    managed: source.managedArtifacts.map(file => file.logicalName === repair.logicalName
      ? { kind: 'bytes', logicalName: file.logicalName, category: file.category, pathParts: file.pathParts, content: bytes }
      : { kind: 'retain', logicalName: file.logicalName })
  });
  const identity = plan.semanticInput.targetIdentity;
  const history = createModernHistoryContract(projectCatalog, {
    recordedIdentity: identity, profile: 'single-maintainer-gitflow', policyVersion: identity.policyVersion,
    selection: { ...plan.target.selection, profile: 'single-maintainer-gitflow' },
    pluginResolutionDigest: source.plugins.resolutionDigest, activeLayoutDigest: identity.activeLayoutDigest
  });
  const semanticInput = history.semanticInput(plan.semanticInput.sourceIdentity, source.sourceManifestHistory, manifest.digest);
  const journal = history.readJournal({
    ...prepared.journal, semanticInput, semanticTransitionDigest: canonicalSha256(semanticInput)
  }, semanticInput, '2026-09-02T00:00:00.000Z');
  await writeFixtureBytes(root, repair.pathParts, bytes);
  await writeFixtureBytes(root, ['liftoff.manifest.json'], manifest.content);
  await writeFixtureBytes(root, ['governance', 'migration-state.json'], canonicalJson(journal));
}

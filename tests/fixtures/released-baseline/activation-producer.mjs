import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadReleasedSource } from './source-loader.mjs';
import { fileTree } from './journal-producer.mjs';

const config = JSON.parse(process.argv[2]);
const baseline = loadReleasedSource(path.resolve(config.baselineRoot));
const ancestor = loadReleasedSource(path.resolve(config.ancestorRoot));
const destination = path.resolve(config.destination);
const cases = [];
const timestamp = '2026-09-09T00:00:00.000Z';

async function put(root, parts, bytes, mode = 0o600) {
  const target = path.join(root, ...parts);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode });
  await chmod(target, mode);
}

async function install(root, files) {
  for (const [name, bytes] of files) await put(root, name.split('/'), bytes);
}

async function newCase(id) {
  const root = path.join(destination, id);
  await mkdir(root, { mode: 0o700 });
  return root;
}

async function record(id, root, authority, extra = {}) {
  cases.push({ id, root, authority, ...extra, files: await fileTree(root) });
}

const v1 = await baseline.import('tests/fixtures/activation-v1/fixture.ts');
const v2 = await baseline.import('tests/fixtures/activation-v2/fixture.ts');
const { canonicalJson, canonicalSha256 } = await baseline.import('src/domain/governance/activation/canonical-json.ts');
const v1Root = await newCase('activation-v1');
const original = await v1.writeHistoricalV1Fixture(v1Root);
await record('activation-v1', v1Root, {
  release: 'v0.12.3', entrypoint: 'tests/fixtures/activation-v1/fixture.ts#writeHistoricalV1Fixture',
  kind: 'released-test-fixture-output', arguments: {}
});
for (const schema of [2, 3]) {
  const id = `activation-v1-maintained-schema${schema}`;
  const root = await newCase(id);
  await v1.writeHistoricalV1Fixture(root, { maintainedCoreCompatibilitySchema: schema });
  await record(id, root, {
    release: 'v0.12.3', entrypoint: 'tests/fixtures/activation-v1/fixture.ts#writeHistoricalV1Fixture',
    kind: 'released-test-fixture-output', arguments: { maintainedCoreCompatibilitySchema: schema }
  });
}
for (const [id, options] of [
  ['activation-v2', {}],
  ['activation-v2-retained', { retention: 'retained' }],
  ['activation-v2-disposed-spec-kit', { retention: 'disposed', workflow: 'spec-kit' }]
]) {
  const root = await newCase(id);
  await v2.writeHistoricalV2Fixture(root, options);
  await record(id, root, {
    release: 'v0.12.3', entrypoint: 'tests/fixtures/activation-v2/fixture.ts#writeHistoricalV2Fixture',
    kind: 'released-test-fixture-output', arguments: options
  });
}

const earlierHistory = await ancestor.import('src/governance-activation/migration-history.ts');
const v1History = await earlierHistory.planActivationHistoryMigration(v1Root);
if (v1History.status !== 'eligible') throw new Error(`Released v1 history planning failed: ${JSON.stringify(v1History)}`);
const earlierFinalized = earlierHistory.finalizeActivationHistoryMigration(
  v1History, canonicalSha256({ fixture: 'released-v1-to-v2-history' }), new Date(timestamp)
);
const earlierHistoryRoot = await newCase('history-v1-to-v2');
await install(earlierHistoryRoot, original.files);
const earlierTransaction = await ancestor.import('src/adapters/filesystem/project-transaction.ts');
await earlierTransaction.applyProjectFileTransaction(earlierHistoryRoot, earlierFinalized.mutations);
await record('history-v1-to-v2', earlierHistoryRoot, {
  release: 'v0.11.2', entrypoint: 'src/governance-activation/migration-history.ts#finalizeActivationHistoryMigration',
  kind: 'released-history-writer-output', source: 'activation-v1',
  limitations: 'Raw successor/history serializer output before managed-core/manifest reconciliation; not a complete active project.'
});

const v2AncestorRoot = await newCase('activation-v2-with-v1-history');
const v2Ancestor = await v2.writeHistoricalV2Fixture(v2AncestorRoot, {
  ancestor: { index: v1History.index, indexContent: v1History.indexContent, files: original.files }
});
await record('activation-v2-with-v1-history', v2AncestorRoot, {
  release: 'v0.12.3', entrypoint: 'tests/fixtures/activation-v2/fixture.ts#writeHistoricalV2Fixture',
  kind: 'released-test-fixture-output',
  ancestorIndex: { release: 'v0.11.2', entrypoint: 'src/governance-activation/migration-history.ts#planActivationHistoryMigration' }
});

const history = await baseline.import('src/governance-activation/migration-history.ts');
const projectTransaction = await baseline.import('src/adapters/filesystem/project-transaction.ts');
const { buildProjectPlan } = await baseline.import('src/application/project/planning.ts');
const { buildArtifacts } = await baseline.import('src/templates.ts');
const { canonicalPhaseGraph, currentActivationIdentity } = await baseline.import('src/domain/governance/activation/graph.ts');
const { validateUserActivationState, validateApprovalEnvelope } = await baseline.import('src/domain/governance/activation/validators.ts');
const records = await baseline.import('src/governance-activation/transition-records.ts');
const stateFiles = await baseline.import('src/governance-activation/activation-state.ts');
const approvals = await baseline.import('src/domain/governance/activation/approvals.ts');
const { writeGovernanceApprovalAuthority } = await baseline.import('src/governance-activation/authority-records.ts');
const fixtures = await baseline.import('tests/governance-activation-fixtures.ts');

const project = buildProjectPlan({
  projectName: 'Flight Log', projectType: 'standard', apiStack: 'node-fastify',
  cloud: 'azure', region: 'eastus', environments: ['dev', 'staging', 'prod'],
  includeFrontend: false, specWorkflow: 'openspec', agents: ['github-copilot'],
  governanceProfile: 'single-maintainer-gitflow'
}, { requireProjectName: true });
const artifacts = buildArtifacts(project);
const v3Root = await newCase('activation-v3-local');
await install(v3Root, new Map(artifacts.map((artifact) => [artifact.pathParts.join('/'), Buffer.from(artifact.content)])));
let state = validateUserActivationState({
  schemaVersion: currentActivationIdentity.activationStateSchemaVersion, identity: currentActivationIdentity,
  repository: { id: 'local:11111111-1111-4111-8111-111111111111', name: 'Flight Log', defaultBranch: 'develop' },
  activeChange: null,
  applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
  phases: Object.fromEntries(canonicalPhaseGraph.phases.map(({ id }) => [id, {
    state: 'pending', updatedAt: timestamp, evidence: [], approvals: [], blockers: []
  }])), createdAt: timestamp, updatedAt: timestamp
});
const writtenState = await stateFiles.writeActivationState(v3Root, state, { expectedContentHash: null });
const phase = canonicalPhaseGraph.phases.find(({ id }) => id === 'seed-valid');
const context = fixtures.fixtureContext(phase.id, { repositoryId: state.repository.id, now: new Date(timestamp) });
const plan = fixtures.fixturePlan(context, state, timestamp, fixtures.fixturePayload(phase.id), v3Root);
await records.saveTransitionPlan(v3Root, plan);
const payload = {
  kind: 'seed-valid.v1', status: 'failed', reason: 'Deliberate offline serializer input; no project check or provider operation ran.',
  planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan)
};
const inspection = { state, graph: canonicalPhaseGraph, contexts: { [phase.id]: context }, sourceOfTruth: { status: 'none' } };
const header = records.evidenceHeaderFor({ inspection, phase, plan, result: 'failed', now: new Date(timestamp), payload });
const evidenceRecord = { evidenceId: 'released-local-failure', header, payload };
state = records.nextStateForOutcome({
  inspection, phase, plan, resultState: 'failed', now: new Date(timestamp),
  evidenceReference: { phaseId: phase.id, evidenceId: evidenceRecord.evidenceId, headerDigest: canonicalSha256(header), result: 'failed' }
});
await records.writeOutcomeTransaction({
  projectRoot: v3Root, plan, nextState: state, evidenceRecord,
  evidencePathParts: ['governance', 'evidence', `${evidenceRecord.evidenceId}.json`],
  expectedStateHash: writtenState.contentHash
});
const commitPhase = canonicalPhaseGraph.phases.find(({ id }) => id === 'committed');
const commitContext = fixtures.fixtureContext(commitPhase.id, { repositoryId: state.repository.id, now: new Date(timestamp) });
const commitPlan = fixtures.fixturePlan(commitContext, state, timestamp, fixtures.fixturePayload(commitPhase.id), v3Root);
const request = approvals.approvalRequestForSavedPlan(commitPlan, commitPhase, state);
const envelope = validateApprovalEnvelope({
  ...request, schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
  id: 'committed-review', approver: 'fixture-owner', approvedAt: timestamp, expiresAt: '2026-09-09T01:00:00.000Z'
});
if (approvals.canonicalApprovalEnvelopeHash(envelope) !== commitPlan.approval.envelopeHash) {
  throw new Error('The released fixture approval does not match its original plan.');
}
await records.saveTransitionPlan(v3Root, commitPlan);
const authorityHome = path.join(destination, 'activation-v3-authority-home');
await mkdir(authorityHome, { mode: 0o700 });
await writeGovernanceApprovalAuthority(v3Root, canonicalSha256({ fixture: 'released-offline-approval' }), envelope, {
  homedir: authorityHome, env: {}, repositoryRoot: v3Root, clock: () => new Date(timestamp)
});
await projectTransaction.applyProjectFileTransaction(v3Root, [{
  type: 'write', pathParts: ['governance', 'approvals', `${envelope.id}.json`], content: `${canonicalJson(envelope)}\n`
}]);
state.phases.committed = { state: 'approved', updatedAt: timestamp, evidence: [], approvals: [envelope.id], blockers: [] };
await stateFiles.writeActivationState(v3Root, state, {
  expectedContentHash: stateFiles.activationStateContentHash(await readFile(path.join(v3Root, 'governance', 'activation-state.json')))
});
await record('activation-v3-disallowed-terminal', v3Root, {
  release: 'v0.12.3', kind: 'released-serializer-negative-input',
  entrypoint: 'src/governance-activation/activation-state.ts#writeActivationState',
  limitations: 'The generic released writer accepts approved, but committed has no approved terminal result in the released graph. This exact emitted negative fixture must remain blocked by the historical reader.'
});
state.phases.committed.state = 'ready';
await stateFiles.writeActivationState(v3Root, state, {
  expectedContentHash: stateFiles.activationStateContentHash(await readFile(path.join(v3Root, 'governance', 'activation-state.json')))
});
await record('activation-v3-local', v3Root, {
  release: 'v0.12.3', kind: 'released-production-serializers-with-offline-inputs',
  entrypoints: [
    'src/templates.ts#buildArtifacts', 'tests/governance-activation-fixtures.ts#fixturePlan',
    'src/governance-activation/activation-state.ts#writeActivationState',
    'src/governance-activation/transition-records.ts#saveTransitionPlan',
    'src/governance-activation/transition-records.ts#evidenceHeaderFor',
    'src/governance-activation/transition-records.ts#nextStateForOutcome',
    'src/governance-activation/transition-records.ts#writeOutcomeTransaction',
    'src/governance-activation/authority-records.ts#writeGovernanceApprovalAuthority'
  ],
  limitations: 'Controlled inputs, not historical user records or successful execution. Only local failure evidence is emitted; approval is test authority and no publication/provider action runs. Public approval uses the released canonicalJson + newline serializer.'
}, { externalAuthority: await fileTree(authorityHome) });

const v3AncestorRoot = await newCase('activation-v3-with-v2-v1-history');
await install(v3AncestorRoot, v2Ancestor.files);
const { inspectProjectUpdate } = await baseline.import('src/application/update/inspection.ts');
const { planUpdateWrites } = await baseline.import('src/application/update/write-plan.ts');
const update = await inspectProjectUpdate(v3AncestorRoot);
const migration = update.historyMigration;
if (migration.status !== 'eligible') throw new Error(`Released v2 history planning failed: ${JSON.stringify(migration)}`);
const writes = planUpdateWrites(update, false);
if (writes.skipped.length) throw new Error('Released history fixture unexpectedly requires force.');
const finalized = history.finalizeActivationHistoryMigration(
  migration, canonicalSha256({ fixture: 'released-v2-to-v3-history' }), new Date(timestamp)
);
await projectTransaction.applyProjectFileTransaction(v3AncestorRoot, [...finalized.mutations, ...writes.mutations]);
await record('activation-v3-with-v2-v1-history', v3AncestorRoot, {
  release: 'v0.12.3', kind: 'released-history-and-managed-update-writer-output',
  entrypoints: [
    'src/application/update/inspection.ts#inspectProjectUpdate',
    'src/application/update/write-plan.ts#planUpdateWrites',
    'src/governance-activation/migration-history.ts#finalizeActivationHistoryMigration',
    'src/adapters/filesystem/project-transaction.ts#applyProjectFileTransaction'
  ],
  source: 'activation-v2-with-v1-history',
  limitations: 'Local serialization/transaction capture only; migration revalidation remains pending, with no inherited proof or live execution.'
});

await writeFile(path.join(destination, 'activation-capture.json'), `${JSON.stringify({
  platform: process.platform, node: process.version, cases,
  sourceFiles: { 'v0.12.3': [...baseline.loaded].sort(), 'v0.11.2': [...ancestor.loaded].sort() }
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

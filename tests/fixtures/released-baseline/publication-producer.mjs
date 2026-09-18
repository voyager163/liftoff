import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadReleasedSource } from './source-loader.mjs';

const input = JSON.parse(process.argv[2]);
const released = loadReleasedSource(input.sourceRoot);
const root = input.projectRoot;
const timestamp = '2026-09-01T10:00:00.000Z';
const repository = 'owner/repo';
const pushUrl = `https://github.com/${repository}.git`;
const azureInputs = {
  schemaVersion: 1, phases: {},
  azure: {
    subscriptionId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222', region: 'eastus'
  }
};
const gitEnvironment = {
  PATH: process.env.PATH, HOME: input.legacyHome, USERPROFILE: input.legacyHome,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: input.emptyGitConfig, GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp
};
function git(args) {
  const result = spawnSync('git', [
    '-c', 'protocol.allow=never', '-c', `core.hooksPath=${input.emptyHooks}`,
    '-c', 'commit.gpgSign=false', '-c', 'user.name=Offline released fixture',
    '-c', 'user.email=fixture@example.invalid', ...args
  ], { cwd: root, env: gitEnvironment, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Owned fixture Git failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
async function put(parts, content) {
  const filename = path.join(root, ...parts);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, content, { flag: 'wx', mode: 0o644 });
}

const { buildProjectPlan } = await released.import('src/application/project/planning.ts');
const { buildArtifacts } = await released.import('src/templates.ts');
const { loadManifest } = await released.import('src/application/project/manifest.ts');
const { canonicalPhaseGraph, currentActivationIdentity } = await released.import('src/domain/governance/activation/graph.ts');
const { canonicalJson, canonicalSha256 } = await released.import('src/domain/governance/activation/canonical-json.ts');
const { validateUserActivationState, validateApprovalEnvelope } = await released.import('src/domain/governance/activation/validators.ts');
const { readActivationInputSnapshot, activationEvidenceContexts, phaseInputDigest } = await released.import('src/governance-activation/inputs.ts');
const { markAllSeedTasksForArchive } = await released.import('src/governance-activation/seed-lifecycle.ts');
const { approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash } = await released.import('src/domain/governance/activation/approvals.ts');
const { writeGovernanceApprovalAuthority } = await released.import('src/governance-activation/authority-records.ts');
const records = await released.import('src/governance-activation/transition-records.ts');
const stateFiles = await released.import('src/governance-activation/activation-state.ts');
const { fixturePlan, fixturePayload } = await released.import('tests/governance-activation-fixtures.ts');

const project = buildProjectPlan({
  projectName: 'Released Publication', projectType: 'standard', apiStack: 'node-fastify',
  cloud: 'azure', region: 'eastus', environments: ['dev'], includeFrontend: false,
  specWorkflow: 'openspec', agents: ['github-copilot'], governanceProfile: 'single-maintainer-gitflow'
}, { requireProjectName: true });
for (const artifact of buildArtifacts(project)) await put(artifact.pathParts, artifact.content);
for (const marker of [
  ...project.framework.baseMarkers,
  ...project.agents.flatMap((agent) => project.framework.agentMarkers[agent.id])
]) {
  try { await readFile(path.join(root, ...marker)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await put(marker, 'Controlled source-harness framework marker; not an official initialization capture.\n');
  }
}
const manifest = await loadManifest(root);
if (manifest.artifactVersion !== 7 || manifest.liftoffVersion !== '0.12.3' ||
    currentActivationIdentity.activationContractVersion !== 3) throw new Error('Wrong released writer identity.');

// Controlled archived-seed input, not a capture of a successful historical tool or provider run.
const seed = 'bootstrap-released-publication';
const capability = 'node-fastify-application-baseline';
const source = path.join(root, 'openspec', 'changes', seed);
const tasksPath = path.join(source, 'tasks.md');
await writeFile(tasksPath, markAllSeedTasksForArchive(await readFile(tasksPath, 'utf8')));
const delta = await readFile(path.join(source, 'specs', capability, 'spec.md'), 'utf8');
const archive = path.join(root, 'openspec', 'changes', 'archive', `20260901-${seed}`);
await mkdir(path.dirname(archive), { recursive: true });
await rename(source, archive);
await put(['openspec', 'specs', capability, 'spec.md'],
  `# Released publication fixture\n\n## Purpose\n\nExercise the retained publication contract with controlled offline observations.\n\n${delta.replace('## ADDED Requirements', '## Requirements')}`);
await mkdir(path.join(root, 'backend', 'node_modules'));
await mkdir(path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', 'dev', '.terraform'));
git(['init', '--quiet', '--initial-branch=develop']);
git(['remote', 'add', 'origin', pushUrl]);
git(['add', '--all']);
git(['commit', '--quiet', '-m', 'Original released fixture application and metadata']);
const head = git(['rev-parse', '--verify', 'HEAD']);
if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error('The fixture did not create an actual local commit.');

let state = validateUserActivationState({
  schemaVersion: 3, identity: currentActivationIdentity,
  repository: { id: `local:${randomUUID()}`, name: manifest.project.name, defaultBranch: 'develop' },
  remoteBinding: { id: '42', name: repository, defaultBranch: 'develop', pushUrl, verifiedAt: timestamp },
  activeChange: null,
  applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
  phases: Object.fromEntries(canonicalPhaseGraph.phases.map(({ id }) => [id, {
    state: 'pending', updatedAt: timestamp, evidence: [], approvals: [], blockers: []
  }])), createdAt: timestamp, updatedAt: timestamp
});
const runner = {
  async run(command) {
    if (command.executable !== 'git') throw new Error('The released serializer fixture only observes real local Git.');
    return { command, displayCommand: `git ${command.args.join(' ')}`, status: 0,
      stdout: git(command.args), stderr: '', signal: null, timedOut: false };
  }
};
const snapshot = await readActivationInputSnapshot(root, manifest, runner);
state.baselineAnchor = snapshot.baselineSha;
let stateHash = (await stateFiles.writeActivationState(root, state, { expectedContentHash: null })).contentHash;
const publicationDigests = {};
for (const phaseId of ['seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed']) {
  const now = new Date(timestamp);
  const phase = canonicalPhaseGraph.phases.find(({ id }) => id === phaseId);
  const contexts = activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now);
  const context = contexts[phaseId];
  const payload = {
    ...fixturePayload(phaseId),
    fixtureObservation: 'Controlled released serializer input; no historical check, push or GitHub request ran.',
    ...(['committed', 'pushed'].includes(phaseId) ? { head, branch: 'develop', pushUrl } : {}),
    ...(phaseId === 'seed-archived' ? { synchronizedSpecDigest: snapshot.workflowSpecDigest } : {})
  };
  const plan = fixturePlan(context, state, timestamp, payload, root);
  if (phase.approvalGate.required) {
    const envelope = validateApprovalEnvelope({
      ...approvalRequestForSavedPlan(plan, phase, state), schemaVersion: 3,
      id: plan.approval.envelopeId, approver: 'fixture-owner',
      approvedAt: timestamp, expiresAt: plan.expiresAt
    });
    if (canonicalApprovalEnvelopeHash(envelope) !== plan.approval.envelopeHash) throw new Error('Released approval does not match its plan.');
    await writeGovernanceApprovalAuthority(root, canonicalSha256(plan), envelope, {
      homedir: input.legacyHome, env: {}, repositoryRoot: root, clock: () => now
    });
    await put(['governance', 'approvals', `${envelope.id}.json`], `${canonicalJson(envelope)}\n`);
  }
  await records.saveTransitionPlan(root, plan);
  const inspection = { state, graph: canonicalPhaseGraph, contexts, sourceOfTruth: { status: 'none' } };
  const liveReadback = phaseId === 'pushed' ? [records.readbackProof(
    { inspection, phase, plan, now }, 'github', 'git-ref', `/repos/${repository}/git/ref/heads/develop`,
    { repositoryId: '42', repository, head, ref: 'refs/heads/develop' }
  )] : undefined;
  const boundPayload = { ...payload, planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan) };
  const header = records.evidenceHeaderFor({ inspection, phase, plan, result: 'verified', now, payload: boundPayload, liveReadback });
  const evidenceId = `released-serializer-${phaseId}`;
  const evidenceRecord = { evidenceId, header, payload: boundPayload, ...(liveReadback ? { liveReadback } : {}) };
  state = records.nextStateForOutcome({
    inspection, phase, plan, resultState: 'verified', now,
    evidenceReference: { phaseId, evidenceId, headerDigest: canonicalSha256(header), result: 'verified' }
  });
  stateHash = (await records.writeOutcomeTransaction({
    projectRoot: root, plan, nextState: state, evidenceRecord,
    evidencePathParts: records.evidencePathParts(evidenceId), expectedStateHash: stateHash
  })).stateHash;
  if (phaseId === 'committed' || phaseId === 'pushed') publicationDigests[phaseId] = {
    original: context.inputDigest, withLaterAzure: phaseInputDigest(phaseId, snapshot, { ...state, activationInputs: azureInputs })
  };
}
process.stdout.write(JSON.stringify({
  release: 'v0.12.3', baselineCommit: '70d10881b46d873118d825735696f39b6d35ebe0',
  kind: 'released-production-serializers-real-local-git-controlled-remote-observation',
  identity: currentActivationIdentity, head, repository, pushUrl, azureInputs, publicationDigests,
  loaded: [...released.loaded].sort()
}));

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from '../../../src/domain/governance/activation/canonical-json.js';
import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, historicalV3ActivationIdentity
} from '../../../src/domain/governance/policy/identity.js';
import {
  historicalV3PhaseGraph, historicalV3PhaseIds, historicalV3InputDigest, historicalV3PhaseContractDigest,
  validateHistoricalV3ActivationState, validateHistoricalV3EvidenceRecord, validateHistoricalV3SavedTransitionPlan
} from '../../../src/governance-activation/historical-v3.js';
import { rawHistoryDigest } from '../../../src/governance-activation/history-contracts.js';
import { buildHistoricalV1Fixture } from '../activation-v1/fixture.js';

const require = createRequire(import.meta.url);
const legacyRoot = path.resolve('assets/governance/single-maintainer-gitflow/activation-v3-reader/domain/governance/activation');
const legacyApprovals = require(path.join(legacyRoot, 'approvals.js'));
const legacyValidators = require(path.join(legacyRoot, 'validators.js'));
const createdAt = '2026-09-01T10:00:00.000Z';
export const publicationHead = 'c'.repeat(40);
export const publicationRepository = 'example-org/flight-log';
export const publicationInputs = {
  schemaVersion: 1 as const, phases: {},
  azure: {
    subscriptionId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222', region: 'eastus'
  }
};
const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, '\t')}\n`.replace(/\n/g, '\r\n'));

export async function writeHistoricalV3Fixture(root: string) {
  const base = buildHistoricalV1Fixture();
  const graph = historicalV3PhaseGraph() as any;
  const files = new Map([...base.files].filter(([name]) => !name.startsWith('governance/')));
  const state = validateHistoricalV3ActivationState({
    schemaVersion: 3, identity: historicalV3ActivationIdentity,
    repository: { id: 'local:11111111-1111-4111-8111-111111111111', name: 'Flight Log', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: publicationRepository, defaultBranch: 'develop', pushUrl: `https://github.com/${publicationRepository}.git`, verifiedAt: createdAt },
    activeChange: null, baselineAnchor: 'a'.repeat(64),
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases: Object.fromEntries(historicalV3PhaseIds.map((id) => [id, {
      state: 'pending', updatedAt: createdAt, evidence: [], approvals: [], blockers: []
    }])), createdAt, updatedAt: createdAt
  });
  const snapshot = {
    schemaVersion: 2 as const, project: base.manifest.project,
    files: [{ path: 'backend/src/index.ts', digest: rawHistoryDigest(files.get('backend/src/index.ts')!) }],
    git: { head: publicationHead, branch: 'develop', pushUrls: [state.remoteBinding!.pushUrl] },
    baselineSha: state.baselineAnchor!
  };
  for (const phaseId of ['seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed'] as const) {
    const phase = graph.phases.find((phase: any) => phase.id === phaseId);
    const inputDigest = historicalV3InputDigest(phaseId, snapshot, state);
    const transition = { phaseId, baselineSha: state.baselineAnchor!, inputDigest, transitionDigest: canonicalSha256({ phaseId, inputDigest }) };
    const actionId = phaseId === 'seed-valid' ? 'openspec.seed.validate' : phaseId === 'seed-verified'
      ? 'openspec.seed.baseline-verify' : phaseId === 'seed-archived' ? 'openspec.seed.archive'
        : phaseId === 'committed' ? 'git.verify-existing-commit' : 'git.verify-existing-push';
    const operations = [{
      phaseId, adapter: phaseId === 'committed' || phaseId === 'pushed' ? 'git' : 'selected-spec-workflow',
      actionId, mutationClass: phaseId === 'pushed' ? 'github-read' : 'read-worktree',
      remote: phaseId === 'pushed', destructive: false,
      destination: phaseId === 'pushed'
        ? { type: 'repository', identity: state.remoteBinding!.pushUrl, repository: publicationRepository, ref: 'refs/heads/develop' }
        : { type: 'local', identity: 'released-v3-checkout' },
      inputs: { head: publicationHead, branch: 'develop' }
    }];
    const request = legacyApprovals.transitionPlanForPhase(phase, state, transition, root, undefined, { operations });
    const envelope = legacyValidators.validateApprovalEnvelope({
      ...request, schemaVersion: 3, id: `released-v3-${phaseId}-approval`,
      approvedAt: createdAt, expiresAt: '2026-09-01T10:15:00.000Z', approver: 'historical-regression-fixture'
    });
    const evaluation = legacyApprovals.evaluateApprovalForTransitionPlan(request, [envelope], { now: new Date(createdAt) });
    const plan = validateHistoricalV3SavedTransitionPlan({
      schemaVersion: 2, scope: phaseId.startsWith('seed-') ? 'local' : 'activation',
      phaseId, createdAt, expiresAt: envelope.expiresAt, identity: historicalV3ActivationIdentity,
      graphHash: historicalV3ActivationIdentity.phaseGraphHash, stateHash: canonicalSha256(state),
      baselineDigest: transition.baselineSha, inputDigest, transitionDigest: transition.transitionDigest,
      planDigest: canonicalSha256({ phaseId, transitionDigest: transition.transitionDigest, operations, approvalPlanDigest: request.planDigest }),
      operations, mutationClasses: phase.allowedMutations,
      approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required,
        evaluation, envelopeId: phase.approvalGate.required ? envelope.id : null,
        envelopeHash: phase.approvalGate.required ? legacyApprovals.canonicalApprovalEnvelopeHash(envelope) : null },
      rollbackPlan: { phaseId, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
      noSecrets: true
    });
    const payload = {
      kind: `${phaseId}.v1`, head: publicationHead, pushUrl: state.remoteBinding!.pushUrl,
      ...(phaseId === 'seed-verified' ? { checks: [{ id: 'backend-tests', status: 'passed' }] } : {}),
      planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan)
    };
    const factDigest = canonicalSha256({ repository: publicationRepository, head: publicationHead, ref: 'refs/heads/develop' });
    const liveReadback = phaseId === 'pushed' ? [{
      schemaVersion: 3, repositoryId: state.repository.id, identity: historicalV3ActivationIdentity,
      phaseGraphHash: historicalV3ActivationIdentity.phaseGraphHash, phaseId,
      baselineSha: transition.baselineSha, inputDigest, transition, observedAt: createdAt,
      provider: 'github', resourceType: 'git-ref', resourceId: `/repos/${publicationRepository}/git/ref/heads/develop`,
      sourceDigest: factDigest, readbackDigest: factDigest, matches: true
    }] : [];
    const record = validateHistoricalV3EvidenceRecord({
      evidenceId: `released-v3-${phaseId}`, payload, liveReadback,
      header: {
        schemaVersion: 3, repositoryId: state.repository.id, identity: historicalV3ActivationIdentity,
        phaseGraphHash: historicalV3ActivationIdentity.phaseGraphHash, phaseId,
        phaseContractDigest: historicalV3PhaseContractDigest(phaseId), inputDigest, baselineSha: transition.baselineSha,
        transition, producedAt: createdAt, producer: 'liftoff-governance-transition-engine',
        bodyDigest: canonicalSha256({ payload, liveReadback }), result: 'verified'
      }
    });
    files.set(`governance/plans/released-v3-${phaseId}.json`, bytes(plan));
    files.set(`governance/evidence/${record.evidenceId}.json`, bytes(record));
    if (phase.approvalGate.required) files.set(`governance/approvals/${envelope.id}.json`, bytes(envelope));
    state.phases[phaseId] = {
      state: 'verified', updatedAt: createdAt, blockers: [], approvals: phase.approvalGate.required ? [envelope.id] : [],
      evidence: [{ phaseId, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }]
    };
  }
  state.activationInputs = publicationInputs;
  files.set('governance/activation-state.json', bytes(state));
  files.set('.liftoff/governance/phase-graph.json', bytes(graph));
  files.set('.github/prompts/liftoff-repair.prompt.md', Buffer.from('# Released v3 repair integration fixture\n'));
  const ancestors = [historicalV1ActivationIdentity, historicalV2ActivationIdentity];
  const managed = [...base.manifest.managedArtifacts, {
    logicalName: 'liftoff-repair-copilot', category: 'governance',
    pathParts: ['.github', 'prompts', 'liftoff-repair.prompt.md'], contentHash: ''
  }];
  files.set('.liftoff/governance/compatibility.json', bytes({
    schemaVersion: 4, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.12.0',
    minimumLiftoffVersions: { manifestWriteVersion7: '0.10.0', remedy: 'Use the exact released activation family.' },
    manifest: { readVersions: [2, 3, 4, 5, 6, 7], writeVersion: 7, hashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash' },
    activation: {
      currentCompatibleTuples: [historicalV3ActivationIdentity],
      historicalReadability: { tuples: ancestors, readers: ['activation-v1', 'activation-v2'], execution: 'diagnostic-only', migration: 'explicit-successor-preserve-bytes' },
      recognizedGraphHashes: [historicalV3ActivationIdentity.phaseGraphHash], graphMappings: [], historicalStateMigrations: [],
      successorMigrations: ancestors.map((identity) => ({
        id: `activation-v${identity.activationContractVersion}-to-v3`, fromIdentity: identity, toIdentity: historicalV3ActivationIdentity,
        strategy: 'preserve-history-revalidate', historySchemaVersion: 1, journalSchemaVersion: 1
      })), unsupportedRemedy: 'Preserve original source bytes.'
    },
    managedCore: {
      logicalNameAllowlist: managed.map((artifact) => artifact.logicalName), pathAllowlist: managed.map((artifact) => artifact.pathParts),
      updateInventory: managed.map((artifact) => ({
        logicalName: artifact.logicalName, pathParts: artifact.pathParts, lifecycle: 'managed-core',
        contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
      })), validation: { strictJson: true, crossPlatformPathParts: true, noSetupSkillVersion: true, checkModeWritesBytes: 0 }
    }
  }));
  const manifest = {
    ...base.manifest, liftoffVersion: '0.12.3',
    governance: { ...base.manifest.governance, activationIdentity: historicalV3ActivationIdentity },
    managedArtifacts: managed.map((artifact) => ({ ...artifact, contentHash: `sha256:${rawHistoryDigest(files.get(artifact.pathParts.join('/'))!)}` }))
  };
  files.set('liftoff.manifest.json', bytes(manifest));
  for (const [name, content] of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return { manifest, state, files, snapshot };
}

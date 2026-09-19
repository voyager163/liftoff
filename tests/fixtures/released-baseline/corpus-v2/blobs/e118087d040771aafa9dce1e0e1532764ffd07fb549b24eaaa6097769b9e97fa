import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../../../src/domain/governance/activation/canonical-json.js';
import { historicalV1ActivationIdentity, historicalV2ActivationIdentity } from '../../../src/domain/governance/policy/identity.js';
import {
  historicalPhaseIds, historicalTransitionPlanPathParts, type HistoricalPhaseId
} from '../../../src/governance-activation/historical-state.js';
import {
  historicalV2EvidenceBodyDigest, historicalV2PhaseContractDigest, historicalV2PhaseGraph,
  validateHistoricalV2ActivationState, validateHistoricalV2ApprovalEnvelope, validateHistoricalV2EvidenceRecord,
  validateHistoricalV2SavedTransitionPlan, historicalV2ApprovalEnvelopeHash,
  type HistoricalV2ApprovalEnvelope, type HistoricalV2EvidenceRecord, type HistoricalV2SavedTransitionPlan
} from '../../../src/governance-activation/historical-v2.js';
import {
  activationHistoryIndexPathParts, historyArray, historyRecord, rawHistoryDigest, type ActivationHistoryIndex
} from '../../../src/governance-activation/history-contracts.js';
import { buildHistoricalV1Fixture } from '../activation-v1/fixture.js';

export const historicalV2FixtureCreatedAt = '2026-09-01T08:00:00.000Z';
export const historicalV2FixtureLocalAnchor = 'local:00000000-0000-4000-8000-000000000002';

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, '\t')}\n`.replace(/\n/g, '\r\n'));
}

export function historicalV2CompatibilityFixture(
  schemaVersion: 2 | 3, managedCore: unknown
) {
  return {
    schemaVersion, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.11.0',
    minimumLiftoffVersions: { manifestWriteVersion7: '0.10.0', remedy: 'Use a release with a declared successor contract.' },
    manifest: { readVersions: [2, 3, 4, 5, 6, 7], writeVersion: 7, hashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash' },
    activation: {
      currentCompatibleTuples: [historicalV2ActivationIdentity],
      historicalReadability: {
        tuples: [historicalV1ActivationIdentity], activationContractVersion: 1, activationStateSchemaVersion: 1,
        evidenceHeaderSchemaVersion: 1, execution: 'diagnostic-only',
        migration: schemaVersion === 2 ? 'unsupported-preserve-bytes' : 'explicit-successor-preserve-bytes'
      },
      recognizedGraphHashes: [historicalV2ActivationIdentity.phaseGraphHash],
      graphMappings: [], historicalStateMigrations: [],
      ...(schemaVersion === 3 ? { successorMigrations: [{
        id: 'activation-v1-to-v2', fromIdentity: historicalV1ActivationIdentity, toIdentity: historicalV2ActivationIdentity,
        strategy: 'preserve-history-revalidate', historySchemaVersion: 1, journalSchemaVersion: 1
      }] } : {}),
      unsupportedRemedy: 'Preserve unsupported activation records.'
    },
    managedCore
  };
}

export function buildHistoricalV2Fixture(options: {
  workflow?: 'openspec' | 'spec-kit';
  localAnchor?: string;
  retention?: 'retained' | 'disposed';
  ancestor?: { index: ActivationHistoryIndex; indexContent: Buffer; files: ReadonlyMap<string, Buffer> };
} = {}) {
  const workflow = options.workflow ?? 'openspec';
  const common = buildHistoricalV1Fixture();
  const files = new Map([...common.files].filter(([name]) =>
    !name.startsWith('governance/evidence/') && !name.startsWith('governance/plans/') &&
    !name.startsWith('governance/approvals/') && name !== 'governance/activation-state.json'));
  files.set('governance/evidence/notes.txt', Buffer.from('Unowned neighbor; never retired.\n'));
  const state = validateHistoricalV2ActivationState({
    schemaVersion: 2, identity: historicalV2ActivationIdentity,
    repository: { id: options.localAnchor ?? historicalV2FixtureLocalAnchor, name: 'Flight Log', defaultBranch: 'develop' },
    remoteBinding: {
      id: 'R_SOURCE_REMOTE', name: 'example-org/flight-log', defaultBranch: 'develop',
      pushUrl: 'https://github.com/example-org/flight-log.git', verifiedAt: historicalV2FixtureCreatedAt
    },
    activeChange: null, applicability: { statePath: 'existing-private', privateStagingDast: false, credentialRequired: false },
    phases: Object.fromEntries(historicalPhaseIds.map((id) => [id, {
      state: 'pending', updatedAt: historicalV2FixtureCreatedAt, evidence: [], approvals: [], blockers: []
    }])), createdAt: historicalV2FixtureCreatedAt, updatedAt: historicalV2FixtureCreatedAt
  });
  const records: HistoricalV2EvidenceRecord[] = [];
  const plans: HistoricalV2SavedTransitionPlan[] = [];
  const approvals: HistoricalV2ApprovalEnvelope[] = [];
  const graph = historicalV2PhaseGraph();
  const graphNodes = historyArray(graph.phases, 'fixture graph').map((entry) => historyRecord(entry, 'fixture phase'));
  for (const phaseId of ['seed-valid', 'seed-verified', 'seed-archived', 'committed'] as const) {
    const node = graphNodes.find((entry) => entry.id === phaseId)!;
    const gate = historyRecord(node.approvalGate, 'fixture approval');
    const baselineSha = canonicalSha256({ publishedV2Baseline: 'flight-log' });
    const inputDigest = canonicalSha256({ publishedV2Input: phaseId });
    const transition = { phaseId, baselineSha, inputDigest, transitionDigest: canonicalSha256({ publishedV2Transition: phaseId }) };
    const evidenceId = `published-v2-${phaseId}`;
    const operations = [{
      adapter: phaseId === 'committed' ? 'git' : 'selected-spec-workflow',
      actionId: phaseId === 'seed-valid' ? 'openspec.seed.validate' : phaseId === 'seed-verified'
        ? 'openspec.seed.baseline-verify' : phaseId === 'seed-archived' ? 'openspec.seed.archive' : 'git.verify-existing-commit',
      mutationClass: 'read-worktree', phaseId, inputs: {},
      destination: { type: 'local', identity: 'historical-v2-project' }, remote: false, destructive: false
    }, {
      adapter: 'local-evidence', actionId: 'governance.evidence.write', mutationClass: 'write-evidence', phaseId,
      inputs: { pathParts: ['governance', 'evidence', `${evidenceId}.json`] },
      destination: { type: 'local', identity: `governance/evidence/${evidenceId}.json`, pathParts: ['governance', 'evidence', `${evidenceId}.json`] },
      remote: false, destructive: false
    }, {
      adapter: 'local-evidence', actionId: 'governance.activation-state.write', mutationClass: 'write-activation-state', phaseId,
      inputs: { pathParts: ['governance', 'activation-state.json'] },
      destination: { type: 'local', identity: 'governance/activation-state.json', pathParts: ['governance', 'activation-state.json'] },
      remote: false, destructive: false
    }];
    const approvalPlanDigest = canonicalSha256({
      phaseId, gateKind: gate.kind, transitionDigest: transition.transitionDigest, allowedMutations: node.allowedMutations
    });
    let envelopeId: string | null = null;
    let envelopeHash: string | null = null;
    if (phaseId === 'committed') {
      const envelope = validateHistoricalV2ApprovalEnvelope({
        schemaVersion: 2, id: 'published-v2-publication-approval', phaseId, gateKind: gate.kind,
        identity: historicalV2ActivationIdentity, baselineSha, planDigest: approvalPlanDigest,
        resources: [], destinations: [], permissions: ['git-commit'],
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        policyExceptions: [], destructiveScope: [], approvedAt: historicalV2FixtureCreatedAt,
        expiresAt: '2026-09-01T08:15:00.000Z', approver: 'historical-maintainer'
      });
      approvals.push(envelope);
      envelopeId = envelope.id;
      envelopeHash = historicalV2ApprovalEnvelopeHash(envelope);
      files.set(`governance/approvals/${envelope.id}.json`, bytes(envelope));
    }
    const plan = validateHistoricalV2SavedTransitionPlan({
      schemaVersion: 1, phaseId, createdAt: historicalV2FixtureCreatedAt, expiresAt: '2026-09-01T08:15:00.000Z',
      identity: historicalV2ActivationIdentity, graphHash: historicalV2ActivationIdentity.phaseGraphHash,
      stateHash: canonicalSha256(state), baselineDigest: baselineSha, inputDigest, transitionDigest: transition.transitionDigest,
      planDigest: canonicalSha256({ phaseId, transitionDigest: transition.transitionDigest, approvalPlanDigest, operations }),
      mutationClasses: node.allowedMutations, operations,
      approval: {
        gateKind: gate.kind, required: gate.required, envelopeId, envelopeHash,
        evaluation: {
          phaseId, gateKind: gate.kind, questionKind: phaseId === 'committed' ? 'repository-creation-initial-commit-push' : null,
          approvalRequired: false, status: phaseId === 'committed' ? 'reused' : 'not-required',
          envelopeId, envelopeHash, reasons: [], expansionReasons: []
        }
      },
      rollbackPlan: { phaseId, strategy: 'none', target: null, operations: [], retained: [], cleanupWarnings: [] }, noSecrets: true
    });
    const payload = {
      kind: `${phaseId}.v1`, status: 'passed', planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
      ...(phaseId === 'seed-archived' ? workflow === 'openspec'
        ? { archivePathParts: ['openspec', 'changes', 'archive', '20260830-bootstrap-flight-log'] }
        : { workflowKind: 'spec-kit', status: 'finalized' } : {})
    };
    const record = validateHistoricalV2EvidenceRecord({
      evidenceId, payload,
      header: {
        schemaVersion: 2, repositoryId: state.repository.id, identity: historicalV2ActivationIdentity,
        phaseGraphHash: historicalV2ActivationIdentity.phaseGraphHash, phaseId,
        phaseContractDigest: historicalV2PhaseContractDigest(phaseId), baselineSha, inputDigest, transition,
        producedAt: historicalV2FixtureCreatedAt, producer: 'liftoff-governance-transition-engine', result: 'verified',
        bodyDigest: historicalV2EvidenceBodyDigest(payload)
      }
    });
    plans.push(plan);
    records.push(record);
    files.set(historicalTransitionPlanPathParts(plan).join('/'), bytes(plan));
    files.set(`governance/evidence/${evidenceId}.json`, bytes(record));
    state.phases[phaseId] = {
      state: 'verified', updatedAt: historicalV2FixtureCreatedAt, blockers: [],
      approvals: envelopeId ? [envelopeId] : [],
      evidence: [{ phaseId, evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }]
    };
  }
  if (options.retention) {
    const lifecycleRecord = (phaseId: HistoricalPhaseId, result: 'verified' | 'disposed') => {
      const inputDigest = canonicalSha256({ originalLifecycle: phaseId });
      const baselineSha = canonicalSha256({ originalRemoteImport: 'verified' });
      const payload = { kind: `${phaseId}.v1`, historicalObservation: true };
      const record = validateHistoricalV2EvidenceRecord({
        evidenceId: `published-v2-${phaseId}`, payload,
        header: {
          schemaVersion: 2, repositoryId: state.repository.id, identity: historicalV2ActivationIdentity,
          phaseGraphHash: historicalV2ActivationIdentity.phaseGraphHash, phaseId,
          phaseContractDigest: historicalV2PhaseContractDigest(phaseId), baselineSha, inputDigest,
          transition: { phaseId, baselineSha, inputDigest, transitionDigest: canonicalSha256({ originalLifecycleTransition: phaseId }) },
          producedAt: historicalV2FixtureCreatedAt, producer: 'historical-independent-observation', result,
          bodyDigest: historicalV2EvidenceBodyDigest(payload)
        }
      });
      records.push(record);
      files.set(`governance/evidence/${record.evidenceId}.json`, bytes(record));
      state.phases[phaseId] = {
        state: result, updatedAt: historicalV2FixtureCreatedAt, approvals: [], blockers: [],
        evidence: [{ phaseId, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result }]
      };
      return record;
    };
    const remote = lifecycleRecord('remote-import-verified', 'verified');
    const deletion = options.retention === 'disposed' ? lifecycleRecord('bootstrap-state-disposed', 'disposed') : undefined;
    state.bootstrapState = {
      status: options.retention, remoteImportEvidenceId: remote.evidenceId,
      remoteImportEvidenceDigest: canonicalSha256(remote.header),
      retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z',
      encryptedStatePathParts: [['governance', 'protected-material', 'opaque-bootstrap-data']],
      encryptionKeyPathParts: [['governance', 'protected-material', 'opaque-bootstrap-key']],
      ...(deletion ? { disposedAt: '2026-09-01T00:00:00.000Z', deletionEvidenceId: deletion.evidenceId } : {})
    };
  }
  files.set('governance/activation-state.json', bytes(state));
  files.set('.liftoff/governance/phase-graph.json', bytes(graph));
  const v1Metadata = JSON.parse(common.files.get('.liftoff/governance/compatibility.json')!.toString('utf8'));
  files.set('.liftoff/governance/compatibility.json', bytes(historicalV2CompatibilityFixture(3, v1Metadata.managedCore)));
  files.set('.liftoff/governance/credential-policy.schema.json', bytes({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: { identity: { properties: Object.fromEntries(Object.entries(historicalV2ActivationIdentity).map(([key, value]) => [key, { const: value }])) } }
  }));
  if (workflow === 'spec-kit') {
    const config = JSON.parse(files.get('liftoff.config.json')!.toString('utf8'));
    files.set('liftoff.config.json', bytes({ ...config, specWorkflow: workflow, defaultAgent: 'github-copilot' }));
    const context = JSON.parse(files.get('.liftoff/governance/context.json')!.toString('utf8'));
    files.set('.liftoff/governance/context.json', bytes({
      ...context, framework: { ...context.framework, id: workflow },
      supportedStack: { ...context.supportedStack, framework: { ...context.supportedStack.framework, id: workflow } }
    }));
    files.set('.specify/integration.json', bytes({ default_integration: 'copilot', installed_integrations: ['copilot'] }));
  }
  const manifest = {
    ...common.manifest, liftoffVersion: '0.11.3',
    project: { ...common.manifest.project, specWorkflow: workflow, ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}) },
    framework: { ...common.manifest.framework, adapter: workflow },
    governance: { ...common.manifest.governance, activationIdentity: historicalV2ActivationIdentity },
    managedArtifacts: common.manifest.managedArtifacts.map((file) => ({
      ...file, contentHash: `sha256:${rawHistoryDigest(files.get(file.pathParts.join('/'))!)}`
    }))
  };
  files.set('liftoff.manifest.json', bytes(manifest));
  if (options.ancestor) {
    const ancestor = options.ancestor;
    files.set(activationHistoryIndexPathParts(ancestor.index.snapshotId).join('/'), Buffer.from(ancestor.indexContent));
    for (const file of ancestor.index.files) files.set(file.copyPathParts.join('/'), Buffer.from(ancestor.files.get(file.originalPathParts.join('/'))!));
    files.set('governance/migration-state.json', bytes({
      schemaVersion: 1, laneId: 'activation-v1-to-v2', snapshotId: ancestor.index.snapshotId,
      historyIndexPathParts: activationHistoryIndexPathParts(ancestor.index.snapshotId),
      historyIndexDigest: rawHistoryDigest(ancestor.indexContent), sourceIdentity: historicalV1ActivationIdentity,
      targetIdentity: historicalV2ActivationIdentity, approvedPlanFingerprint: canonicalSha256({ earlierApprovedMigration: true }),
      successor: { repositoryId: state.repository.id, createdAt: state.createdAt },
      transaction: { status: 'committed', committedAt: state.createdAt },
      revalidation: {
        status: 'complete', updatedAt: state.createdAt, nextAction: null,
        phases: ['seed-valid', 'seed-verified', 'seed-archived'].map((phaseId) => ({
          phaseId, status: 'complete', evidenceIds: [`published-v2-${phaseId}`], blockers: []
        }))
      }
    }));
  }
  return { files, state, manifest, records, plans, approvals, graph };
}

export async function writeHistoricalV2Fixture(
  root: string, options: Parameters<typeof buildHistoricalV2Fixture>[0] = {}
) {
  const fixture = buildHistoricalV2Fixture(options);
  for (const [name, content] of fixture.files) {
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
    await chmod(target, 0o600);
  }
  return fixture;
}

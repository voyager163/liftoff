import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../../../src/domain/governance/activation/canonical-json.js';
import type { PhaseExecutionState, TransitionOperation } from '../../../src/domain/governance/activation/types.js';
import { historicalActivationIdentities } from '../../../src/domain/governance/policy/identity.js';
import {
  assertHistoricalPhasesComplete, historicalPhaseIds, historicalTransitionPlanPathParts,
  type HistoricalActivationState, type HistoricalApprovalEnvelope, type HistoricalEvidenceRecord,
  type HistoricalPhaseId, type HistoricalSavedTransitionPlan
} from '../../../src/governance-activation/historical-state.js';
import { rawHistoryDigest } from '../../../src/governance-activation/history-contracts.js';
import { buildProjectPlan } from '../../../src/application/project/planning.js';
import { buildRepositoryGovernanceArtifacts } from '../../../src/repository-governance.js';
import { validateGovernanceCompatibilityMetadata } from '../../../src/governance-activation/compatibility.js';
import { historicalFixtureGraph } from './graph.js';

export const historicalFixtureIdentity = historicalActivationIdentities[0];
export const historicalFixtureCreatedAt = '2026-08-30T09:00:00.000Z';
export const historicalFixtureBaseline = canonicalSha256({ repository: 'example-org/flight-log', head: 'c'.repeat(40) });
export const historicalFixtureArchiveParts = ['openspec', 'changes', 'archive', '20260830-bootstrap-flight-log'] as const;
const capability = 'node-fastify-application-baseline';
const coreFiles = [
  ['repository-governance-policy', ['.liftoff', 'governance', 'policy.md']],
  ['repository-governance-context', ['.liftoff', 'governance', 'context.json']],
  ['repository-governance-guide', ['.liftoff', 'governance', 'README.md']],
  ['repository-governance-phase-graph', ['.liftoff', 'governance', 'phase-graph.json']],
  ['repository-governance-compatibility', ['.liftoff', 'governance', 'compatibility.json']],
  ['repository-governance-credential-policy-schema', ['.liftoff', 'governance', 'credential-policy.schema.json']],
  ['liftoff-setup-copilot', ['.github', 'prompts', 'liftoff-setup.prompt.md']],
  ['liftoff-governance-assess-copilot', ['.github', 'prompts', 'liftoff-governance-assess.prompt.md']]
] as const;
const historicalCoreLogicalNames = [
  'repository-governance-policy', 'repository-governance-context', 'repository-governance-guide',
  'repository-governance-phase-graph', 'repository-governance-compatibility', 'repository-governance-credential-policy-schema',
  'liftoff-setup-copilot', 'liftoff-setup-claude', 'liftoff-governance-assess-copilot', 'liftoff-governance-assess-claude'
] as const;
const hashAuthority = 'liftoff.manifest.json managedArtifacts[].contentHash';

function fixtureJson(value: unknown, crlf = false): Buffer {
  const text = `${JSON.stringify(value, null, crlf ? '\t' : 2)}\n`;
  return Buffer.from(crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

export function buildHistoricalV1Fixture() {
  const files = new Map<string, Buffer>();
  const phases: Partial<Record<HistoricalPhaseId, PhaseExecutionState>> = {};
  for (const id of historicalPhaseIds) phases[id] = {
    state: 'pending', updatedAt: historicalFixtureCreatedAt, evidence: [], approvals: [], blockers: []
  };
  assertHistoricalPhasesComplete(phases);
  const state: HistoricalActivationState = {
    schemaVersion: 1, identity: { ...historicalFixtureIdentity },
    repository: { id: 'R_HISTORICAL_FLIGHT_LOG', name: 'example-org/flight-log', defaultBranch: 'develop' },
    activeChange: null,
    applicability: { statePath: 'bootstrap-local', privateStagingDast: true, credentialRequired: true },
    phases, createdAt: historicalFixtureCreatedAt, updatedAt: '2026-08-30T09:30:00.000Z'
  };
  const records: HistoricalEvidenceRecord[] = [];
  const plans: HistoricalSavedTransitionPlan[] = [];
  const approvals: HistoricalApprovalEnvelope[] = [];
  const completed = ['seed-valid', 'seed-verified', 'seed-archived', 'committed'] as const;
  for (const [index, id] of completed.entries()) {
    const phase = historicalFixtureGraph.phases.find((entry) => entry.id === id);
    if (phase === undefined) throw new Error(`Missing frozen historical phase ${id}.`);
    const timestamp = `2026-08-30T09:${String(index * 5).padStart(2, '0')}:00.000Z`;
    const transition = {
      phaseId: id, baselineSha: historicalFixtureBaseline,
      inputDigest: canonicalSha256({ phase: id, fixture: 'pre-v2-current-inputs' }),
      transitionDigest: canonicalSha256({ phase: id, fixture: 'pre-v2-reviewed-transition' })
    };
    const approvalPlanDigest = canonicalSha256({
      phaseId: id, gateKind: phase.approvalGate.kind,
      transitionDigest: transition.transitionDigest, allowedMutations: phase.allowedMutations
    });
    const evidenceId = `${id}-${timestamp.replace(/[^0-9A-Za-z]/g, '')}`;
    const action = id === 'seed-valid' ? 'openspec.seed.validate' : id === 'seed-verified'
      ? 'openspec.seed.baseline-verify' : id === 'seed-archived' ? 'openspec.seed.archive' : 'git.verify-existing-commit';
    const operations: TransitionOperation[] = [{
      adapter: id === 'committed' ? 'git' : 'selected-spec-workflow',
      actionId: action, mutationClass: id === 'seed-archived' ? 'write-openspec-seed' : 'read-worktree', phaseId: id,
      inputs: id === 'seed-verified' ? { checks: [{ id: 'backend-tests', taskId: '2.2', applicable: true }] } : {},
      destination: id === 'seed-archived'
        ? { type: 'local', identity: 'openspec/changes', pathParts: ['openspec', 'changes'] }
        : { type: 'local', identity: 'historical-flight-log-checkout' },
      remote: false, destructive: false
    }, {
      adapter: 'local-evidence', actionId: 'governance.evidence.write', mutationClass: 'write-evidence', phaseId: id,
      inputs: { pathParts: ['governance', 'evidence', `${evidenceId}.json`] },
      destination: { type: 'local', identity: `governance/evidence/${evidenceId}.json`, pathParts: ['governance', 'evidence', `${evidenceId}.json`] },
      remote: false, destructive: false
    }, {
      adapter: 'local-evidence', actionId: 'governance.activation-state.write', mutationClass: 'write-activation-state', phaseId: id,
      inputs: { pathParts: ['governance', 'activation-state.json'] },
      destination: { type: 'local', identity: 'governance/activation-state.json', pathParts: ['governance', 'activation-state.json'] },
      remote: false, destructive: false
    }];
    let envelopeId: string | null = null;
    let envelopeHash: string | null = null;
    if (id === 'committed') {
      const approval: HistoricalApprovalEnvelope = {
        schemaVersion: 1, id: 'initial-baseline-publish', phaseId: id, gateKind: 'repository-publish',
        identity: { ...historicalFixtureIdentity }, baselineSha: historicalFixtureBaseline, planDigest: approvalPlanDigest,
        resources: [{ type: 'git-commit', identity: 'committed:git-commit' }],
        destinations: [{ type: 'repository', identity: 'example-org/flight-log', repository: 'example-org/flight-log', subscriptionId: null }],
        permissions: ['git-commit', 'read-worktree', 'write-activation-state', 'write-evidence'],
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        policyExceptions: [], destructiveScope: [], approvedAt: timestamp, expiresAt: '2026-08-30T10:15:00.000Z',
        approver: 'historical-fixture-maintainer'
      };
      approvals.push(approval);
      const { id: _id, approvedAt: _at, approver: _approver, ...scope } = approval;
      envelopeId = approval.id;
      envelopeHash = canonicalSha256(scope);
      files.set(`governance/approvals/${approval.id}.json`, fixtureJson(approval, true));
    }
    const plan: HistoricalSavedTransitionPlan = {
      schemaVersion: 1, phaseId: id, createdAt: timestamp, expiresAt: '2026-08-30T10:15:00.000Z',
      identity: { ...historicalFixtureIdentity }, graphHash: historicalFixtureIdentity.phaseGraphHash,
      stateHash: canonicalSha256(state), baselineDigest: historicalFixtureBaseline,
      inputDigest: transition.inputDigest, transitionDigest: transition.transitionDigest,
      planDigest: canonicalSha256({ phaseId: id, transitionDigest: transition.transitionDigest, approvalPlanDigest, operations }),
      mutationClasses: phase.allowedMutations, operations,
      approval: {
        gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, envelopeId, envelopeHash,
        evaluation: {
          phaseId: id, gateKind: phase.approvalGate.kind,
          questionKind: id === 'committed' ? 'repository-creation-initial-commit-push' : null,
          approvalRequired: false, status: id === 'committed' ? 'reused' : 'not-required',
          envelopeId, envelopeHash, reasons: [], expansionReasons: []
        }
      },
      rollbackPlan: { phaseId: id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
      noSecrets: true
    };
    const { label: _label, ...behavior } = phase;
    const record: HistoricalEvidenceRecord = {
      evidenceId,
      header: {
        schemaVersion: 1, repositoryId: state.repository.id, identity: { ...historicalFixtureIdentity },
        phaseGraphHash: historicalFixtureIdentity.phaseGraphHash, phaseId: id,
        phaseContractDigest: canonicalSha256(behavior), inputDigest: transition.inputDigest,
        baselineSha: historicalFixtureBaseline, transition, producedAt: timestamp,
        producer: 'liftoff-governance-transition-engine', result: 'verified'
      },
      payload: {
        kind: `${id}.v1`, changeName: 'bootstrap-flight-log',
        ...(id === 'seed-valid' ? { status: 'passed', capabilityId: capability } : {}),
        ...(id === 'seed-verified' ? { status: 'passed', checks: [{
          id: 'backend-tests', taskId: '2.2', status: 'passed', command: { executable: 'npm', args: ['test'], status: 0 },
          cwdPathParts: ['backend']
        }] } : {}),
        ...(id === 'seed-archived' ? {
          status: 'archived', archivePathParts: [...historicalFixtureArchiveParts],
          synchronizedSpecDigest: canonicalSha256({ capability, revision: 'original-v1-baseline' })
        } : {}),
        ...(id === 'committed' ? { head: 'c'.repeat(40), branch: 'develop', status: 'verified-existing-commit' } : {})
      }
    };
    plans.push(plan);
    records.push(record);
    files.set(historicalTransitionPlanPathParts(plan).join('/'), fixtureJson(plan, index % 2 === 0));
    files.set(`governance/evidence/${evidenceId}.json`, fixtureJson(record, index % 2 !== 0));
    state.phases[id] = {
      state: 'verified', updatedAt: timestamp,
      evidence: [{ phaseId: id, evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }],
      approvals: envelopeId === null ? [] : [envelopeId], blockers: []
    };
  }
  files.set('governance/activation-state.json', fixtureJson(state, true));
  files.set('.liftoff/governance/phase-graph.json', Buffer.from(canonicalJson(historicalFixtureGraph)));
  files.set('.liftoff/governance/policy.md', Buffer.from('---\nschemaVersion: 1\nprofile: single-maintainer-gitflow\npolicyVersion: "6"\n---\n\nHistorical policy fixture; no provider permissions are supplied.\n'));
  files.set('.liftoff/governance/README.md', Buffer.from('# Historical activation handoff\n\nInitial local work was completed with activation v1.\n'));
  files.set('.github/prompts/liftoff-setup.prompt.md', Buffer.from('# Historical setup\n\nUse the v1 governance transition engine for the exact recorded graph.\n'));
  files.set('.github/prompts/liftoff-governance-assess.prompt.md', Buffer.from('# Historical assessment\n\nRead-only assessment does not grant execution authority.\n'));
  files.set('.liftoff/governance/compatibility.json', fixtureJson({
    schemaVersion: 1, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.10.0',
    minimumLiftoffVersions: { manifestWriteVersion7: '0.10.0', remedy: 'Use the historical release matching this project.' },
    manifest: { readVersions: [2, 3, 4, 5, 6, 7], writeVersion: 7, hashAuthority },
    activation: {
      currentCompatibleTuples: [historicalFixtureIdentity], recognizedGraphHashes: [historicalFixtureIdentity.phaseGraphHash],
      graphMappings: [], historicalStateMigrations: [], unsupportedRemedy: 'Preserve unsupported activation state and evidence.'
    },
    managedCore: {
      logicalNameAllowlist: [...historicalCoreLogicalNames],
      pathAllowlist: coreFiles.map(([, pathParts]) => [...pathParts]),
      updateInventory: coreFiles.map(([logicalName, pathParts]) => ({ logicalName, pathParts, lifecycle: 'managed-core', contentHashAuthority: hashAuthority })),
      validation: { strictJson: true, crossPlatformPathParts: true, noSetupSkillVersion: true, checkModeWritesBytes: 0 }
    }
  }));
  files.set('.liftoff/governance/context.json', fixtureJson({
    schemaVersion: 1,
    policy: { profile: 'single-maintainer-gitflow', version: '6', state: 'handoff-generated', liveEnforcement: 'not-active' },
    project: { name: 'Flight Log', safeName: 'flight-log', workload: 'standard', artifactForm: 'containerized-api' },
    supportedStack: { id: 'historical-stack', verifiedOn: '2026-08-30', node: '24.20.0', npm: '11.9.0', framework: { id: 'openspec', version: '1.0.0' } },
    agents: ['github-copilot'], framework: { id: 'openspec', version: '1.0.0' },
    discovery: { githubRepository: 'undiscovered', defaultBranch: 'undiscovered', providerStatus: 'undiscovered' },
    commands: [{ id: 'backend-tests', executable: 'npm', args: ['test'], cwdPathParts: ['backend'] }],
    generatedBoundaries: { backend: { state: 'generated', pathParts: ['backend'] }, frontend: { state: 'inapplicable' } },
    environments: ['dev', 'staging', 'prod'],
    deployment: { provider: 'azure', region: 'eastus', liveState: 'undiscovered' },
    health: [{ component: 'backend', path: '/health', depth: 'shallow' }]
  }));
  files.set('.liftoff/governance/credential-policy.schema.json', fixtureJson({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://mission-control.local/liftoff/governance/credential-policy.schema.v1.json',
    type: 'object', properties: {
      identity: {
        type: 'object', additionalProperties: false, required: Object.keys(historicalFixtureIdentity),
        properties: Object.fromEntries(Object.entries(historicalFixtureIdentity).map(([key, value]) => [key, { const: value }]))
      }
    }
  }));
  const backendContent = Buffer.from("console.log('historical user-owned application');\n");
  files.set('backend/src/index.ts', backendContent);
  files.set('liftoff.config.json', fixtureJson({
    projectName: 'Flight Log', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus',
    environments: ['dev', 'staging', 'prod'], includeFrontend: false, specWorkflow: 'openspec',
    agents: ['github-copilot'], governanceProfile: 'single-maintainer-gitflow'
  }));
  const manifest = {
    artifactVersion: 7, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.10.0',
    project: {
      name: 'Flight Log', workload: { kind: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus', frontend: false, environments: ['dev', 'staging', 'prod'] },
      specWorkflow: 'openspec', agents: ['github-copilot']
    },
    framework: { state: 'initialized', adapter: 'openspec', contractVersion: '1.0.0' },
    governance: { profile: 'single-maintainer-gitflow', policyVersion: '6', state: 'handoff-generated', activationIdentity: historicalFixtureIdentity },
    managedArtifacts: coreFiles.map(([logicalName, pathParts]) => {
      const content = files.get(pathParts.join('/'));
      if (content === undefined) throw new Error(`Missing fixture managed artifact ${logicalName}.`);
      return { logicalName, category: 'governance', pathParts, contentHash: `sha256:${rawHistoryDigest(content)}` };
    }),
    projectArtifacts: [{
      logicalName: 'backend-entrypoint', category: 'backend', pathParts: ['backend', 'src', 'index.ts'],
      generatedBy: '0.10.0', generationHash: `sha256:${rawHistoryDigest(backendContent)}`, provisioningGroup: 'base'
    }]
  };
  files.set('liftoff.manifest.json', fixtureJson(manifest, true));
  const archiveSpec = '## Purpose\n\nPreserve the generated API baseline.\n\n## ADDED Requirements\n\n### Requirement: Baseline responds\nThe system SHALL respond to local health requests.\n\n#### Scenario: Local baseline\n- **WHEN** the local health endpoint is queried\n- **THEN** the generated API responds\n';
  const archive = historicalFixtureArchiveParts.join('/');
  files.set(`${archive}/.openspec.yaml`, Buffer.from('schema: spec-driven\n'));
  files.set(`${archive}/proposal.md`, Buffer.from(`## Why\n\nEstablish a local baseline.\n\n## Capabilities\n\n### New Capabilities\n\n- \`${capability}\`: Local API baseline.\n`));
  files.set(`${archive}/design.md`, Buffer.from('## Context\n\nGenerated API baseline, validated before archive; no remote resources were changed.\n'));
  files.set(`${archive}/tasks.md`, Buffer.from('- [x] 1.1 Inspect generated API\n- [x] 2.1 Strictly validate baseline spec\n- [x] 2.2 Run backend tests\n'));
  files.set(`${archive}/specs/${capability}/spec.md`, Buffer.from(archiveSpec));
  files.set(`openspec/specs/${capability}/spec.md`, Buffer.from(`# ${capability}\n\n${archiveSpec.replace('## ADDED Requirements', '## Requirements')}`));
  files.set('governance/evidence/notes.txt', Buffer.from('Unowned local notes: keep unchanged.\n'));
  files.set('governance/production-settings.json', Buffer.from('{"projectOwned":true}\n'));
  return { files, state, manifest, records, plans, approvals };
}

export function buildPostMaintenanceHistoricalV1Fixture(compatibilitySchemaVersion: 2 | 3 = 3) {
  const fixture = buildHistoricalV1Fixture();
  const project = buildProjectPlan({
    projectName: fixture.manifest.project.name, projectType: 'standard', apiStack: 'node-fastify',
    cloud: 'azure', region: 'eastus', environments: ['dev', 'staging', 'prod'], includeFrontend: false,
    specWorkflow: 'openspec', agents: ['github-copilot', 'claude'], governanceProfile: 'single-maintainer-gitflow'
  }, { requireProjectName: true });
  const core = buildRepositoryGovernanceArtifacts(project);
  for (const artifact of core) {
    let content = artifact.content;
    if (compatibilitySchemaVersion === 2 && artifact.logicalName === 'repository-governance-compatibility') {
      const value: unknown = JSON.parse(content);
      const metadata = validateGovernanceCompatibilityMetadata(value);
      const { successorMigrations: _successors, ...activation } = metadata.activation;
      content = canonicalJson({
        ...metadata, schemaVersion: 2,
        activation: {
          ...activation,
          historicalReadability: { ...activation.historicalReadability, migration: 'unsupported-preserve-bytes' }
        }
      });
    }
    fixture.files.set(artifact.pathParts.join('/'), Buffer.from(content.replace(/\r?\n/g, '\r\n'), 'utf8'));
  }
  const manifest = {
    ...fixture.manifest, liftoffVersion: '0.11.1',
    project: { ...fixture.manifest.project, agents: ['github-copilot', 'claude'] },
    managedArtifacts: core.map((artifact) => {
      const content = fixture.files.get(artifact.pathParts.join('/'));
      if (content === undefined) throw new Error(`Missing maintained source metadata ${artifact.logicalName}.`);
      return {
        logicalName: artifact.logicalName, category: artifact.category, pathParts: artifact.pathParts,
        contentHash: `sha256:${rawHistoryDigest(content)}`
      };
    })
  };
  fixture.files.set('liftoff.manifest.json', fixtureJson(manifest, true));
  return { ...fixture, manifest };
}

export async function writeHistoricalV1Fixture(root: string, options: { maintainedCoreCompatibilitySchema?: 2 | 3 } = {}) {
  const fixture = options.maintainedCoreCompatibilitySchema === undefined
    ? buildHistoricalV1Fixture() : buildPostMaintenanceHistoricalV1Fixture(options.maintainedCoreCompatibilitySchema);
  for (const [name, content] of fixture.files) {
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
    await chmod(target, 0o600);
  }
  return fixture;
}

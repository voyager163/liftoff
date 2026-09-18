import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalPhaseGraph, canonicalPhaseGraphHash, canonicalPhaseContractDigests, currentActivationIdentity
} from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  compatibilityMetadataSchemaVersion, governanceOutputSchemaVersion,
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, historicalV3ActivationIdentity
} from '../src/domain/governance/policy/identity.js';
import {
  validateActivationConfiguration, validateActivationIdentity, validateManagedPhaseGraph, validateUserActivationState
} from '../src/domain/governance/activation/validators.js';
import {
  phaseConsumedConfiguration, phaseInputDigest, type ActivationInputSnapshot
} from '../src/domain/governance/activation/inputs.js';
import { phaseIds, phaseInScope, repositoryPhaseIds, type TransitionOperation, type UserActivationState } from '../src/domain/governance/activation/types.js';
import { assertOperationAllowed, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import {
  historicalV3InputDigest, historicalV3PhaseGraph, historicalV3PhaseIds, historicalV3PhaseContractDigest,
  validateHistoricalV3ActivationState, type HistoricalV3ActivationState
} from '../src/governance-activation/historical-v3.js';
import { packagedActivationSuccessorMigrations } from '../src/governance-activation/compatibility.js';
import { readGovernanceConfiguration, assertGovernanceConfigurationBinding } from '../src/application/repository-governance/configuration.js';

const baseline = JSON.parse(readFileSync('tests/fixtures/activation-history/v3-baseline.json', 'utf8'));
const root = path.join(process.cwd(), '.activation-v4-contracts', String(process.pid));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function state(): UserActivationState {
  return {
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: 'local:11111111-1111-4111-8111-111111111111', name: 'released-v3', defaultBranch: 'develop' },
    activeChange: null, applicability: { statePath: 'none', credentialRequired: 'unknown', privateStagingDast: 'unknown' },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: '2026-09-01T00:00:00.000Z', evidence: [], approvals: [], blockers: []
    }])) as UserActivationState['phases'],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
  };
}

describe('activation v4 and immutable released v3 boundaries', () => {
  it('declares the exact current family with an actually computed graph and separate output contracts', () => {
    expect(currentActivationIdentity).toEqual({
      liftoffVersion: '0.13.0', manifestArtifactVersion: 8, policyVersion: '8',
      activationContractVersion: 4, phaseGraphSchemaVersion: 3,
      phaseGraphHash: canonicalSha256(canonicalPhaseGraph),
      activationStateSchemaVersion: 4, evidenceHeaderSchemaVersion: 4, approvalEnvelopeSchemaVersion: 4,
      supersessionSchemaVersion: 1, credentialPolicySchemaVersion: 2
    });
    expect(canonicalPhaseGraphHash).not.toBe(historicalV3ActivationIdentity.phaseGraphHash);
    expect(compatibilityMetadataSchemaVersion).toBe(5);
    expect(governanceOutputSchemaVersion).toBe(3);
    expect(validateManagedPhaseGraph(canonicalPhaseGraph)).toEqual(canonicalPhaseGraph);
    expect(Object.keys(canonicalPhaseContractDigests)).toEqual(phaseIds);
    expect(validateUserActivationState(state()).schemaVersion).toBe(4);
  });

  it('retains every exact old identity without accepting mixed fields or graph hashes for execution', () => {
    for (const identity of [historicalV1ActivationIdentity, historicalV2ActivationIdentity, historicalV3ActivationIdentity]) {
      expect(() => validateActivationIdentity(identity)).toThrow(/diagnostic-only/);
      expect(() => validateActivationIdentity({ ...currentActivationIdentity, phaseGraphHash: identity.phaseGraphHash })).toThrow();
    }
    expect(() => validateActivationIdentity({ ...currentActivationIdentity, policyVersion: '6' })).toThrow();
    expect(() => validateActivationIdentity({ ...currentActivationIdentity, activationContractVersion: 5 })).toThrow();
    expect(packagedActivationSuccessorMigrations().map((lane) => lane.id)).toEqual([
      'activation-v1-to-v4', 'activation-v2-to-v4', 'activation-v3-to-v4', 'activation-v4-policy7-to-policy8'
    ]);
  });

  it('reads the frozen graph and original configuration digest algorithms from the immutable Git baseline', () => {
    expect(baseline.baseline).toBe('70d10881b46d873118d825735696f39b6d35ebe0');
    expect(baseline.identity).toEqual(historicalV3ActivationIdentity);
    expect(canonicalSha256(historicalV3PhaseGraph())).toBe(baseline.graphHash);
    const historical = {
      ...state(), schemaVersion: 3, identity: historicalV3ActivationIdentity,
      phases: Object.fromEntries(historicalV3PhaseIds.map((id) => [id, state().phases[id]]))
    } as HistoricalV3ActivationState;
    for (const id of historicalV3PhaseIds) {
      expect(historicalV3PhaseContractDigest(id)).toBe(baseline.phaseContractDigests[id]);
    }
    for (const id of ['seed-valid', 'committed', 'pushed', 'phase-0-complete'] as const) {
      expect(historicalV3InputDigest(id, baseline.snapshot)).toBe(baseline.inputDigests[id].absent);
      expect(historicalV3InputDigest(id, baseline.snapshot, { ...historical, activationInputs: { schemaVersion: 1, phases: {} } })).toBe(baseline.inputDigests[id].empty);
      expect(historicalV3InputDigest(id, baseline.snapshot, { ...historical, activationInputs: baseline.configuration })).toBe(baseline.inputDigests[id].azure);
    }
    expect(baseline.inputDigests.committed.absent).not.toBe(baseline.inputDigests.committed.azure);
    expect(validateHistoricalV3ActivationState(historical).identity).toEqual(historicalV3ActivationIdentity);
    expect(() => validateHistoricalV3ActivationState({ ...historical, schemaVersion: 4 })).toThrow();
    expect(() => validateHistoricalV3ActivationState({ ...historical, phases: { ...historical.phases, 'repository-discovered': state().phases['repository-discovered'] } })).toThrow();
    const original = Buffer.from(`${JSON.stringify(historical, null, '\t')}\r\n`);
    const copy = Buffer.from(original);
    validateHistoricalV3ActivationState(JSON.parse(original.toString('utf8')));
    expect(original.equals(copy)).toBe(true);
  });

  it('normalizes absent unused inputs without hiding real source, destination or commit changes', () => {
    const snapshot: ActivationInputSnapshot = baseline.snapshot;
    const empty = { ...state(), activationInputs: { schemaVersion: 1 as const, phases: {} } };
    const azure = { ...state(), activationInputs: baseline.configuration };
    expect(Object.keys(phaseConsumedConfiguration)).toHaveLength(phaseIds.length);
    for (const id of ['seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed', 'repository-discovered'] as const) {
      expect(phaseInputDigest(id, snapshot)).toBe(phaseInputDigest(id, snapshot, empty));
      expect(phaseInputDigest(id, snapshot, empty)).toBe(phaseInputDigest(id, snapshot, azure));
    }
    for (const id of ['committed', 'pushed'] as const) {
      expect(phaseInputDigest(id, snapshot, azure)).not.toBe(phaseInputDigest(id, { ...snapshot, git: { ...snapshot.git, head: 'e'.repeat(40) } }, azure));
      expect(phaseInputDigest(id, snapshot, azure)).not.toBe(phaseInputDigest(id, { ...snapshot, files: [...snapshot.files, { path: '.github/workflows/new.yml', digest: 'f'.repeat(64) }] }, azure));
      expect(phaseInputDigest(id, snapshot, azure)).not.toBe(phaseInputDigest(id, snapshot, { ...azure, activationInputs: { ...baseline.configuration, repository: { name: 'example/other' } } }));
    }
    expect(phaseInputDigest('pushed', snapshot)).not.toBe(phaseInputDigest('pushed', { ...snapshot, git: { ...snapshot.git, pushUrls: ['https://github.com/example/other.git'] } }));
    expect(phaseInputDigest('phase-0-complete', snapshot, azure)).not.toBe(phaseInputDigest('phase-0-complete', snapshot, empty));
  });

  it('registers repository-only phases with only shared local/publication prerequisites', () => {
    expect(phaseInScope('committed', 'repository')).toBe(true);
    expect(phaseInScope('seed-valid', 'repository', true)).toBe(true);
    expect(phaseInScope('phase-0-complete', 'repository', true)).toBe(false);
    expect(phaseInScope('repository-live-readback', 'activation')).toBe(false);
    for (const id of repositoryPhaseIds) {
      const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === id)!;
      expect(phase.allowedMutations.remote.some((mutation) => mutation.startsWith('azure-'))).toBe(false);
      expect(phase.evidence.liveReadbackProviders).not.toContain('azure');
      expect(phase.dependencies.flatMap((edge) => edge.anyOf).every((parent) => phaseInScope(parent, 'repository', true))).toBe(true);
    }
  });

  it('requires reviewed publication authority and actual GitHub readback for every workflow source producer', () => {
    for (const id of ['repository-workflow-source-ready', 'bootstrap-workflow-source-ready', 'workflow-source-ready'] as const) {
      const node = canonicalPhaseGraph.phases.find((phase) => phase.id === id)!;
      expect(node.approvalGate).toMatchObject({ kind: 'repository-publish', required: true });
      expect(node.evidence).toMatchObject({ required: true, liveReadbackProviders: ['github'] });
      expect(node.allowedMutations.remote).toEqual(expect.arrayContaining(['github-read', 'github-write', 'git-push']));
      const invalidNodes = [
        { ...node, approvalGate: { ...node.approvalGate, required: false, kind: 'none' } },
        { ...node, evidence: { ...node.evidence, required: false } },
        { ...node, evidence: { ...node.evidence, liveReadbackProviders: [] } },
        ...(['github-read', 'github-write', 'git-push'] as const).map((mutation) => ({
          ...node,
          allowedMutations: { ...node.allowedMutations, remote: node.allowedMutations.remote.filter((value) => value !== mutation) }
        }))
      ];
      for (const invalid of invalidNodes) {
        expect(() => validateManagedPhaseGraph({
          ...canonicalPhaseGraph, phases: canonicalPhaseGraph.phases.map((phase) => phase.id === id ? invalid : phase)
        })).toThrow();
      }
    }
  });

  it('requires distinct settings and ruleset effects under exact enforcement approval and readback', () => {
    for (const id of ['repository-rulesets-applied', 'rulesets-applied'] as const) {
      const node = canonicalPhaseGraph.phases.find((phase) => phase.id === id)!;
      expect(node.approvalGate).toMatchObject({ kind: 'enforcement', required: true });
      expect(node.evidence).toMatchObject({ required: true, liveReadbackProviders: ['github'] });
      expect(node.allowedMutations.remote).toEqual(expect.arrayContaining(['github-ruleset-write', 'github-write', 'github-read']));
      const invalidNodes = [
        { ...node, approvalGate: { ...node.approvalGate, required: false, kind: 'none' } },
        { ...node, evidence: { ...node.evidence, required: false } },
        { ...node, evidence: { ...node.evidence, liveReadbackProviders: [] } },
        ...(['github-ruleset-write', 'github-write', 'github-read'] as const).map((mutation) => ({
          ...node,
          allowedMutations: { ...node.allowedMutations, remote: node.allowedMutations.remote.filter((value) => value !== mutation) }
        }))
      ];
      for (const invalid of invalidNodes) {
        expect(() => validateManagedPhaseGraph({
          ...canonicalPhaseGraph, phases: canonicalPhaseGraph.phases.map((phase) => phase.id === id ? invalid : phase)
        })).toThrow();
      }
    }
  });

  it('admits only exact source-publication and owned-settings actions in their registered phase families', () => {
    const destination = { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo' };
    for (const id of ['repository-workflow-source-ready', 'bootstrap-workflow-source-ready', 'workflow-source-ready'] as const) {
      const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === id)!;
      const publication: TransitionOperation = {
        phaseId: id, adapter: 'github', actionId: 'github.workflow-source.publish', mutationClass: 'github-write',
        inputs: {}, destination, remote: true, destructive: false,
        effects: (['github-read', 'git-push'] as const).map((mutationClass) => ({
          mutationClass, destination, remote: true, destructive: false
        }))
      };
      expect(() => assertOperationAllowed(phase, publication)).not.toThrow();
      expect(() => assertOperationAllowed(phase, { ...publication, effects: [] })).toThrow(/must declare/);
      expect(() => assertOperationAllowed(phase, {
        ...publication, effects: publication.effects!.map((effect) => ({
          ...effect, destination: { ...destination, identity: 'owner/other', repository: 'owner/other' }
        }))
      })).toThrow(/exact approved destination/);
      expect(() => assertOperationAllowed(phase, { ...publication, actionId: 'github.repository.settings.apply' })).toThrow(/not allowlisted/);
      expect(rollbackPlanForPhase(phase, [publication])).toMatchObject({
        operations: [], retained: [`${id}:github.workflow-source.publish:published-history`]
      });
    }
    for (const id of ['repository-rulesets-applied', 'rulesets-applied'] as const) {
      const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === id)!;
      const settings: TransitionOperation = {
        phaseId: id, adapter: 'github', actionId: 'github.repository.settings.apply', mutationClass: 'github-write',
        inputs: {}, destination, remote: true, destructive: false
      };
      expect(() => assertOperationAllowed(phase, settings)).not.toThrow();
      expect(() => assertOperationAllowed(phase, { ...settings, mutationClass: 'github-read' })).toThrow(/mutation class/);
      expect(() => assertOperationAllowed(phase, { ...settings, actionId: 'github.workflow-source.publish' })).toThrow(/not allowlisted/);
      expect(rollbackPlanForPhase(phase, [settings])).toMatchObject({
        operations: [], retained: [`${id}:github.repository.settings.apply:repository-protection`]
      });
    }
  });

  it('rejects nil Azure bindings and keeps the canonical configuration reference and exact byte digest', async () => {
    expect(() => validateActivationConfiguration({
      ...baseline.configuration,
      azure: { ...baseline.configuration.azure, subscriptionId: '00000000-0000-0000-0000-000000000000' }
    })).toThrow(/concrete/);
    await mkdir(root, { recursive: true });
    const file = path.join(root, 'public inputs & exact.json');
    await writeFile(file, JSON.stringify(baseline.configuration));
    const configured = await readGovernanceConfiguration(path.basename(file), root);
    expect(configured.binding.reference).toBe(file);
    expect(await assertGovernanceConfigurationBinding(configured.binding)).toEqual(baseline.configuration);
    await writeFile(file, `${JSON.stringify(baseline.configuration)}\n`);
    await expect(assertGovernanceConfigurationBinding(configured.binding)).rejects.toThrow(/bytes changed/);
  });
});

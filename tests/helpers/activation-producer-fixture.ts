import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentGovernanceManifest } from '../governance-activation-fixtures.js';
import { parseManifest } from '../../src/application/project/manifest.js';
import { canonicalJson } from '../../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../../src/domain/governance/activation/graph.js';
import { phaseIds, type ActivationConfiguration, type PhaseId } from '../../src/domain/governance/activation/types.js';
import { validateUserActivationState } from '../../src/domain/governance/activation/validators.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../../src/governance-activation/inputs.js';
import { loadActivationState } from '../../src/governance-activation/activation-state.js';
import { saveGovernancePreview, approveGovernancePreview } from '../../src/governance-activation/public-plans.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput } from '../../src/governance-activation/transition-ports.js';
import type { CommandRunner } from '../../src/process-runner.js';

export const producerSubscription = '11111111-2222-4333-8444-555555555555';
export const producerTenant = '66666666-7777-4888-8999-000000000001';

export async function activationProducerFixture(
  phaseId: PhaseId,
  phaseInputs: Record<string, unknown>,
  runner: CommandRunner
) {
  const root = path.resolve(`tests/.activation-producer-${randomUUID()}`);
  const projectRoot = path.join(root, 'project');
  const home = path.join(root, 'home');
  const manifest = parseManifest(currentGovernanceManifest('Activation producer'));
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const now = new Date('2026-09-15T00:00:00.000Z');
  const storage = { homedir: home, repositoryRoot: projectRoot, env: {}, clock: () => now };
  const configuration: ActivationConfiguration = {
    schemaVersion: 1,
    azure: { subscriptionId: producerSubscription, tenantId: producerTenant, region: 'eastus' },
    phases: { [phaseId]: phaseInputs }
  };
  const state = validateUserActivationState({
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: `local:${randomUUID()}`, name: 'producer', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git', verifiedAt: now.toISOString() },
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false, cloudStateRequired: true, privateRunnerRequired: false },
    activationInputs: configuration,
    phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: [] }])),
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  await writeFile(path.join(projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
  await mkdir(path.join(projectRoot, 'governance'));
  await writeFile(path.join(projectRoot, 'governance', 'activation-state.json'), canonicalJson(state));
  const localReads: CommandRunner = {
    async run(command) {
      if (command.executable !== 'git') throw new Error('Input capture cannot invoke provider or project commands.');
      return {
        command, status: 128, signal: null, timedOut: false,
        stdout: '', stderr: 'not a git repository', displayCommand: 'fixture Git metadata'
      };
    }
  };
  const snapshot = await readActivationInputSnapshot(projectRoot, manifest, localReads);
  const inspection: GovernanceTransitionInspection = {
    projectRoot, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash,
    scope: 'activation', activationInputs: configuration, state,
    loadedState: await loadActivationState(projectRoot),
    approvals: [], evidence: [], contexts: activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now),
    readiness: {
      nextReadyPhase: null, nextPlannablePhase: phaseId,
      phases: structuredClone(state.phases)
    },
    sourceOfTruth: {
      status: 'none', selected: null, candidates: [],
      createPlan: { status: 'blocked', changeId: 'producer-contract', workflowKind: 'openspec', reason: 'An isolated producer contract, not completed activation.', requiredFacts: [] }
    }
  };
  return {
    root, projectRoot, home, storage, inspection, now, runner,
    async refreshInputs() {
      if (inspection.activationInputs) inspection.state.activationInputs = inspection.activationInputs;
      const snapshot = await readActivationInputSnapshot(projectRoot, manifest, localReads);
      inspection.contexts = activationEvidenceContexts(canonicalPhaseGraph, inspection.state, snapshot, now);
      inspection.loadedState = await loadActivationState(projectRoot);
    },
    async approve(): Promise<PhaseAdapterExecutionInput> {
      const saved = await saveGovernancePreview(inspection, { runner, now, storage });
      if (!saved) throw new Error('The production planner did not return a preview.');
      const approved = await approveGovernancePreview({
        projectRoot, fingerprint: saved.preview.fingerprint, inspect: async () => inspection,
        runner, now, storage
      });
      inspection.approvals = [...inspection.approvals, approved.envelope];
      return {
        inspection, plan: approved.plan,
        phase: canonicalPhaseGraph.phases.find((phase) => phase.id === phaseId)!,
        runner, now, adapters: { azureActivation: { storage } }
      };
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

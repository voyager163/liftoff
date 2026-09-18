import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { activationProducerFixture, producerSubscription, producerTenant } from './activation-producer-fixture.js';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { transitionPlanForPhase, evaluateApprovalForTransitionPlan } from '../../src/domain/governance/activation/approvals.js';
import { planDigestFor, rollbackPlanForPhase, assertPlanOperationsAllowed } from '../../src/domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../../src/domain/governance/activation/validators.js';
import { writeGovernanceApprovalAuthority } from '../../src/governance-activation/authority-records.js';
import { withProjectMutationLock } from '../../src/adapters/filesystem/project-lock.js';
import { EncryptedStateWorkspace } from '../../src/adapters/state/protected-workspace.js';
import { darwinStateKeyReferenceId } from '../../src/adapters/state/darwin-capabilities.js';
import { MemoryProtectedStorage } from '../fixtures/state-migration/fakes.js';
import type { PhaseId } from '../../src/domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhasePlanBuild, PhasePlanningInput } from '../../src/governance-activation/transition-ports.js';
import type { StateExecutionContext } from '../../src/domain/repair/stateful.js';
import type { BootstrapAccessInputs } from '../../src/application/azure-activation/private-resource-plans.js';
import type { PrivateCustodyConfiguration } from '../../src/application/azure-activation/private-custody.js';
import type { PrivateStatePathTarget } from '../../src/adapters/azure/private-state-path.js';
import type { CommandRunner } from '../../src/process-runner.js';

export const fixtureBinding = {
  subscriptionId: producerSubscription, tenantId: producerTenant, principalId: '88888888-9999-4aaa-8bbb-cccccccccccc'
};
export const fixtureTime = new Date('2026-09-15T00:00:00.000Z');
export const fixtureGroup = `/subscriptions/${producerSubscription}/resourceGroups/private-access`;
export const fixtureVnet = `${fixtureGroup}/providers/Microsoft.Network/virtualNetworks/repo-vnet`;
export const fixtureStorageAccount = `${fixtureGroup}/providers/Microsoft.Storage/storageAccounts/liftofffixture`;
export const fixtureHost = 'private-activation-fixture-host';

export function bootstrapAccess(): BootstrapAccessInputs {
  return {
    binding: fixtureBinding, repositoryId: '42', region: 'eastus', configurationDigest: canonicalSha256('reviewed configuration'),
    expiresAt: '2026-09-15T00:30:00.000Z', resourceGroup: 'private-access', storageAccountResourceId: fixtureStorageAccount,
    network: {
      vnetName: 'repo-vnet', addressPrefix: '10.60.0.0/16', runnerSubnetName: 'runners', runnerSubnetPrefix: '10.60.1.0/24',
      endpointSubnetName: 'endpoints', endpointSubnetPrefix: '10.60.2.0/24', endpointAddress: '10.60.2.4',
      networkSecurityGroupName: 'repo-nsg', routeTableName: 'repo-routes', natGatewayName: 'repo-nat', publicIpName: 'repo-egress',
      privateEndpointName: 'repo-state', dnsLinkName: 'repo-link', outboundHttpsPrefixes: ['192.0.2.0/24']
    },
    runner: { networkSettingsName: 'repo-runner-network', githubBusinessId: '7' }
  };
}

export function privateTarget(): PrivateStatePathTarget {
  const privateEndpointId = `${fixtureGroup}/providers/Microsoft.Network/privateEndpoints/repo-state`;
  const privateDnsZoneId = `${fixtureGroup}/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net`;
  return {
    binding: fixtureBinding, backend: {
      id: 'private-state', ownerId: '42', kind: 'azurerm', format: 'opentofu-v4-json',
      subscriptionId: producerSubscription, tenantId: producerTenant, resourceGroup: 'private-access',
      account: 'liftofffixture', container: 'tfstate', key: 'network.tfstate', network: 'private'
    },
    region: 'eastus', hostId: fixtureHost, privateEndpointId, endpointAddress: '10.60.2.4',
    virtualNetworkId: fixtureVnet, subnetId: `${fixtureVnet}/subnets/endpoints`,
    privateDnsZoneId, privateDnsLinkId: `${privateDnsZoneId}/virtualNetworkLinks/repo-link`,
    privateDnsZoneGroupId: `${privateEndpointId}/privateDnsZoneGroups/state`
  };
}

export function custody(root: string): PrivateCustodyConfiguration {
  return {
    workspaceId: randomUUID(), workspaceRoot: path.join(root, 'protected'),
    keyReference: { keychainPath: path.join(root, 'fixture.keychain'), service: 'org.liftoff.state.fixture', account: '42' },
    tools: {
      python: { path: path.join(root, 'python'), sha256: canonicalSha256('fixture-python') },
      tofu: { path: path.join(root, 'tofu'), sha256: canonicalSha256('fixture-tofu') },
      pythonVersion: '3.14.0', tofuVersion: '1.12.6', hostId: fixtureHost
    },
    retainedAt: fixtureTime.toISOString(), disposeAfter: '2026-11-15T00:00:00.000Z'
  };
}

export async function privateActivationFixture(phaseId: PhaseId, phaseInputs: Record<string, unknown>) {
  const calls: string[] = [];
  const runner: CommandRunner = { async run(command) {
    calls.push(command.executable);
    throw new Error('No ambient provider or native tool execution is authorized in this fixture.');
  } };
  const f = await activationProducerFixture(phaseId, phaseInputs, runner);
  f.inspection.state.applicability.statePath = phaseId === 'existing-private-path' ? 'existing-private' : 'bootstrap-local';
  const phase = f.inspection.graph.phases.find((entry) => entry.id === phaseId)!;
  return {
    ...f, calls, phase,
    planning(): PhasePlanningInput { return { inspection: f.inspection, phase, runner, now: f.now }; },
    async execution(build: PhasePlanBuild, options: {
      issue?: boolean; recovery?: boolean; approvalExpiresAt?: string; phaseId?: PhaseId;
    } = {}): Promise<PhaseAdapterExecutionInput> {
      if (build.blockers?.length) throw new Error(build.blockers.join(' '));
      const retainedContexts = f.inspection.contexts;
      await f.refreshInputs();
      for (const [id, context] of Object.entries(retainedContexts)) {
        const current = f.inspection.contexts[id as PhaseId];
        if (context.reviewedPlans) current.reviewedPlans = context.reviewedPlans;
        if (context.evidenceReferences) current.evidenceReferences = context.evidenceReferences;
      }
      const selectedPhaseId = options.phaseId ?? phaseId;
      const selectedPhase = f.inspection.graph.phases.find((entry) => entry.id === selectedPhaseId)!;
      const context = f.inspection.contexts[selectedPhaseId];
      const configuration = f.inspection.activationInputs;
      const request = transitionPlanForPhase(selectedPhase, f.inspection.state, context.transition, f.projectRoot, undefined, {
        operations: build.operations, configuration, selectionScope: 'activation', fileChanges: [], recovery: options.recovery ?? false
      });
      const envelopes = [];
      if (selectedPhase.approvalGate.required) {
        const envelope = validateApprovalEnvelope({
          ...request, schemaVersion: 4, id: randomUUID(), approvedAt: f.now.toISOString(),
          expiresAt: options.approvalExpiresAt ?? '2026-09-15T00:20:00.000Z', approver: 'isolated-fixture-operator'
        }, { expectedIdentity: f.inspection.state.identity, now: f.now, requireUnexpired: true });
        envelopes.push(envelope);
        if (options.issue !== false) await withProjectMutationLock(f.projectRoot, () =>
          writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(request), envelope, f.storage));
      }
      f.inspection.approvals = envelopes;
      const evaluation = evaluateApprovalForTransitionPlan(request, envelopes, { now: f.now });
      const plan = validateSavedTransitionPlan({
        schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: selectedPhaseId,
        createdAt: f.now.toISOString(), expiresAt: '2026-09-15T00:20:00.000Z',
        identity: f.inspection.state.identity, graphHash: f.inspection.graphHash,
        stateHash: f.inspection.loadedState?.contentHash ?? null, baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
        transitionDigest: context.transition.transitionDigest,
        planDigest: planDigestFor({ phase: selectedPhase, transitionDigest: context.transition.transitionDigest, operations: build.operations, approvalPlanDigest: request.planDigest }),
        mutationClasses: selectedPhase.allowedMutations, operations: build.operations,
        approval: { gateKind: selectedPhase.approvalGate.kind, required: selectedPhase.approvalGate.required, evaluation,
          envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
        rollbackPlan: rollbackPlanForPhase(selectedPhase), configuration, fileChanges: [], recovery: options.recovery ?? false, noSecrets: true
      });
      assertPlanOperationsAllowed(plan, selectedPhase);
      return { inspection: f.inspection, phase: selectedPhase, plan, runner, now: f.now, adapters: { azureActivation: { storage: f.storage } }, recovery: options.recovery };
    }
  };
}

export function encryptedFixtureWorkspace(config: PrivateCustodyConfiguration, ownerId = '42') {
  const storage = new MemoryProtectedStorage();
  const keyRef = darwinStateKeyReferenceId(config.keyReference);
  storage.withScratch = async <T>(_context: StateExecutionContext, action: (directory: string) => Promise<T>) => {
    const directory = path.join(config.workspaceRoot, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { return await action(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  const workspace = new EncryptedStateWorkspace({
    workspaceId: config.workspaceId, keyRef, ownerId, storage,
    keys: {
      async describe(keyRef, context) {
        return { keyRef, ownerId, hostId: context.hostId, storage: 'external-key-provider', algorithm: 'aes-256-gcm' };
      },
      async withKey(_ref, action) {
        const key = Buffer.alloc(32, 73);
        try { return await action(key); } finally { key.fill(0); }
      }
    }
  });
  return { workspace, storage, keyRef };
}

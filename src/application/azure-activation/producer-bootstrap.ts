import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput, PhasePlanBuild
} from '../../governance-activation/transition-ports.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type { ProtectedStateWorkspace } from '../../domain/repair/stateful.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import {
  createPrivateBootstrapArmPort, observePrivateArmResource, type BootstrapArmPort, type BootstrapConditionalCreateQualification
} from '../../adapters/azure/private-bootstrap-arm.js';
import { validateAzureBindings } from '../../adapters/azure/production-adapter.js';
import { safePrivateStateFailure } from '../../adapters/azure/private-state-path.js';
import { resolveAzureInputs } from './producer-discovery.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import {
  exactObject, planBootstrapArmResources, privateArmInventory,
  type BootstrapAccessInputs, type PrivateArmResourcePlan
} from './private-resource-plans.js';
import {
  openPrivateCustody, preserveBootstrapCustody, privateStateContext, validatePrivateCustody, type PrivateCustodyConfiguration
} from './private-custody.js';
import {
  preparePrivateEffect, readPrivateEffect, settlePrivateEffect, submitPrivateEffect,
  type PrivateEffectCheckpoint, type PrivateEffectIntent
} from './private-checkpoints.js';
export { planBootstrapArmResources, planRunnerArmResources, privateArmInventory } from './private-resource-plans.js';
export { executePrivateBackendProof, planPrivateBackendProof } from './private-backend-proof.js';
export { executeRemoteImportVerified, planRemoteImportVerified } from './producer-remote-import.js';

export interface BootstrapLocalPorts {
  arm?: BootstrapArmPort;
  workspace?: ProtectedStateWorkspace;
  pollAttempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
  conditionalCreateQualification?: BootstrapConditionalCreateQualification;
}

export function bootstrapArmPlanForInspection(input: PhasePlanningInput): {
  access: PrivateArmResourcePlan; custody: PrivateCustodyConfiguration;
} {
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const config = exactObject(configuration?.phases['bootstrap-local'],
    ['principalId', 'expiresAt', 'access', 'custody'], 'Bootstrap phase inputs');
  const selected = exactObject(config.access, ['resourceGroup', 'storageAccountResourceId', 'network', 'runner'], 'Bootstrap access scope');
  const validation = validateAzureBindings(resolveAzureInputs(input));
  if (!validation.valid || !validation.subscriptionId || !validation.tenantId || !validation.region ||
    typeof config.principalId !== 'string' || typeof config.expiresAt !== 'string' ||
    !input.inspection.state.remoteBinding?.id) {
    throw new AzureActivationAdmissionError('bootstrap-binding', 'Bootstrap requires exact subscription, tenant, principal, region, published repository and expiry.');
  }
  const custody = validatePrivateCustody(config.custody);
  const access = planBootstrapArmResources({
    binding: { subscriptionId: validation.subscriptionId, tenantId: validation.tenantId, principalId: config.principalId },
    repositoryId: input.inspection.state.remoteBinding.id, region: validation.region,
    configurationDigest: canonicalSha256(configuration), expiresAt: config.expiresAt,
    ...selected as Pick<BootstrapAccessInputs, 'resourceGroup' | 'storageAccountResourceId' | 'network' | 'runner'>
  });
  if (custody.keyReference.account !== access.repositoryId || Date.parse(access.expiresAt) <= input.now.getTime()) {
    throw new AzureActivationAdmissionError('bootstrap-custody', 'Bootstrap custody must belong to the exact repository and the explicit access plan must be current.');
  }
  return { access, custody };
}

export function planBootstrapLocal(input: PhasePlanningInput): PhasePlanBuild {
  try {
    if (input.phase.id !== 'bootstrap-local' || (input.inspection.scope ?? 'activation') !== 'activation' ||
      input.inspection.manifest.project.workload.kind === 'components' ||
      input.inspection.state.applicability.statePath !== 'bootstrap-local') {
      throw new AzureActivationAdmissionError('bootstrap-scope', 'Access-establishing bootstrap is available only in its applicable activation phase.');
    }
    const { access, custody } = bootstrapArmPlanForInspection(input);
    const destination = transitionDestination('subscription', access.binding.subscriptionId, { subscriptionId: access.binding.subscriptionId });
    return { operations: access.resources.map((resource, index) => operation({
      phaseId: 'bootstrap-local', adapter: 'azure-opentofu', actionId: 'azure.bootstrap-local.apply',
      mutationClass: 'azure-network-provision', remote: true, destructive: false,
      destination: { ...destination, identity: resource.resourceId },
      inputs: {
        binding: access.binding, repositoryId: access.repositoryId, region: access.region,
        configurationDigest: access.configurationDigest, expiresAt: access.expiresAt,
        producerSourceDigest: access.sourceDigest, accessPlanDigest: access.planDigest, resource,
        custody, expected: 'absent'
      },
      effects: [
        { mutationClass: 'azure-read', destination, remote: true, destructive: false },
        ...(index === 0 ? [{
          mutationClass: 'write-local-state' as const,
          destination: transitionDestination('external', `state-workspace:${custody.workspaceId}`),
          remote: false, destructive: false
        }] : [])
      ]
    })) };
  } catch (error) {
    return { operations: [], blockers: [error instanceof AzureActivationAdmissionError ? error.message : safePrivateStateFailure(error)] };
  }
}

function intentFor(resource: PrivateArmResourcePlan['resources'][number]): PrivateEffectIntent {
  return {
    kind: 'bootstrap-arm-resource', step: 'create', provider: 'azure', resourceId: resource.resourceId,
    request: { method: 'PUT', apiVersion: resource.apiVersion, body: resource.body, ifNoneMatch: '*' }
  };
}

function pending(
  input: PhaseAdapterExecutionInput, checkpoint: PrivateEffectCheckpoint, completed: readonly TransitionOperation[]
): PhaseAdapterOutcome {
  if (!checkpoint.submitted) return {
    status: 'blocked', blocker: 'Bootstrap dispatch outcome is unknown. Its immutable pre-effect checkpoint is retained; recover the actual ARM request before any retry.',
    completedOperations: completed, cleanupWarnings: ['No cross-provider rollback or resource deletion was attempted.']
  };
  return {
    status: 'pending', blocker: 'The exact access-establishing ARM request has not reached independently verified settlement.',
    operation: {
      provider: 'azure', actionId: 'azure.bootstrap-local.apply', operationId: checkpoint.submitted.requestId,
      resourceId: checkpoint.submitted.resourceId, startedAt: checkpoint.prepared.preparedAt,
      observedAt: (input.clock?.() ?? input.now).toISOString(), status: 'running', planDigest: input.plan.planDigest,
      ...(checkpoint.submitted.operationUrl ? { pollUrl: checkpoint.submitted.operationUrl } : {})
    },
    completedOperations: completed
  };
}

export async function executeBootstrapLocal(
  input: PhaseAdapterExecutionInput, ports: BootstrapLocalPorts = {}
): Promise<PhaseAdapterOutcome> {
  const completed: TransitionOperation[] = [];
  let checkpoint: PrivateEffectCheckpoint | null = null;
  try {
    const planned = planBootstrapLocal(input);
    const reviewed = input.plan.operations.filter((entry) => entry.actionId === 'azure.bootstrap-local.apply');
    if (planned.blockers?.length || !planned.operations.length || canonicalSha256(planned.operations) !== canonicalSha256(reviewed)) {
      return { status: 'blocked', blocker: planned.blockers?.join(' ') ?? 'The reviewed exact bootstrap resource inventory changed.', completedOperations: [] };
    }
    const { access, custody } = bootstrapArmPlanForInspection(input);
    const attempts = ports.pollAttempts ?? 3;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) throw new AzureActivationAdmissionError('bootstrap-bound', 'Bootstrap polling is bounded to one through five observations per invocation.');
    await assertAzurePhaseAuthority(input, reviewed[0]!);
    const arm = ports.arm ?? createPrivateBootstrapArmPort(input.runner, input.inspection.projectRoot, {
      transport: azurePorts(input).transport, qualification: ports.conditionalCreateQualification
    });
    const bootstrapConfig = (input.inspection.activationInputs ?? input.inspection.state.activationInputs)!.phases['bootstrap-local']!;
    const storageId = (bootstrapConfig.access as { storageAccountResourceId: string }).storageAccountResourceId;
    const storageResources = [
      { resourceId: storageId, resourceType: 'Microsoft.Storage/storageAccounts' },
      { resourceId: `${storageId}/blobServices/default`, resourceType: 'Microsoft.Storage/storageAccounts/blobServices' }
    ];
    for (const resource of storageResources) {
      await assertAzurePhaseAuthority(input, reviewed[0]!);
      const response = await arm.read({ ...resource, apiVersion: '2023-05-01', location: access.region, body: {},
        bodyDigest: canonicalSha256({}), dependsOn: [] }, access.binding);
      if (response.status !== 200 || !response.requestId || !isRecord(response.data) ||
        typeof response.data.id !== 'string' || response.data.id.toLowerCase() !== resource.resourceId.toLowerCase() ||
        !isRecord(response.data.properties)) throw new AzureActivationAdmissionError('bootstrap-storage-prerequisite',
          'Bootstrap requires the exact existing storage account and blob service; it does not create or replace storage resources.');
      const properties = response.data.properties;
      if (resource.resourceType === 'Microsoft.Storage/storageAccounts') {
        if (response.data.location !== access.region || !isRecord(response.data.tags) ||
          response.data.tags['liftoff-repository-id'] !== access.repositoryId ||
          properties.publicNetworkAccess !== 'Disabled' || properties.allowBlobPublicAccess !== false ||
          !['TLS1_2', 'TLS1_3'].includes(String(properties.minimumTlsVersion))) {
          throw new AzureActivationAdmissionError('bootstrap-storage-prerequisite', 'The existing account does not match the reviewed repository ownership, region or private TLS baseline.');
        }
      } else if (properties.isVersioningEnabled !== true || !isRecord(properties.deleteRetentionPolicy) ||
        properties.deleteRetentionPolicy.enabled !== true || typeof properties.deleteRetentionPolicy.days !== 'number' ||
        properties.deleteRetentionPolicy.days < 1) {
        throw new AzureActivationAdmissionError('bootstrap-storage-prerequisite', 'Existing blob versioning and soft-delete retention must be independently observed before network establishment.');
      }
    }
    const context = privateStateContext(input, access.binding, custody.tools.hostId, access.repositoryId);
    const workspace = await openPrivateCustody(input, custody, context, ports.workspace);
    const inventory = privateArmInventory(access);
    const custodyRef = await preserveBootstrapCustody(workspace, context, custody, {
      schemaVersion: 1, kind: 'private-bootstrap-custody', repositoryId: access.repositoryId,
      workspaceRef: workspace.workspaceRef, planDigest: access.planDigest,
      retainedAt: custody.retainedAt, disposeAfter: custody.disposeAfter, resources: inventory.resources
    });
    const observations: ReturnType<typeof observePrivateArmResource>[] = [];
    const wait = ports.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    for (let index = 0; index < access.resources.length; index++) {
      const resource = access.resources[index]!;
      const op = reviewed[index]!;
      await assertAzurePhaseAuthority(input, op);
      if (Date.parse(access.expiresAt) <= (input.clock?.() ?? input.now).getTime()) throw new AzureActivationAdmissionError('bootstrap-expired', 'The exact access-establishing scope expired before the next effect.');
      checkpoint = await readPrivateEffect(input, op, intentFor(resource));
      if (checkpoint && !checkpoint.submitted && !checkpoint.settled) return pending(input, checkpoint, completed);
      let creating = checkpoint === null;
      if (checkpoint?.settled && checkpoint.settled.outcome !== 'verified') {
        if (!input.recovery || checkpoint.prepared.approvalEnvelopeHash === input.plan.approval.envelopeHash) {
          return { status: 'blocked', blocker: 'A prior bootstrap request was rejected or never dispatched. Its exact checkpoint is retained; a distinct reviewed recovery is required.', completedOperations: completed };
        }
        creating = true;
      }
      let response = await arm.read(resource, access.binding);
      if (creating) {
        if (response.status !== 404 || !response.requestId) return {
          status: 'blocked', blocker: 'Bootstrap creates only absent exact network resources. Existing objects, matching names or ownership tags cannot authorize replacement.',
          completedOperations: completed
        };
        checkpoint = await preparePrivateEffect(input, op, intentFor(resource));
        await assertAzurePhaseAuthority(input, op);
        response = await arm.create(resource, access.binding, checkpoint.prepared.clientRequestId);
        if (!response.requestId) return pending(input, checkpoint, completed);
        checkpoint = await submitPrivateEffect(input, checkpoint, {
          requestId: response.requestId, resourceId: resource.resourceId, status: response.status, operationUrl: response.operationUrl
        });
        if (![201, 202].includes(response.status)) {
          await settlePrivateEffect(input, checkpoint, { outcome: 'rejected', readbackRequestId: response.requestId,
            readbackDigest: canonicalSha256({ status: response.status, requestId: response.requestId }) });
          return {
            status: 'blocked',
            blocker: response.status === 200
              ? 'ARM returned an update response for a create-only request. Conditional-create support is not established for this exact provider/API combination; no further resources are touched.'
              : 'ARM did not confirm conditional creation of the exact resource. No automatic resubmission or deletion is permitted.',
            completedOperations: completed,
            cleanupWarnings: ['The attempted resource effect and returned request identity are retained for independent recovery.']
          };
        }
      }
      if (!checkpoint) throw new AzureActivationAdmissionError('bootstrap-checkpoint', 'Bootstrap cannot poll or settle without its durable checkpoint.');
      if (!checkpoint.settled) {
        for (let poll = 0; poll < attempts; poll++) {
          await assertAzurePhaseAuthority(input, op);
          if (checkpoint.submitted!.operationUrl) {
            const operation = await arm.poll(checkpoint.submitted!.operationUrl, access.binding);
            if (operation.status !== 200 && operation.status !== 202) return pending(input, checkpoint, completed);
            if (isRecord(operation.data) && ['Failed', 'Canceled', 'Cancelled'].includes(String(operation.data.status))) {
              await settlePrivateEffect(input, checkpoint, { outcome: 'rejected',
                readbackRequestId: operation.requestId ?? null,
                readbackDigest: canonicalSha256({ status: operation.data.status, requestId: operation.requestId ?? null }) });
              return { status: 'blocked', blocker: 'The actual ARM operation failed. Retain all prior effects and use separately reviewed recovery.', completedOperations: completed };
            }
          }
          response = await arm.read(resource, access.binding);
          if (response.status === 200 && isRecord(response.data) && isRecord(response.data.properties) &&
            response.data.properties.provisioningState === 'Succeeded') break;
          if (poll + 1 < attempts) await wait(Math.min(response.retryAfterSeconds ?? 1, 5) * 1000);
        }
      }
      if (response.status !== 200 || !isRecord(response.data) || !isRecord(response.data.properties) ||
        response.data.properties.provisioningState !== 'Succeeded') return pending(input, checkpoint, completed);
      const observation = observePrivateArmResource(resource, response);
      if (!checkpoint.settled) await settlePrivateEffect(input, checkpoint, {
        outcome: 'verified', readbackRequestId: observation.requestId, readbackDigest: observation.bodyDigest
      });
      observations.push(observation);
      completed.push(op);
    }
    await assertAzurePhaseAuthority(input, reviewed.at(-1)!);
    observations.length = 0;
    for (const resource of access.resources) {
      await assertAzurePhaseAuthority(input, reviewed.at(-1)!);
      observations.push(observePrivateArmResource(resource, await arm.read(resource, access.binding)));
    }
    const networkSettings = observations.find((entry) => entry.resourceType === 'GitHub.Network/networkSettings')!;
    const settingsResource = access.resources.find((entry) => entry.resourceType === 'GitHub.Network/networkSettings')!;
    const settingsProperties = settingsResource.body.properties as { subnetId: string; businessId: string };
    const subnetResource = access.resources.find((entry) => entry.resourceId === settingsProperties.subnetId)!;
    const subnetProperties = subnetResource.body.properties as { addressPrefix: string };
    return {
      status: 'completed', resultState: 'verified', completedOperations: completed,
      evidencePayload: {
        kind: 'bootstrap-local.v1', recipe: access.recipe, accessPlanDigest: access.planDigest,
        inventory, resources: observations, custodyRef, retainedAt: custody.retainedAt, disposeAfter: custody.disposeAfter,
        scope: 'access-establishing-only', applicationProvisioning: 'not-performed', backendVerified: false
      },
      liveReadback: observations.map((entry) => readbackProof(input, 'azure', entry.resourceType, entry.resourceId, entry)),
      outputs: {
        values: { 'bootstrap.accessPlanDigest': access.planDigest, 'bootstrap.custodyRef': custodyRef,
          'runner.networkSettingsId': networkSettings.githubNetworkSettingsId, 'runner.networkSettingsResourceId': networkSettings.resourceId,
          'runner.subnetId': settingsProperties.subnetId, 'runner.subnetPrefix': subnetProperties.addressPrefix,
          'runner.region': access.region, 'runner.githubBusinessId': settingsProperties.businessId },
        resources: observations.map(({ resourceType, resourceId }) => ({ provider: 'azure' as const, resourceType, resourceId }))
      },
      cleanupWarnings: ['Access resources and encrypted custody are retained. Runner assignment, backend proof and import remain separate phases; no atomic rollback is claimed.']
    };
  } catch (error) {
    if (checkpoint && !checkpoint.submitted && error instanceof AzureArmError && error.dispatched === false) {
      await settlePrivateEffect(input, checkpoint, { outcome: 'not-dispatched', readbackRequestId: null, readbackDigest: null });
    } else if (checkpoint && !checkpoint.submitted && error instanceof AzureArmError && error.requestId && error.status) {
      await submitPrivateEffect(input, checkpoint, {
        requestId: error.requestId, status: error.status, resourceId: checkpoint.prepared.intent.resourceId
      });
    }
    return {
      status: 'blocked', blocker: error instanceof AzureActivationAdmissionError ? error.message : safePrivateStateFailure(error),
      completedOperations: completed,
      cleanupWarnings: checkpoint ? ['Retained immutable private checkpoints and encrypted custody require attributable recovery; unknown effects are never automatically retried.'] : []
    };
  }
}

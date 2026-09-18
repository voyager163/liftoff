import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput, PhasePlanBuild } from '../../governance-activation/transition-ports.js';
import { validateAzureBindings } from '../../adapters/azure/production-adapter.js';
import {
  createAzureCliPrivateStatePath, safePrivateStateFailure, validatePrivateStatePathTarget,
  type AzurePrivateStatePath, type PrivateStatePathTarget
} from '../../adapters/azure/private-state-path.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { azureStateUrl } from '../../adapters/state/azure-blob.js';
import { operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { resolveAzureInputs } from './producer-discovery.js';
import { assertAzurePhaseAuthority, AzureActivationAdmissionError } from './authority.js';
import { exactObject } from './private-resource-plans.js';
import { privateStateContext } from './private-custody.js';

export function planExistingPrivatePath(input: PhasePlanningInput): PhasePlanBuild {
  try {
    if (input.phase.id !== 'existing-private-path' || (input.inspection.scope ?? 'activation') !== 'activation' ||
      input.inspection.state.applicability.statePath !== 'existing-private') {
      throw new AzureActivationAdmissionError('private-path-selection', 'Existing private-path verification requires its exact selected activation path.');
    }
    const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
    const config = exactObject(configuration?.phases['existing-private-path'], ['target'], 'Existing private path');
    const target = validatePrivateStatePathTarget(config.target as PrivateStatePathTarget);
    const validation = validateAzureBindings(resolveAzureInputs(input));
    if (!validation.valid || validation.subscriptionId !== target.binding.subscriptionId ||
      validation.tenantId !== target.binding.tenantId || validation.region !== target.region ||
      input.inspection.state.remoteBinding?.id !== target.backend.ownerId) {
      throw new AzureActivationAdmissionError('private-path-binding', 'The selected backend, network, owner, tenant, principal and region must match the reviewed activation binding.');
    }
    const destination = transitionDestination('subscription', target.privateEndpointId, { subscriptionId: target.binding.subscriptionId });
    return { operations: [operation({
      phaseId: 'existing-private-path', adapter: 'azure-opentofu', actionId: 'azure.existing-private-path.verify',
      mutationClass: 'azure-read', remote: true, destructive: false, destination, inputs: { target },
      effects: [{
        mutationClass: 'backend-state-read', destination: transitionDestination('external', azureStateUrl(target.backend, 'blob')),
        remote: true, destructive: false
      }]
    })] };
  } catch (error) {
    return { operations: [], blockers: [error instanceof AzureActivationAdmissionError ? error.message : safePrivateStateFailure(error)] };
  }
}

export async function executeExistingPrivatePathVerification(
  input: PhaseAdapterExecutionInput, ports: { path?: AzurePrivateStatePath } = {}
): Promise<PhaseAdapterOutcome> {
  try {
    const current = planExistingPrivatePath(input);
    const reviewed = input.plan.operations.filter((entry) => entry.actionId === 'azure.existing-private-path.verify');
    if (current.blockers?.length || reviewed.length !== 1 || canonicalSha256(current.operations) !== canonicalSha256(reviewed)) {
      return { status: 'blocked', blocker: current.blockers?.join(' ') ?? 'The exact existing private path changed after review.', completedOperations: [] };
    }
    const op = reviewed[0]!;
    const target = validatePrivateStatePathTarget(op.inputs.target as PrivateStatePathTarget);
    await assertAzurePhaseAuthority(input, op);
    const path = ports.path ?? createAzureCliPrivateStatePath(input.runner, input.inspection.projectRoot, target, {
      arm: azurePorts(input).transport, now: () => (input.clock?.() ?? input.now).getTime()
    });
    if (canonicalSha256(path.target) !== canonicalSha256(target)) throw new AzureActivationAdmissionError('private-path-binding', 'The concrete state adapter targets another private backend.');
    const context = privateStateContext(input, target.binding, target.hostId, target.backend.ownerId);
    const observation = await path.inspect(context);
    await assertAzurePhaseAuthority(input, op);
    const metadata = await path.backend.metadata(context);
    await assertAzurePhaseAuthority(input, op);
    if (!observation.permissions.leaseCapability) return {
      status: 'blocked', blocker: 'The exact principal lacks the observed blob-write permission required for future exclusive leases. No lease mutation or state payload read was performed.',
      completedOperations: [op]
    };
    const payload = {
      kind: 'existing-private-path.v1', observation,
      backend: { id: target.backend.id, exists: metadata.exists, etag: metadata.etag, version: metadata.version, size: metadata.size },
      privateManagementPath: 'observed', locking: { capability: 'azure-blob-exclusive-lease', acquired: false },
      statePayloadRead: false
    };
    return {
      status: 'completed', resultState: 'verified', evidencePayload: payload, completedOperations: [op],
      liveReadback: [readbackProof(input, 'azure', 'private-state-path', target.privateEndpointId, payload)],
      outputs: {
        values: { 'backend.id': target.backend.id, 'backend.privatePathObserved': true, 'backend.exclusiveLeaseAcquired': false },
        resources: [{ provider: 'azure', resourceType: 'private-state-path', resourceId: target.privateEndpointId }]
      }
    };
  } catch (error) {
    return { status: 'blocked', blocker: error instanceof AzureActivationAdmissionError ? error.message : safePrivateStateFailure(error), completedOperations: [] };
  }
}

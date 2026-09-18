import {
  type DarwinStateKeychainReference, type NativeLocalStateTools, type ProtectedStateWorkspace,
  type StateArtifactDescriptor, type StateExecutionContext
} from '../../domain/repair/stateful.js';
import { stateAssert, validateStateContext } from '../../domain/repair/stateful-invariants.js';
import { protectedStateScope } from '../../adapters/state/protected-workspace.js';
import { createDarwinStateStorageProfile } from '../../adapters/state/darwin-capabilities.js';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { exactObject, privateDigest } from './private-resource-plans.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { AzureArmBinding } from '../../adapters/azure/activation-rest.js';

export interface PrivateCustodyConfiguration {
  workspaceRoot: string;
  workspaceId: string;
  keyReference: DarwinStateKeychainReference;
  tools: NativeLocalStateTools;
  retainedAt: string;
  disposeAfter: string;
}

export interface PrivateCustodyInventory {
  schemaVersion: 1;
  kind: 'private-bootstrap-custody';
  repositoryId: string;
  workspaceRef: string;
  planDigest: string;
  retainedAt: string;
  disposeAfter: string;
  resources: readonly { resourceId: string; resourceType: string; apiVersion: string; bodyDigest: string }[];
}

export interface PrivateCustodyMaterial {
  descriptor: StateArtifactDescriptor;
  state: 'prepared' | 'retained' | 'absent';
}

export function validatePrivateCustody(value: unknown): PrivateCustodyConfiguration {
  const config = exactObject(value, ['workspaceRoot', 'workspaceId', 'keyReference', 'tools', 'retainedAt', 'disposeAfter'], 'Private bootstrap custody');
  stateAssert(typeof config.workspaceRoot === 'string' && !/[\u0000-\u001f\u007f]/u.test(config.workspaceRoot) &&
    typeof config.workspaceId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(config.workspaceId), 'protected-workspace-required');
  const key = exactObject(config.keyReference, ['keychainPath', 'service', 'account'], 'Existing external encryption key');
  stateAssert(typeof key.keychainPath === 'string' && typeof key.service === 'string' && typeof key.account === 'string', 'key-unavailable');
  const tools = exactObject(config.tools, ['python', 'tofu', 'pythonVersion', 'tofuVersion', 'hostId'], 'Registered private-state tools');
  for (const name of ['python', 'tofu']) {
    const tool = exactObject(tools[name], ['path', 'sha256'], 'Registered state executable');
    stateAssert(typeof tool.path === 'string' && !/[\u0000-\u001f]/u.test(tool.path), 'tool-unavailable');
    privateDigest(tool.sha256, 'Registered executable digest');
  }
  stateAssert(tools.tofuVersion === '1.12.6' && typeof tools.pythonVersion === 'string' && /^3\.14\.\d+$/u.test(tools.pythonVersion) &&
    typeof tools.hostId === 'string' && tools.hostId.length > 0, 'tool-unavailable');
  stateAssert(typeof config.retainedAt === 'string' && typeof config.disposeAfter === 'string' &&
    Number.isFinite(Date.parse(config.retainedAt)) && Number.isFinite(Date.parse(config.disposeAfter)) &&
    new Date(config.retainedAt).toISOString() === config.retainedAt && new Date(config.disposeAfter).toISOString() === config.disposeAfter &&
    Date.parse(config.disposeAfter) - Date.parse(config.retainedAt) >= 30 * 86_400_000, 'invalid-binding');
  return structuredClone(config) as unknown as PrivateCustodyConfiguration;
}

export function privateStateContext(
  input: PhasePlanningInput, binding: AzureArmBinding, hostId: string, ownerId: string
): StateExecutionContext {
  stateAssert(input.inspection.state.remoteBinding?.id === ownerId, 'ownership-mismatch');
  const context: StateExecutionContext = {
    projectRoot: input.inspection.projectRoot, projectId: ownerId, hostId, principalId: binding.principalId,
    configurationDigest: canonicalSha256(input.inspection.activationInputs ?? input.inspection.state.activationInputs ?? null),
    artifactDigest: canonicalSha256({ baselineSha: input.inspection.contexts[input.phase.id].baselineSha, manifest: input.inspection.manifest }),
    cliDigest: canonicalSha256(currentActivationIdentity)
  };
  validateStateContext(context);
  return context;
}

export async function openPrivateCustody(
  input: PhaseAdapterExecutionInput, configuration: PrivateCustodyConfiguration,
  context: StateExecutionContext, supplied?: ProtectedStateWorkspace
): Promise<ProtectedStateWorkspace> {
  stateAssert(input.lease, 'lock-unavailable');
  await input.lease.assertHeld();
  stateAssert(configuration.keyReference.account === context.projectId &&
    configuration.tools.hostId === context.hostId &&
    Date.parse(configuration.retainedAt) <= (input.clock?.() ?? input.now).getTime(), 'ownership-mismatch');
  const workspace = supplied ?? (await createDarwinStateStorageProfile({
    tools: configuration.tools, workspaceRoot: configuration.workspaceRoot,
    workspaceId: configuration.workspaceId, keyReference: configuration.keyReference, projectId: context.projectId
  })).workspace;
  stateAssert(workspace.workspaceRef === `state-workspace:${configuration.workspaceId}`, 'ownership-mismatch');
  await workspace.assertAvailable(context);
  return workspace;
}

export function bootstrapCustodyArtifactRef(workspaceId: string): string {
  const value = canonicalSha256({ kind: 'private-bootstrap-custody/1', workspaceId });
  const id = `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
  return `state-workspace:${workspaceId}/${id}`;
}

export async function preserveBootstrapCustody(
  workspace: ProtectedStateWorkspace, context: StateExecutionContext,
  configuration: PrivateCustodyConfiguration, inventory: PrivateCustodyInventory
): Promise<string> {
  const scope = protectedStateScope(context);
  const ref = bootstrapCustodyArtifactRef(configuration.workspaceId);
  const id = ref.slice(workspace.workspaceRef.length + 1);
  const prior = await workspace.describe(ref, 'journal', scope);
  if (prior) {
    const bytes = await workspace.get(ref, 'journal', scope);
    try {
      const saved: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      stateAssert(isRecord(saved), 'recovery-conflict');
      const { planDigest: priorPlanDigest, ...priorInventory } = saved;
      const { planDigest: _currentPlanDigest, ...currentInventory } = inventory;
      stateAssert(typeof priorPlanDigest === 'string' && /^[a-f0-9]{64}$/u.test(priorPlanDigest) &&
        canonicalSha256(priorInventory) === canonicalSha256(currentInventory), 'recovery-conflict');
      stateAssert(saved.retainedAt === configuration.retainedAt && saved.disposeAfter === configuration.disposeAfter, 'recovery-conflict');
      return ref;
    } finally { bytes.fill(0); }
  }
  const bytes = Buffer.from(canonicalJson(inventory));
  try { return (await workspace.put('journal', scope, bytes, id)).ref; }
  finally { bytes.fill(0); }
}

export async function readBootstrapCustody(
  workspace: ProtectedStateWorkspace, context: StateExecutionContext,
  configuration: PrivateCustodyConfiguration
): Promise<PrivateCustodyInventory> {
  const ref = bootstrapCustodyArtifactRef(configuration.workspaceId);
  const bytes = await workspace.get(ref, 'journal', protectedStateScope(context));
  try {
    const value = exactObject(JSON.parse(Buffer.from(bytes).toString('utf8')), [
      'schemaVersion', 'kind', 'repositoryId', 'workspaceRef', 'planDigest', 'retainedAt', 'disposeAfter', 'resources'
    ], 'Retained bootstrap inventory');
    stateAssert(value.schemaVersion === 1 && value.kind === 'private-bootstrap-custody' &&
      value.repositoryId === context.projectId && value.workspaceRef === workspace.workspaceRef &&
      value.retainedAt === configuration.retainedAt && value.disposeAfter === configuration.disposeAfter &&
      Array.isArray(value.resources), 'recovery-conflict');
    return value as unknown as PrivateCustodyInventory;
  } finally { bytes.fill(0); }
}

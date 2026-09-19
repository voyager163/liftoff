import { azureArmUrl } from '../../adapters/azure/activation-rest.js';
import { parseApplicationImageReference } from '../../adapters/azure/application-provisioning.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { requiredApplicationArtifacts, type ApplicationArtifactRole } from './application-artifact-inputs.js';
import {
  readApplicationArtifactSetReference, validateApplicationArtifactSetReference
} from './application-artifact-set-execution.js';
import {
  applicationPrivateAssert as must, applicationPrivateFullInventory,
  type ApplicationPrivateArtifact, type ApplicationPrivateArtifactDeployment, type ApplicationPrivateArtifactSelection,
  type ApplicationPrivateHealth, type ApplicationPrivateIntent, type ApplicationPrivateTarget
} from './application-private-contracts.js';
import { applicationPrivateAddress } from './application-private-address.js';

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  must(isRecord(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','), 'artifact-set-fields');
  return value;
}

function registry(resourceId: unknown, subscriptionId: string): asserts resourceId is string {
  must(typeof resourceId === 'string' &&
    /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ContainerRegistry\/registries\/[a-zA-Z0-9]{5,50}$/u.test(resourceId),
  'artifact-set-registry');
  azureArmUrl(resourceId, '2023-07-01', subscriptionId);
}

/** Pure declaration admission. Stored producer custody is checked separately at every execution boundary. */
export function assertApplicationPrivateArtifactSet(intent: ApplicationPrivateIntent, manifest: LiftoffManifest): void {
  if (intent.artifactSet === undefined) return;
  must(intent.artifact === null && applicationPrivateFullInventory(intent.scope), 'artifact-set-stage');
  const set = object(intent.artifactSet, ['reference', 'sourceSha', 'deployments']);
  validateApplicationArtifactSetReference(set.reference);
  must(typeof set.sourceSha === 'string' && /^[a-f0-9]{40}$/u.test(set.sourceSha), 'artifact-set-source');
  const required = requiredApplicationArtifacts(manifest).map((entry) => entry.role);
  const deployments = object(set.deployments, required);
  const addresses = new Set<string>(), digests = new Set<string>();
  for (const role of required) {
    const raw = deployments[role];
    const deployment = object(raw, ['address', 'imageRef', 'registryResourceId',
      ...(isRecord(raw) && Object.hasOwn(raw, 'sourceRegistryResourceId') ? ['sourceRegistryResourceId'] : [])]);
    const address = applicationPrivateAddress(deployment.address);
    const image = parseApplicationImageReference(deployment.imageRef);
    registry(deployment.registryResourceId, intent.binding.subscriptionId);
    must(address.mode === 'managed' && address.type === 'azurerm_container_app' && address.index === null &&
      !addresses.has(address.address) && !digests.has(image.digest), 'artifact-set-role-alias');
    addresses.add(address.address); digests.add(image.digest);
    if (deployment.sourceRegistryResourceId !== undefined) {
      registry(deployment.sourceRegistryResourceId, intent.binding.subscriptionId);
      must(['staging', 'rehearsal-rollout', 'rehearsal-rollback'].includes(intent.scope) &&
        deployment.sourceRegistryResourceId.toLowerCase() !== deployment.registryResourceId.toLowerCase(), 'artifact-mirror-scope');
    }
    const selected = intent.targets.filter((target) => target.address === address.address);
    must(selected.length === 1 && selected[0]!.type === 'azurerm_container_app' &&
      selected[0]!.expected['template.0.container.0.image'] === deployment.imageRef && selected[0]!.runtime,
    'artifact-set-target');
    applicationPrivateHealthUrl(selected[0]!.runtime!, role);
  }
  const apps = intent.targets.filter((target) => target.type === 'azurerm_container_app');
  must(apps.length === required.length && apps.every((target) => addresses.has(target.address)), 'artifact-set-inventory');
}

/** Configuration selection only, never a producer receipt or runtime-success assertion. */
export function applicationPrivateArtifactForTarget(
  intent: ApplicationPrivateIntent, target: Pick<ApplicationPrivateTarget, 'address' | 'type'>
): ApplicationPrivateArtifact | ApplicationPrivateArtifactSelection | null {
  if (target.type !== 'azurerm_container_app') return null;
  if (!intent.artifactSet) return intent.artifact;
  must(intent.artifact === null, 'artifact-set-stage');
  const entries = (['backend', 'frontend'] as const).flatMap((role) => {
    const deployment = intent.artifactSet!.deployments[role];
    return deployment?.address === target.address ? [{ role, deployment }] : [];
  });
  must(entries.length === 1, 'artifact-set-target');
  const { role, deployment } = entries[0]!;
  return {
    ...structuredClone(deployment), role, sourceSha: intent.artifactSet.sourceSha,
    reference: { set: structuredClone(intent.artifactSet.reference), role }
  };
}

/** Declared read destinations only, not stored producer custody or live registry evidence. */
export function applicationPrivateArtifactDeployments(
  intent: ApplicationPrivateIntent
): readonly (ApplicationPrivateArtifactDeployment | ApplicationPrivateArtifact)[] {
  if (!intent.artifactSet) return intent.artifact ? [intent.artifact] : [];
  return (['backend', 'frontend'] as const).flatMap((role) => {
    const deployment = intent.artifactSet!.deployments[role];
    return deployment ? [deployment] : [];
  });
}

export function applicationPrivateBackendArtifact(
  intent: ApplicationPrivateIntent
): ApplicationPrivateArtifact | ApplicationPrivateArtifactSelection | null {
  if (!intent.artifactSet) return intent.artifact;
  return applicationPrivateArtifactForTarget(intent, {
    address: intent.artifactSet.deployments.backend.address, type: 'azurerm_container_app'
  });
}

export function assertApplicationPrivateArtifactVariables(variables: Record<string, unknown>, intent: ApplicationPrivateIntent): void {
  if (!intent.artifactSet) return;
  for (const role of ['backend', 'frontend'] as const) {
    const deployment = intent.artifactSet.deployments[role];
    if (deployment) must(variables[`${role}_image`] === deployment.imageRef, 'artifact-set-variable');
  }
}

export interface RecordedApplicationPrivateArtifact extends ApplicationPrivateArtifactSelection {
  producerImageRef: string;
  producerRegistryResourceId: string;
}

/**
 * Reads ALL actual stored producer roles and their private original whole-plan custody.
 * No provider writes, latest-image selection, or supplied role-success override is supported.
 * Callers still need independent ACR, ARM, native-state and role-specific health readback.
 */
export async function readApplicationPrivateArtifactRoles(
  input: PhasePlanningInput & { clock?: () => Date }, intent: ApplicationPrivateIntent
): Promise<readonly RecordedApplicationPrivateArtifact[]> {
  if (!intent.artifactSet) return [];
  assertApplicationPrivateArtifactSet(intent, input.inspection.manifest);
  const commitment = canonicalSha256(intent);
  const set = await readApplicationArtifactSetReference(input, intent.artifactSet.reference);
  must(canonicalSha256(intent) === commitment, 'artifact-set-changed');
  must(set.evidence.source.sourceSha === intent.artifactSet.sourceSha &&
    canonicalSha256(set.evidence.requiredRoles) === canonicalSha256(requiredApplicationArtifacts(input.inspection.manifest).map((entry) => entry.role)),
  'artifact-set-source');
  return set.evidence.artifacts.map((entry) => {
    const deployment = intent.artifactSet!.deployments[entry.role];
    must(deployment, 'artifact-set-target');
    const selected = applicationPrivateArtifactForTarget(intent, { address: deployment.address, type: 'azurerm_container_app' });
    must(selected && 'role' in selected && selected.role === entry.role, 'artifact-set-role');
    const image = parseApplicationImageReference(selected.imageRef), original = entry.provenance;
    must(original.sourceSha === selected.sourceSha && entry.source.sourceSha === selected.sourceSha &&
      image.digest === original.digest &&
      (selected.sourceRegistryResourceId === undefined
        ? original.imageRef === selected.imageRef && original.registryResourceId === selected.registryResourceId
        : original.registryResourceId === selected.sourceRegistryResourceId), 'artifact-set-image-binding');
    return { ...selected, producerImageRef: original.imageRef, producerRegistryResourceId: original.registryResourceId };
  });
}

/** Backend JSON remains the legacy recipe; set-mode frontend health is explicitly document-only. */
export function applicationPrivateHealthUrl(recipe: ApplicationPrivateHealth, role?: ApplicationArtifactRole): URL {
  const frontend = role === 'frontend';
  const value = object(recipe, frontend ? ['kind', 'url'] : ['url', 'statusField', 'statusValue']);
  must(typeof value.url === 'string' && value.url.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value.url), 'runtime-target');
  let url: URL;
  try { url = new URL(value.url); } catch { must(false, 'runtime-target'); }
  must(url.protocol === 'https:' && url.port === '' && !url.username && !url.password && !url.search && !url.hash &&
    /^[a-z0-9.-]+\.azurecontainerapps\.io$/u.test(url.hostname) && !url.hostname.includes('..') &&
    /^\/[a-zA-Z0-9/_-]{0,120}$/u.test(url.pathname), 'runtime-target');
  if (role !== undefined) must(url.href === value.url && !url.pathname.includes('//'), 'runtime-target');
  if (frontend) must(value.kind === 'frontend-html/1', 'runtime-role-health');
  else must(typeof value.statusField === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/u.test(value.statusField) &&
    typeof value.statusValue === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/u.test(value.statusValue), 'runtime-target');
  return url;
}

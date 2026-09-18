import {
  createHash
} from 'node:crypto';
import path from 'node:path';
import {
  getEnvironment
} from '../project/catalog.js';
import {
  captureProjectFileSnapshot,
  type ProjectFileMutation,
  type ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import {
  manifestDisplayPath
} from '../../domain/project/paths.js';
import {
  readProjectFile
} from '../../adapters/filesystem/project-files.js';
import {
  resolveProjectPath
} from '../../adapters/filesystem/project-paths.js';
import type {
  ReconcileEntry
} from '../../reconcile.js';
import type {
  GeneratedArtifact,
  LiftoffManifest,
  ManifestManagedArtifact,
  ManifestProjectArtifact,
  ProjectProvisioningGroup,
  ProjectPlan
} from '../../domain/project/contracts.js';
import {
  liftoffVersion
} from '../../version.js';
import {
  assessInfrastructureLayout,
  infrastructureProvisioningGate,
  sharedApplicationModuleIdentities
} from '../../domain/project/infrastructure-layout.js';
import { buildArtifacts } from '../../templates.js';
import { renderGovernanceContext } from '../../repository-governance.js';

export function buildUpdateArtifacts(
  plan: ProjectPlan,
  manifest: LiftoffManifest
): GeneratedArtifact[] {
  const infrastructureLayout = assessInfrastructureLayout(manifest).kind;
  return buildArtifacts(plan).map((artifact) =>
    artifact.logicalName === 'repository-governance-context'
      ? {
          ...artifact,
          content: infrastructureLayout === 'independent'
            ? renderGovernanceContext(plan)
            : renderGovernanceContext(plan, { infrastructureLayout })
        }
      : artifact
  );
}

type GeneratedProjectArtifact = Extract<GeneratedArtifact, { lifecycle: 'project' }>;
type ProvisioningEntryStatus = 'create' | 'adopt' | 'conflict';

export interface ProvisioningEntry {
  group: ProjectProvisioningGroup;
  status: ProvisioningEntryStatus;
  rendered: GeneratedProjectArtifact;
  reason: string;
}

export interface ProvisioningGroupPlan {
  group: ProjectProvisioningGroup;
  entries: ProvisioningEntry[];
  blocked: boolean;
  reason?: string;
}

export interface ProvisioningGroupRequest {
  group: ProjectProvisioningGroup;
  status: 'ready' | 'migration-required';
  reason?: string;
}

export function requestedProvisioningGroups(
  manifest: LiftoffManifest,
  plan: ProjectPlan
): ProvisioningGroupRequest[] {
  const provisioned = new Set(
    manifest.projectArtifacts.map((artifact) => artifact.provisioningGroup)
  );
  const groups: ProvisioningGroupRequest[] = [];
  if (
    plan.includeFrontend &&
    !manifest.project.workload.frontend &&
    !provisioned.has('frontend')
  ) {
    groups.push({ group: 'frontend', status: 'ready' });
  }
  const recordedEnvironments = new Set(manifest.project.workload.environments);
  for (const environment of plan.environments) {
    const group = `environment:${environment.id}` as const;
    if (
      !recordedEnvironments.has(environment.id) &&
      !provisioned.has(group)
    ) {
      const gate = infrastructureProvisioningGate(manifest, environment.id);
      groups.push({
        group,
        status: gate.status,
        ...(gate.status === 'migration-required' ? { reason: gate.reason } : {})
      });
    }
  }
  return groups;
}

export async function inspectProvisioningGroups(
  projectRoot: string,
  render: readonly GeneratedArtifact[],
  groups: readonly ProvisioningGroupRequest[],
  options: {
    readFile?: typeof readProjectFile;
  } = {}
): Promise<ProvisioningGroupPlan[]> {
  const readFile = options.readFile ?? readProjectFile;
  const projectArtifacts = render.filter(
    (artifact): artifact is GeneratedProjectArtifact =>
      artifact.lifecycle === 'project'
  );
  const plans: ProvisioningGroupPlan[] = [];
  for (const request of groups) {
    const group = request.group;
    const artifacts = projectArtifacts.filter(
      (artifact) => artifact.provisioningGroup === group
    );
    if (artifacts.length === 0) {
      throw new Error(`Provisioning group ${group} did not render any project artifacts.`);
    }
    if (request.status === 'migration-required') {
      plans.push({
        group,
        entries: [],
        blocked: true,
        reason: request.reason
      });
      continue;
    }
    if (group.startsWith('environment:')) {
      const missingSharedModule = [];
      for (const identity of sharedApplicationModuleIdentities) {
        if (await readFile(projectRoot, [...identity.pathParts]) === undefined) {
          missingSharedModule.push(identity.pathParts.join('/'));
        }
      }
      if (missingSharedModule.length > 0) {
        plans.push({
          group,
          entries: [],
          blocked: true,
          reason: `Recorded shared application module files are missing: ${missingSharedModule.join(', ')}. An explicit reviewed infrastructure migration is required; no environment root was created.`
        });
        continue;
      }
    }
    const entries = await Promise.all(artifacts.map(async (artifact): Promise<ProvisioningEntry> => {
      const disk = await readFile(projectRoot, artifact.pathParts);
      if (disk === undefined) {
        return {
          group,
          status: 'create',
          rendered: artifact,
          reason: 'destination is absent'
        };
      }
      if (disk.toString('utf8') === artifact.content) {
        return {
          group,
          status: 'adopt',
          rendered: artifact,
          reason: 'destination already matches the selected component'
        };
      }
      return {
        group,
        status: 'conflict',
        rendered: artifact,
        reason: 'destination contains project-owned bytes'
      };
    }));
    plans.push({
      group,
      entries,
      blocked: entries.some((entry) => entry.status === 'conflict')
    });
  }
  return plans;
}

export function provisioningJson(plans: readonly ProvisioningGroupPlan[]): object[] {
  return plans.map((plan) => ({
    group: plan.group,
    status: plan.blocked ? 'blocked' : 'ready',
    ...(plan.reason ? { reason: plan.reason } : {}),
    entries: plan.entries.map((entry) => ({
      status: entry.status,
      path: manifestDisplayPath(entry.rendered.pathParts),
      reason: entry.reason
    }))
  }));
}

function projectProvenanceFor(
  artifact: GeneratedProjectArtifact
): ManifestProjectArtifact {
  return {
    logicalName: artifact.logicalName,
    category: artifact.category,
    pathParts: artifact.pathParts,
    generatedBy: liftoffVersion,
    generationHash: `sha256:${createHash('sha256').update(artifact.content, 'utf8').digest('hex')}`,
    provisioningGroup: artifact.provisioningGroup
  };
}

export function appendProvisionedProjectArtifacts(
  existing: readonly ManifestProjectArtifact[],
  plans: readonly ProvisioningGroupPlan[]
): ManifestProjectArtifact[] {
  const byName = new Map(existing.map((artifact) => [artifact.logicalName, artifact]));
  for (const plan of plans) {
    if (plan.blocked) {
      continue;
    }
    for (const entry of plan.entries) {
      if (!byName.has(entry.rendered.logicalName)) {
        byName.set(entry.rendered.logicalName, projectProvenanceFor(entry.rendered));
      }
    }
  }
  return [...byName.values()];
}

export function sameWorkloadIntent(
  left: LiftoffManifest['project']['workload'],
  right: LiftoffManifest['project']['workload']
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.apiStack === right.apiStack &&
    left.cloud === right.cloud &&
    left.region === right.region &&
    left.frontend === right.frontend &&
    left.environments.length === right.environments.length &&
    left.environments.every((environment, index) =>
      environment === right.environments[index]
    ) &&
    (left.kind !== 'genai' || right.kind !== 'genai' || left.pattern === right.pattern);
}

export function planWithBlockedProvisioning(
  plan: ProjectPlan,
  recordedWorkload: LiftoffManifest['project']['workload'],
  provisioningPlans: readonly ProvisioningGroupPlan[]
): ProjectPlan {
  const blockedGroups = new Set(
    provisioningPlans
      .filter((group) => group.blocked)
      .map((group) => group.group)
  );
  const hasBlockedEnvironment = [...blockedGroups].some((group) =>
    group.startsWith('environment:')
  );
  const environments = hasBlockedEnvironment
    ? recordedWorkload.environments.map((id) => {
        const environment = getEnvironment(id);
        if (!environment) {
          throw new Error(`Recorded environment ${id} is no longer supported.`);
        }
        return environment;
      })
    : plan.environments;
  return {
    ...plan,
    includeFrontend: blockedGroups.has('frontend')
      ? recordedWorkload.frontend
      : plan.includeFrontend,
    environments
  };
}

export function isUnownedUpdateConflict(
  entry: ReconcileEntry,
  recordedByName: ReadonlyMap<string, ManifestManagedArtifact>
): boolean {
  if (entry.status === 'moved') {
    return entry.destinationOccupied === true && entry.destinationMatches !== true;
  }
  if (entry.status !== 'conflict') {
    return false;
  }
  const recorded = recordedByName.get(entry.logicalName);
  return !recorded ||
    recorded.category !== entry.rendered?.category ||
    recorded.pathParts.join('\0') !== entry.pathParts.join('\0');
}

export async function preflightUpdate(
  projectRoot: string,
  entries: ReconcileEntry[],
  force: boolean,
  recordedByName: ReadonlyMap<string, ManifestManagedArtifact>
): Promise<void> {
  for (const entry of entries) {
    if (isUnownedUpdateConflict(entry, recordedByName)) {
      continue;
    }
    const writesDestination =
      entry.status === 'new' ||
      entry.status === 'missing' ||
      entry.status === 'upgrade' ||
      entry.status === 'moved' && (entry.cleanMove === true || force) ||
      entry.status === 'conflict' && force;
    const deletesDestination =
      entry.status === 'retired' ||
      entry.status === 'retired-conflict' && force;
    if (writesDestination) {
      await resolveProjectPath(projectRoot, entry.pathParts);
    }
    if (deletesDestination) {
      await resolveProjectPath(projectRoot, entry.pathParts);
    }
    if (
      entry.previousPathParts &&
      (entry.status === 'moved' && (entry.cleanMove === true || force) || entry.status === 'conflict' && force)
    ) {
      await resolveProjectPath(projectRoot, entry.previousPathParts);
    }
  }
  await resolveProjectPath(projectRoot, ['liftoff.manifest.json']);
}

function updateSnapshotKey(pathParts: readonly string[]): string {
  return pathParts.join('\0');
}

export async function captureUpdateSnapshots(
  projectRoot: string,
  manifest: LiftoffManifest,
  render: readonly GeneratedArtifact[],
  initialSnapshots: readonly ProjectFileSnapshot[]
): Promise<ProjectFileSnapshot[]> {
  const snapshots = new Map(
    initialSnapshots.map((snapshot) => [updateSnapshotKey(snapshot.pathParts), snapshot])
  );
  const seenKeys = new Set(snapshots.keys());
  const candidates = [
    ...manifest.managedArtifacts.map((artifact) => artifact.pathParts),
    ...render.map((artifact) => artifact.pathParts)
  ];
  const uncaptured: string[][] = [];
  for (const pathParts of candidates) {
    const key = updateSnapshotKey(pathParts);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uncaptured.push(pathParts);
    }
  }
  for (const snapshot of await Promise.all(
    uncaptured.map((pathParts) => captureProjectFileSnapshot(projectRoot, pathParts))
  )) {
    snapshots.set(updateSnapshotKey(snapshot.pathParts), snapshot);
  }
  return [...snapshots.values()];
}

export function selectUpdatePreconditions(
  snapshots: readonly ProjectFileSnapshot[],
  entries: readonly ReconcileEntry[],
  mutations: readonly ProjectFileMutation[],
  additionalPaths: readonly string[][] = []
): ProjectFileSnapshot[] {
  const requiredKeys = new Set([
    updateSnapshotKey(['liftoff.config.json']),
    ...mutations.map((mutation) => updateSnapshotKey(mutation.pathParts)),
    ...additionalPaths.map((pathParts) => updateSnapshotKey(pathParts))
  ]);
  for (const entry of entries) {
    const adoptsExistingDestination =
      entry.status === 'moved' && entry.destinationMatches === true;
    if (
      !(entry.status === 'unchanged' && entry.refreshHash) &&
      !adoptsExistingDestination
    ) {
      continue;
    }
    requiredKeys.add(updateSnapshotKey(entry.pathParts));
    if (entry.previousPathParts) {
      requiredKeys.add(updateSnapshotKey(entry.previousPathParts));
    }
  }
  return snapshots.filter((snapshot) => requiredKeys.has(updateSnapshotKey(snapshot.pathParts)));
}

export function assertAuthorizedUpdateMutations(
  mutations: readonly ProjectFileMutation[],
  entries: readonly ReconcileEntry[],
  provisioningPlans: readonly ProvisioningGroupPlan[],
  additionalAuthorizedPaths: readonly string[][] = []
): void {
  const authorized = new Set<string>([
    updateSnapshotKey(['liftoff.manifest.json']),
    ...additionalAuthorizedPaths.map((pathParts) => updateSnapshotKey(pathParts))
  ]);
  for (const entry of entries) {
    if (entry.rendered && entry.rendered.lifecycle !== 'managed-core') {
      throw new Error(
        `Update reconciliation produced a non-core mutation candidate: ${entry.logicalName}`
      );
    }
    authorized.add(updateSnapshotKey(entry.pathParts));
    if (entry.previousPathParts) {
      authorized.add(updateSnapshotKey(entry.previousPathParts));
    }
  }
  for (const plan of provisioningPlans) {
    if (plan.blocked) {
      continue;
    }
    for (const entry of plan.entries) {
      if (entry.status === 'create') {
        authorized.add(updateSnapshotKey(entry.rendered.pathParts));
      }
    }
  }
  for (const mutation of mutations) {
    if (!authorized.has(updateSnapshotKey(mutation.pathParts))) {
      throw new Error(
        `Update mutation is outside managed-core or authorized provisioning scope: ${manifestDisplayPath(mutation.pathParts)}`
      );
    }
  }
}

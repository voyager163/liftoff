import type { ProjectFileMutation } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { parseManifest } from '../project/manifest.js';
import type { ReconcileEntry } from '../../reconcile.js';
import { buildManifest } from '../../templates.js';
import { appendProvisionedProjectArtifacts, isUnownedUpdateConflict, type ProvisioningEntry } from './planning.js';
import { preserveDiagnosticGovernanceIdentity, type UpdateInspection } from './inspection.js';

export function planUpdateWrites(inspection: UpdateInspection, force: boolean) {
  const { manifest, entries, oldByName, provisioningPlans, plan, renderPlan, render } = inspection;
  const written: ReconcileEntry[] = [];
  const retired: ReconcileEntry[] = [];
  const skipped: ReconcileEntry[] = [];
  const mutations: ProjectFileMutation[] = [];
  for (const entry of entries) {
    switch (entry.status) {
      case 'new':
      case 'missing':
      case 'upgrade':
        mutations.push({ type: 'write', pathParts: entry.pathParts, content: entry.rendered!.content });
        written.push(entry);
        break;
      case 'moved':
        if (!isUnownedUpdateConflict(entry, oldByName) && (entry.cleanMove || force)) {
          if (!entry.destinationMatches) {
            mutations.push({ type: 'write', pathParts: entry.pathParts, content: entry.rendered!.content });
          }
          mutations.push({ type: 'delete', pathParts: entry.previousPathParts! });
          written.push(entry);
        } else skipped.push(entry);
        break;
      case 'retired':
      case 'retired-conflict':
        if (entry.status === 'retired' || force) {
          if (entry.destinationOccupied !== false) {
            mutations.push({ type: 'delete', pathParts: entry.pathParts });
          }
          retired.push(entry);
        } else skipped.push(entry);
        break;
      case 'conflict':
        if (force && !isUnownedUpdateConflict(entry, oldByName)) {
          mutations.push({ type: 'write', pathParts: entry.pathParts, content: entry.rendered!.content });
          if (entry.previousPathParts) mutations.push({ type: 'delete', pathParts: entry.previousPathParts });
          written.push(entry);
        } else skipped.push(entry);
        break;
    }
  }
  const provisioned: ProvisioningEntry[] = [];
  for (const group of provisioningPlans) {
    if (group.blocked) continue;
    for (const entry of group.entries) {
      if (entry.status === 'create') {
        mutations.push({ type: 'write', pathParts: entry.rendered.pathParts, content: entry.rendered.content });
      }
      provisioned.push(entry);
    }
  }
  mutations.push(...inspection.stateMigration.mutations);
  const nextManifest = buildManifest(renderPlan, render.filter((artifact) => artifact.logicalName !== 'manifest'), {
    frameworkState: manifest.framework.state,
    projectArtifacts: appendProvisionedProjectArtifacts(manifest.projectArtifacts, provisioningPlans)
  });
  nextManifest.framework = manifest.framework;
  nextManifest.project.specWorkflow = manifest.project.specWorkflow;
  nextManifest.project.agents = manifest.project.agents;
  if (manifest.project.defaultAgent) nextManifest.project.defaultAgent = manifest.project.defaultAgent;
  else delete nextManifest.project.defaultAgent;
  const partialHandoff = skipped.some((entry) =>
    entry.status === 'retired-conflict' ||
    entry.status === 'conflict' && entry.rendered?.category === 'governance' && !oldByName.has(entry.logicalName)
  );
  if (partialHandoff && nextManifest.governance.profile !== 'none') {
    nextManifest.governance.state = 'handoff-partial';
  }
  if (inspection.stateMigration.report.diagnosticOnly === true && inspection.historyMigration.status !== 'eligible') {
    preserveDiagnosticGovernanceIdentity(nextManifest, manifest);
  }
  const skippedNames = new Set(skipped.map((entry) => entry.logicalName));
  nextManifest.managedArtifacts = nextManifest.managedArtifacts.flatMap((artifact) => {
    if (!skippedNames.has(artifact.logicalName)) return [artifact];
    const previous = oldByName.get(artifact.logicalName);
    return previous ? [{ ...artifact, pathParts: previous.pathParts, contentHash: previous.contentHash }] : [];
  });
  for (const entry of entries) {
    if (entry.status !== 'orphan' && !(entry.status === 'retired-conflict' && !force)) continue;
    const previous = oldByName.get(entry.logicalName)!;
    if (plan.governanceProfile.id !== 'none' || previous.category !== 'governance') {
      nextManifest.managedArtifacts.push(previous);
    }
  }
  parseManifest(nextManifest);
  const manifestChanged = canonicalSha256(nextManifest) !== canonicalSha256(manifest);
  const writesManifest = inspection.hasDrift &&
    (mutations.length > 0 || manifestChanged || inspection.ownershipMigrationPending);
  if (writesManifest) {
    mutations.push({
      type: 'write', pathParts: ['liftoff.manifest.json'],
      content: `${JSON.stringify(nextManifest, null, 2)}\n`
    });
  }
  return {
    force, mutations, nextManifest: writesManifest ? nextManifest : manifest,
    written, retired, skipped, provisioned, hasWrites: mutations.length > 0
  };
}

export type UpdateWritePlan = ReturnType<typeof planUpdateWrites>;

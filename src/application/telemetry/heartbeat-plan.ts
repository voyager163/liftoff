import path from 'node:path';
import type { observeProjectTelemetry } from './project-reporting.js';
import type { readHeartbeatRepository } from '../../adapters/filesystem/telemetry-heartbeat.js';
import { readTelemetryFile, telemetrySnapshotIdentity } from '../../adapters/filesystem/telemetry-consent.js';
import { applyProjectFileTransaction } from '../../adapters/filesystem/project-transaction.js';
import { assertHeartbeatTargetsWritable } from '../../adapters/filesystem/telemetry-heartbeat.js';
import { telemetryReviewFingerprint } from '../../domain/project/telemetry-consent.js';
import { FileSystemError } from '../../domain/project/errors.js';
import {
  heartbeatInventoryPath, heartbeatToolingMatches, heartbeatWorkflowHasJobs, heartbeatWorkflowPath, heartbeatWorkflowText, renderHeartbeatWorkflow, updateHeartbeatEntry, validateHeartbeatWorkflow,
  validateHeartbeatTooling, type HeartbeatTooling
} from '../../domain/project/telemetry-heartbeat.js';

export function heartbeatSelectedRoot(repositoryRoot: string, projectRoot: string): string[] {
  const relative = path.relative(repositoryRoot, projectRoot);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new FileSystemError('The selected project is outside the reviewed repository.');
  }
  return relative ? relative.split(path.sep) : [];
}

export function heartbeatReviewBindings(
  repository: Awaited<ReturnType<typeof readHeartbeatRepository>>,
  project: Awaited<ReturnType<typeof observeProjectTelemetry>>
) {
  return {
    repositoryRoot: repository.root, physical: repository.physical,
    repositoryIdentity: repository.identity ?? null, gitRoot: repository.gitRoot, gitPhysical: repository.gitPhysical,
    projectRoot: project.root, projectPhysical: project.physical,
    selectedRoot: heartbeatSelectedRoot(repository.root, project.root),
    manifest: telemetrySnapshotIdentity(project.manifest), record: telemetrySnapshotIdentity(project.recordFile),
    configPath: project.config.path, configAnchor: project.config.anchor,
    config: telemetrySnapshotIdentity(project.config.snapshot)
  };
}

// A candidate plan is deterministic data, not approval, publication qualification or a transport proof.
export function buildHeartbeatEnablementPlan(
  repository: Awaited<ReturnType<typeof readHeartbeatRepository>>,
  project: Awaited<ReturnType<typeof observeProjectTelemetry>>,
  tooling: HeartbeatTooling
) {
  if (!repository.identity || !project.record?.enabled || !project.consent) {
    throw new FileSystemError('Heartbeat enablement requires independently verified repository identity and current local enrollment consent.');
  }
  const checkedTooling = validateHeartbeatTooling(tooling);
  const entry = { projectId: project.record.projectId, pathParts: heartbeatSelectedRoot(repository.root, project.root) };
  let target;
  if (!repository.inventory && repository.workflowFile.content === undefined) {
    const inventory = { schemaVersion: 1 as const, repository: repository.identity, tooling: checkedTooling, entries: [entry] };
    target = { inventory, workflow: renderHeartbeatWorkflow(inventory) };
  } else {
    if (!repository.inventory || !repository.workflowFile.content ||
        repository.inventory.repository !== repository.identity ||
        !heartbeatToolingMatches(repository.inventory.tooling, checkedTooling)) {
      throw new FileSystemError('Existing heartbeat ownership or release tooling differs; no implicit overwrite or upgrade is permitted.');
    }
    validateHeartbeatWorkflow(repository.inventory, repository.workflowFile.content);
    target = updateHeartbeatEntry(repository.inventory, repository.workflowFile.content, entry, 'add');
  }
  validateHeartbeatWorkflow(target.inventory, target.workflow);
  return {
    schemaVersion: 1, kind: 'liftoff-heartbeat-enablement',
    ...heartbeatReviewBindings(repository, project), tooling: checkedTooling,
    inventory: telemetrySnapshotIdentity(repository.inventoryFile), workflow: telemetrySnapshotIdentity(repository.workflowFile),
    targetInventory: target.inventory, targetWorkflow: target.workflow, removeOwnedFiles: false
  };
}

export function heartbeatRemovalTarget(
  inventory: Parameters<typeof updateHeartbeatEntry>[0], workflow: string | Buffer,
  entry: Parameters<typeof updateHeartbeatEntry>[2]
) {
  const text = heartbeatWorkflowText(workflow);
  validateHeartbeatWorkflow(inventory, text);
  const updated = updateHeartbeatEntry(inventory, text, entry, 'remove');
  const header = renderHeartbeatWorkflow({ ...updated.inventory, entries: [] });
  const remaining = updated.workflow.replaceAll('\r\n', '\n');
  const removeOwnedFiles = updated.inventory.entries.length === 0 && remaining === header;
  if (updated.inventory.entries.length === 0 && !removeOwnedFiles &&
      !heartbeatWorkflowHasJobs(remaining)) {
    throw new FileSystemError('Last heartbeat entry removal leaves custom content without jobs; obtain a separate workflow review rather than delete custom bytes.');
  }
  if (!removeOwnedFiles) validateHeartbeatWorkflow(updated.inventory, updated.workflow);
  return { targetInventory: updated.inventory, targetWorkflow: updated.workflow, removeOwnedFiles };
}

export async function applyHeartbeatPlan(
  repository: Awaited<ReturnType<typeof readHeartbeatRepository>>,
  plan: { repositoryRoot: string; targetInventory: Parameters<typeof renderHeartbeatWorkflow>[0];
    targetWorkflow: string; removeOwnedFiles: boolean },
  approvedFingerprint: string,
  assertCurrent: () => Promise<void>
): Promise<void> {
  if (approvedFingerprint !== telemetryReviewFingerprint(plan) || plan.repositoryRoot !== repository.root) {
    throw new FileSystemError('Heartbeat plan approval does not match this exact repository update.');
  }
  await assertHeartbeatTargetsWritable(repository);
  await assertCurrent();
  await applyProjectFileTransaction(repository.root, plan.removeOwnedFiles ? [
    { type: 'delete', pathParts: [...heartbeatWorkflowPath] },
    { type: 'delete', pathParts: [...heartbeatInventoryPath] }
  ] : [
    { type: 'write', pathParts: [...heartbeatWorkflowPath], content: plan.targetWorkflow, mode: repository.workflowFile.mode },
    { type: 'write', pathParts: [...heartbeatInventoryPath], content: `${JSON.stringify(plan.targetInventory, null, 2)}\n`, mode: repository.inventoryFile.mode }
  ], {
    preconditions: [repository.inventoryFile, repository.workflowFile],
    onBeforeMutation: assertCurrent
  });
  const inventory = await readTelemetryFile(repository.root, heartbeatInventoryPath);
  const workflow = await readTelemetryFile(repository.root, heartbeatWorkflowPath);
  if (plan.removeOwnedFiles
    ? workflow.content !== undefined || inventory.content !== undefined
    : !workflow.content?.equals(Buffer.from(plan.targetWorkflow, 'utf8')) ||
      !inventory.content?.equals(Buffer.from(`${JSON.stringify(plan.targetInventory, null, 2)}\n`, 'utf8'))) {
    throw new FileSystemError('Heartbeat entry update did not read back; committed progress needs inspection.');
  }
}

import path from 'node:path';
import type { ExecutionContext } from '../context.js';
import { observeProjectTelemetry } from './project-reporting.js';
import { readTelemetryFile, telemetryJson, telemetryRoot, telemetrySnapshotIdentity } from '../../adapters/filesystem/telemetry-consent.js';
import { applyProjectFileTransaction } from '../../adapters/filesystem/project-transaction.js';
import { FileSystemError } from '../../domain/project/errors.js';
import {
  heartbeatInventoryPath, heartbeatPublicationBlocker, heartbeatWorkflowPath,
  parseHeartbeatInventory, updateHeartbeatEntry
} from '../../domain/project/telemetry-heartbeat.js';
import { telemetryReviewFingerprint } from '../../domain/project/telemetry-consent.js';
import { telemetryDisabledResult } from '../../telemetry/delivery.js';
import { NodeCommandRunner } from '../../process-runner.js';
import { requestUpdateApproval } from '../update/approval.js';

export async function runHeartbeat(request: {
  operation: 'status' | 'enable' | 'disable';
  project?: string;
  repository?: string;
  check: boolean;
  approvePlan?: string;
  json: boolean;
}, context: ExecutionContext): Promise<number> {
  const env = context.env ?? process.env;
  const output = (value: Record<string, unknown>): void => context.presentation.rawStdout(`${JSON.stringify({
    schemaVersion: 1, kind: 'liftoff-project-heartbeat', operation: request.operation, ...value
  }, null, 2)}\n`);
  const disabled = telemetryDisabledResult(env);
  if (disabled) { output(disabled); return 0; }
  if (!request.repository) throw new FileSystemError('Heartbeat review requires --repository with the exact repository root; project consent is not repository file authority.');
  const repository = await telemetryRoot(path.resolve(context.cwd, request.repository));
  const git = await (context.runner ?? new NodeCommandRunner()).run({
    executable: 'git', args: ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel']
  }, { cwd: repository.root, env, timeoutMs: 5_000, maxOutputBytes: 8192 });
  if (git.status !== 0 || git.timedOut || git.outputLimitExceeded ||
      (await telemetryRoot(git.stdout.trim())).root !== repository.root) {
    throw new FileSystemError('Heartbeat repository boundary could not be independently verified.');
  }
  const project = await observeProjectTelemetry(context.cwd, request.project, env);
  const relative = path.relative(repository.root, project.root);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new FileSystemError('The selected project is outside the reviewed repository.');
  }
  const pathParts = relative === '' ? [] : relative.split(path.sep);
  const inventoryFile = await readTelemetryFile(repository.root, heartbeatInventoryPath, 64 * 1024);
  const workflowFile = await readTelemetryFile(repository.root, heartbeatWorkflowPath, 256 * 1024);
  const inventory = inventoryFile.content === undefined ? undefined : parseHeartbeatInventory(telemetryJson(inventoryFile.content, 'Heartbeat inventory'));
  const entry = inventory?.entries.find(entry => JSON.stringify(entry.pathParts) === JSON.stringify(pathParts));
  if (entry && entry.projectId !== project.record?.projectId) throw new FileSystemError('Heartbeat inventory and selected project identity disagree; neither is write approval.');
  if (request.operation === 'status') {
    output({ status: 'disabled', configuredEntry: entry !== undefined, reportingQualified: false, blocker: heartbeatPublicationBlocker });
    return 0;
  }
  if (request.operation === 'enable') {
    output({
      status: 'blocked', reason: project.record?.enabled && project.consent ? 'publication-not-qualified' : 'project-consent-required',
      blocker: heartbeatPublicationBlocker, repositoryRoot: repository.root, selectedRoot: pathParts,
      writes: [heartbeatInventoryPath.join('/'), heartbeatWorkflowPath.join('/')],
      projectEnrolled: project.record?.enabled === true && project.consent, scheduleInstalled: false
    });
    return 2;
  }
  if (!entry || !inventory) { output({ status: 'disabled', reason: 'entry-absent' }); return 0; }
  if (!workflowFile.content) throw new FileSystemError('Declared heartbeat workflow is absent; no unrelated workflow was replaced.');
  const updated = updateHeartbeatEntry(inventory, workflowFile.content.toString('utf8'), entry, 'remove');
  const plan = {
    schemaVersion: 1, kind: 'liftoff-heartbeat-removal', repositoryRoot: repository.root, physical: repository.physical,
    projectRoot: project.root, projectPhysical: project.physical, selectedRoot: pathParts,
    manifest: telemetrySnapshotIdentity(project.manifest), record: telemetrySnapshotIdentity(project.recordFile),
    inventory: telemetrySnapshotIdentity(inventoryFile), workflow: telemetrySnapshotIdentity(workflowFile),
    targetInventory: updated.inventory, targetWorkflow: updated.workflow
  };
  const fingerprint = telemetryReviewFingerprint(plan);
  if (!request.json || request.check || !request.approvePlan) output({ status: 'review-required', fingerprint, plan });
  if (request.check || request.json && !request.approvePlan) return 2;
  const approval = await requestUpdateApproval({ fingerprint, approvePlan: request.approvePlan,
    message: `Remove only this exact heartbeat entry from the separately reviewed repository (${fingerprint})?`
  }, { ...context, approveUpdatePlan: context.approveTelemetryPlan });
  if (approval.status !== 'approved') { output({ status: approval.status, fingerprint }); return approval.status === 'mismatch' ? 1 : 2; }
  await applyProjectFileTransaction(repository.root, [
    { type: 'write', pathParts: [...heartbeatWorkflowPath], content: updated.workflow, mode: workflowFile.mode },
    { type: 'write', pathParts: [...heartbeatInventoryPath], content: `${JSON.stringify(updated.inventory, null, 2)}\n`, mode: inventoryFile.mode }
  ], {
    preconditions: [inventoryFile, workflowFile],
    onBeforeMutation: async () => {
      if (telemetryDisabledResult(env)) throw new FileSystemError('Telemetry was disabled after review; no heartbeat writes are permitted.');
      const currentProject = await observeProjectTelemetry(context.cwd, request.project, env);
      if (currentProject.root !== project.root || currentProject.physical !== project.physical ||
          JSON.stringify(telemetrySnapshotIdentity(currentProject.manifest)) !== JSON.stringify(plan.manifest) ||
          JSON.stringify(telemetrySnapshotIdentity(currentProject.recordFile)) !== JSON.stringify(plan.record) ||
          (await telemetryRoot(repository.root)).physical !== repository.physical) {
        throw new FileSystemError('Heartbeat project/repository review changed; obtain fresh scoped approval.');
      }
    }
  });
  const savedInventory = await readTelemetryFile(repository.root, heartbeatInventoryPath);
  const savedWorkflow = await readTelemetryFile(repository.root, heartbeatWorkflowPath);
  if (savedWorkflow.content?.toString('utf8') !== updated.workflow ||
      savedInventory.content?.toString('utf8') !== `${JSON.stringify(updated.inventory, null, 2)}\n`) {
    throw new FileSystemError('Heartbeat entry removal did not read back; committed progress needs inspection.');
  }
  output({ status: 'disabled', entryRemoved: true, otherEntriesPreserved: true, customWorkflowBytesPreserved: true });
  return 0;
}

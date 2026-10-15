import path from 'node:path';
import type { ExecutionContext } from '../context.js';
import { observeProjectTelemetry } from './project-reporting.js';
import { telemetrySnapshotIdentity } from '../../adapters/filesystem/telemetry-consent.js';
import { assertHeartbeatTargetsWritable, readHeartbeatRepository } from '../../adapters/filesystem/telemetry-heartbeat.js';
import { applyHeartbeatPlan, buildHeartbeatEnablementPlan, heartbeatRemovalTarget, heartbeatReviewBindings, heartbeatSelectedRoot } from './heartbeat-plan.js';
import { FileSystemError } from '../../domain/project/errors.js';
import {
  heartbeatInventoryPath, heartbeatPublicationBlocker, heartbeatWorkflowPath,
  qualifiedHeartbeatTooling
} from '../../domain/project/telemetry-heartbeat.js';
import { telemetryReviewFingerprint } from '../../domain/project/telemetry-consent.js';
import { telemetryDisabledResult } from '../../telemetry/delivery.js';
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
  const tooling = qualifiedHeartbeatTooling;
  const repository = await readHeartbeatRepository(path.resolve(context.cwd, request.repository), env,
    request.operation === 'enable' && tooling !== undefined);
  const project = await observeProjectTelemetry(context.cwd, request.project, env);
  const pathParts = heartbeatSelectedRoot(repository.root, project.root);
  const { inventoryFile, workflowFile, inventory } = repository;
  const entry = inventory?.entries.find(entry => JSON.stringify(entry.pathParts) === JSON.stringify(pathParts));
  if (entry && entry.projectId !== project.record?.projectId) throw new FileSystemError('Heartbeat inventory and selected project identity disagree; neither is write approval.');
  if (request.operation === 'status') {
    output({ status: entry && tooling && project.record?.enabled && project.consent ? 'configured' : 'disabled',
      configuredEntry: entry !== undefined, reportingQualified: false, blocker: heartbeatPublicationBlocker });
    return 0;
  }
  if (request.operation === 'enable' && !tooling) {
    output({
      status: 'blocked', reason: project.record?.enabled && project.consent ? 'publication-not-qualified' : 'project-consent-required',
      blocker: heartbeatPublicationBlocker, repositoryRoot: repository.root, selectedRoot: pathParts,
      writes: [heartbeatInventoryPath.join('/'), heartbeatWorkflowPath.join('/')],
      projectEnrolled: project.record?.enabled === true && project.consent, scheduleInstalled: false
    });
    return 2;
  }
  if (request.operation === 'enable' &&
      (!request.project || path.resolve(context.cwd, request.project) !== project.root)) {
    throw new FileSystemError('Heartbeat enablement requires the explicit canonical selected project root.');
  }
  if (request.operation === 'disable' && (!entry || !inventory)) { output({ status: 'disabled', reason: 'entry-absent' }); return 0; }
  await assertHeartbeatTargetsWritable(repository);
  const bindings = heartbeatReviewBindings(repository, project);
  const plan = request.operation === 'enable'
    ? buildHeartbeatEnablementPlan(repository, project, tooling!)
    : (() => {
      if (!workflowFile.content || !inventory || !entry) throw new FileSystemError('Declared heartbeat workflow is absent; no unrelated workflow was replaced.');
      return { schemaVersion: 1, kind: 'liftoff-heartbeat-removal', ...bindings,
        inventory: telemetrySnapshotIdentity(inventoryFile), workflow: telemetrySnapshotIdentity(workflowFile),
        ...heartbeatRemovalTarget(inventory, workflowFile.content, entry) };
    })();
  const fingerprint = telemetryReviewFingerprint(plan);
  if (!request.json || request.check || !request.approvePlan) output({ status: 'review-required', fingerprint, plan });
  if (request.check || request.json && !request.approvePlan) return 2;
  const approval = await requestUpdateApproval({ fingerprint, approvePlan: request.approvePlan,
    message: `${request.operation === 'enable' ? 'Enable monthly observations for' : 'Remove'} only this exact heartbeat entry in the separately reviewed repository (${fingerprint})?`
  }, { ...context, approveUpdatePlan: context.approveTelemetryPlan });
  if (approval.status !== 'approved') { output({ status: approval.status, fingerprint }); return approval.status === 'mismatch' ? 1 : 2; }
  await applyHeartbeatPlan(repository, plan, fingerprint, async () => {
      if (telemetryDisabledResult(env)) throw new FileSystemError('Telemetry was disabled after review; no heartbeat writes are permitted.');
      const currentProject = await observeProjectTelemetry(context.cwd, request.project, env);
      const currentRepository = await readHeartbeatRepository(repository.root, env, request.operation === 'enable');
      await assertHeartbeatTargetsWritable(currentRepository);
      if (JSON.stringify(heartbeatReviewBindings(currentRepository, currentProject)) !== JSON.stringify(bindings) ||
          request.operation === 'enable' && (!currentProject.consent || qualifiedHeartbeatTooling !== tooling)) {
        throw new FileSystemError('Heartbeat project/repository review changed; obtain fresh scoped approval.');
      }
  });
  output({ status: request.operation === 'enable' ? 'enabled' : 'disabled',
    entryRemoved: request.operation === 'disable', entryEnabled: request.operation === 'enable',
    ownedFilesRemoved: plan.removeOwnedFiles, otherEntriesPreserved: true, customWorkflowBytesPreserved: true });
  return 0;
}

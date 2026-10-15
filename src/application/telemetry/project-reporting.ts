import path from 'node:path';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import { FileSystemError } from '../../domain/project/errors.js';
import {
  projectConsentBindings, projectTelemetryDisclosure, projectTelemetryDisclosureVersion,
  projectTelemetryRecordPath, telemetryReviewFingerprint, type ProjectTelemetryRecord
} from '../../domain/project/telemetry-consent.js';
import {
  commitTelemetryConsent, newProjectTelemetryId, parseTelemetryFile, readTelemetryConsentConfig,
  readTelemetryFile, telemetryJson, telemetryRoot, telemetrySnapshotIdentity
} from '../../adapters/filesystem/telemetry-consent.js';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import { projectTelemetryDimensions } from '../project/telemetry.js';
import { liftoffVersion } from '../../version.js';
import {
  createTelemetryDelivery, telemetryDisabledResult,
  type TelemetryDelivery, type TelemetryDeliveryResult
} from '../../telemetry/delivery.js';
import { productionTelemetryEndpoint } from '../../telemetry/index.js';
import { getTelemetryConfigPath } from '../../telemetry/config.js';
import { isProjectTelemetryEvent, type ProjectTelemetryEvent } from '../../telemetry/contract.js';
import { requestUpdateApproval } from '../update/approval.js';
import type { ExecutionContext } from '../context.js';
import { qualifiedHeartbeatTooling } from '../../domain/project/telemetry-heartbeat.js';
import { readQualifiedHeartbeatReportProof } from '../../adapters/filesystem/telemetry-heartbeat.js';

export const projectTelemetryEndpoint = productionTelemetryEndpoint.replace(/\/events$/, '/projects');
export type ProjectReportResult = TelemetryDeliveryResult | {
  status: 'disabled'; attempted: false; reason: 'not-enrolled' | 'local-consent-required' | 'heartbeat-not-qualified';
} | { status: 'failed'; attempted: false; reason: 'project-or-consent-unavailable' };

export interface ProjectTelemetryRequest {
  operation: 'status' | 'enroll' | 'disable' | 'report';
  project?: string;
  repository?: string;
  check: boolean;
  approvePlan?: string;
  preserveIdentity: boolean;
  newIdentity: boolean;
  heartbeat: boolean;
  json: boolean;
}

export async function observeProjectTelemetryRoot(cwd: string, project: string | undefined) {
  const selected = project === undefined ? await findProjectRoot(cwd) : path.resolve(cwd, project);
  if (!selected) throw new FileSystemError('No Liftoff project root was selected.');
  const location = await telemetryRoot(selected);
  const manifest = await readTelemetryFile(location.root, ['liftoff.manifest.json']);
  if (!manifest.content) throw new FileSystemError('The selected root has no Liftoff manifest; an outer project was not selected.');
  const dimensions = projectTelemetryDimensions(telemetryJson(manifest.content, 'Project manifest'));
  const recordFile = await readTelemetryFile(location.root, projectTelemetryRecordPath, 4096);
  const record = parseTelemetryFile(recordFile);
  return { ...location, manifest, dimensions, recordFile, record };
}

async function observe(cwd: string, project: string | undefined, env: NodeJS.ProcessEnv) {
  const observed = await observeProjectTelemetryRoot(cwd, project);
  const config = await readTelemetryConsentConfig(getTelemetryConfigPath({ env }));
  if (config.path === observed.root || config.path.startsWith(`${observed.root}${path.sep}`)) {
    throw new FileSystemError('Project consent must be stored outside the selected project.');
  }

  const consent = observed.record && projectConsentBindings(config.config).some(binding =>
    binding.projectRoot === observed.root && binding.projectId === observed.record?.projectId &&
    binding.disclosureVersion === projectTelemetryDisclosureVersion);
  const writableConfig = config.snapshot.mode === undefined || (config.snapshot.mode & 0o222) !== 0;
  return { ...observed, config, consent: consent === true && writableConfig };
}

export { observe as observeProjectTelemetry };

function review(observed: Awaited<ReturnType<typeof observe>>, request: ProjectTelemetryRequest) {
  if (request.operation === 'enroll' && observed.record && !request.preserveIdentity && !request.newIdentity) {
    throw new FileSystemError('A tracked identity already exists. Explicitly choose --preserve-identity for a clone/worktree or --new-identity for an independent fork/copy.');
  }
  if (request.operation === 'enroll' && !observed.record && request.preserveIdentity) {
    throw new FileSystemError('There is no existing identity to preserve.');
  }
  return {
    kind: 'liftoff-project-telemetry-review', schemaVersion: 1,
    operation: request.operation, projectRoot: observed.root, physical: observed.physical,
    configPath: observed.config.path, disclosureVersion: projectTelemetryDisclosureVersion,
    identity: request.newIdentity || !observed.record ? 'new-random-after-approval' : observed.record.projectId,
    manifest: telemetrySnapshotIdentity(observed.manifest),
    record: telemetrySnapshotIdentity(observed.recordFile),
    config: telemetrySnapshotIdentity(observed.config.snapshot),
    writes: [projectTelemetryRecordPath.join('/'), 'external user-local telemetry.projectConsents'],
    heartbeatEnabled: false
  };
}

export async function reportProjectObservation(
  options: { cwd: string; project?: string; repository?: string; env: NodeJS.ProcessEnv; heartbeat?: boolean; delivery?: TelemetryDelivery }
): Promise<ProjectReportResult> {
  const disabled = telemetryDisabledResult(options.env);
  if (disabled?.reason === 'global-opt-out') return disabled;
  if (options.heartbeat && (!qualifiedHeartbeatTooling || !options.project || !options.repository)) {
    return { status: 'disabled', attempted: false, reason: 'heartbeat-not-qualified' };
  }
  if (disabled && !options.heartbeat) return disabled;
  const delivery = options.delivery ?? createTelemetryDelivery({ env: options.env });
  try {
    const prepared = await delivery.withinBudget(async () => {
      const observed = options.heartbeat
        ? { ...await observeProjectTelemetryRoot(options.cwd, options.project), consent: undefined }
        : await observe(options.cwd, options.project, options.env);
      if (options.heartbeat && path.resolve(options.cwd, options.project!) !== observed.root) {
        throw new FileSystemError('Heartbeat report requires the explicit canonical selected project root.');
      }
      if (!observed.record?.enabled) return { status: 'disabled', reason: 'not-enrolled', attempted: false } as const;
      if (!options.heartbeat && !observed.consent) return { status: 'disabled', reason: 'local-consent-required', attempted: false } as const;
      const event: ProjectTelemetryEvent = {
        schemaVersion: 2, event: 'project_observed', projectId: observed.record.projectId,
        cliVersion: liftoffVersion, ...observed.dimensions, source: options.heartbeat ? 'ci-heartbeat' : 'cli'
      };
      if (!isProjectTelemetryEvent(event)) throw new FileSystemError('Project telemetry dimensions are unsupported.');
      const heartbeatProof = options.heartbeat ? await readQualifiedHeartbeatReportProof({
        projectRoot: observed.root, repositoryRoot: path.resolve(options.cwd, options.repository!),
        manifest: telemetrySnapshotIdentity(observed.manifest), event, env: options.env, signal: delivery.signal
      }) : undefined;
      if (options.heartbeat && !heartbeatProof) return { status: 'disabled', attempted: false, reason: 'heartbeat-not-qualified' } as const;
      const after = telemetryDisabledResult(options.env);
      if (after?.reason === 'global-opt-out' || after && !options.heartbeat) return after;
      return { status: 'ready', event: Object.freeze(event), heartbeatProof } as const;
    });
    if (prepared.status === 'failed') {
      return prepared.reason === 'operation-failed'
        ? { status: 'failed', attempted: false, reason: 'project-or-consent-unavailable' }
        : { status: 'failed', attempted: false, reason: prepared.reason };
    }
    if (prepared.value.status !== 'ready') return prepared.value;
    const result = await delivery.deliver({ project: {
      endpoint: projectTelemetryEndpoint, event: prepared.value.event, heartbeatProof: prepared.value.heartbeatProof
    } });
    if (!result.project) throw new FileSystemError('Project delivery did not return its requested result.');
    return result.project;
  } finally {
    if (!options.delivery) delivery.close();
  }
}

export async function reportOrdinaryProject(
  parsed: ParsedArgs, cwd: string, env: NodeJS.ProcessEnv, delivery: TelemetryDelivery
): Promise<void> {
  if (parsed.flags.help === true || !['validate', 'update', 'repair', 'doctor', 'governance', 'dev', 'infra'].includes(parsed.command ?? '')) return;
  const project = typeof parsed.flags.project === 'string' ? parsed.flags.project : parsed.positional[0];
  await reportProjectObservation({ cwd, project, env, delivery });
}

export async function runProjectTelemetry(request: ProjectTelemetryRequest, context: ExecutionContext): Promise<number> {
  const env = context.env ?? process.env;
  const output = (value: Record<string, unknown>): void => {
    const report = { schemaVersion: 1, kind: 'liftoff-project-telemetry', operation: request.operation, ...value };
    context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
  };
  const disabled = telemetryDisabledResult(env);
  if (disabled && !(disabled.reason === 'ordinary-ci' && request.operation === 'report' && request.heartbeat)) {
    output(disabled);
    return 0;
  }
  if (request.operation === 'report') {
    const result = await reportProjectObservation({
      cwd: context.cwd, project: request.project, repository: request.repository, env, heartbeat: request.heartbeat
    });
    output(result);
    return result.status === 'failed' ? 1 : 0;
  }
  const observed = await observe(context.cwd, request.project, env);
  if (request.operation === 'status') {
    output({
      status: observed.record?.enabled && observed.consent ? 'enabled' : 'disabled',
      reason: !observed.record?.enabled ? 'not-enrolled' : !observed.consent ? 'local-consent-required' : 'current-consent',
      projectId: observed.record?.projectId ?? null, disclosureVersion: projectTelemetryDisclosureVersion,
      heartbeatEnabled: false, heartbeatBlocker: 'No qualified published heartbeat CLI artifact is registered.'
    });
    return 0;
  }
  if (request.operation === 'disable' && !observed.record) {
    output({ status: 'disabled', reason: 'not-enrolled' });
    return 0;
  }
  const plan = review(observed, request), fingerprint = telemetryReviewFingerprint(plan);
  if (!request.json || request.check || !request.approvePlan) {
    output({ status: 'review-required', fingerprint, plan, disclosure: projectTelemetryDisclosure });
  }
  if (request.check || request.json && !request.approvePlan) return 2;
  const approval = await requestUpdateApproval({
    fingerprint, approvePlan: request.approvePlan,
    message: `${request.operation === 'enroll' ? 'Approve the disclosed pseudonymous reporting and exact enrollment writes' : 'Disable reporting with these exact project/config writes'} (${fingerprint})?`
  }, { ...context, approveUpdatePlan: context.approveTelemetryPlan });
  if (approval.status !== 'approved') {
    output({ status: approval.status, fingerprint });
    return approval.status === 'mismatch' ? 1 : 2;
  }
  const assertCurrent = async (): Promise<void> => {
    if (telemetryDisabledResult(env)) throw new FileSystemError('Telemetry was disabled after review; no further consent writes are permitted.');
    const current = await observe(context.cwd, request.project, env);
    if (telemetryReviewFingerprint(review(current, request)) !== fingerprint) {
      throw new FileSystemError('Telemetry review changed; obtain fresh approval for this exact checkout and configuration.');
    }
  };
  await assertCurrent();
  const target: ProjectTelemetryRecord = {
    schemaVersion: 1, disclosureVersion: projectTelemetryDisclosureVersion,
    projectId: request.newIdentity || !observed.record ? newProjectTelemetryId() : observed.record.projectId,
    enabled: request.operation === 'enroll'
  };
  try {
    await commitTelemetryConsent({
      projectRoot: observed.root, manifest: observed.manifest, record: observed.recordFile, config: observed.config, target,
      assertCurrent
    });
  } catch (error) {
    output({ status: 'failed', reason: 'consent-publication-failed', detail: error instanceof Error ? error.message : 'Publication failed.',
      projectRecordMayHaveCommitted: true, remedy: 'Inspect telemetry status and create a fresh review before retrying; no event was sent.' });
    return 1;
  }
  output({ status: target.enabled ? 'enrolled' : 'disabled', projectId: target.projectId, heartbeatEnabled: false });
  return 0;
}

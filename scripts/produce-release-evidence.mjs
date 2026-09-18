#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseSubject, canonicalJson, confinedDirectory, exactIds, inspectFile, loadReleaseContext,
  loadReleaseContracts, readJsonFile, readVerifiedReleaseReport, REQUIRED_NATIVE_TARGETS, sha256,
  verifyNativeArtifactFile, verifyNativeManifestFile, verifySourceWorktree
} from './release-evidence.mjs';
import { createGitHubEvidenceVerifier, instant, positiveId, requireValue, validateAuthorityPolicy, validateWorkflowPolicy } from './release-evidence-github.mjs';
import { ACTION_APPROVAL_MECHANISM, ACTION_PURPOSES, QUALIFICATION_PURPOSES, buildActionRequest, loadQualificationRegistry, verifyQualificationExecutions } from './release-qualification.mjs';

export function parseProducerArgs(args) {
  const [command, ...rest] = args;
  requireValue(['prepare-action', 'approve-action', 'qualify-records'].includes(command), 'Usage: produce-release-evidence.mjs <prepare-action|approve-action|qualify-records> --source-commit SHA --evidence PATH --run-id ID --run-attempt N --artifact-id ID [--purpose publication|liveQualification|dashboard|telemetryGateway]');
  const allowed = ['--source-commit', '--evidence', '--run-id', '--run-attempt', '--artifact-id', ...(command === 'qualify-records' ? [] : ['--purpose'])];
  requireValue(rest.length === allowed.length * 2, 'Missing or extra report-producer arguments');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    requireValue(allowed.includes(rest[index]) && !Object.hasOwn(options, rest[index]) && typeof rest[index + 1] === 'string' && rest[index + 1].length > 0, 'Unknown, repeated, or empty report-producer option');
    options[rest[index]] = rest[index + 1];
  }
  requireValue(/^[a-f0-9]{40}$/.test(options['--source-commit']), 'An exact immutable source commit is required');
  positiveId(options['--run-id'], 'Selected evidence run ID');
  positiveId(options['--artifact-id'], 'Selected evidence artifact ID');
  requireValue(/^[1-9][0-9]?$/.test(options['--run-attempt']), 'Selected evidence attempt must be exact and bounded');
  if (command !== 'qualify-records') requireValue(ACTION_PURPOSES.includes(options['--purpose']), 'An explicit action-specific purpose is required');
  return { command, options };
}

export function actionApprovalReceipt(request, actor, issuedAt, expiresAt) {
  // This is signing input, not authority: admission still requires the actual dispatch and attestation.
  requireValue(instant(issuedAt, 'Receipt issue time') < instant(expiresAt, 'Receipt expiry'), 'Receipt has no valid approval interval');
  return {
    schemaVersion: 2, mechanism: ACTION_APPROVAL_MECHANISM, intent: 'authorize-exact-request', purpose: request.purpose,
    request, requestSha256: sha256(canonicalJson(request)), actor, issuedAt, expiresAt
  };
}

export function releaseReport(type, subject, data) {
  return {
    schemaVersion: 1, kind: 'liftoff-release-report', type,
    binding: { product: subject.product, version: subject.version, repository: subject.repository,
      sourceCommit: subject.sourceCommit, releaseSubjectSha256: sha256(canonicalJson(subject)) },
    data
  };
}

export async function produceReleaseEvidence(command, options, projectRoot = process.cwd()) {
  requireValue(['prepare-action', 'approve-action', 'qualify-records'].includes(command), 'Unknown explicit release report-producing mode');
  const now = Date.now();
  const sourceCommit = options['--source-commit'];
  const environment = process.env;
  requireValue(environment.GITHUB_ACTIONS === 'true' && environment.LIFTOFF_RELEASE_MODE === command &&
    environment.GITHUB_SHA === sourceCommit && environment.GITHUB_REPOSITORY === 'voyager163/liftoff' &&
    environment.GITHUB_RUN_ATTEMPT === '1', 'Report production requires its registered first-attempt explicit CI mode, not local flags or model assertions');
  positiveId(environment.GITHUB_RUN_ID, 'Report-producing workflow run ID');
  verifySourceWorktree(projectRoot, sourceCommit);
  const context = await loadReleaseContext(projectRoot, sourceCommit, await loadReleaseContracts(projectRoot, sourceCommit));
  context.qualificationRegistry = loadQualificationRegistry(context);
  requireValue(context.qualificationRegistry.operationalBlockers.length === 0, `Operational host trust is missing: ${context.qualificationRegistry.operationalBlockers.join('; ')}`);
  requireValue(context.implementationBlockers.length === 0, `Required implementation remains unavailable: ${context.implementationBlockers.join('; ')}`);
  const verification = context.scope.verification;
  const verifier = createGitHubEvidenceVerifier({ projectRoot, verification, sourceCommit, now });
  const purpose = options['--purpose'];
  const workflowKey = command === 'approve-action' ? verification.authorities?.[purpose]?.workflow :
    verification.reportProducers?.[command === 'prepare-action' ? 'approvalRequest' : 'executionQualification'];
  requireValue(typeof workflowKey === 'string' && workflowKey.length > 0, `Missing registered ${command} report-producing workflow; source contracts do not supply an operational identity`);
  const reportKind = command === 'approve-action' ? `authority-${purpose}` : command === 'prepare-action' ? 'approval-request' : 'execution-qualification';
  const policy = validateWorkflowPolicy(verification.workflows?.[workflowKey], reportKind, sourceCommit);
  const current = await verifier.api(`repos/voyager163/liftoff/actions/runs/${environment.GITHUB_RUN_ID}`);
  requireValue(current.id === Number(environment.GITHUB_RUN_ID) && current.status === 'in_progress' && current.run_attempt === 1 && current.event === 'workflow_dispatch' &&
    current.head_sha === sourceCommit && current.head_commit?.id === sourceCommit &&
    current.repository?.full_name === 'voyager163/liftoff' && current.repository.id === Number(policy.repositoryId) && current.repository.private === false &&
    current.head_repository?.full_name === 'voyager163/liftoff' && current.head_repository.id === Number(policy.repositoryId) && current.head_repository.private === false &&
    current.path === policy.path && current.workflow_id === Number(policy.workflowId) &&
    current.head_branch === policy.sourceRef.replace(/^refs\/(?:heads|tags)\//, ''), 'Report-producing dispatch is not the exact registered public workflow/source');
  requireValue(policy.signerCommit === sourceCommit, 'This direct report producer requires explicit signerSource: reviewed-source-commit (or that exact immutable signer SHA), never an inferred signer default');
  const collectionOrigin = { workflow: verification.collectionWorkflow, runId: options['--run-id'], runAttempt: Number(options['--run-attempt']) };
  const collection = await verifier.verifyOrigin(collectionOrigin, 'evidence-collection');
  requireValue(String(collection.artifact.id) === options['--artifact-id'], 'Explicit dispatch selected another evidence artifact');
  const sourceEvidence = { origin: collectionOrigin, artifactId: String(collection.artifact.id), archiveSha256: collection.artifact.digest.slice(7) };
  const relative = path.relative(projectRoot, path.resolve(projectRoot, options['--evidence'])).split(path.sep).join('/');
  const loaded = readJsonFile(projectRoot, relative);
  const evidence = loaded.value;
  requireValue(evidence.schemaVersion === 1 && evidence.kind === 'liftoff-coordinated-release-evidence' && evidence.sourceCommit === sourceCommit, 'Selected evidence index does not bind this source');
  await verifier.verifyFile(loaded.file, collectionOrigin, 'evidence-collection');
  const evidenceRoot = confinedDirectory(projectRoot, path.posix.dirname(relative));
  const trackedFiles = [];
  const { file, manifest } = await verifyNativeManifestFile(context, evidence.manifest, evidenceRoot, verifier, trackedFiles);
  exactIds(Object.keys(evidence.artifacts ?? {}), REQUIRED_NATIVE_TARGETS, 'Report-producing final artifact inventory');
  const targets = {};
  for (const target of REQUIRED_NATIVE_TARGETS) targets[target] = await verifyNativeArtifactFile(context, manifest, target, evidence.artifacts[target], evidenceRoot, verifier, trackedFiles);
  const subject = buildReleaseSubject(context, file, targets);
  let report;
  let filename;
  if (command === 'prepare-action') {
    const request = buildActionRequest(context, subject, purpose, sourceEvidence, now);
    report = releaseReport(`approval-request-${purpose}`, subject, request);
    filename = `approval-request-${purpose}.json`;
  } else if (command === 'approve-action') {
    const request = buildActionRequest(context, subject, purpose, sourceEvidence, now);
    const dispatch = await verifier.admitApprovalDispatch(purpose, environment);
    requireValue(instant(collection.run.updated_at, 'Selected evidence completion') <= instant(dispatch.run.run_started_at, 'Action dispatch start'), 'Approval must explicitly select already existing immutable evidence');
    const authorityPolicy = validateAuthorityPolicy(verification.authorities[purpose], purpose);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Math.min(Date.parse(issuedAt) + authorityPolicy.maxAgeSeconds * 1000, ...request.plans.map((plan) => instant(plan.expiresAt, 'Approved plan expiry')))).toISOString();
    report = releaseReport(`authority-${purpose}`, subject, actionApprovalReceipt(request, dispatch.actor, issuedAt, expiresAt));
    filename = `authority-${purpose}.json`;
  } else {
    const authorities = {};
    for (const action of QUALIFICATION_PURPOSES) {
      const approved = await readVerifiedReleaseReport(evidence.reports?.[`authority-${action}`], `authority-${action}`, subject, evidenceRoot, verifier, trackedFiles);
      const request = buildActionRequest(context, subject, action, approved.data.request?.sourceEvidence, now);
      await verifier.verifyAuthority(approved.data, approved.origin, approved.verifiedFile, action, request);
      authorities[action] = approved;
    }
    const qualified = await verifyQualificationExecutions({ context, subject, evidence, evidenceRoot, verifier, authorities, trackedFiles, now });
    report = releaseReport('execution-qualification', subject, qualified);
    filename = 'execution-qualification.json';
  }
  for (const tracked of trackedFiles) inspectFile(evidenceRoot, tracked.path, tracked.sha256);
  inspectFile(projectRoot, relative, loaded.file.sha256);
  verifier.assertFresh(Date.now());
  verifySourceWorktree(projectRoot, sourceCommit);
  const outputDirectory = confinedDirectory(projectRoot, 'build/source-validation/produced', true);
  fs.writeFileSync(path.join(outputDirectory, filename), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { path: `build/source-validation/produced/${filename}`, status: 'REQUIRES_TRUSTED_ATTESTATION', productionQualified: false };
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  try {
    const { command, options } = parseProducerArgs(process.argv.slice(2));
    const result = await produceReleaseEvidence(command, options);
    process.stdout.write(`${result.status}: ${result.path}. No provider execution, staging, deployment, or publication was performed.\n`);
  } catch (error) {
    process.stderr.write(`REPORT_PRODUCTION_BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, sha256 } from './release-evidence.mjs';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'voyager163/liftoff';
const ISSUER = 'https://token.actions.githubusercontent.com';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function object(value, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

export function exactKeys(value, keys, label) {
  object(value, label);
  requireValue(Object.keys(value).every((key) => keys.includes(key)), `${label} contains unsupported fields`);
}

export function positiveId(value, label) {
  requireValue(typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)), `${label} must be an exact positive integer ID string`);
  return value;
}

export function instant(value, label) {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)), `${label} must be a UTC timestamp`);
  requireValue(new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z'), `${label} contains an invalid calendar date`);
  return Date.parse(value);
}

export function validateWorkflowPolicy(policy, kind, sourceCommit) {
  object(policy, `Missing registered GitHub workflow trust for ${kind}`);
  requireValue(Array.isArray(policy.kinds) && policy.kinds.includes(kind), `Workflow is not registered to verify ${kind}`);
  positiveId(policy.repositoryId, 'Trusted repository ID');
  positiveId(policy.workflowId, 'Trusted workflow ID');
  requireValue(/^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/.test(policy.path), 'Trusted workflow path is invalid');
  requireValue(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(policy.sourceRef), 'Missing exact trusted source ref');
  requireValue(typeof policy.signerWorkflow === 'string' && policy.signerWorkflow.startsWith(`${REPOSITORY}/.github/workflows/`) && /^voyager163\/liftoff\/\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/.test(policy.signerWorkflow), 'Missing canonical trusted signer workflow');
  const usesReviewedSource = policy.signerSource === 'reviewed-source-commit';
  // An explicit source binding avoids embedding a commit's own hash inside that commit; absence is never a default.
  requireValue(usesReviewedSource ? policy.signerCommit === undefined && /^[a-f0-9]{40}$/.test(sourceCommit) : policy.signerSource === undefined && /^[a-f0-9]{40}$/.test(policy.signerCommit), 'Missing explicit immutable signer commit or registered reviewed-source-commit binding');
  requireValue(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(policy.signerRef), 'Missing exact trusted signer ref');
  requireValue(['workflow_dispatch', 'push', 'workflow_call'].includes(policy.event), 'Untrusted workflow event');
  requireValue(['github-hosted', 'self-hosted'].includes(policy.runnerEnvironment), 'Missing trusted runner environment');
  requireValue(typeof policy.artifactName === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(policy.artifactName), 'Missing exact trusted artifact name');
  requireValue(Array.isArray(policy.requiredJobs) && policy.requiredJobs.length > 0 && policy.requiredJobs.length <= 100 && new Set(policy.requiredJobs).size === policy.requiredJobs.length && policy.requiredJobs.every((name) => typeof name === 'string' && name.length > 0), 'Missing exact unique required CI job names');
  requireValue(Number.isSafeInteger(policy.maxAgeSeconds) && policy.maxAgeSeconds > 0 && policy.maxAgeSeconds <= MAX_AGE_SECONDS, 'Workflow evidence validity must be bounded to at most seven days');
  return { ...policy, signerCommit: usesReviewedSource ? sourceCommit : policy.signerCommit };
}

export function validateAuthorityPolicy(policy, purpose) {
  exactKeys(policy, ['mechanism', 'workflow', 'allowedActors', 'maxAgeSeconds'], `${purpose} authority policy`);
  requireValue(policy.mechanism === 'github-explicit-dispatch-v1' && typeof policy.workflow === 'string' && policy.workflow.length > 0, `Missing registered ${purpose} explicit action-approval mechanism`);
  requireValue(Array.isArray(policy.allowedActors) && policy.allowedActors.length > 0 && policy.allowedActors.length <= 128, `Missing registered ${purpose} maintainer/machine actor IDs`);
  const ids = new Set();
  for (const actor of policy.allowedActors) {
    exactKeys(actor, ['id', 'type', 'role'], 'Trusted action approver');
    requireValue(Number.isSafeInteger(actor.id) && actor.id > 0 && ['User', 'Bot'].includes(actor.type) && ['maintainer', 'machine'].includes(actor.role), 'Invalid trusted action-approver identity');
    requireValue(actor.role !== 'maintainer' || actor.type === 'User', 'A maintainer approval requires a registered User identity');
    requireValue(!ids.has(actor.id), 'Duplicate trusted action-approver ID');
    ids.add(actor.id);
  }
  requireValue(Number.isSafeInteger(policy.maxAgeSeconds) && policy.maxAgeSeconds > 0 && policy.maxAgeSeconds <= 86400, 'Action approval validity must be bounded to 1..86400 seconds');
  return policy;
}

async function runGh(args, cwd) {
  try {
    const result = await execFileAsync('gh', args, {
      cwd, timeout: 30_000, maxBuffer: 12 * 1024 * 1024,
      env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GitHub read-only verification failed (${error?.code ?? 'invalid response'}); check gh authentication, attestation support, and registered read permissions`);
  }
}

// Only the CLI's verified output is admitted here, never JSON supplied in an evidence file.
export function validateAttestationResults(results, file, origin, policy, sourceCommit, now) {
  requireValue(Array.isArray(results) && results.length > 0 && results.length <= 10, 'No bounded cryptographically verified attestation results');
  const invocation = `https://github.com/${REPOSITORY}/actions/runs/${origin.runId}/attempts/${origin.runAttempt}`;
  const identity = `https://github.com/${policy.signerWorkflow}@${policy.signerRef}`;
  for (const result of results) {
    const verified = result?.verificationResult;
    const cert = verified?.signature?.certificate;
    const statement = verified?.statement;
    if (
      cert?.issuer !== ISSUER ||
      cert.sourceRepositoryURI !== `https://github.com/${REPOSITORY}` ||
      cert.sourceRepositoryIdentifier !== policy.repositoryId ||
      cert.sourceRepositoryDigest !== sourceCommit ||
      cert.sourceRepositoryRef !== policy.sourceRef ||
      cert.buildSignerDigest !== policy.signerCommit ||
      cert.buildSignerURI !== identity ||
      cert.subjectAlternativeName !== identity ||
      cert.buildConfigURI !== `https://github.com/${REPOSITORY}/${policy.path}@${policy.sourceRef}` ||
      cert.buildConfigDigest !== sourceCommit ||
      cert.buildTrigger !== policy.event ||
      cert.runInvocationURI !== invocation ||
      cert.runnerEnvironment !== policy.runnerEnvironment ||
      statement?.predicateType !== PREDICATE ||
      statement?._type !== 'https://in-toto.io/Statement/v1'
    ) continue;
    if (!Array.isArray(statement.subject) || !statement.subject.some((subject) =>
      subject.name === file.name && subject.digest?.sha256 === file.sha256
    )) continue;
    const timestamps = verified.verifiedTimestamps;
    if (!Array.isArray(timestamps) || timestamps.length === 0) continue;
    const witnessed = timestamps.map((entry) => {
      try { return instant(entry.timestamp, 'Signed witness timestamp'); } catch { return NaN; }
    });
    if (!witnessed.every((timestamp) => Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= policy.maxAgeSeconds * 1000)) continue;
    return { certificate: cert, witnessedAt: Math.min(...witnessed) };
  }
  throw new Error('Verified signature does not bind the registered repository, workflow, run attempt, reviewed source, current witness, and exact subject bytes');
}

export function validateWorkflowRun(run, jobs, artifacts, origin, policy, sourceCommit, now) {
  requireValue(run?.id === Number(origin.runId) && run.run_attempt === origin.runAttempt, 'CI run ID/attempt mismatch or superseded attempt');
  requireValue(run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY && run.repository.id === Number(policy.repositoryId) && run.head_repository.id === Number(policy.repositoryId) && run.repository.private === false && run.head_repository.private === false, 'Foreign or non-public CI source repository');
  requireValue(run.head_sha === sourceCommit && run.head_commit?.id === sourceCommit, 'CI evidence is for an earlier or different source commit');
  requireValue(run.path === policy.path && run.workflow_id === Number(policy.workflowId) && run.event === policy.event, 'CI workflow identity/event mismatch');
  requireValue(run.head_branch === policy.sourceRef.replace(/^refs\/(?:heads|tags)\//, ''), 'CI source ref mismatch');
  requireValue(run.status === 'completed' && run.conclusion === 'success', 'CI run is incomplete, failed, skipped, or not successful');
  const startedAt = instant(run.run_started_at, 'CI start');
  const completedAt = instant(run.updated_at, 'CI completion');
  requireValue(startedAt <= completedAt && completedAt <= now && now - startedAt <= policy.maxAgeSeconds * 1000, 'CI evidence is old or has invalid execution times');
  requireValue(Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length <= 100, 'CI job enumeration is incomplete or exceeds the bounded limit');
  for (const name of policy.requiredJobs) {
    const matches = jobs.jobs.filter((job) => job.name === name);
    requireValue(matches.length === 1 && matches[0].run_id === run.id && matches[0].head_sha === sourceCommit && matches[0].status === 'completed' && matches[0].conclusion === 'success', `Required CI job did not execute successfully: ${name}`);
  }
  requireValue(Array.isArray(artifacts?.artifacts) && artifacts.total_count === artifacts.artifacts.length && artifacts.artifacts.length <= 100, 'CI artifact enumeration is incomplete or exceeds the bounded limit');
  const matches = artifacts.artifacts.filter((artifact) => artifact.name === policy.artifactName);
  requireValue(matches.length === 1, `Missing or ambiguous registered CI artifact: ${policy.artifactName}`);
  const artifact = matches[0];
  requireValue(artifact.expired === false && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === sourceCommit && artifact.workflow_run?.repository_id === Number(policy.repositoryId) && artifact.workflow_run?.head_repository_id === Number(policy.repositoryId), 'Expired, foreign, or mismatched CI artifact');
  requireValue(/^sha256:[0-9a-f]{64}$/.test(artifact.digest) && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 2 * 1024 ** 3, 'CI artifact lacks a bounded final-byte digest');
  requireValue(instant(artifact.created_at, 'Artifact creation') >= startedAt && instant(artifact.created_at, 'Artifact creation') <= completedAt && instant(artifact.expires_at, 'Artifact expiry') > now, 'CI artifact is stale or outside the verified run');
  return { run, artifact, jobs: jobs.jobs };
}

export function createGitHubEvidenceVerifier({ projectRoot, verification, sourceCommit, now = Date.now(), commands }) {
  const execute = commands ?? ((args) => runGh(args, projectRoot));
  const cache = new Map();
  let calls = 0;
  let validUntil = Infinity;
  async function api(endpoint) {
    requireValue(typeof endpoint === 'string' && /^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\//.test(endpoint) && !endpoint.includes('..'), 'Invalid read-only API endpoint');
    if (!cache.has(endpoint)) {
      requireValue(++calls <= 256, 'GitHub verification exceeded the 256-request bound');
      cache.set(endpoint, execute(['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint]));
    }
    return cache.get(endpoint);
  }

  async function verifyOrigin(origin, kind) {
    exactKeys(origin, ['workflow', 'runId', 'runAttempt'], 'Evidence origin');
    requireValue(typeof origin.workflow === 'string', 'Missing registered evidence workflow key');
    const policy = validateWorkflowPolicy(verification?.workflows?.[origin.workflow], kind, sourceCommit);
    positiveId(origin.runId, 'CI run ID');
    requireValue(Number.isSafeInteger(origin.runAttempt) && origin.runAttempt > 0 && origin.runAttempt <= 100, 'Invalid exact CI run attempt');
    const base = `repos/${REPOSITORY}/actions/runs/${origin.runId}`;
    const [run, attempt, jobs, artifacts] = await Promise.all([
      api(base),
      api(`${base}/attempts/${origin.runAttempt}`),
      api(`${base}/attempts/${origin.runAttempt}/jobs?per_page=100&page=1`),
      api(`${base}/artifacts?per_page=100&page=1`)
    ]);
    requireValue(run.run_attempt === origin.runAttempt && attempt.id === run.id && attempt.head_sha === run.head_sha, 'Evidence run was rerun or its attempt identity disagrees');
    const result = validateWorkflowRun(run, jobs, artifacts, origin, policy, sourceCommit, now);
    validUntil = Math.min(validUntil, instant(run.run_started_at, 'CI start') + policy.maxAgeSeconds * 1000, instant(result.artifact.expires_at, 'Artifact expiry'));
    return { ...result, policy };
  }

  async function verifyFile(file, origin, kind) {
    const verifiedRun = await verifyOrigin(origin, kind);
    const policy = verifiedRun.policy;
    const args = [
      'attestation', 'verify', file.absolutePath, '--hostname', 'github.com',
      '--repo', REPOSITORY, '--signer-repo', REPOSITORY,
      '--signer-workflow', policy.signerWorkflow, '--signer-digest', policy.signerCommit,
      '--source-digest', sourceCommit, '--source-ref', policy.sourceRef,
      '--cert-identity', `https://github.com/${policy.signerWorkflow}@${policy.signerRef}`,
      '--cert-oidc-issuer', ISSUER, '--predicate-type', PREDICATE,
      '--digest-alg', 'sha256', '--limit', '10', '--format', 'json'
    ];
    if (policy.runnerEnvironment === 'github-hosted') args.push('--deny-self-hosted-runners');
    requireValue(++calls <= 256, 'GitHub verification exceeded the 256-request bound');
    const attestation = validateAttestationResults(await execute(args), file, origin, policy, sourceCommit, now);
    requireValue(attestation.witnessedAt >= instant(verifiedRun.run.run_started_at, 'CI start') && attestation.witnessedAt <= instant(verifiedRun.run.updated_at, 'CI completion') + 60_000, 'Attestation was not witnessed during its bound CI run');
    return { ...verifiedRun, ...attestation };
  }

  async function verifyDispatchActor(run, purpose) {
    const policy = validateAuthorityPolicy(verification?.authorities?.[purpose], purpose);
    const workflow = validateWorkflowPolicy(verification.workflows?.[policy.workflow], `authority-${purpose}`, sourceCommit);
    requireValue(run.event === 'workflow_dispatch' && workflow.event === 'workflow_dispatch' && run.run_attempt === 1, 'Action approval requires an explicit first-attempt dispatch, not push, PR, rerun, or deployment review');
    requireValue(run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY && run.repository.id === Number(workflow.repositoryId) && run.head_repository.id === Number(workflow.repositoryId) && run.repository.private === false && run.head_repository.private === false, 'Action approval is not from the registered public source repository');
    requireValue(run.path === workflow.path && run.workflow_id === Number(workflow.workflowId) && run.head_sha === sourceCommit && run.head_commit?.id === sourceCommit && run.head_branch === workflow.sourceRef.replace(/^refs\/(?:heads|tags)\//, ''), 'Action approval workflow/source/ref identity mismatch');
    const actor = policy.allowedActors.find((entry) => entry.id === run.actor?.id && entry.type === run.actor?.type);
    requireValue(actor && run.triggering_actor?.id === actor.id && run.triggering_actor?.type === actor.type, 'Dispatch actor is not the exact registered maintainer/machine authority');
    const currentWorkflow = await api(`repos/${REPOSITORY}/actions/workflows/${workflow.workflowId}`);
    requireValue(currentWorkflow.id === Number(workflow.workflowId) && currentWorkflow.path === workflow.path && currentWorkflow.state === 'active', 'Registered action-approval workflow is disabled, changed, or revoked');
    if (actor.role === 'maintainer') {
      requireValue(typeof run.actor.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(run.actor.login), 'Invalid maintainer login returned by GitHub');
      const permission = await api(`repos/${REPOSITORY}/collaborators/${run.actor.login}/permission`);
      requireValue(permission.user?.id === actor.id && ['admin', 'maintain'].includes(permission.role_name ?? permission.permission), 'Dispatch actor no longer has the registered maintainer role');
    }
    return { id: actor.id, type: actor.type };
  }

  async function admitApprovalDispatch(purpose, environment) {
    requireValue(environment.GITHUB_ACTIONS === 'true' && environment.LIFTOFF_RELEASE_MODE === 'approve-action' && environment.LIFTOFF_APPROVAL_PURPOSE === purpose, 'Only the registered explicit approve-action dispatch can issue a receipt; local/model flags are not authority');
    positiveId(environment.GITHUB_RUN_ID, 'Issuing workflow run ID');
    requireValue(environment.GITHUB_RUN_ATTEMPT === '1' && environment.GITHUB_SHA === sourceCommit && environment.GITHUB_REPOSITORY === REPOSITORY, 'Issuing action context does not match the immutable first-attempt source');
    const run = await api(`repos/${REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`);
    requireValue(run.id === Number(environment.GITHUB_RUN_ID) && run.status === 'in_progress', 'Approval receipts can only be produced by their currently executing registered dispatch');
    const actor = await verifyDispatchActor(run, purpose);
    return { actor, run };
  }

  async function verifyAuthority(receipt, origin, verifiedFile, purpose, expectedRequest) {
    const policy = validateAuthorityPolicy(verification?.authorities?.[purpose], purpose);
    exactKeys(receipt, ['schemaVersion', 'mechanism', 'intent', 'purpose', 'request', 'requestSha256', 'actor', 'issuedAt', 'expiresAt'], 'Action approval receipt');
    requireValue(receipt.schemaVersion === 2 && receipt.mechanism === policy.mechanism && receipt.intent === 'authorize-exact-request', 'Legacy, reviewer-gate, or self-asserted approval is not Liftoff action authority');
    requireValue(origin.workflow === policy.workflow && origin.runAttempt === 1 && receipt.purpose === purpose, `${purpose} authority must bind its exact registered dispatch`);
    const expectedDigest = sha256(canonicalJson(expectedRequest));
    requireValue(receipt.requestSha256 === expectedDigest && sha256(canonicalJson(receipt.request)) === expectedDigest, `${purpose} approval does not bind the exact release/manifest/plan/effect set`);
    const actor = await verifyDispatchActor(verifiedFile.run, purpose);
    exactKeys(receipt.actor, ['id', 'type'], 'Receipt actor identity');
    requireValue(receipt.actor.id === actor.id && receipt.actor.type === actor.type, 'Caller actor claims do not match authenticated dispatch authority');
    const source = expectedRequest.sourceEvidence;
    requireValue(source.origin?.workflow === verification.collectionWorkflow, 'Approval did not select the registered source-evidence collection');
    const collection = await verifyOrigin(source.origin, 'evidence-collection');
    requireValue(String(collection.artifact.id) === source.artifactId && collection.artifact.digest === `sha256:${source.archiveSha256}`, 'Approval selected a different source-evidence artifact');
    const issuedAt = instant(receipt.issuedAt, 'Authority issuedAt');
    const expiresAt = instant(receipt.expiresAt, 'Authority expiresAt');
    requireValue(issuedAt <= now && expiresAt > now && expiresAt > issuedAt && expiresAt - issuedAt <= policy.maxAgeSeconds * 1000 && now - issuedAt <= policy.maxAgeSeconds * 1000 && issuedAt >= instant(verifiedFile.run.run_started_at, 'Authority run start') && issuedAt <= verifiedFile.witnessedAt, 'Authority is old, expired, future-dated, or outside its authenticated run');
    requireValue(instant(collection.run.updated_at, 'Source collection completion') <= instant(verifiedFile.run.run_started_at, 'Approval dispatch start'), 'Action approval was dispatched before its exact source-evidence artifact existed');
    validUntil = Math.min(validUntil, expiresAt);
    for (const plan of expectedRequest.plans) validUntil = Math.min(validUntil, instant(plan.expiresAt, 'Approved qualification plan expiry'));
    return { actor, requestSha256: expectedDigest, issuedAt: receipt.issuedAt, expiresAt: receipt.expiresAt };
  }

  function assertFresh(at = Date.now()) {
    requireValue(Number.isFinite(validUntil) && at < validUntil, 'Evidence or authority expired during verification; fresh qualification/approval is required');
    return { validUntil: new Date(validUntil).toISOString() };
  }

  return { api, verifyOrigin, verifyFile, verifyAuthority, admitApprovalDispatch, assertFresh };
}

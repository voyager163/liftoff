import {
  canonicalJson, CANONICAL_REPOSITORY, exactIds, inspectFile, readJsonFile, same, sha256
} from './release-evidence.mjs';
import { exactKeys, instant, object, positiveId, requireValue, validateWorkflowPolicy } from './release-evidence-github.mjs';
import { gatewayImageTestRequest, TELEMETRY_CONTRACT_PATH, TELEMETRY_PROFILE_ID, validateGatewayRegistration } from './release-telemetry-gateway.mjs';

export const ACTION_APPROVAL_MECHANISM = 'github-explicit-dispatch-v1';
export const ACTION_PURPOSES = ['publication', 'liveQualification', 'dashboard', 'telemetryGateway'];
export const QUALIFICATION_PURPOSES = ACTION_PURPOSES.filter((purpose) => purpose !== 'publication');
export const QUALIFICATION_OUTCOMES = ['success', 'failure', 'recovery'];
const OPERATIONS = {
  local: ['read-worktree', 'write-activation-state', 'write-evidence', 'write-openspec-seed', 'write-seed-tasks',
    'project-governance-tasks', 'write-openspec-governance', 'write-local-state', 'delete-local-state',
    'write-workflows', 'write-ruleset-source', 'write-credential-policy', 'git-commit', 'git-remote-bind',
    'backend-state-read', 'backend-state-write', 'qualify-gateway-image'],
  github: ['git-push', 'github-read', 'github-write', 'github-repository-create', 'github-workflow-dispatch',
    'github-secret-write', 'github-ruleset-write', 'registry-publish'],
  azure: ['azure-read', 'azure-provider-register', 'azure-network-provision', 'azure-state-import',
    'azure-resource-provision', 'backend-state-read', 'backend-state-write', 'registry-publish', 'azure-dashboard-write']
};
const READBACK_OPERATIONS = { local: ['read-worktree'], github: ['github-read'], azure: ['azure-read', 'backend-state-read'] };

function identifier(value, label) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,191}$/.test(value) && !value.includes('..'), `${label} requires an exact registered identity`);
}

function sourceReference(context, reference, label) {
  exactKeys(reference, ['path', 'sha256'], label);
  requireValue(/^(src|scripts|assets|infrastructure|services)\//.test(reference.path), `${label} must name reviewed repository source`);
  inspectFile(context.projectRoot, reference.path, reference.sha256, 32 * 1024 * 1024);
}

export function loadQualificationRegistry(context) {
  const raw = context.scope.verification?.qualificationRegistry;
  const phaseIds = context.contracts.graph.phases.map((phase) => phase.id);
  requireValue(raw !== null && raw !== undefined, `Missing canonical producer/provider/execution-host/recipe/profile registrations for: ${phaseIds.join(', ')}; operator-dashboard; telemetry-gateway. This is missing registration/producer code, not missing publication approval`);
  exactKeys(raw, ['schemaVersion', 'profiles', 'hosts', 'recipes', 'producers', 'dashboard', 'telemetryGateway'], 'Qualification registry');
  requireValue(raw.schemaVersion === 1, 'Unsupported qualification registry schema');
  for (const key of ['profiles', 'hosts', 'recipes', 'producers']) object(raw[key], `Qualification ${key}`);
  exactIds(Object.keys(raw.producers), phaseIds, 'Canonical production producer registrations');
  const operationalBlockers = [];
  for (const [id, profile] of Object.entries(raw.profiles)) {
    identifier(id, 'Profile ID');
    exactKeys(profile, ['kind', 'source'], `Profile ${id}`);
    requireValue(['standards', 'governance', 'operator', 'telemetry'].includes(profile.kind), `Unknown qualification profile kind: ${id}`);
    if (profile.kind === 'standards') requireValue(Object.hasOwn(context.profiles.profiles, id) && profile.source?.path === 'assets/profiles/catalog.json', `Unregistered standards profile: ${id}`);
    if (profile.kind === 'governance') requireValue(id === 'single-maintainer-gitflow' && profile.source?.path === 'assets/governance/single-maintainer-gitflow/policy.md', 'Unregistered governance profile identity');
    if (profile.kind === 'operator') requireValue(id === context.dashboard.id && profile.source?.path === 'infrastructure/opentofu/telemetry/dashboard.json', 'Unregistered operator profile identity');
    if (profile.kind === 'telemetry') requireValue(id === TELEMETRY_PROFILE_ID && profile.source?.path === TELEMETRY_CONTRACT_PATH, 'Unregistered shared telemetry contract profile');
    sourceReference(context, profile.source, `Profile ${id} source`);
  }
  for (const [id, host] of Object.entries(raw.hosts)) {
    identifier(id, 'Execution host ID');
    exactKeys(host, ['workflow', 'job', 'runnerLabels', 'runnerEnvironment', 'role'], `Execution host ${id}`);
    requireValue(['executor', 'verifier'].includes(host.role), `Unknown host role: ${id}`);
    identifier(host.workflow, `Host ${id} workflow key`);
    requireValue(typeof host.job === 'string' && host.job.length > 0 && ['github-hosted', 'self-hosted'].includes(host.runnerEnvironment), `Host ${id} lacks its explicit job/runner contract`);
    try {
      const policy = validateWorkflowPolicy(context.scope.verification.workflows?.[host.workflow], host.role === 'executor' ? 'qualification-execution' : 'qualification-case', context.sourceCommit);
      requireValue(policy.requiredJobs.includes(host.job) && policy.runnerEnvironment === host.runnerEnvironment, `Host ${id} workflow/job/environment is not registered`);
    } catch (error) {
      operationalBlockers.push(`Host ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    requireValue(Array.isArray(host.runnerLabels) && host.runnerLabels.length > 0 && host.runnerLabels.length <= 10, `Missing runner labels for ${id}`);
    exactIds(host.runnerLabels, host.runnerLabels, `Host ${id} runner labels`);
  }
  const groups = [...context.contracts.graph.phases.map((phase) => ({
    id: phase.id, digest: context.contracts.phaseDigests[phase.id], registration: raw.producers[phase.id],
    operations: [...phase.allowedMutations.local, ...phase.allowedMutations.remote].filter((operation) => operation !== 'none'),
    providers: phase.evidence.liveReadbackProviders.length ? phase.evidence.liveReadbackProviders : ['local'],
    recoveryRequired: phase.rollback.kind !== 'none', purpose: 'liveQualification'
  })), { id: 'operator-dashboard', digest: context.dashboard.sha256, registration: raw.dashboard,
    operations: ['azure-read', 'azure-dashboard-write'], providers: ['azure'], recoveryRequired: true, purpose: 'dashboard' },
  { id: 'telemetry-gateway', digest: context.telemetry.sha256, registration: raw.telemetryGateway,
    operations: ['azure-read', 'read-worktree', 'qualify-gateway-image'], providers: ['azure'], recoveryRequired: false, purpose: 'telemetryGateway' }];
  const cases = [];
  for (const group of groups) {
    const registration = group.registration;
    exactKeys(registration, ['contractDigest', 'cases'], `Producer ${group.id} registration`);
    requireValue(registration.contractDigest === group.digest, `Stale producer contract digest: ${group.id}`);
    requireValue(Array.isArray(registration.cases) && registration.cases.length > 0, `Missing explicit qualification cases for ${group.id}`);
    exactIds([...new Set(registration.cases.map((row) => row.provider))], group.providers, `Producer ${group.id} canonical readback provider coverage`);
    const combinations = new Map();
    for (const row of registration.cases) {
      exactKeys(row, ['id', 'provider', 'executionHost', 'recipe', 'profile', 'outcome'], `Producer ${group.id} case`);
      identifier(row.id, 'Case ID');
      for (const key of ['executionHost', 'recipe', 'profile']) identifier(row[key], `Case ${row.id} ${key}`);
      requireValue(Object.hasOwn(OPERATIONS, row.provider) && QUALIFICATION_OUTCOMES.includes(row.outcome), `Unknown provider/outcome for case ${row.id}`);
      const recipe = object(raw.recipes[row.recipe], `Missing recipe registration: ${row.recipe}`);
      exactKeys(recipe, ['producer', 'provider', 'source', 'verifierSource', 'verificationHost', 'operations', 'verificationOperations'], `Recipe ${row.recipe}`);
      requireValue(recipe.producer === group.id && recipe.provider === row.provider, `Case ${row.id} uses another producer/provider recipe`);
      sourceReference(context, recipe.source, `Recipe ${row.recipe} executor`);
      sourceReference(context, recipe.verifierSource, `Recipe ${row.recipe} independent verifier`);
      exactIds(recipe.operations, recipe.operations, `Recipe ${row.recipe} operations`);
      requireValue(recipe.operations.length > 0 && recipe.operations.every((operation) => group.operations.includes(operation)), `Recipe ${row.recipe} widens the canonical producer's effects`);
      exactIds(recipe.verificationOperations, recipe.verificationOperations, `Recipe ${row.recipe} verification operations`);
      requireValue(recipe.verificationOperations.length > 0 && recipe.verificationOperations.every((operation) => [...READBACK_OPERATIONS[row.provider], ...READBACK_OPERATIONS.local].includes(operation)), `Recipe ${row.recipe} requires an explicit read-only independent verifier`);
      requireValue(raw.hosts[row.executionHost]?.role === 'executor' && raw.hosts[recipe.verificationHost]?.role === 'verifier', `Case ${row.id} lacks registered execution/verification hosts`);
      requireValue(Object.hasOwn(raw.profiles, row.profile), `Case ${row.id} uses an unregistered profile`);
      if (group.purpose === 'dashboard') requireValue(raw.profiles[row.profile].kind === 'operator' && row.provider === 'azure', 'Dashboard qualification must use its exact registered operator profile/provider');
      if (group.purpose === 'telemetryGateway') requireValue(raw.profiles[row.profile].kind === 'telemetry' && row.provider === 'azure', 'Deployed gateway qualification must use the shared telemetry contract profile and Azure operator scope');
      const tuple = canonicalJson([row.provider, row.executionHost, row.recipe, row.profile]);
      const outcomes = combinations.get(tuple) ?? [];
      outcomes.push(row.outcome);
      combinations.set(tuple, outcomes);
      cases.push({ ...row, producer: group.id, contractDigest: group.digest, purpose: group.purpose });
    }
    for (const outcomes of combinations.values()) {
      const required = group.recoveryRequired ? QUALIFICATION_OUTCOMES : ['success', 'failure'];
      exactIds(outcomes, outcomes.includes('recovery') ? QUALIFICATION_OUTCOMES : required, `Producer ${group.id} registered combination outcomes`);
    }
  }
  requireValue(cases.length <= 1000, 'Qualification registry exceeds the 1000-case bound; reviewed batching is required');
  exactIds(cases.map((row) => row.id), cases.map((row) => row.id), 'Canonical qualification cases');
  exactIds(Object.keys(raw.recipes), [...new Set(cases.map((row) => row.recipe))], 'Registered recipes');
  return { ...raw, cases, sha256: sha256(canonicalJson(raw)), operationalBlockers };
}

export function validateEffect(effect, row, registry) {
  exactKeys(effect, ['id', 'stage', 'type', 'operation', 'target', 'requestSha256'], `Case ${row.id} effect`);
  identifier(effect.id, 'Effect ID');
  requireValue(Object.hasOwn(OPERATIONS, effect.type) && OPERATIONS[effect.type].includes(effect.operation), `Unknown typed effect operation for ${row.id}`);
  requireValue(['execution', 'verification'].includes(effect.stage), 'Effect must identify its execution or independent verification stage');
  const operations = effect.stage === 'execution' ? registry.recipes[row.recipe].operations : registry.recipes[row.recipe].verificationOperations;
  requireValue((effect.type === row.provider || effect.type === 'local') && operations.includes(effect.operation), `Effect exceeds registered producer/provider/recipe scope: ${row.id}`);
  requireValue(typeof effect.requestSha256 === 'string' && /^[a-f0-9]{64}$/.test(effect.requestSha256), `Effect ${effect.id} lacks an immutable exact request digest`);
  if (effect.type === 'local') {
    exactKeys(effect.target, ['rootId', 'path'], 'Local effect target');
    identifier(effect.target.rootId, 'Disposable local root identity');
    requireValue(typeof effect.target.path === 'string' && effect.target.path.length > 0 && !effect.target.path.startsWith('/') && !/[\\:*?\u0000-\u001f]/.test(effect.target.path) && effect.target.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[ .]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Local effects require exact native-safe relative paths, not aliases/prefixes/globs');
  } else if (effect.type === 'github') {
    exactKeys(effect.target, ['repository', 'kind', 'id'], 'GitHub effect target');
    requireValue(typeof effect.target.repository === 'string' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(effect.target.repository) && !effect.target.repository.split('/').some((part) => part === '.' || part === '..') && effect.target.repository.toLowerCase() !== CANONICAL_REPOSITORY, 'Qualification requires an explicit disposable GitHub target, never the release repository');
    requireValue(['repository', 'workflow', 'ref', 'ruleset', 'check', 'release', 'registry'].includes(effect.target.kind), 'Unknown GitHub effect target kind');
    identifier(effect.target.id, 'GitHub resource identity');
  } else {
    exactKeys(effect.target, ['resourceId'], 'Azure effect target');
    requireValue(typeof effect.target.resourceId === 'string' && /^\/subscriptions\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\/(?:resourceGroups\/[A-Za-z0-9_.()-]+\/)?providers\/[A-Za-z0-9.]+(?:\/[A-Za-z0-9_.()-]+)*$/.test(effect.target.resourceId) && !effect.target.resourceId.split('/').some((part) => part === '.' || part === '..'), 'Azure effects require exact ARM resource identities, not wildcard/subscription-wide scope');
    if (effect.operation === 'azure-dashboard-write') requireValue(/\/providers\/Microsoft\.Dashboard\/dashboards\/[^/]+$/.test(effect.target.resourceId), 'Dashboard mutation cannot target ingestion, storage, roles, or another resource type');
  }
  return effect;
}

export function qualificationPlans(context, registry, purpose, now) {
  requireValue(QUALIFICATION_PURPOSES.includes(purpose), 'Invalid qualification purpose');
  const plans = context.scope.verification?.qualificationPlans?.[purpose];
  requireValue(Array.isArray(plans) && plans.length > 0 && plans.length <= 100, `Missing bounded ${purpose} action plans`);
  exactIds(plans.map((plan) => plan.id), plans.map((plan) => plan.id), `${purpose} plans`);
  const covered = [];
  for (const plan of plans) {
    exactKeys(plan, ['schemaVersion', 'id', 'purpose', 'entries', 'maxCost', 'maxDurationSeconds', 'notBefore', 'expiresAt', 'retention'], `${purpose} plan`);
    requireValue(plan.schemaVersion === 2 && plan.purpose === purpose, 'Legacy/untyped qualification plans cannot authorize execution');
    identifier(plan.id, 'Plan ID');
    exactKeys(plan.maxCost, ['minorUnits', 'currency'], 'Qualification cost budget');
    requireValue(Number.isSafeInteger(plan.maxCost.minorUnits) && plan.maxCost.minorUnits >= 0 && /^[A-Z]{3}$/.test(plan.maxCost.currency), 'Qualification requires an exact nonnegative integer minor-unit budget/currency');
    requireValue(Number.isSafeInteger(plan.maxDurationSeconds) && plan.maxDurationSeconds > 0 && plan.maxDurationSeconds <= 86400, 'Qualification duration must be bounded to 1..86400 seconds');
    requireValue(instant(plan.notBefore, 'Plan notBefore') < instant(plan.expiresAt, 'Plan expiry') && instant(plan.expiresAt, 'Plan expiry') > now, 'Qualification plan is expired or has an invalid validity interval');
    requireValue(plan.retention === 'retain-evidence-and-separately-approve-recovery', 'Qualification cannot authorize implicit cleanup or broaden recovery');
    requireValue(Array.isArray(plan.entries) && plan.entries.length > 0, `Plan ${plan.id} has no explicit case/effect entries`);
    for (const entry of plan.entries) {
      exactKeys(entry, ['caseId', 'principals', 'effects', 'expectedEffectIds'], `Plan ${plan.id} entry`);
      const row = registry.cases.find((candidate) => candidate.id === entry.caseId);
      requireValue(row?.purpose === purpose, `Unknown or cross-purpose plan case: ${entry.caseId}`);
      exactKeys(entry.principals, ['execution', 'verification'], 'Qualification acting principals');
      requireValue(['execution', 'verification'].every((stage) => typeof entry.principals[stage] === 'string' && entry.principals[stage].length > 0 && entry.principals[stage].length <= 256 && !/[\u0000-\u001f]/.test(entry.principals[stage])), `Case ${entry.caseId} lacks its explicit execution/verification principals`);
      requireValue(Array.isArray(entry.effects) && entry.effects.length > 0 && entry.effects.length <= 100, `Case ${entry.caseId} lacks bounded typed effects`);
      for (const effect of entry.effects) validateEffect(effect, row, registry);
      const effectIds = entry.effects.map((effect) => effect.id);
      exactIds(effectIds, effectIds, `Case ${entry.caseId} effects`);
      exactIds(entry.expectedEffectIds, entry.expectedEffectIds, `Case ${entry.caseId} expected observed effects`);
      requireValue(entry.expectedEffectIds.every((id) => effectIds.includes(id)), 'Expected outcome includes an unapproved effect');
      requireValue(entry.effects.some((effect) => effect.stage === 'verification' && effect.type === row.provider && entry.expectedEffectIds.includes(effect.id)), `Case ${row.id} has no explicit expected provider readback effect`);
      if (purpose === 'telemetryGateway') {
        const gateway = validateGatewayRegistration(context.scope.verification.telemetryGateway);
        const imageRequestSha256 = sha256(canonicalJson(gatewayImageTestRequest(context)));
        requireValue(entry.effects.some((effect) => effect.operation === 'qualify-gateway-image' && effect.stage === 'execution' &&
          effect.requestSha256 === imageRequestSha256 && entry.expectedEffectIds.includes(effect.id)), 'Gateway qualification must explicitly authorize the exact isolated image/contract tests');
        requireValue(entry.effects.every((effect) => effect.type !== 'azure' || effect.operation === 'azure-read' &&
          [gateway.resourceId, `${gateway.resourceId}/revisions/${gateway.revision}`].includes(effect.target.resourceId)),
        'Gateway compatibility approval is read-only for the exact app/revision; it cannot deploy, query ingestion data, or send production events');
      }
      if (row.outcome === 'success') same(entry.expectedEffectIds, effectIds, 'Successful qualification must observe every exact planned effect');
      covered.push(row.id);
    }
  }
  exactIds(covered, registry.cases.filter((row) => row.purpose === purpose).map((row) => row.id), `Complete ${purpose} plan-to-case coverage`);
  return plans;
}

export function buildActionRequest(context, subject, purpose, sourceEvidence, now) {
  requireValue(ACTION_PURPOSES.includes(purpose), 'Unknown action approval purpose');
  exactKeys(sourceEvidence, ['origin', 'artifactId', 'archiveSha256'], 'Approval source evidence');
  positiveId(sourceEvidence.artifactId, 'Approval source artifact ID');
  requireValue(/^[a-f0-9]{64}$/.test(sourceEvidence.archiveSha256), 'Approval source artifact lacks exact final bytes');
  const releaseSubjectSha256 = sha256(canonicalJson(subject));
  const plans = purpose === 'publication' ? [] : qualificationPlans(context, context.qualificationRegistry, purpose, now);
  const effects = purpose === 'publication' ? [
    { operation: 'promote-native-stable', repository: CANONICAL_REPOSITORY, tag: `v${subject.version}`, manifestSha256: subject.manifestSha256, artifacts: Object.fromEntries(Object.entries(subject.targets).map(([target, identity]) => [target, identity.artifactSha256])) },
    { operation: 'announce-coordinated-release', repository: CANONICAL_REPOSITORY, version: subject.version, releaseSubjectSha256 }
  ] : plans.flatMap((plan) => plan.entries.map((entry) => ({ planId: plan.id, ...entry })));
  return { schemaVersion: 2, purpose, releaseSubjectSha256, qualificationRegistrySha256: context.qualificationRegistry.sha256, sourceEvidence, plans, effects };
}

function registeredJob(verified, host, jobId, label) {
  positiveId(jobId, `${label} job ID`);
  requireValue(verified.policy.requiredJobs.includes(host.job) && verified.policy.runnerEnvironment === host.runnerEnvironment, `${label} workflow/host contract mismatch`);
  const matches = verified.jobs.filter((job) => job.id === Number(jobId) && job.name === host.job);
  requireValue(matches.length === 1 && host.runnerLabels.every((value) => matches[0].labels?.includes(value)) && Number.isSafeInteger(matches[0].runner_id) && matches[0].runner_id > 0, `${label} did not run on the registered execution host/job`);
  const job = matches[0];
  requireValue(instant(job.started_at, `${label} job start`) >= instant(verified.run.run_started_at, `${label} run start`) &&
    instant(job.started_at, `${label} job start`) <= instant(job.completed_at, `${label} job completion`) &&
    instant(job.completed_at, `${label} job completion`) <= instant(verified.run.updated_at, `${label} run completion`), `${label} job chronology is invalid`);
  return job;
}

export async function verifyQualificationExecutions({ context, subject, evidence, evidenceRoot, verifier, authorities, trackedFiles = [], now }) {
  const registry = context.qualificationRegistry;
  object(registry, 'Missing canonical qualification registry');
  requireValue(registry.operationalBlockers.length === 0, `Operational host trust is missing: ${registry.operationalBlockers.join('; ')}`);
  const allPlans = QUALIFICATION_PURPOSES.flatMap((purpose) => qualificationPlans(context, registry, purpose, now));
  const pointers = evidence.executionReports;
  requireValue(Array.isArray(pointers) && pointers.length > 0 && pointers.length <= 32, 'Missing bounded authenticated execution report batches');
  exactIds(pointers.map((pointer) => pointer.path), pointers.map((pointer) => pointer.path), 'Execution report files');
  const binding = { product: subject.product, version: subject.version, repository: subject.repository, sourceCommit: subject.sourceCommit, releaseSubjectSha256: sha256(canonicalJson(subject)) };
  const results = [];
  const totals = new Map();
  for (const pointer of pointers) {
    exactKeys(pointer, ['path', 'sha256', 'origin'], 'Execution report pointer');
    const { file, value: report } = readJsonFile(evidenceRoot, pointer.path, pointer.sha256);
    trackedFiles.push(file);
    exactKeys(report, ['schemaVersion', 'kind', 'binding', 'cases'], 'Measured execution batch');
    requireValue(report.schemaVersion === 1 && report.kind === 'liftoff-qualification-executions' && Array.isArray(report.cases) && report.cases.length > 0 && report.cases.length <= 1000, 'Unsupported or empty measured execution report');
    same(report.binding, binding, 'Execution report exact release subject');
    const observation = await verifier.verifyFile(file, pointer.origin, 'qualification-case');
    for (const measured of report.cases) {
      exactKeys(measured, ['case', 'planId', 'approvalSha256', 'execution', 'verificationJobId', 'startedAt', 'completedAt', 'principals', 'effects', 'outcome', 'cost'], 'Measured qualification case');
      const row = registry.cases.find((candidate) => candidate.id === measured.case?.id);
      requireValue(row, `Unregistered measured case: ${measured.case?.id}`);
      same(measured.case, row, `Producer/provider/host/recipe/profile/outcome tuple ${row.id}`);
      const plan = allPlans.find((candidate) => candidate.id === measured.planId);
      const entry = plan?.entries.find((candidate) => candidate.caseId === row.id);
      requireValue(entry, `Case ${row.id} was not authorized by this exact plan`);
      const authority = authorities[row.purpose];
      requireValue(authority && measured.approvalSha256 === authority.file.sha256, `Case ${row.id} lacks its exact authenticated pre-execution approval receipt`);
      const host = registry.hosts[row.executionHost];
      const verificationHost = registry.hosts[registry.recipes[row.recipe].verificationHost];
      requireValue(measured.execution?.origin?.workflow === host.workflow && pointer.origin.workflow === verificationHost.workflow, `Case ${row.id} uses an unregistered executor/verifier workflow`);
      exactKeys(measured.execution, ['origin', 'jobId'], 'Execution run reference');
      const execution = await verifier.verifyOrigin(measured.execution.origin, 'qualification-execution');
      const job = registeredJob(execution, host, measured.execution.jobId, `Case ${row.id} execution`);
      const verificationJob = registeredJob(observation, verificationHost, measured.verificationJobId, `Case ${row.id} independent verification`);
      requireValue(job.id !== verificationJob.id && instant(verificationJob.started_at, 'Readback job start') >= instant(job.completed_at, 'Execution job completion'), `Case ${row.id} has no independent post-execution verification job`);
      requireValue(instant(measured.startedAt, 'Reported execution start') === instant(job.started_at, 'Actual execution start'), `Case ${row.id} actual execution start mismatch`);
      requireValue(instant(measured.completedAt, 'Reported execution completion') === instant(job.completed_at, 'Actual execution completion'), `Case ${row.id} actual execution completion mismatch`);
      const startedAt = instant(job.started_at, 'Measured execution start');
      const completedAt = instant(job.completed_at, 'Measured execution completion');
      const verificationCompletedAt = instant(verificationJob.completed_at, 'Independent verification completion');
      const approvedAt = Math.max(authority.verifiedFile.witnessedAt, instant(authority.verifiedFile.run.updated_at, 'Approval workflow completion'));
      requireValue(startedAt >= approvedAt && startedAt >= instant(plan.notBefore, 'Plan notBefore'), `Case ${row.id} executed before its exact action approval or permitted start`);
      requireValue(verificationCompletedAt <= instant(authority.data.expiresAt, 'Approval expiry') && verificationCompletedAt <= instant(plan.expiresAt, 'Plan expiry') &&
        completedAt <= observation.witnessedAt && instant(verificationJob.started_at, 'Verification start') <= observation.witnessedAt && verificationCompletedAt <= now, `Case ${row.id} exceeded approval/plan validity or was verified before completion`);
      requireValue(verificationCompletedAt - startedAt <= plan.maxDurationSeconds * 1000, `Case ${row.id} exceeded its actual execution and verification time bound`);
      same(measured.principals, entry.principals, `Case ${row.id} execution/verification principals`);
      requireValue(measured.outcome === row.outcome, `Case ${row.id} measured outcome differs from the approved case`);
      requireValue(Array.isArray(measured.effects), `Case ${row.id} lacks measured effects`);
      for (const effect of measured.effects) validateEffect(effect, row, registry);
      same(measured.effects, entry.expectedEffectIds.map((id) => entry.effects.find((effect) => effect.id === id)), `Case ${row.id} actual observed effect inventory`);
      exactKeys(measured.cost, ['minorUnits', 'currency'], 'Measured execution cost');
      requireValue(Number.isSafeInteger(measured.cost.minorUnits) && measured.cost.minorUnits >= 0 && measured.cost.currency === plan.maxCost.currency, `Case ${row.id} lacks valid independent cost measurements`);
      const total = totals.get(plan.id) ?? { cost: 0n, start: startedAt, end: verificationCompletedAt };
      total.cost += BigInt(measured.cost.minorUnits);
      total.start = Math.min(total.start, startedAt);
      total.end = Math.max(total.end, verificationCompletedAt);
      totals.set(plan.id, total);
      results.push({ caseId: row.id, planId: plan.id, approvalSha256: authority.file.sha256, evidenceSha256: file.sha256,
        executionRunId: measured.execution.origin.runId, executionJobId: measured.execution.jobId,
        verificationRunId: pointer.origin.runId, verificationJobId: measured.verificationJobId,
        startedAt: measured.startedAt, completedAt: measured.completedAt, verificationCompletedAt: verificationJob.completed_at, outcome: measured.outcome,
        effectsSha256: sha256(canonicalJson(measured.effects)), cost: measured.cost });
    }
  }
  exactIds(results.map((result) => result.caseId), registry.cases.map((row) => row.id), 'Exact measured producer/provider/host/recipe/profile coverage');
  for (const plan of allPlans) {
    const total = totals.get(plan.id);
    requireValue(total && total.cost <= BigInt(plan.maxCost.minorUnits), `Plan ${plan.id} exceeded its aggregate cost budget`);
    requireValue(total.end - total.start <= plan.maxDurationSeconds * 1000, `Plan ${plan.id} exceeded its aggregate elapsed-time budget`);
  }
  return { schemaVersion: 1, qualificationRegistrySha256: registry.sha256, cases: results.sort((a, b) => a.caseId.localeCompare(b.caseId)) };
}

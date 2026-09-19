import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { extractWorkflowReport } from '../../adapters/github/workflow-report-archive.js';
import { type WorkflowRunBinding } from '../../adapters/github/workflow-dispatch.js';
import { type BoundWorkflowJob } from '../../adapters/github/production-checks.js';
import {
  qualificationFailure, qualificationInteger, qualificationObject, qualificationText, qualificationTimestamp, providerQualificationTimestamp,
  type QualificationEnvironment
} from './qualification-authority.js';
import { qualificationDigest } from './qualification-evidence.js';

export const environmentRuntimeReportFile = 'liftoff-environment-runtime.json';
export const environmentRuntimeJob = 'Liftoff environment runtime observation';
export const environmentRuntimeStep = 'Observe actual runtime';
export const environmentRuntimeUploadStep = 'Retain bounded runtime observation';
export const environmentRuntimeJobTimeoutMinutes = 5;

export interface EnvironmentRuntimeRecipe {
  workflowPath: string;
  environment: QualificationEnvironment;
  resourceId: string;
  fqdn: string;
  healthPath: string;
  schemaPath: string;
  runner: { group: string; label: string };
  uploadArtifactActionSha: string;
}

export function environmentRuntimeRecipe(value: unknown): EnvironmentRuntimeRecipe {
  const data = qualificationObject(value, [
    'workflowPath', 'environment', 'resourceId', 'fqdn', 'healthPath', 'schemaPath', 'runner', 'uploadArtifactActionSha'
  ], 'Registered environment observation recipe');
  const runner = qualificationObject(data.runner, ['group', 'label'], 'Stable observation runner routing');
  const workflowPath = qualificationText(data.workflowPath, 'Environment workflow path');
  const fqdn = qualificationText(data.fqdn, 'Runtime hostname');
  const healthPath = qualificationText(data.healthPath, 'Health path');
  const schemaPath = qualificationText(data.schemaPath, 'Schema path');
  const resourceId = qualificationText(data.resourceId, 'Runtime resource');
  if (data.environment !== 'dev' && data.environment !== 'staging' && data.environment !== 'prod' ||
    !/^\.github\/workflows\/liftoff-environment-[a-z0-9-]+\.yml$/u.test(workflowPath) ||
    !/^[a-z0-9][a-z0-9.-]{1,200}\.azurecontainerapps\.io$/u.test(fqdn) || fqdn.includes('..') ||
    ![healthPath, schemaPath].every((path) => /^\/[A-Za-z0-9_./-]{1,200}$/u.test(path) &&
      !path.includes('//') && !path.split('/').some((part) => part === '.' || part === '..')) ||
    healthPath === schemaPath ||
    !/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.App\/containerApps\/[a-z0-9-]+$/u.test(resourceId)) {
    qualificationFailure('environment-runtime-recipe', 'Runtime observations require an exact declared environment, Container App HTTPS hostname and distinct canonical health/schema paths.');
  }
  const group = qualificationText(runner.group, 'Runner group');
  const label = qualificationText(runner.label, 'Runner label');
  if (![group, label].every((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(name))) {
    qualificationFailure('environment-runtime-recipe', 'Runtime observations require exact dedicated runner group and label names.');
  }
  return {
    workflowPath, environment: data.environment, resourceId, fqdn, healthPath, schemaPath,
    runner: { group, label },
    uploadArtifactActionSha: sourceSha(data.uploadArtifactActionSha, 'Pinned artifact upload action')
  };
}

const runtimeProbe = String.raw`import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const recipe = JSON.parse(process.env.LIFTOFF_RUNTIME_RECIPE);
const require = (condition) => { if (!condition) throw new Error('Runtime observation failed.'); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (url, headers = {}) => {
  const response = await fetch(url, {headers, redirect:'error', signal:AbortSignal.timeout(15000)});
  require(response.status === 200 && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json');
  let size = 0;
  const chunks = [];
  require(response.body !== null);
  for await (const chunk of response.body) {
    size += chunk.length;
    require(size <= 131072);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks), body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  require(body !== null && typeof body === 'object' && !Array.isArray(body));
  return {body, status:response.status, mediaType:'application/json', bodyDigest:digest(bytes)};
};
try {
  const runId = Number(process.env.GITHUB_RUN_ID), runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const repository = process.env.GITHUB_REPOSITORY, headers = {authorization:'Bearer ' + process.env.GH_TOKEN, accept:'application/vnd.github+json'};
  const root = 'https://api.github.com/repos/' + repository + '/actions/runs/' + runId;
  const run = (await json(root + '/attempts/' + runAttempt,headers)).body;
  const jobs = (await json(root + '/attempts/' + runAttempt + '/jobs?per_page=100&page=1',headers)).body;
  require(jobs.total_count === 1 && Array.isArray(jobs.jobs) && jobs.jobs.length === 1);
  const job = jobs.jobs[0];
  const publicName = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  require(job.name === 'Liftoff environment runtime observation' && job.run_id === runId &&
    job.head_sha === process.env.GITHUB_SHA && Number.isSafeInteger(job.runner_id) && job.runner_id > 0 &&
    Number.isSafeInteger(job.runner_group_id) && job.runner_group_id > 0 &&
    job.runner_group_name === recipe.runner.group && publicName(job.runner_name) &&
    Array.isArray(job.labels) && job.labels.length > 0 && job.labels.length <= 100 &&
    job.labels.every(publicName) && new Set(job.labels).size === job.labels.length && job.labels.includes(recipe.runner.label));
  const health = await json('https://' + recipe.fqdn + recipe.healthPath);
  require(health.body.status === 'ok');
  const schema = await json('https://' + recipe.fqdn + recipe.schemaPath);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const methods = ['get','post','put','patch','delete','head','options','trace'];
  require(/^3\.(?:0|1)\.\d+$/.test(schema.body.openapi) && schema.body.paths !== null &&
    record(schema.body.info) && typeof schema.body.info.title === 'string' && schema.body.info.title.length > 0 &&
    typeof schema.body.info.version === 'string' && schema.body.info.version.length > 0 && record(schema.body.paths) &&
    Object.keys(schema.body.paths).length > 0 && Object.keys(schema.body.paths).length <= 128 &&
    Object.entries(schema.body.paths).every(([path,item]) => path.startsWith('/') && record(item) &&
      Object.entries(item).some(([method,operation]) => methods.includes(method) && record(operation) &&
        record(operation.responses) && Object.keys(operation.responses).length > 0)));
  const report = {schemaVersion:1,kind:'liftoff-environment-runtime',
    correlationId:process.env.LIFTOFF_CORRELATION_ID,configurationDigest:process.env.LIFTOFF_CONFIGURATION_DIGEST,
    recipeDigest:process.env.LIFTOFF_RECIPE_DIGEST,
    source:{repository,repositoryId:Number(process.env.GITHUB_REPOSITORY_ID),commitSha:process.env.GITHUB_SHA},
    producer:{workflowId:run.workflow_id,workflowPath:run.path,runId,runAttempt,actorId:run.actor.id,
      jobId:job.id,runnerId:job.runner_id,runnerName:job.runner_name,
      runnerGroupId:job.runner_group_id,runnerGroupName:job.runner_group_name,labels:job.labels},
    target:{environment:recipe.environment,resourceId:recipe.resourceId,fqdn:recipe.fqdn},
    health:{path:recipe.healthPath,status:health.status,mediaType:health.mediaType,bodyDigest:health.bodyDigest,statusValue:health.body.status},
    schema:{path:recipe.schemaPath,status:schema.status,mediaType:schema.mediaType,bodyDigest:schema.bodyDigest,
      openapi:schema.body.openapi,paths:Object.keys(schema.body.paths).sort()},
    observedAt:new Date().toISOString()};
  await writeFile('liftoff-environment-runtime.json',JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});
} catch {
  process.stderr.write('Runtime observation failed; response bodies and credential diagnostics withheld.\n');
  process.exitCode = 1;
}
`;

export function renderEnvironmentRuntimeWorkflow(value: EnvironmentRuntimeRecipe): string {
  const recipe = environmentRuntimeRecipe(value);
  return stringify({
    name: environmentRuntimeJob,
    'run-name': 'liftoff-${{ inputs.liftoff_operation_id }}',
    on: { workflow_dispatch: { inputs: {
      liftoff_operation_id: { required: true, type: 'string' },
      qualification_digest: { required: true, type: 'string' }
    } } },
    permissions: { actions: 'read' },
    jobs: { runtime: {
      name: environmentRuntimeJob,
      'runs-on': { group: recipe.runner.group, labels: recipe.runner.label },
      'timeout-minutes': environmentRuntimeJobTimeoutMinutes,
      steps: [
        { name: environmentRuntimeStep, shell: 'bash', env: {
          GH_TOKEN: '${{ github.token }}', LIFTOFF_RUNTIME_RECIPE: JSON.stringify(recipe),
          LIFTOFF_CORRELATION_ID: '${{ inputs.liftoff_operation_id }}',
          LIFTOFF_CONFIGURATION_DIGEST: '${{ inputs.qualification_digest }}',
          LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe)
        }, run: `node --input-type=module <<'LIFTOFF_RUNTIME_OBSERVATION'\n${runtimeProbe}LIFTOFF_RUNTIME_OBSERVATION\n` },
        { name: environmentRuntimeUploadStep, uses: `actions/upload-artifact@${recipe.uploadArtifactActionSha}`,
          with: { name: 'liftoff-environment-${{ inputs.liftoff_operation_id }}', path: environmentRuntimeReportFile,
            'if-no-files-found': 'error', 'retention-days': 1, 'include-hidden-files': false } }
      ]
    } }
  }, { lineWidth: 0 });
}

/** Keeps environment-specific bounds above the shared strict ZIP/ZIP64 byte extractor. */
export function readEnvironmentRuntimeArchive(archive: Uint8Array): Buffer {
  if (!(archive instanceof Uint8Array) || archive.byteLength < 22 || archive.byteLength > 512 * 1024) {
    qualificationFailure('environment-report-archive', 'The environment report archive must be bounded ZIP data of at most 512 KiB.');
  }
  try {
    return extractWorkflowReport(archive, { filename: environmentRuntimeReportFile, maxBytes: 64 * 1024 });
  } catch (error) {
    if (error instanceof GitHubActivationError && error.code === 'workflow-report-archive') {
      qualificationFailure('environment-report-archive', error.message);
    }
    throw error;
  }
}

export interface EnvironmentRuntimeJobRunner {
  runnerId: number;
  runnerName: string;
  runnerGroupId: number;
  runnerGroupName: string;
  labels: readonly string[];
}

export function environmentRuntimeJobRunner(
  providerJob: Record<string, unknown>, recipe: EnvironmentRuntimeRecipe
): EnvironmentRuntimeJobRunner {
  const runnerName = qualificationText(providerJob.runner_name, 'Actual provider-assigned runner name');
  const runnerGroupName = qualificationText(providerJob.runner_group_name, 'Actual provider-assigned group name');
  if (!Array.isArray(providerJob.labels) || !providerJob.labels.length || providerJob.labels.length > 100) {
    qualificationFailure('environment-runner-binding', 'Actual job runner labels must be present and bounded; source routing is not a provider observation.');
  }
  const labels = providerJob.labels.map((value) => qualificationText(value, 'Actual job runner label'));
  if (runnerName.length > 256 || labels.some((label) => label.length > 256) ||
    new Set(labels).size !== labels.length || !labels.includes(recipe.runner.label) || runnerGroupName !== recipe.runner.group) {
    qualificationFailure('environment-runner-binding', 'The actual job must name the exact reviewed group and label with its own provider-assigned runner identity.');
  }
  return {
    runnerId: qualificationInteger(providerJob.runner_id, 'Actual provider-assigned runner ID'),
    runnerName, runnerGroupId: qualificationInteger(providerJob.runner_group_id, 'Actual provider-assigned group ID'),
    runnerGroupName, labels
  };
}

export interface EnvironmentRuntimeReport {
  schemaVersion: 1;
  kind: 'liftoff-environment-runtime';
  correlationId: string;
  configurationDigest: string;
  recipeDigest: string;
  /** Actual verifier execution checkout, not independently qualified application build source. */
  source: { repository: string; repositoryId: number; commitSha: string };
  producer: EnvironmentRuntimeJobRunner & {
    workflowId: number; workflowPath: string; runId: number; runAttempt: number; actorId: number;
    jobId: number;
  };
  target: { environment: QualificationEnvironment; resourceId: string; fqdn: string };
  health: { path: string; status: 200; mediaType: 'application/json'; bodyDigest: string; statusValue: 'ok' };
  schema: { path: string; status: 200; mediaType: 'application/json'; bodyDigest: string; openapi: string; paths: readonly string[] };
  observedAt: string;
}

export function validateEnvironmentRuntimeReport(
  bytes: Buffer, recipe: EnvironmentRuntimeRecipe, workflow: WorkflowRunBinding,
  observed: {
    runId: number; correlationId: string; configurationDigest: string;
    job: BoundWorkflowJob; providerJob: Record<string, unknown>; now: Date;
  }
): { report: EnvironmentRuntimeReport; reportDigest: string; runner: EnvironmentRuntimeJobRunner } {
  if (!isUtf8(bytes) || !bytes.length || bytes.length > 64 * 1024) qualificationFailure('environment-report', 'Runtime report bytes are absent or outside the bounded UTF-8 contract.');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    qualificationFailure('environment-report', 'Runtime report is not JSON.');
  }
  if (`${JSON.stringify(value)}\n` !== bytes.toString('utf8')) {
    qualificationFailure('environment-report', 'The registered producer emits one unambiguous JSON line; duplicate keys and alternative numeric encodings are rejected.');
  }
  const data = qualificationObject(value, [
    'schemaVersion', 'kind', 'correlationId', 'configurationDigest', 'recipeDigest', 'source', 'producer', 'target', 'health', 'schema', 'observedAt'
  ], 'Actual runtime report');
  const source = qualificationObject(data.source, ['repository', 'repositoryId', 'commitSha'], 'Actual runtime source');
  const producer = qualificationObject(data.producer, [
    'workflowId', 'workflowPath', 'runId', 'runAttempt', 'actorId', 'jobId',
    'runnerId', 'runnerName', 'runnerGroupId', 'runnerGroupName', 'labels'
  ], 'Actual runtime producer');
  const target = qualificationObject(data.target, ['environment', 'resourceId', 'fqdn'], 'Observed runtime target');
  const health = qualificationObject(data.health, ['path', 'status', 'mediaType', 'bodyDigest', 'statusValue'], 'Actual health observation');
  const schema = qualificationObject(data.schema, ['path', 'status', 'mediaType', 'bodyDigest', 'openapi', 'paths'], 'Actual schema observation');
  const { job, providerJob } = observed;
  const startedAt = providerQualificationTimestamp(providerJob.started_at, 'Provider job start');
  const completedAt = providerQualificationTimestamp(providerJob.completed_at, 'Provider job completion');
  const observedAt = qualificationTimestamp(data.observedAt, 'Actual runtime observation time');
  const runner = environmentRuntimeJobRunner(providerJob, recipe);
  const expectedProducer = {
    workflowId: workflow.workflowId, workflowPath: workflow.workflowPath, runId: observed.runId,
    runAttempt: workflow.runAttempt, actorId: workflow.actorId, jobId: job.id, ...runner
  };
  if (data.schemaVersion !== 1 || data.kind !== 'liftoff-environment-runtime' ||
    data.correlationId !== observed.correlationId || data.configurationDigest !== observed.configurationDigest ||
    data.recipeDigest !== canonicalSha256(recipe) ||
    source.repository !== workflow.repository || source.repositoryId !== workflow.repositoryId || source.commitSha !== workflow.sourceSha ||
    canonicalSha256(producer) !== canonicalSha256(expectedProducer) ||
    canonicalSha256(target) !== canonicalSha256({ environment: recipe.environment, resourceId: recipe.resourceId, fqdn: recipe.fqdn }) ||
    providerJob.id !== job.id || providerJob.name !== environmentRuntimeJob || job.name !== environmentRuntimeJob ||
    providerJob.run_id !== observed.runId || providerJob.head_sha !== workflow.sourceSha ||
    job.conclusion !== 'success' || providerJob.status !== 'completed' || providerJob.conclusion !== 'success' ||
    health.path !== recipe.healthPath || health.status !== 200 || health.mediaType !== 'application/json' || health.statusValue !== 'ok' ||
    schema.path !== recipe.schemaPath || schema.status !== 200 || schema.mediaType !== 'application/json' ||
    typeof schema.openapi !== 'string' || !/^3\.(?:0|1)\.\d+$/u.test(schema.openapi) ||
    !Array.isArray(schema.paths) || !schema.paths.length || schema.paths.length > 128 ||
    schema.paths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.length > 2048) ||
    new Set(schema.paths).size !== schema.paths.length ||
    !Number.isFinite(observed.now.getTime()) || Date.parse(completedAt) < Date.parse(startedAt) || Date.parse(observedAt) < Date.parse(startedAt) ||
    Date.parse(completedAt) - Date.parse(startedAt) > environmentRuntimeJobTimeoutMinutes * 60_000 ||
    Date.parse(observedAt) > Date.parse(completedAt) || Date.parse(completedAt) > observed.now.getTime()) {
    qualificationFailure('environment-report-binding', 'Runtime proof must match the actual source/run/attempt/job/runner/actor, exact environment and in-job health/schema observations. HTTP 200 or asserted success alone is not proof.');
  }
  for (const name of [environmentRuntimeStep, environmentRuntimeUploadStep]) {
    const steps = job.steps.filter((step) => step.name === name);
    if (steps.length !== 1 || steps[0]!.status !== 'completed' || steps[0]!.conclusion !== 'success') {
      qualificationFailure('environment-validation-step', 'The exact registered runtime and artifact steps must actually execute successfully; skipped or unrelated jobs cannot qualify.');
    }
  }
  if (job.steps.some((step) => step.status !== 'completed' || !['success', 'skipped'].includes(step.conclusion))) {
    qualificationFailure('environment-validation-step', 'A failed or unfinished setup/cleanup step cannot supply runtime proof.');
  }
  const paths = schema.paths.map((path) => qualificationText(path, 'Observed schema path'));
  const report: EnvironmentRuntimeReport = {
    schemaVersion: 1, kind: 'liftoff-environment-runtime', correlationId: observed.correlationId,
    configurationDigest: qualificationDigest(data.configurationDigest, 'Reviewed runtime configuration'),
    recipeDigest: canonicalSha256(recipe),
    source: { repository: workflow.repository, repositoryId: workflow.repositoryId, commitSha: workflow.sourceSha },
    producer: expectedProducer, target: { environment: recipe.environment, resourceId: recipe.resourceId, fqdn: recipe.fqdn },
    health: { path: recipe.healthPath, status: 200, mediaType: 'application/json',
      bodyDigest: qualificationDigest(health.bodyDigest, 'Actual health response digest'), statusValue: 'ok' },
    schema: { path: recipe.schemaPath, status: 200, mediaType: 'application/json',
      bodyDigest: qualificationDigest(schema.bodyDigest, 'Actual schema response digest'), openapi: schema.openapi, paths },
    observedAt
  };
  return { report, reportDigest: createHash('sha256').update(bytes).digest('hex'), runner };
}

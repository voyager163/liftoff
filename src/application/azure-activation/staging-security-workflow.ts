import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { stringify, parse } from 'yaml';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { normalizeApprovalCostCeiling } from '../../domain/governance/activation/approvals.js';
import type { ApprovalCostCeiling } from '../../domain/governance/activation/types.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import {
  applicationImageDigest, applicationUuid, parseApplicationImageReference
  , applicationRegistryHost, applicationImageRepository
} from '../../adapters/azure/application-provisioning.js';
import { AzureActivationAdmissionError } from './authority.js';
import {
  qualificationFailure, qualificationInteger, qualificationObject,
  qualificationText, qualificationTimestamp, providerQualificationTimestamp
} from './qualification-authority.js';
import { qualificationDigest } from './qualification-evidence.js';
import type { WorkflowFileDefinition } from '../../adapters/github/production-workflows.js';
import type { WorkflowRunBinding } from '../../adapters/github/workflow-dispatch.js';
import type { BoundWorkflowJob } from '../../adapters/github/production-checks.js';
import { extractPrivateReportArchive } from './private-report-archive.js';
import { stagingSecurityWorkflowProgramDelivery } from './staging-security-workflow-program.js';
import { isRfc1918Ipv4, type StagingPrivateHttpWitness } from './staging-private-http.js';

export const stagingSecurityWorkflowRecipeId = 'liftoff-staging-security-workflow.v1';
export const stagingSecurityWorkflowJob = 'Liftoff staging security and DAST qualification';
export const stagingSecurityWorkflowReportFile = 'liftoff-staging-security.json';
export const stagingSecurityWorkflowStep = 'Execute staging security and DAST observation';
export const stagingSecurityWorkflowUploadStep = 'Retain bounded staging security and DAST report';

export const stagingSecurityWorkflowIntegration = {
  sourcePhase: 'workflow-source-ready',
  qualificationPhase: 'staging-qualified',
  publicationAction: 'github.workflow-source.publish',
  dispatchAction: 'github.staging-security.dispatch',
  readbackAction: 'github.staging-security.readback',
  workflowPermissions: { actions: 'read', contents: 'read' },
  jobPermissions: { actions: 'read', contents: 'read', 'id-token': 'write' },
  jobKey: 'security_dast',
  jobName: stagingSecurityWorkflowJob,
  event: 'workflow_dispatch',
  runAttempt: 1,
  dispatchInputs: ['liftoff_operation_id', 'qualification_digest', 'source_sha', 'workflow_id',
    'image_digest', 'target_fqdn', 'target_private_ip', 'database_digest', 'database_metadata_digest',
    'runner_group_id', 'runner_id'],
  correlationInput: 'liftoff_operation_id',
  reportFilename: stagingSecurityWorkflowReportFile
} as const;

export const stagingSecurityWorkflowRuntimePrerequisites = [
  'The repository must be enrolled in staging qualification with an assigned dedicated VNet-injected Linux runner.',
  'The runner group and runner label must exist and match the approved staging network infrastructure.',
  'The staging target Container App must be deployed and responsive before qualification dispatch.',
  'The staging health endpoint and OpenAPI schema endpoint must be accessible from the dedicated runner VNet.',
  'Container scanning (Trivy) and DAST scanning (ZAP) tool binaries must be pre-installed on the runner or verified by digest.',
  'No dynamic downloads (curl|sh, pip, npm) or ambient unpinned tool execution are permitted on the runner.',
  'Actions upload-artifact action must be pinned by immutable 40-character commit SHA.',
  'Tokens must be private: GH_TOKEN is accessed via environment only, never passed in argv or logged.',
  'This source component generates workflow source only; remote execution and publishing belong to separate checkpoints.'
] as const;

export const stagingSecurityWorkflowLimitations = [
  'ZAP uses its actual passive baseline scanner and a one-minute spider within the exact generated HTTPS target context. It does not run active attack fuzzing or an AJAX spider; the qualified dedicated runner must enforce the approved network boundary.',
  'Container supply-chain scanning (Trivy) runs against the immutable OCI image digest with pre-installed scanner binaries and runner-local/cached vulnerability databases; outbound database auto-updates and blind package downloads are prohibited in isolated VNet runner environments.',
  'Authentication: Scans target unauthenticated staging health, documentation, and public/internal endpoints as declared in OpenAPI. Authenticated DAST testing requiring synthetic tokens or secret injection is excluded to avoid credential leakage in scanner arguments or reports.',
  'Network Isolation: Network reachability depends strictly on the pre-provisioned Azure VNet-injected GitHub-hosted runner with private DNS resolution to the Staging Container App environment; this component does not provision VNet peering, NSGs, or private DNS records.',
  'Tool Pinning: Scanner binaries must be pre-installed on the dedicated runner or verified against an exact expected SHA-256 digest; runtime binary downloads (e.g. via curl, pip, npm, or unpinned container pulls) are strictly rejected.',
  'Spend and Time: Execution duration is capped at the approved time ceiling (max 30 minutes); scans exceeding the allotted budget or timeout will be aborted and classified as prerequisite failures rather than passing qualifications.',
  'This component generates and verifies workflow source only; remote execution, dispatch authorization, and GitFlow publishing are owned by separate coordinator checkpoints.'
] as const;

export interface StagingSecurityToolPin {
  name: string;
  executable: string;
  version: string;
  expectedSha256: string;
}

export interface StagingSecurityLimits {
  maxRunMinutes: number;
  commandTimeoutSeconds: number;
  scanTimeoutSeconds: number;
  httpTimeoutSeconds: number;
}

export interface StagingSecurityWorkflowRecipe {
  schemaVersion: 1;
  recipe: typeof stagingSecurityWorkflowRecipeId;
  workflowPath: string;
  repository: string;
  repositoryId: number;
  actorId: number;
  workflowId: number | null;
  ref: string;
  sourceSha: string | null;
  azure: { subscriptionId: string; tenantId: string; clientId: string; principalId: string };
  environment: 'staging';
  target: {
    resourceId: string;
    fqdn: string | null;
    appName: string;
    healthPath: string;
    schemaPath: string;
    privateIp: string | null;
  };
  image: {
    loginServer: string;
    repository: string;
    digest: string | null;
  };
  database: { cacheDirectory: string; databaseSha256: string | null; metadataSha256: string | null; maxAgeHours: number };
  runner: {
    group: string;
    label: string;
    runnerId?: number | null;
    runnerGroupId?: number | null;
  };
  tools: {
    containerScanner: StagingSecurityToolPin;
    dastScanner: StagingSecurityToolPin;
    azureCli: StagingSecurityToolPin;
    azureLoginActionSha: string;
    uploadArtifactActionSha: string;
  };
  authority: {
    allowedNetworkTargets: readonly string[] | null;
    budget: ApprovalCostCeiling;
    limits: StagingSecurityLimits;
  };
  policy: {
    failOnSeverities: readonly ('CRITICAL' | 'HIGH')[];
    failOnDastRisk: readonly ('HIGH' | 'MEDIUM')[];
  };
}

export type PublishedStagingSecurityWorkflowRecipe = StagingSecurityWorkflowRecipe & {
  workflowId: number;
  sourceSha: string;
  target: StagingSecurityWorkflowRecipe['target'] & { fqdn: string };
  image: StagingSecurityWorkflowRecipe['image'] & { digest: string };
  database: StagingSecurityWorkflowRecipe['database'] & { databaseSha256: string; metadataSha256: string };
  runner: StagingSecurityWorkflowRecipe['runner'] & { runnerId: number | null; runnerGroupId: number };
  authority: StagingSecurityWorkflowRecipe['authority'] & { allowedNetworkTargets: readonly string[] };
};

export function assertPublishedStagingSecurityRecipe(recipe: StagingSecurityWorkflowRecipe): asserts recipe is PublishedStagingSecurityWorkflowRecipe {
  if (recipe.workflowId === null || recipe.sourceSha === null || recipe.target.fqdn === null || recipe.image.digest === null ||
    recipe.database.databaseSha256 === null || recipe.database.metadataSha256 === null || recipe.authority.allowedNetworkTargets === null ||
    !Number.isSafeInteger(recipe.runner.runnerGroupId) || Number(recipe.runner.runnerGroupId) < 1 ||
    recipe.runner.runnerId !== null && (!Number.isSafeInteger(recipe.runner.runnerId) || Number(recipe.runner.runnerId) < 1)) {
    qualificationFailure('staging-security-publication-required', 'Dispatch requires actual published workflow/ref, actual artifact, endpoint and database identities, and an assigned runner group with an explicit optional runner pin; unpublished source carries only stable routing names.');
  }
}

export interface SecurityFinding {
  vulnerabilityId: string;
  packageName: string;
  installedVersion: string;
  fixedVersion?: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  title?: string;
  primaryUrl?: string;
}

export interface DastAlert {
  pluginId: string;
  name: string;
  risk: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';
  confidence?: string;
  uri?: string;
  param?: string;
  evidence?: string;
}

export interface SupplyChainScanResult {
  tool: { name: string; version: string; binarySha256?: string };
  target: string;
  status: 'passed' | 'policy_violation' | 'prerequisite_failed';
  exitCode: number;
  reportDigest: string;
  findingsCount: { critical: number; high: number; medium: number; low: number; info: number };
  findings: readonly SecurityFinding[];
  error?: string;
}

export interface DastScanResult {
  tool: { name: string; version: string; binarySha256?: string };
  target: string;
  status: 'passed' | 'policy_violation' | 'prerequisite_failed';
  exitCode: number;
  reportDigest: string;
  alertsCount: { high: number; medium: number; low: number; info: number };
  alerts: readonly DastAlert[];
  error?: string;
}

export interface StagingSecurityReport {
  schemaVersion: 1;
  kind: 'liftoff-staging-security';
  correlationId: string;
  configurationDigest: string;
  recipeDigest: string;
  source: {
    repository: string;
    repositoryId: number;
    commitSha: string;
    ref: string;
  };
  producer: {
    workflowId: number;
    workflowPath: string;
    workflowDigest: string;
    runId: number;
    runAttempt: number;
    actorId: number;
    jobId: number;
    runnerId: number;
    runnerGroupId: number;
  };
  target: {
    environment: 'staging';
    resourceId: string;
    fqdn: string;
    imageDigest: string;
  };
  prerequisites: {
    health: {
      path: string;
      status: 200;
      mediaType: 'application/json';
      bodyDigest: string;
      statusValue: 'ok';
    };
    schema: {
      path: string;
      status: 200;
      mediaType: 'application/json';
      bodyDigest: string;
      openapi: string;
      paths: readonly string[];
    };
    reachabilityVerified: true;
    privateAccess: { health: StagingPrivateHttpWitness; schema: StagingPrivateHttpWitness } | null;
  };
  scans: {
    supplyChain: SupplyChainScanResult;
    dast: DastScanResult;
  };
  overallStatus: 'passed' | 'policy_violation' | 'prerequisite_failed';
  observedAt: string;
}

export interface StagingSecurityWorkflowSource {
  recipe: typeof stagingSecurityWorkflowRecipeId;
  recipeDigest: string;
  files: readonly WorkflowFileDefinition[];
  workflow: {
    path: string;
    digest: string;
    expectedJobs: readonly string[];
    event: 'workflow_dispatch';
    runAttempt: 1;
  };
}

export interface VerifiedStagingSecurityReport {
  report: StagingSecurityReport;
  reportDigest: string;
  policyPassed: boolean;
}

function toolPin(value: unknown, label: string): StagingSecurityToolPin {
  if (!isRecord(value)) {
    qualificationFailure('staging-security-recipe', `${label} must be an object`);
  }
  const data = qualificationObject(value, ['name', 'executable', 'version', 'expectedSha256'], label);
  const name = qualificationText(data.name, `${label} name`);
  const executable = qualificationText(data.executable, `${label} executable`);
  const version = qualificationText(data.version, `${label} version`);
  const text = qualificationText(data.expectedSha256, `${label} SHA-256 digest`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(text) ||
    !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(executable) ||
    executable.split('/').some((part) => part === '.' || part === '..') ||
    !/^\d+\.\d+\.\d+$/u.test(version)) {
    qualificationFailure('staging-security-recipe', `${label} requires an absolute executable, exact semantic version and explicit SHA-256.`);
  }
  return { name, executable, version, expectedSha256: text };
}

export function stagingSecurityWorkflowRecipe(value: unknown): StagingSecurityWorkflowRecipe {
  const data = qualificationObject(value, [
    'schemaVersion', 'recipe', 'workflowPath', 'repository', 'repositoryId', 'actorId', 'workflowId',
    'ref', 'sourceSha', 'azure', 'environment', 'target', 'image', 'database', 'runner', 'tools', 'authority', 'policy'
  ], 'Staging security workflow recipe');

  if (data.schemaVersion !== 1 || data.recipe !== stagingSecurityWorkflowRecipeId) {
    qualificationFailure('staging-security-recipe', 'Recipe schema version must be 1 and recipe ID must be ' + stagingSecurityWorkflowRecipeId);
  }

  if (data.environment !== 'staging') {
    qualificationFailure('staging-security-recipe', 'Staging security recipe exclusively targets the staging environment; dev and prod are not permitted.');
  }

  const workflowPath = qualificationText(data.workflowPath, 'Workflow path');
  if (!/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u.test(workflowPath)) {
    qualificationFailure('staging-security-recipe', 'Workflow path must be within .github/workflows/');
  }

  const repository = qualificationText(data.repository, 'Repository');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(repository)) {
    qualificationFailure('staging-security-recipe', 'Repository must be in owner/repo format');
  }

  const repositoryId = qualificationInteger(data.repositoryId, 'Repository ID');
  const actorId = qualificationInteger(data.actorId, 'Actor ID');
  const workflowId = data.workflowId === null ? null : qualificationInteger(data.workflowId, 'Workflow ID');
  const ref = qualificationText(data.ref, 'Ref');
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/u.test(ref) || ref.includes('..')) {
    qualificationFailure('staging-security-recipe', 'Invalid ref format');
  }

  const commitSha = data.sourceSha === null ? null : sourceSha(data.sourceSha, 'Source commit SHA');
  const unpublished = workflowId === null && commitSha === null;
  if ((workflowId === null) !== (commitSha === null)) {
    qualificationFailure('staging-security-recipe', 'Publication identities must both be actual or both be explicitly unpublished.');
  }
  const azureData = qualificationObject(data.azure, ['subscriptionId', 'tenantId', 'clientId', 'principalId'], 'Explicit Azure scan identity');
  const azure = {
    subscriptionId: applicationUuid(azureData.subscriptionId, 'Scanner subscription'),
    tenantId: applicationUuid(azureData.tenantId, 'Scanner tenant'),
    clientId: applicationUuid(azureData.clientId, 'Scanner client'),
    principalId: applicationUuid(azureData.principalId, 'Scanner principal')
  };

  const targetData = qualificationObject(data.target, ['resourceId', 'fqdn', 'appName', 'healthPath', 'schemaPath', 'privateIp'], 'Target configuration');
  const resourceId = qualificationText(targetData.resourceId, 'Target resource ID');
  if (!/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.App\/containerApps\/[a-z0-9-]+$/u.test(resourceId)) {
    qualificationFailure('staging-security-recipe', 'Target resourceId must be an Azure Container App ARM ID');
  }

  const fqdn = unpublished && targetData.fqdn === null ? null : qualificationText(targetData.fqdn, 'Target FQDN');
  if (fqdn !== null && (!/^[a-z0-9][a-z0-9.-]{1,200}\.azurecontainerapps\.io$/u.test(fqdn) || fqdn.includes('..'))) {
    qualificationFailure('staging-security-recipe', 'Target FQDN must be a valid .azurecontainerapps.io domain');
  }

  const appName = qualificationText(targetData.appName, 'Target App Name');
  const healthPath = qualificationText(targetData.healthPath, 'Health path');
  const schemaPath = qualificationText(targetData.schemaPath, 'Schema path');
  const privateIp = targetData.privateIp === null ? null : qualificationText(targetData.privateIp, 'Private staging peer');
  if (privateIp !== null && !isRfc1918Ipv4(privateIp)) {
    qualificationFailure('staging-security-private-address', 'Private DAST requires one explicit RFC1918 peer, independently read from the declared private environment.');
  }
  if (![healthPath, schemaPath].every((entry) => /^\/[A-Za-z0-9_./-]{1,200}$/u.test(entry) &&
    !entry.includes('//') && !entry.split('/').some((part) => part === '.' || part === '..')) ||
    healthPath === schemaPath || resourceId.split('/')[2] !== azure.subscriptionId || resourceId.split('/').at(-1) !== appName) {
    qualificationFailure('staging-security-recipe', 'Health and schema paths must be distinct absolute paths');
  }

  const imageData = qualificationObject(data.image, ['loginServer', 'repository', 'digest'], 'Image configuration');
  const loginServer = applicationRegistryHost(imageData.loginServer);
  const imageRepo = applicationImageRepository(imageData.repository);
  const digest = unpublished && imageData.digest === null ? null : applicationImageDigest(imageData.digest);
  if (digest !== null) parseApplicationImageReference(`${loginServer}/${imageRepo}@${digest}`);
  const databaseData = qualificationObject(data.database, ['cacheDirectory', 'databaseSha256', 'metadataSha256', 'maxAgeHours'], 'Pinned vulnerability database');
  const cacheDirectory = qualificationText(databaseData.cacheDirectory, 'Preinstalled database directory');
  if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(cacheDirectory) ||
    cacheDirectory.split('/').some((part) => part === '.' || part === '..')) {
    qualificationFailure('staging-security-recipe', 'The database requires an exact preinstalled absolute directory; no implicit refresh/download is allowed.');
  }
  const database = {
    cacheDirectory, databaseSha256: unpublished && databaseData.databaseSha256 === null ? null :
      qualificationDigest(databaseData.databaseSha256, 'Pinned Trivy database bytes'),
    metadataSha256: unpublished && databaseData.metadataSha256 === null ? null :
      qualificationDigest(databaseData.metadataSha256, 'Pinned Trivy database metadata'),
    maxAgeHours: qualificationInteger(databaseData.maxAgeHours, 'Database maximum age', 48)
  };

  const runnerIdsSupplied = isRecord(data.runner) &&
    (Object.hasOwn(data.runner, 'runnerId') || Object.hasOwn(data.runner, 'runnerGroupId'));
  const runnerData = qualificationObject(data.runner, [
    'group', 'label', ...(!unpublished || runnerIdsSupplied ? ['runnerId', 'runnerGroupId'] : [])
  ], 'Runner configuration');
  const runnerGroup = qualificationText(runnerData.group, 'Runner group');
  const runnerLabel = qualificationText(runnerData.label, 'Runner label');
  const runnerIdentity = !unpublished || runnerIdsSupplied ? {
    runnerId: runnerData.runnerId === null ? null : qualificationInteger(runnerData.runnerId, 'Runner ID'),
    runnerGroupId: unpublished && runnerData.runnerGroupId === null ? null : qualificationInteger(runnerData.runnerGroupId, 'Runner group ID')
  } : {};
  if (![runnerGroup, runnerLabel].every((entry) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(entry))) {
    qualificationFailure('staging-security-recipe', 'Runner group and label require exact canonical names.');
  }

  const toolsData = qualificationObject(data.tools, ['containerScanner', 'dastScanner', 'azureCli', 'azureLoginActionSha', 'uploadArtifactActionSha'], 'Tools configuration');
  const containerScanner = toolPin(toolsData.containerScanner, 'Container scanner');
  const dastScanner = toolPin(toolsData.dastScanner, 'DAST scanner');
  const azureCli = toolPin(toolsData.azureCli, 'Azure CLI');
  if (containerScanner.name !== 'trivy' || dastScanner.name !== 'zap-baseline' || azureCli.name !== 'az') {
    qualificationFailure('staging-security-recipe', 'Only the registered Trivy, ZAP baseline and Azure CLI contracts are executable.');
  }
  const azureLoginActionSha = sourceSha(toolsData.azureLoginActionSha, 'Pinned Azure login action');
  const uploadArtifactActionSha = sourceSha(toolsData.uploadArtifactActionSha, 'Upload artifact action SHA');

  const authorityData = qualificationObject(data.authority, ['allowedNetworkTargets', 'budget', 'limits'], 'Authority configuration');
  if (!(unpublished && fqdn === null && authorityData.allowedNetworkTargets === null) &&
    (!Array.isArray(authorityData.allowedNetworkTargets) || !authorityData.allowedNetworkTargets.length)) {
    qualificationFailure('staging-security-recipe', 'Allowed network targets must be a non-empty array');
  }
  const allowedNetworkTargets = Array.isArray(authorityData.allowedNetworkTargets)
    ? authorityData.allowedNetworkTargets.map(t => qualificationText(t, 'Allowed network target')) : null;
  if (allowedNetworkTargets !== null &&
    canonicalSha256([...allowedNetworkTargets].sort()) !== canonicalSha256([fqdn, 'api.github.com', loginServer].sort())) {
    qualificationFailure('staging-security-recipe', 'Allowed network targets must be exactly the target FQDN, api.github.com and approved registry; scanner DB updates and foreign targets are forbidden.');
  }

  let budget: ApprovalCostCeiling;
  try {
    budget = normalizeApprovalCostCeiling(authorityData.budget as ApprovalCostCeiling);
  } catch {
    qualificationFailure('staging-security-recipe', 'Invalid approval cost ceiling');
  }

  const limitsData = qualificationObject(authorityData.limits, ['maxRunMinutes', 'commandTimeoutSeconds', 'scanTimeoutSeconds', 'httpTimeoutSeconds'], 'Limits configuration');
  const maxRunMinutes = qualificationInteger(limitsData.maxRunMinutes, 'Max run minutes', 30);
  const commandTimeoutSeconds = qualificationInteger(limitsData.commandTimeoutSeconds, 'Command timeout seconds', 300);
  const scanTimeoutSeconds = qualificationInteger(limitsData.scanTimeoutSeconds, 'Scan timeout seconds', 1200);
  const httpTimeoutSeconds = qualificationInteger(limitsData.httpTimeoutSeconds, 'HTTP timeout seconds', 60);

  const policyData = qualificationObject(data.policy, ['failOnSeverities', 'failOnDastRisk'], 'Policy configuration');
  if (canonicalSha256(policyData.failOnSeverities) !== canonicalSha256(['CRITICAL', 'HIGH'])) {
    qualificationFailure('staging-security-recipe', 'failOnSeverities must contain CRITICAL and/or HIGH');
  }
  if (canonicalSha256(policyData.failOnDastRisk) !== canonicalSha256(['HIGH', 'MEDIUM'])) {
    qualificationFailure('staging-security-recipe', 'failOnDastRisk must contain HIGH and/or MEDIUM');
  }

  return {
    schemaVersion: 1,
    recipe: stagingSecurityWorkflowRecipeId,
    workflowPath,
    repository,
    repositoryId,
    actorId,
    workflowId,
    ref,
    sourceSha: commitSha,
    azure,
    environment: 'staging',
    target: { resourceId, fqdn, appName, healthPath, schemaPath, privateIp },
    image: { loginServer, repository: imageRepo, digest },
    database,
    runner: { group: runnerGroup, label: runnerLabel, ...runnerIdentity },
    tools: { containerScanner, dastScanner, azureCli, azureLoginActionSha, uploadArtifactActionSha },
    authority: {
      allowedNetworkTargets: allowedNetworkTargets === null ? null : [fqdn!, 'api.github.com', loginServer],
      budget,
      limits: { maxRunMinutes, commandTimeoutSeconds, scanTimeoutSeconds, httpTimeoutSeconds }
    },
    policy: {
      failOnSeverities: policyData.failOnSeverities as ('CRITICAL' | 'HIGH')[],
      failOnDastRisk: policyData.failOnDastRisk as ('HIGH' | 'MEDIUM')[]
    }
  };
}

export function stagingSecuritySourceRecipe(value: StagingSecurityWorkflowRecipe) {
  const recipe = stagingSecurityWorkflowRecipe(value);
  const { workflowId: _workflowId, sourceSha: _sourceSha, ...source } = recipe;
  const { fqdn: _fqdn, privateIp: _privateIp, ...target } = recipe.target;
  const { digest: _digest, ...image } = recipe.image;
  const { databaseSha256: _databaseSha256, metadataSha256: _metadataSha256, ...database } = recipe.database;
  const { allowedNetworkTargets: _allowedNetworkTargets, ...authority } = recipe.authority;
  const { runnerId: _runnerId, runnerGroupId: _runnerGroupId, ...runner } = recipe.runner;
  return { ...source, target, image, database, authority, runner };
}

export function stagingSecurityWorkflowDispatchInputs(value: StagingSecurityWorkflowRecipe): Record<string, string> {
  const recipe = stagingSecurityWorkflowRecipe(value);
  assertPublishedStagingSecurityRecipe(recipe);
  return {
    source_sha: recipe.sourceSha, workflow_id: String(recipe.workflowId),
    image_digest: recipe.image.digest, target_fqdn: recipe.target.fqdn,
    target_private_ip: recipe.target.privateIp ?? 'none',
    database_digest: recipe.database.databaseSha256, database_metadata_digest: recipe.database.metadataSha256,
    runner_group_id: String(recipe.runner.runnerGroupId), runner_id: recipe.runner.runnerId === null ? 'none' : String(recipe.runner.runnerId),
    qualification_digest: canonicalSha256(recipe)
  };
}

export function renderStagingSecurityWorkflow(value: StagingSecurityWorkflowRecipe): string {
  const recipe = stagingSecuritySourceRecipe(value);
  const delivery = stagingSecurityWorkflowProgramDelivery();

  const definition = {
    name: stagingSecurityWorkflowJob,
    'run-name': 'liftoff-${{ inputs.liftoff_operation_id }}',
    on: {
      workflow_dispatch: {
        inputs: {
          liftoff_operation_id: { type: 'string', required: true },
          qualification_digest: { type: 'string', required: true },
          source_sha: { type: 'string', required: true },
          workflow_id: { type: 'string', required: true },
          image_digest: { type: 'string', required: true },
          target_fqdn: { type: 'string', required: true },
          target_private_ip: { type: 'string', required: true },
          database_digest: { type: 'string', required: true },
          database_metadata_digest: { type: 'string', required: true },
          runner_group_id: { type: 'string', required: true },
          runner_id: { type: 'string', required: true }
        }
      }
    },
    permissions: stagingSecurityWorkflowIntegration.workflowPermissions,
    jobs: {
      [stagingSecurityWorkflowIntegration.jobKey]: {
        name: stagingSecurityWorkflowJob,
        'runs-on': {
          group: recipe.runner.group,
          labels: recipe.runner.label
        },
        permissions: stagingSecurityWorkflowIntegration.jobPermissions,
        'timeout-minutes': recipe.authority.limits.maxRunMinutes,
        steps: [
          {
            name: 'Prepare private scanner authentication',
            shell: 'bash',
            env: { LIFTOFF_CORRELATION_ID: '${{ inputs.liftoff_operation_id }}' },
            run: `node --input-type=module <<'LIFTOFF_SCAN_AUTH'\nimport { mkdir, realpath } from 'node:fs/promises';\nimport { join } from 'node:path';\nconst id=process.env.LIFTOFF_CORRELATION_ID;\nif(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid scan correlation');\nawait mkdir(join(await realpath(process.env.RUNNER_TEMP),'liftoff-staging-azure-'+id),{mode:0o700});\nLIFTOFF_SCAN_AUTH\n`
          },
          {
            name: 'Authenticate exact read-only scanner identity',
            uses: `azure/login@${recipe.tools.azureLoginActionSha}`,
            env: { AZURE_CONFIG_DIR: '${{ runner.temp }}/liftoff-staging-azure-${{ inputs.liftoff_operation_id }}',
              AZURE_LOGIN_POST_CLEANUP: 'true' },
            with: { 'client-id': recipe.azure.clientId, 'tenant-id': recipe.azure.tenantId, 'subscription-id': recipe.azure.subscriptionId }
          },
          {
            name: stagingSecurityWorkflowStep,
            'timeout-minutes': recipe.authority.limits.maxRunMinutes,
            shell: 'bash',
            env: {
              GH_TOKEN: '${{ github.token }}',
              AZURE_CONFIG_DIR: '${{ runner.temp }}/liftoff-staging-azure-${{ inputs.liftoff_operation_id }}',
              LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
              LIFTOFF_CORRELATION_ID: '${{ inputs.liftoff_operation_id }}',
              LIFTOFF_CONFIGURATION_DIGEST: '${{ inputs.qualification_digest }}',
              LIFTOFF_EXECUTION_SOURCE_SHA: '${{ inputs.source_sha }}',
              LIFTOFF_WORKFLOW_ID: '${{ inputs.workflow_id }}',
              LIFTOFF_IMAGE_DIGEST: '${{ inputs.image_digest }}',
              LIFTOFF_TARGET_FQDN: '${{ inputs.target_fqdn }}',
              LIFTOFF_TARGET_PRIVATE_IP: '${{ inputs.target_private_ip }}',
              LIFTOFF_DATABASE_DIGEST: '${{ inputs.database_digest }}',
              LIFTOFF_DATABASE_METADATA_DIGEST: '${{ inputs.database_metadata_digest }}',
              LIFTOFF_RUNNER_GROUP_ID: '${{ inputs.runner_group_id }}',
              LIFTOFF_RUNNER_ID: '${{ inputs.runner_id }}',
              LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
              LIFTOFF_TIMEOUT_MINUTES: String(recipe.authority.limits.maxRunMinutes),
              ...delivery.env
            },
            run: delivery.run
          },
          {
            name: stagingSecurityWorkflowUploadStep,
            if: '${{ always() }}',
            uses: `actions/upload-artifact@${recipe.tools.uploadArtifactActionSha}`,
            'timeout-minutes': 1,
            with: {
              name: 'liftoff-staging-security-${{ inputs.liftoff_operation_id }}',
              path: stagingSecurityWorkflowReportFile,
              'if-no-files-found': 'error',
              'retention-days': 1,
              'include-hidden-files': false,
              'compression-level': 0,
              overwrite: false
            }
          }
        ]
      }
    }
  };

  const content = stringify(definition, { lineWidth: 0 });
  if (Buffer.byteLength(content) > 256 * 1024) {
    qualificationFailure('staging-security-workflow', 'Generated workflow size exceeds 256KB limit');
  }
  return content;
}

export function stagingSecurityWorkflowSource(value: StagingSecurityWorkflowRecipe): StagingSecurityWorkflowSource {
  const recipe = stagingSecurityWorkflowRecipe(value);
  const content = renderStagingSecurityWorkflow(recipe);
  const digest = canonicalSha256(content);
  return {
    recipe: stagingSecurityWorkflowRecipeId,
    recipeDigest: canonicalSha256(stagingSecuritySourceRecipe(recipe)),
    files: [{ path: recipe.workflowPath, content, digest }],
    workflow: {
      path: recipe.workflowPath,
      digest,
      expectedJobs: [stagingSecurityWorkflowJob],
      event: 'workflow_dispatch',
      runAttempt: 1
    }
  };
}

export function assertStagingSecurityWorkflowSource(content: string, value: StagingSecurityWorkflowRecipe): void {
  if (content !== renderStagingSecurityWorkflow(value)) {
    throw new AzureActivationAdmissionError(
      'staging-security-workflow-source',
      'Staging security workflow bytes differ from the registered reviewed recipe.'
    );
  }
}

export function parseTrivyScanOutput(
  raw: Buffer | Uint8Array | string,
  failOnSeverities: readonly string[] = ['CRITICAL', 'HIGH']
): {
  findings: SecurityFinding[];
  findingsCount: { critical: number; high: number; medium: number; low: number; info: number };
  status: 'passed' | 'policy_violation';
} {
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Trivy output is not valid JSON');
  }
  if (!isRecord(data)) {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Trivy output must be a JSON object');
  }
  if (data.SchemaVersion !== 2 || data.ArtifactType !== 'container_image' || typeof data.ArtifactName !== 'string') {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Unsupported or missing Trivy SchemaVersion');
  }
  if (!Array.isArray(data.Results) || data.Results.length < 1 || data.Results.length > 4096) {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Trivy output missing Results array');
  }

  const findings: SecurityFinding[] = [];
  const findingsCount = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const res of data.Results) {
    if (!isRecord(res) || typeof res.Target !== 'string' || !res.Target ||
      res.Vulnerabilities !== undefined && !Array.isArray(res.Vulnerabilities)) {
      qualificationFailure('staging-security-scanner-output', 'Malformed or unclassified Trivy result cannot establish a clean scan.');
    }
    for (const vuln of res.Vulnerabilities ?? []) {
      if (!isRecord(vuln)) {
        throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Malformed vulnerability entry');
      }
      if (typeof vuln.VulnerabilityID !== 'string' || !vuln.VulnerabilityID) {
        throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Missing VulnerabilityID in Trivy report');
      }
      if (typeof vuln.PkgName !== 'string' || !vuln.PkgName) {
        throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Missing PkgName in Trivy report');
      }
      const severity = vuln.Severity;
      if (severity !== 'CRITICAL' && severity !== 'HIGH' && severity !== 'MEDIUM' && severity !== 'LOW' ||
        typeof vuln.InstalledVersion !== 'string' || !vuln.InstalledVersion) {
        qualificationFailure('staging-security-scanner-output', 'Unknown vulnerability severity or installed package version cannot qualify the threshold.');
      }
      if (severity === 'CRITICAL') findingsCount.critical++;
      else if (severity === 'HIGH') findingsCount.high++;
      else if (severity === 'MEDIUM') findingsCount.medium++;
      else if (severity === 'LOW') findingsCount.low++;
      else findingsCount.info++;

      const finding: SecurityFinding = {
        vulnerabilityId: vuln.VulnerabilityID,
        packageName: vuln.PkgName,
        installedVersion: vuln.InstalledVersion,
        severity
      };
      if (vuln.FixedVersion !== undefined) finding.fixedVersion = qualificationText(vuln.FixedVersion, 'Fixed version');
      if (vuln.Title !== undefined) finding.title = qualificationText(vuln.Title, 'Vulnerability title');
      if (vuln.PrimaryURL !== undefined) finding.primaryUrl = qualificationText(vuln.PrimaryURL, 'Vulnerability reference');
      findings.push(finding);
    }
  }

  const policyViolations = findings.filter(f => failOnSeverities.includes(f.severity));
  return {
    findings,
    findingsCount,
    status: policyViolations.length > 0 ? 'policy_violation' : 'passed'
  };
}

export function parseZapScanOutput(
  raw: Buffer | Uint8Array | string,
  expectedHost: string,
  failOnRisk: readonly string[] = ['HIGH', 'MEDIUM']
): {
  alerts: DastAlert[];
  alertsCount: { high: number; medium: number; low: number; info: number };
  status: 'passed' | 'policy_violation';
} {
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'ZAP output is not valid JSON');
  }
  if (!isRecord(data)) {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'ZAP output must be a JSON object');
  }
  if (data['@programName'] !== 'ZAP' || typeof data['@version'] !== 'string' || !/^\d+\.\d+\.\d+$/u.test(data['@version'])) {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Missing ZAP @programName');
  }
  if (!Array.isArray(data.site) || data.site.length !== 1) {
    throw new AzureActivationAdmissionError('staging-security-scanner-output', 'ZAP output missing site array');
  }

  const alerts: DastAlert[] = [];
  const alertsCount = { high: 0, medium: 0, low: 0, info: 0 };
  for (const s of data.site) {
    if (!isRecord(s)) {
      throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Malformed ZAP site entry');
    }
    const host = s['@host'];
    if (host !== expectedHost || s['@name'] !== `https://${expectedHost}` ||
      s['@port'] !== '443' || s['@ssl'] !== 'true') {
      throw new AzureActivationAdmissionError('staging-security-scanner-output', `ZAP site host mismatch: expected ${expectedHost}, got ${host}`);
    }
    if (!Array.isArray(s.alerts) || s.alerts.length > 4096) {
      qualificationFailure('staging-security-scanner-output', 'Missing, malformed or unbounded ZAP alerts cannot establish an empty scan.');
    }
    for (const a of s.alerts) {
      if (!isRecord(a)) {
        throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Malformed ZAP alert entry');
      }
      if (typeof a.pluginid !== 'string' || !a.pluginid) {
        throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Missing ZAP alert pluginid');
      }
      const name = typeof a.alert === 'string' ? a.alert : (typeof a.name === 'string' ? a.name : '');
      if (!name) {
        throw new AzureActivationAdmissionError('staging-security-scanner-output', 'Missing ZAP alert name');
      }
      const risks = { '3': 'HIGH', '2': 'MEDIUM', '1': 'LOW', '0': 'INFORMATIONAL' } as const;
      if (a.riskcode !== '0' && a.riskcode !== '1' && a.riskcode !== '2' && a.riskcode !== '3' ||
        !Array.isArray(a.instances) || !a.instances.length || a.instances.length > 4096) {
        qualificationFailure('staging-security-scanner-output', 'Unknown ZAP risk or missing actual instance evidence cannot qualify a scan.');
      }
      const risk = risks[a.riskcode];
      alertsCount[risk === 'INFORMATIONAL' ? 'info' : risk === 'HIGH' ? 'high' : risk === 'MEDIUM' ? 'medium' : 'low']++;
      let uri: string | undefined;
      for (const instance of a.instances) {
        if (!isRecord(instance) || typeof instance.uri !== 'string') qualificationFailure('staging-security-scanner-output', 'Malformed ZAP instance.');
        const url = new URL(instance.uri);
        if (url.origin !== `https://${expectedHost}` || url.username || url.password || url.hash) {
          qualificationFailure('staging-security-scanner-output', 'An out-of-scope DAST instance invalidates the whole report.');
        }
        uri ??= `${url.origin}${url.pathname}`;
      }
      const alert: DastAlert = {
        pluginId: a.pluginid,
        name,
        risk
      };
      if (a.confidence !== undefined) alert.confidence = qualificationText(a.confidence, 'DAST confidence');
      if (uri) alert.uri = uri;
      alerts.push(alert);
    }
  }

  const policyViolations = alerts.filter(a => failOnRisk.includes(a.risk));
  return {
    alerts,
    alertsCount,
    status: policyViolations.length > 0 ? 'policy_violation' : 'passed'
  };
}

export function readStagingSecurityArchive(archive: Uint8Array): Buffer {
  return extractPrivateReportArchive(archive, stagingSecurityWorkflowReportFile);
}

export function parseStagingSecurityReport(bytes: Buffer | Uint8Array): StagingSecurityReport {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!isUtf8(buf) || !buf.length || buf.length > 131072) {
    throw new AzureActivationAdmissionError('staging-security-report', 'Staging security report bytes are absent or exceed the 128KB limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new AzureActivationAdmissionError('staging-security-report', 'Staging security report is not valid JSON.');
  }
  return parsed as StagingSecurityReport;
}

export function validateStagingSecurityReport(
  bytes: Buffer | Uint8Array,
  recipe: StagingSecurityWorkflowRecipe,
  workflow: WorkflowRunBinding,
  observation: {
    runId: number;
    correlationId: string;
    configurationDigest: string;
    job: BoundWorkflowJob;
    providerJob: Record<string, unknown>;
    now: Date;
  }
): VerifiedStagingSecurityReport {
  const report = parseStagingSecurityReport(bytes);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const rawString = buf.toString('utf8');
  if (`${JSON.stringify(report)}\n` !== rawString && JSON.stringify(report) !== rawString.trimEnd()) {
    throw new AzureActivationAdmissionError('staging-security-report', 'The registered producer emits unambiguous JSON; formatting or whitespace deviations are rejected.');
  }

  const data = qualificationObject(report, [
    'schemaVersion', 'kind', 'correlationId', 'configurationDigest', 'recipeDigest',
    'source', 'producer', 'target', 'prerequisites', 'scans', 'overallStatus', 'observedAt'
  ], 'Staging security report');

  if (data.schemaVersion !== 1 || data.kind !== 'liftoff-staging-security') {
    qualificationFailure('staging-security-report', 'Report schema version must be 1 and kind must be liftoff-staging-security');
  }

  if (data.correlationId !== observation.correlationId) {
    qualificationFailure('staging-security-report', 'Correlation ID does not match observation');
  }

  if (data.configurationDigest !== observation.configurationDigest) {
    qualificationFailure('staging-security-report', 'Configuration digest does not match reviewed dispatch');
  }

  recipe = stagingSecurityWorkflowRecipe(recipe);
  assertPublishedStagingSecurityRecipe(recipe);
  if (data.recipeDigest !== canonicalSha256(stagingSecuritySourceRecipe(recipe)) ||
    workflow.workflowDigest !== canonicalSha256(renderStagingSecurityWorkflow(recipe))) {
    qualificationFailure('staging-security-report', 'Recipe digest does not match registered recipe');
  }

  const source = qualificationObject(data.source, ['repository', 'repositoryId', 'commitSha', 'ref'], 'Report source');
  if (source.repository !== workflow.repository || source.repositoryId !== workflow.repositoryId ||
    source.commitSha !== workflow.sourceSha || source.ref !== workflow.ref) {
    qualificationFailure('staging-security-report-binding', 'Report source bindings do not match workflow run binding');
  }

  const producer = qualificationObject(data.producer, [
    'workflowId', 'workflowPath', 'workflowDigest', 'runId', 'runAttempt', 'actorId', 'jobId', 'runnerId', 'runnerGroupId'
  ], 'Report producer');

  if (producer.workflowId !== workflow.workflowId ||
    producer.workflowPath !== workflow.workflowPath || producer.workflowDigest !== workflow.workflowDigest ||
    producer.runId !== observation.runId ||
    producer.runAttempt !== workflow.runAttempt ||
    producer.actorId !== workflow.actorId ||
    producer.jobId !== observation.job.id ||
    producer.runnerId !== qualificationInteger(observation.providerJob.runner_id, 'Actual security job runner') ||
    recipe.runner.runnerId !== null && producer.runnerId !== recipe.runner.runnerId ||
    producer.runnerGroupId !== recipe.runner.runnerGroupId) {
    qualificationFailure('staging-security-report-binding', 'Producer execution metadata does not match reviewed dedicated runner and job');
  }

  const target = qualificationObject(data.target, ['environment', 'resourceId', 'fqdn', 'imageDigest'], 'Report target');
  if (target.environment !== 'staging' ||
    target.resourceId !== recipe.target.resourceId ||
    target.fqdn !== recipe.target.fqdn ||
    target.imageDigest !== recipe.image.digest) {
    qualificationFailure('staging-security-report-binding', 'Observed staging target does not match recipe target and immutable OCI image');
  }

  const prereqs = qualificationObject(data.prerequisites, ['health', 'schema', 'reachabilityVerified', 'privateAccess'], 'Report prerequisites');
  if (prereqs.reachabilityVerified !== true) {
    qualificationFailure('staging-security-report', 'Private network reachability was not verified');
  }

  const health = qualificationObject(prereqs.health, ['path', 'status', 'mediaType', 'bodyDigest', 'statusValue'], 'Health observation');
  if (health.path !== recipe.target.healthPath || health.status !== 200 || health.statusValue !== 'ok' ||
    health.mediaType !== 'application/json') {
    qualificationFailure('staging-security-report', 'Prerequisite health check observation failed');
  }

  const schema = qualificationObject(prereqs.schema, ['path', 'status', 'mediaType', 'bodyDigest', 'openapi', 'paths'], 'Schema observation');
  qualificationDigest(health.bodyDigest, 'Health response body');
  if (schema.path !== recipe.target.schemaPath || schema.status !== 200 || schema.mediaType !== 'application/json' ||
    !/^3\.(?:0|1)\.\d+$/u.test(String(schema.openapi)) || !Array.isArray(schema.paths) || !schema.paths.length ||
    schema.paths.length > 128 || new Set(schema.paths).size !== schema.paths.length ||
    !schema.paths.every((entry) => typeof entry === 'string' && entry.startsWith('/'))) {
    qualificationFailure('staging-security-report', 'Prerequisite OpenAPI schema check observation failed');
  }
  qualificationDigest(schema.bodyDigest, 'Schema response body');

  const { job, providerJob } = observation;
  if (job.id !== providerJob.id || job.name !== stagingSecurityWorkflowJob || providerJob.name !== stagingSecurityWorkflowJob ||
    job.conclusion !== 'success' || providerJob.status !== 'completed' || providerJob.conclusion !== 'success' ||
    recipe.runner.runnerId !== null && providerJob.runner_id !== recipe.runner.runnerId ||
    providerJob.runner_group_id !== recipe.runner.runnerGroupId ||
    !Array.isArray(providerJob.labels) || !providerJob.labels.includes(recipe.runner.label)) {
    qualificationFailure('staging-security-report-binding', 'Provider job execution and dedicated runner assignment verification failed');
  }
  const requiredSteps = ['Prepare private scanner authentication', 'Authenticate exact read-only scanner identity', stagingSecurityWorkflowStep, stagingSecurityWorkflowUploadStep];
  const providerSteps = providerJob.steps;
  if (!Array.isArray(providerSteps) || !requiredSteps.every((name) =>
    providerSteps.filter((step) => isRecord(step) && step.name === name && step.status === 'completed' && step.conclusion === 'success').length === 1) ||
    !requiredSteps.every((name) => job.steps.filter((step) => step.name === name && step.conclusion === 'success').length === 1)) {
    qualificationFailure('staging-security-report-binding', 'Every registered authentication, scan and retention step must actually succeed in the bound job.');
  }

  const startedAt = providerQualificationTimestamp(providerJob.started_at, 'Provider job start');
  const completedAt = providerQualificationTimestamp(providerJob.completed_at, 'Provider job completion');
  const observedAt = qualificationTimestamp(data.observedAt, 'Actual staging security observation time');

  if (Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(observedAt) < Date.parse(startedAt) ||
    Date.parse(observedAt) > Date.parse(completedAt) ||
    Date.parse(completedAt) > observation.now.getTime() ||
    Date.parse(completedAt) - Date.parse(startedAt) > recipe.authority.limits.maxRunMinutes * 60_000) {
    qualificationFailure('staging-security-report-binding', 'Observation timestamps outside valid execution interval');
  }
  if (recipe.target.privateIp === null) {
    if (prereqs.privateAccess !== null) qualificationFailure('staging-security-private-access', 'A public observation cannot claim private network proof.');
  } else {
    const access = qualificationObject(prereqs.privateAccess, ['health', 'schema'], 'Actual private HTTPS observations');
    for (const [key, body] of [['health', health], ['schema', schema]] as const) {
      const witness = qualificationObject(access[key], ['protocol', 'fqdn', 'path', 'observedDnsAddresses', 'peerAddress', 'peerPort',
        'tlsAuthorized', 'tlsPeerCertificate', 'statusCode', 'mediaType', 'bodyDigest', 'bodyBytesLength', 'observedAt'], 'Actual HTTPS witness');
      if (witness.protocol !== 'https:' || witness.fqdn !== recipe.target.fqdn || witness.path !== body.path ||
        witness.peerAddress !== recipe.target.privateIp || witness.peerPort !== 443 || witness.tlsAuthorized !== true ||
        witness.statusCode !== 200 || witness.mediaType !== 'application/json' || witness.bodyDigest !== body.bodyDigest ||
        !Array.isArray(witness.observedDnsAddresses) || witness.observedDnsAddresses.length < 1 ||
        !witness.observedDnsAddresses.every((address) => address === recipe.target.privateIp) ||
        !isRecord(witness.tlsPeerCertificate) || typeof witness.tlsPeerCertificate.fingerprint256 !== 'string' ||
        !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/iu.test(witness.tlsPeerCertificate.fingerprint256)) {
        qualificationFailure('staging-security-private-access', 'Private proof requires the actual same-job DNS, pinned TLS socket peer/certificate and matching bounded response commitments.');
      }
      const witnessTime = qualificationTimestamp(witness.observedAt, 'Actual private HTTPS observation');
      if (Date.parse(witnessTime) < Date.parse(startedAt) || Date.parse(witnessTime) > Date.parse(observedAt)) {
        qualificationFailure('staging-security-private-access', 'The private HTTPS observation is outside the actual security job/report interval.');
      }
    }
  }

  const scans = qualificationObject(data.scans, ['supplyChain', 'dast'], 'Report scans');
  const supplyChain = qualificationObject(scans.supplyChain, ['tool', 'target', 'status', 'exitCode', 'reportDigest', 'findingsCount', 'findings'], 'Supply-chain scan');
  const dast = qualificationObject(scans.dast, ['tool', 'target', 'status', 'exitCode', 'reportDigest', 'alertsCount', 'alerts'], 'DAST scan');

  const scTool = qualificationObject(supplyChain.tool, ['name', 'version', 'binarySha256'], 'Supply-chain tool');
  if (scTool.name !== recipe.tools.containerScanner.name || scTool.version !== recipe.tools.containerScanner.version ||
    scTool.binarySha256 !== recipe.tools.containerScanner.expectedSha256) {
    qualificationFailure('staging-security-report-binding', 'Supply chain scanner tool metadata mismatch');
  }

  const dastTool = qualificationObject(dast.tool, ['name', 'version', 'binarySha256'], 'DAST tool');
  if (dastTool.name !== recipe.tools.dastScanner.name || dastTool.version !== recipe.tools.dastScanner.version ||
    dastTool.binarySha256 !== recipe.tools.dastScanner.expectedSha256) {
    qualificationFailure('staging-security-report-binding', 'DAST scanner tool metadata mismatch');
  }

  qualificationDigest(supplyChain.reportDigest, 'Supply-chain report digest');
  qualificationDigest(dast.reportDigest, 'DAST report digest');

  if (!['passed', 'policy_violation', 'prerequisite_failed'].includes(String(data.overallStatus))) {
    qualificationFailure('staging-security-report', 'Invalid overallStatus value');
  }

  if (supplyChain.target !== `${recipe.image.loginServer}/${recipe.image.repository}@${recipe.image.digest}` ||
    dast.target !== `https://${recipe.target.fqdn}` || supplyChain.exitCode !== 0 ||
    ![0, 1, 2].includes(Number(dast.exitCode)) || !Array.isArray(supplyChain.findings) || !Array.isArray(dast.alerts)) {
    qualificationFailure('staging-security-report-binding', 'The actual scanner target, exit or bounded finding inventory is absent or inconsistent.');
  }
  const findingCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const alertCounts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of supplyChain.findings) {
    if (!isRecord(finding) || typeof finding.vulnerabilityId !== 'string' || !finding.vulnerabilityId ||
      typeof finding.packageName !== 'string' || !finding.packageName || typeof finding.installedVersion !== 'string' ||
      !['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(String(finding.severity))) {
      qualificationFailure('staging-security-report', 'Malformed findings or unknown severity cannot prove a clean security result.');
    }
    const severity = String(finding.severity).toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
    findingCounts[severity]++;
  }
  for (const alert of dast.alerts) {
    if (!isRecord(alert) || typeof alert.pluginId !== 'string' || !alert.pluginId || typeof alert.name !== 'string' ||
      !['HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'].includes(String(alert.risk))) {
      qualificationFailure('staging-security-report', 'Malformed DAST alerts or unknown risk cannot prove a clean scan.');
    }
    if (alert.uri !== undefined && (typeof alert.uri !== 'string' || new URL(alert.uri).origin !== `https://${recipe.target.fqdn}`)) {
      qualificationFailure('staging-security-report', 'A DAST alert names an unapproved target.');
    }
    const risk = alert.risk === 'INFORMATIONAL' ? 'info' : String(alert.risk).toLowerCase() as 'high' | 'medium' | 'low';
    alertCounts[risk]++;
  }
  const supplyPassed = findingCounts.critical === 0 && findingCounts.high === 0;
  const dastPassed = alertCounts.high === 0 && alertCounts.medium === 0;
  const policyPassed = supplyPassed && dastPassed;
  if (canonicalSha256(supplyChain.findingsCount) !== canonicalSha256(findingCounts) ||
    canonicalSha256(dast.alertsCount) !== canonicalSha256(alertCounts) ||
    supplyChain.status !== (supplyPassed ? 'passed' : 'policy_violation') ||
    dast.status !== (dastPassed ? 'passed' : 'policy_violation') ||
    data.overallStatus !== (policyPassed ? 'passed' : 'policy_violation')) {
    qualificationFailure('staging-security-report', 'Scanner status/count assertions differ from the actual finding inventories and registered thresholds.');
  }
  const reportDigest = 'sha256:' + createHash('sha256').update(buf).digest('hex');

  return {
    report,
    reportDigest,
    policyPassed
  };
}

export function assertStagingSecurityReportPassed(verified: VerifiedStagingSecurityReport): void {
  if (verified.report.overallStatus === 'prerequisite_failed') {
    throw new AzureActivationAdmissionError(
      'staging-security-prerequisite-failed',
      'Staging security qualification failed: prerequisite reachability or scanner execution failed.'
    );
  }
  if (!verified.policyPassed || verified.report.overallStatus !== 'passed') {
    throw new AzureActivationAdmissionError(
      'staging-security-policy-violation',
      'Staging security qualification failed: security or DAST findings violate the approved policy thresholds.'
    );
  }
}

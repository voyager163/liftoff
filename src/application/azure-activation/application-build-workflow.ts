import { stringify } from 'yaml';
import {
  applicationObject, applicationRegistryHost, applicationImageRepository, applicationUuid
} from '../../adapters/azure/application-provisioning.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { normalizeApprovalCostCeiling } from '../../domain/governance/activation/approvals.js';
import type { ApprovalCostCeiling } from '../../domain/governance/activation/types.js';
import type { WorkflowFileDefinition } from '../../adapters/github/production-workflows.js';
import { AzureActivationAdmissionError } from './authority.js';
import { applicationBuildWorkflowProgramDelivery } from './application-build-workflow-program.js';

/** Logical source recipe, not the report schema, activation graph or a release qualification. */
export const applicationBuildWorkflowRecipeId = 'liftoff-application-build-workflow.v1';
export const applicationBuildWorkflowJob = 'Liftoff application image build';
export const applicationBuildWorkflowReportFile = 'liftoff-application-build.json';
export const applicationBuildWorkflowIntegration = {
  sourcePhase: 'workflow-source-ready',
  artifactPhase: 'application-artifact-ready',
  publicationAction: 'github.workflow-source.publish',
  dispatchAction: 'github.artifact.build-dispatch',
  readbackAction: 'azure.artifact.readback',
  workflowPermissions: { contents: 'read', actions: 'read' },
  jobPermissions: { contents: 'read', actions: 'read', 'id-token': 'write' },
  jobKey: 'build',
  jobName: applicationBuildWorkflowJob,
  event: 'workflow_dispatch',
  runAttempt: 1,
  dispatchInputs: ['source_sha', 'registry_resource_id', 'image_repository', 'artifact_name', 'platform'],
  correlationInput: 'liftoff_operation_id',
  reportFilename: applicationBuildWorkflowReportFile
} as const;

export const applicationBuildWorkflowRuntimePrerequisites = [
  'The existing GitFlow publisher must observe these exact bytes and actual workflow registration at the approved dispatch commit.',
  'The reviewed recipe and artifact operation must share repository/actor/ref, registry/repository, platform, report name, budget and time ceilings.',
  'Artifact workflow admission must explicitly permit actions:read for exact attempt/job/workflow metadata, while keeping every write permission except job OIDC denied.',
  'The configured Entra client/principal needs a pre-enrolled GitHub federation for this exact repository/ref and api://AzureADTokenExchange, ARM read on this registry, and repository pull/push authorization.',
  'Use the native GitHub-hosted Ubuntu runner for the chosen architecture, Node with fetch/AbortSignal.any, and the exact Docker client/server and system Buildx versions; no tool installation or ambient account fallback is performed.',
  'The operator supplies reviewed immutable upload-artifact and BuildKit image pins. No upstream action or image pin is invented.',
  'Registry metadata/config blob responses must be directly readable at the approved HTTPS registry origin; credential-bearing redirects and foreign blob URLs are refused.',
  'Base-image pulls need public access or the same exact repository scope; no additional registry credentials, secret build arguments, application deployment or promotion are supplied.',
  'The existing combined artifact producer dispatches once and independently validates the named artifact and exact ACR digest using its separately configured readback principal.',
  'This source implementation and its local fixtures do not qualify any live provider, native package or release.'
] as const;

export interface ApplicationBuildWorkflowRecipe {
  schemaVersion: 1;
  recipe: typeof applicationBuildWorkflowRecipeId;
  workflowPath: string;
  repository: string;
  repositoryId: number;
  actorId: number;
  ref: string;
  /** Build identity is explicit and distinct from the later registry-readback caller. */
  azure: { tenantId: string; clientId: string; principalId: string };
  registry: { resourceId: string; loginServer: string; location: string; repository: string };
  artifactName: string;
  platform: 'linux/amd64' | 'linux/arm64';
  context: string;
  /** Relative to the source root, not to context. No generated Dockerfile or build arguments. */
  dockerfile: string;
  tools: { dockerVersion: string; buildxVersion: string; buildkitImage: string };
  uploadArtifactActionSha: string;
  budget: ApprovalCostCeiling;
  limits: {
    maxRunMinutes: number;
    httpTimeoutSeconds: number;
    commandTimeoutSeconds: number;
    buildTimeoutSeconds: number;
  };
}

function fail(): never {
  throw new AzureActivationAdmissionError('application-build-workflow-recipe',
    'Application build source requires the exact versioned public recipe, operator/provider identities, scoped target, reviewed immutable action/BuildKit pins, tool versions and explicit cost/time ceilings.');
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length > 2048 || !pattern.test(value)) fail();
  return value;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) fail();
  return Number(value);
}

function sourcePath(value: unknown, root = false): string {
  if (root && value === '.') return '.';
  const path = text(value, /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/u);
  if (path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) fail();
  return path;
}

export function applicationBuildWorkflowRecipe(value: unknown): ApplicationBuildWorkflowRecipe {
  const data = applicationObject(value, 'Application build source recipe', [
    'schemaVersion', 'recipe', 'workflowPath', 'repository', 'repositoryId', 'actorId', 'ref', 'azure', 'registry',
    'artifactName', 'platform', 'context', 'dockerfile', 'tools', 'uploadArtifactActionSha', 'budget', 'limits'
  ]);
  const azure = applicationObject(data.azure, 'Explicit federated build identity', ['tenantId', 'clientId', 'principalId']);
  const registry = applicationObject(data.registry, 'Exact build registry', ['resourceId', 'loginServer', 'location', 'repository']);
  const tools = applicationObject(data.tools, 'Reviewed build tools', ['dockerVersion', 'buildxVersion', 'buildkitImage']);
  const limits = applicationObject(data.limits, 'Explicit build limits', [
    'maxRunMinutes', 'httpTimeoutSeconds', 'commandTimeoutSeconds', 'buildTimeoutSeconds'
  ]);
  applicationObject(data.budget, 'Explicit build budget', ['currency', 'fixedMonthlyCents', 'usageMonthlyCents']);
  if (data.schemaVersion !== 1 || data.recipe !== applicationBuildWorkflowRecipeId ||
    !['linux/amd64', 'linux/arm64'].includes(String(data.platform))) fail();
  const ref = text(data.ref, /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/u);
  if (ref.includes('..') || ref.split('/').some((part) => !part || part.endsWith('.') || part.endsWith('.lock'))) fail();
  const resourceId = text(registry.resourceId,
    /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[A-Za-z0-9_()-][A-Za-z0-9_.()-]{0,89}\/providers\/Microsoft\.ContainerRegistry\/registries\/[a-z0-9]{5,50}$/u);
  applicationUuid(resourceId.split('/')[2], 'Build registry subscription');
  const loginServer = applicationRegistryHost(registry.loginServer);
  if (loginServer.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) fail();
  const maxRunMinutes = integer(limits.maxRunMinutes, 30);
  const commandTimeoutSeconds = integer(limits.commandTimeoutSeconds, 60);
  const buildTimeoutSeconds = integer(limits.buildTimeoutSeconds, maxRunMinutes * 60 - commandTimeoutSeconds - 70);
  let budget: ApprovalCostCeiling;
  try { budget = normalizeApprovalCostCeiling(data.budget as ApprovalCostCeiling); }
  catch { return fail(); }
  return {
    schemaVersion: 1, recipe: applicationBuildWorkflowRecipeId,
    workflowPath: text(data.workflowPath, /^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u),
    repository: text(data.repository, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u),
    repositoryId: integer(data.repositoryId), actorId: integer(data.actorId), ref,
    azure: {
      tenantId: applicationUuid(azure.tenantId, 'Build tenant'),
      clientId: applicationUuid(azure.clientId, 'Federated build client'),
      principalId: applicationUuid(azure.principalId, 'Federated build principal object')
    },
    registry: {
      resourceId, loginServer,
      location: text(registry.location, /^[a-z0-9-]{1,50}$/u), repository: applicationImageRepository(registry.repository)
    },
    artifactName: text(data.artifactName, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u),
    platform: data.platform as ApplicationBuildWorkflowRecipe['platform'],
    context: sourcePath(data.context, true), dockerfile: sourcePath(data.dockerfile),
    tools: {
      dockerVersion: text(tools.dockerVersion, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u),
      buildxVersion: text(tools.buildxVersion, /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u),
      buildkitImage: text(tools.buildkitImage, /^moby\/buildkit@sha256:[a-f0-9]{64}$/u)
    },
    uploadArtifactActionSha: text(data.uploadArtifactActionSha, /^[a-f0-9]{40}$/u),
    budget,
    limits: {
      maxRunMinutes, buildTimeoutSeconds,
      httpTimeoutSeconds: integer(limits.httpTimeoutSeconds, 30),
      commandTimeoutSeconds
    }
  };
}

export function applicationBuildWorkflowDispatchInputs(value: ApplicationBuildWorkflowRecipe, sourceSha: string) {
  const recipe = applicationBuildWorkflowRecipe(value);
  return {
    source_sha: text(sourceSha, /^[a-f0-9]{40}$/u), registry_resource_id: recipe.registry.resourceId,
    image_repository: recipe.registry.repository, artifact_name: recipe.artifactName, platform: recipe.platform
  };
}

export function renderApplicationBuildWorkflow(value: ApplicationBuildWorkflowRecipe): string {
  const recipe = applicationBuildWorkflowRecipe(value);
  const declarations = [...applicationBuildWorkflowIntegration.dispatchInputs, 'liftoff_operation_id'];
  const program = applicationBuildWorkflowProgramDelivery();
  const content = stringify({
    name: applicationBuildWorkflowJob,
    'run-name': 'liftoff-${{ inputs.liftoff_operation_id }}',
    on: { workflow_dispatch: { inputs: Object.fromEntries(declarations.map((name) =>
      [name, { type: 'string', required: true }])) } },
    permissions: applicationBuildWorkflowIntegration.workflowPermissions,
    jobs: { build: {
      name: applicationBuildWorkflowJob,
      'runs-on': recipe.platform === 'linux/amd64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm',
      permissions: applicationBuildWorkflowIntegration.jobPermissions,
      'timeout-minutes': recipe.limits.maxRunMinutes,
      steps: [
        {
          name: 'Build and verify exact source image',
          'timeout-minutes': recipe.limits.maxRunMinutes,
          shell: 'bash',
          env: {
            GH_TOKEN: '${{ github.token }}',
            LIFTOFF_APPLICATION_BUILD_RECIPE: JSON.stringify(recipe),
            ...program.env,
            ...Object.fromEntries(declarations.map((name) => [
              name === 'liftoff_operation_id' ? 'LIFTOFF_OPERATION_ID' : `LIFTOFF_${name.toUpperCase()}`, `\${{ inputs.${name} }}`
            ]))
          },
          run: program.run
        },
        {
          name: 'Retain exact application build report',
          uses: `actions/upload-artifact@${recipe.uploadArtifactActionSha}`,
          'timeout-minutes': 1,
          with: {
            name: '${{ inputs.artifact_name }}', path: '${{ github.workspace }}/liftoff-application-build.json',
            'if-no-files-found': 'error', 'retention-days': 1, 'include-hidden-files': false,
            'compression-level': 0, overwrite: false
          }
        }
      ]
    } }
  }, { lineWidth: 0 });
  if (Buffer.byteLength(content) > 256 * 1024) fail();
  return content;
}

export interface ApplicationBuildWorkflowSource {
  recipe: typeof applicationBuildWorkflowRecipeId;
  recipeDigest: string;
  files: readonly WorkflowFileDefinition[];
  workflow: { path: string; digest: string; expectedJobs: readonly string[]; event: 'workflow_dispatch'; runAttempt: 1 };
}

/**
 * Feed files to the existing approved GitFlow source producer; this function never writes or dispatches.
 * Bind the returned bytes to the actual published commit/workflow ID before artifact planning.
 * Admission must compare these exact bytes and allow actions:read, not arbitrary permission writes.
 * Native/live release qualification and successful application activation remain separate.
 */
export function applicationBuildWorkflowSource(value: ApplicationBuildWorkflowRecipe): ApplicationBuildWorkflowSource {
  const recipe = applicationBuildWorkflowRecipe(value);
  const content = renderApplicationBuildWorkflow(recipe), digest = canonicalSha256(content);
  return {
    recipe: applicationBuildWorkflowRecipeId, recipeDigest: canonicalSha256(recipe),
    files: [{ path: recipe.workflowPath, content, digest }],
    workflow: { path: recipe.workflowPath, digest, expectedJobs: [applicationBuildWorkflowJob], event: 'workflow_dispatch', runAttempt: 1 }
  };
}

export function assertApplicationBuildWorkflowSource(content: string, value: ApplicationBuildWorkflowRecipe): void {
  if (content !== renderApplicationBuildWorkflow(value)) {
    throw new AzureActivationAdmissionError('application-build-workflow-source',
      'Application workflow bytes differ from the registered reviewed build recipe.');
  }
}

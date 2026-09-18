import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { withProjectMutationLock } from '../../src/adapters/filesystem/project-lock.js';
import type { AzureArmRequest, AzureArmResponse, AzureArmTransport } from '../../src/adapters/azure/activation-rest.js';
import type { GitHubActivationTransport } from '../../src/adapters/github/activation-rest.js';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import type { ActivationConfiguration } from '../../src/domain/governance/activation/types.js';
import type { CommandRunner, CommandResult } from '../../src/process-runner.js';
import { applicationBuildReportFilename } from '../../src/application/azure-activation/application-build-report.js';
import { applicationArtifactInputs, applicationArtifactOperations } from '../../src/application/azure-activation/application-artifact-inputs.js';
import { executeApplicationArtifactReady } from '../../src/application/azure-activation/producer-artifact.js';
import { canonicalPhaseGraph } from '../../src/domain/governance/activation/graph.js';
import { WorkflowGitHubFixture, workflowFixturePath } from './workflow-publication-fixture.js';
import { workflowOperationFixture } from './workflow-operation-fixture.js';

export const applicationSubscription = '11111111-2222-4333-8444-555555555555';
export const applicationTenant = '66666666-7777-4888-8999-000000000001';
export const applicationPrincipal = '11111111-2222-4333-8444-555555555557';
export const applicationRegistryId = `/subscriptions/${applicationSubscription}/resourceGroups/rg-app/providers/Microsoft.ContainerRegistry/registries/crliftoff`;
export const artifactSha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function applicationImageBytes(sourceSha: string) {
  const imageConfig = Buffer.from(JSON.stringify({
    architecture: 'amd64', os: 'linux', config: {
      Labels: { 'org.opencontainers.image.source': 'https://github.com/owner/repo', 'org.opencontainers.image.revision': sourceSha },
      Env: ['CONFIG_BYTES_MUST_NOT_APPEAR_IN_RECORDS=private-fixture-sentinel']
    }
  }));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: artifactSha(imageConfig), size: imageConfig.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${'c'.repeat(64)}`, size: 100 }]
  }));
  return { imageConfig, manifest };
}
export const applicationWorkflowSource = [
  'name: Application build protocol fixture',
  'run-name: liftoff-${{ inputs.liftoff_operation_id }}',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  ...['liftoff_operation_id', 'source_sha', 'registry_resource_id', 'image_repository', 'artifact_name', 'platform'].flatMap((key) =>
    [`      ${key}:`, '        type: string', '        required: true']),
  'permissions:', '  contents: read',
  'jobs:', '  build:', '    name: Node source validation', '    runs-on: ubuntu-24.04', '    timeout-minutes: 5',
  '    steps:', '      - name: Offline protocol fixture, never a qualification run', '        run: echo fixture-only', ''
].join('\n');

export function applicationReportZip(value: unknown, filename = applicationBuildReportFilename): Buffer<ArrayBuffer> {
  const content = Buffer.from(JSON.stringify(value));
  const name = Buffer.from(filename);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), footer = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(1, 8);
  footer.writeUInt16LE(1, 10);
  footer.writeUInt32LE(central.length + name.length, 12);
  footer.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, footer]);
}

export async function applicationArtifactFixture(options: {
  defaultAzure?: boolean;
  defaultGitHub?: boolean;
  source?: string;
  phasePatch?: Record<string, unknown>;
  budget?: boolean;
  sourceSha?: string;
  runId?: number;
  ref?: string;
  existing?: (configuration: ActivationConfiguration, runner: CommandRunner) => Promise<Awaited<ReturnType<typeof workflowOperationFixture>>>;
} = {}) {
  const workflowSource = options.source ?? applicationWorkflowSource;
  const runId = options.runId ?? 100, artifactId = runId - 45;
  const protocol = new WorkflowGitHubFixture(workflowSource, [], options.sourceSha, runId);
  const ref = options.ref ?? 'develop';
  protocol.refs.set(ref, protocol.baseSha);
  const workflow = {
    repository: 'owner/repo', repositoryId: 42, workflowPath: workflowFixturePath, workflowId: 4,
    workflowDigest: canonicalSha256(workflowSource), sourceSha: protocol.baseSha, ref,
    actorId: 7, event: 'workflow_dispatch', expectedJobs: ['Node source validation'], runAttempt: 1
  };
  const { imageConfig, manifest } = applicationImageBytes(protocol.baseSha);
  const imageDigest = artifactSha(manifest);
  const report = {
    schemaVersion: 1, kind: 'liftoff-application-build',
    source: { repository: 'owner/repo', repositoryId: 42, commitSha: protocol.baseSha },
    producer: { workflowId: 4, workflowPath: workflowFixturePath, workflowDigest: workflow.workflowDigest,
      runId, runAttempt: 1, actorId: 7, jobId: runId * 10 },
    image: { registryResourceId: applicationRegistryId, loginServer: 'crliftoff.azurecr.io', repository: 'team/app', digest: imageDigest },
    oci: { manifestBase64: manifest.toString('base64'), configBase64: imageConfig.toString('base64') }
  };
  const dispatchInputs = {
    source_sha: protocol.baseSha, registry_resource_id: applicationRegistryId,
    image_repository: 'team/app', artifact_name: 'application-build-report', platform: 'linux/amd64'
  };
  const phaseInputs: Record<string, unknown> = {
    principalId: applicationPrincipal, resourceGroup: 'rg-app', acrName: 'crliftoff',
    imageName: 'team/app', expectedDigest: imageDigest, workflow, dispatchInputs,
    artifactName: 'application-build-report', platform: 'linux/amd64', maxRunMinutes: 5,
    ...options.phasePatch
  };
  for (const [key, value] of Object.entries(phaseInputs)) if (value === undefined) delete phaseInputs[key];
  const configuration: ActivationConfiguration = {
    schemaVersion: 1,
    azure: { subscriptionId: applicationSubscription, tenantId: applicationTenant, region: 'eastus' },
    ...(options.budget === false ? {} : { budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 } }),
    phases: { 'application-artifact-ready': phaseInputs }
  };
  const artifact = {
    metadata: {
      id: artifactId, name: 'application-build-report', expired: false, digest: '', size_in_bytes: 0,
      workflow_run: { id: runId, repository_id: 42, head_repository_id: 42, head_sha: protocol.baseSha, head_branch: ref }
    },
    bytes: Buffer.alloc(0)
  };
  const setReport = (value: unknown, filename?: string) => {
    artifact.bytes = applicationReportZip(value, filename);
    artifact.metadata.digest = artifactSha(artifact.bytes);
    artifact.metadata.size_in_bytes = artifact.bytes.length;
    protocol.artifacts.set(artifactId, artifact);
  };
  setReport(report);
  let listedArtifacts: Array<Record<string, unknown>> = [artifact.metadata];
  const github: GitHubActivationTransport = {
    async request(request) {
      if (request.method === 'GET' && request.path.split('?')[0] === `/repos/owner/repo/actions/runs/${runId}/artifacts`) {
        protocol.requests.push(structuredClone(request));
        await protocol.beforeRequest?.(request);
        return { status: 200, headers: { 'x-github-request-id': 'PROVIDER-ARTIFACT-LIST' },
          data: { total_count: listedArtifacts.length, artifacts: listedArtifacts } };
      }
      const response = await protocol.request(request);
      return Buffer.isBuffer(response.data) ? { ...response, data: Buffer.from(response.data) } : response;
    }
  };
  const azureRequests: AzureArmRequest[] = [];
  const registry = {
    id: applicationRegistryId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
    properties: { loginServer: 'crliftoff.azurecr.io', provisioningState: 'Succeeded', adminUserEnabled: false }
  };
  let azureResponse: (request: AzureArmRequest) => Promise<AzureArmResponse> = async (request) => {
    if (request.method !== 'GET' || request.resourceId !== applicationRegistryId) throw new Error('Fixture forbids every undeclared ARM endpoint and every ARM mutation.');
    return { status: 200, requestId: randomUUID(), data: registry };
  };
  const azure: AzureArmTransport = { async request(request, binding) {
    if (binding.subscriptionId !== applicationSubscription || binding.tenantId !== applicationTenant || binding.principalId !== applicationPrincipal) {
      throw new Error('Fixture rejects another Azure authority identity.');
    }
    azureRequests.push(structuredClone(request));
    return azureResponse(request);
  } };
  const commands: Array<{ executable: string; args: readonly string[] }> = [];
  let registryManifest: Buffer = Buffer.from(manifest);
  const registryRequests: Array<{ url: string; method: string }> = [];
  let credentialPrincipal = applicationPrincipal;
  const jwt = (claims: Record<string, unknown>) =>
    `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Date.parse('2026-09-15T01:00:00.000Z') / 1000, ...claims })).toString('base64url')}.Zml4dHVyZQ`;
  const success = (command: Parameters<CommandRunner['run']>[0], data: unknown): CommandResult => ({
    command, status: 0, signal: null, timedOut: false,
    stdout: JSON.stringify(data), stderr: '', displayCommand: 'isolated application fixture'
  });
  const runner: CommandRunner = { async run(command, commandOptions) {
    commands.push({ executable: command.executable, args: [...command.args] });
    if (command.executable === 'gh') return protocol.runner.run(command, commandOptions);
    if (command.executable !== 'az') throw new Error('Fixture forbids local scripts and every unregistered provider tool.');
    if (command.args.slice(0, 2).join(' ') === 'account get-access-token') {
      const claims = { oid: credentialPrincipal, tid: applicationTenant, aud: 'https://management.azure.com/' };
      return success(command, { tokenType: 'Bearer', subscription: applicationSubscription, tenant: applicationTenant,
        accessToken: jwt(claims) });
    }
    throw new Error('Fixture forbids every unregistered Azure command.');
  } };
  const fixture = options.existing ? await options.existing(configuration, runner) : await workflowOperationFixture('application-artifact-ready', (inspection) => Promise.resolve(applicationArtifactOperations(
    applicationArtifactInputs({ inspection, phase: canonicalPhaseGraph.phases.find((entry) => entry.id === 'application-artifact-ready')! })
  )), runner, { configuration });
  fixture.input.adapters.githubActivation = { storage: fixture.storage, ...(options.defaultGitHub ? {} : { transport: github }) };
  fixture.input.adapters.azureActivation = { storage: fixture.storage, ...(options.defaultAzure ? {} : { transport: azure }) };
  const config = applicationArtifactInputs(fixture.input);
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url);
    if (url.origin === 'https://management.azure.com') {
      if (init?.method !== 'GET' || init.redirect !== 'error') throw new Error('Fixture forbids ARM writes and redirects.');
      const response = await azure.request({ method: 'GET', resourceId: url.pathname, apiVersion: url.searchParams.get('api-version')! }, config.azure);
      return new Response(JSON.stringify(response.data), {
        status: response.status, headers: response.requestId ? { 'x-ms-request-id': response.requestId } : {}
      });
    }
    if (url.origin !== 'https://crliftoff.azurecr.io') throw new Error('Fixture forbids every foreign HTTP target.');
    registryRequests.push({ url: url.href, method: init?.method ?? 'GET' });
    if (init?.redirect !== 'error') throw new Error('Fixture requires redirect refusal.');
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    if (url.pathname === '/oauth2/exchange' && init?.method === 'POST') {
      if (form.get('grant_type') !== 'access_token' || form.get('tenant') !== applicationTenant ||
        form.get('service') !== 'crliftoff.azurecr.io') throw new Error('Fixture refuses unbound registry token exchange.');
      return new Response(JSON.stringify({ refresh_token: jwt({
        aud: 'crliftoff.azurecr.io', grant_type: 'refresh_token', tenant: applicationTenant
      }) }));
    }
    if (url.pathname === '/oauth2/token' && init?.method === 'POST') {
      if (form.get('grant_type') !== 'refresh_token' || form.get('scope') !== 'repository:team/app:pull' ||
        form.get('service') !== 'crliftoff.azurecr.io') throw new Error('Fixture refuses broader registry credentials.');
      return new Response(JSON.stringify({ access_token: jwt({
        aud: 'crliftoff.azurecr.io', grant_type: 'access_token',
        access: [{ type: 'repository', name: 'team/app', actions: ['pull'] }]
      }) }));
    }
    if (url.pathname === `/v2/team/app/manifests/${imageDigest}` && init?.method === 'GET') {
      if (!new Headers(init.headers).get('authorization')?.startsWith('Bearer ')) throw new Error('Fixture requires the scoped pull credential.');
      return new Response(new Uint8Array(registryManifest), {
        headers: { 'docker-content-digest': imageDigest, 'x-ms-request-id': 'ACR-PROVIDER-READBACK' }
      });
    }
    throw new Error('Fixture forbids catalog/tag selection and every registry mutation.');
  };
  return {
    ...fixture, config, protocol, github, azure, azureRequests, commands, registry, phaseInputs, report, artifact,
    imageDigest, manifest, imageConfig, setReport, fetch, registryRequests,
    setListedArtifacts: (entries: Array<Record<string, unknown>>) => { listedArtifacts = entries; },
    setRegistryManifest: (bytes: Buffer) => { registryManifest = Buffer.from(bytes); },
    setCredentialPrincipal: (principal: string) => { credentialPrincipal = principal; },
    setAzureResponse: (response: typeof azureResponse) => { azureResponse = response; },
    execute: () => withProjectMutationLock(fixture.projectRoot, (lease) => executeApplicationArtifactReady({ ...fixture.input, lease }))
  };
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AzureApplicationRegistryCopyClient, inspectApplicationRegistryOciManifest, verifyApplicationRegistryOciLayer
} from '../src/adapters/azure/application-registry-copy.js';
import {
  applicationRegistryPromotionInputs, applicationRegistryPromotionOperation,
  assertApplicationRegistryPromotionAuthority, createApplicationRegistryPromotionAuthority,
  executeApplicationRegistryPromotion, planApplicationRegistryPromotion,
  readApplicationRegistryPromotionCheckpoint, readApplicationRegistryPromotionSource, readbackApplicationRegistryPromotion,
  recoverApplicationRegistryPromotion, validateApplicationRegistryPromotionConfiguration,
  type ApplicationRegistryPromotionConfiguration, type ApplicationRegistryPromotionResult
} from '../src/application/azure-activation/application-registry-promotion.js';
import {
  applicationArtifactInputs, applicationArtifactOperations
} from '../src/application/azure-activation/application-artifact-inputs.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalJson, canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import {
  canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity
} from '../src/domain/governance/activation/graph.js';
import {
  evaluateApprovalForTransitionPlan, transitionPlanForPhase
} from '../src/domain/governance/activation/approvals.js';
import { evidenceHeaderDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { assertOperationAllowed, planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import {
  validateApprovalEnvelope, validateSavedTransitionPlan
} from '../src/domain/governance/activation/validators.js';
import type {
  ActivationConfiguration, PhaseEvidenceRecord, TransitionOperation
} from '../src/domain/governance/activation/types.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import { executeCompositePhase } from '../src/governance-activation/phase-composite.js';
import {
  activationEvidenceContexts, readActivationInputSnapshot
} from '../src/governance-activation/inputs.js';
import {
  evidenceHeaderFor, evidencePathParts, nextStateForOutcome, saveTransitionPlan,
  transitionPlanPathParts, writeOutcomeTransaction
} from '../src/governance-activation/transition-records.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import {
  applicationArtifactFixture, applicationPrincipal, applicationRegistryId, applicationSubscription, applicationTenant
} from './helpers/application-artifact-fixture.js';

const sourceHost = 'crliftoff.azurecr.io';
const targetHost = 'crstaging.azurecr.io';
const targetId = `/subscriptions/${applicationSubscription}/resourceGroups/rg-staging/providers/Microsoft.ContainerRegistry/registries/crstaging`;
const clientId = '11111111-2222-4333-8444-555555555559';
const now = new Date('2026-09-15T00:00:00.000Z');
const imageType = 'application/vnd.oci.image.manifest.v1+json';
const indexType = 'application/vnd.oci.image.index.v1+json';
const configType = 'application/vnd.oci.image.config.v1+json';
const layerType = 'application/vnd.oci.image.layer.v1.tar+gzip';
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const token = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    exp: now.getTime() / 1000 + 3600, ...claims
  })).toString('base64url')}.${Buffer.from('isolated-http-fixture-not-a-real-signature').toString('base64url')}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

function configuration(): ApplicationRegistryPromotionConfiguration {
  return {
    schemaVersion: 1, mode: 'promote',
    binding: { subscriptionId: applicationSubscription, tenantId: applicationTenant, principalId: applicationPrincipal, clientId },
    sourceBuild: {
      evidenceId: 'original-build', headerDigest: 'a'.repeat(64),
      planPathParts: ['governance', 'plans', 'application-artifact-ready-20260915T000000000Z-aaaaaaaaaaaa.json'],
      savedPlanDigest: 'b'.repeat(64)
    },
    sourceRegistryResourceId: applicationRegistryId, sourceLoginServer: sourceHost, sourceRepository: 'team/app',
    imageDigest: `sha256:${'c'.repeat(64)}`, targetRegistryResourceId: targetId,
    targetLoginServer: targetHost, targetRepository: 'release/app',
    disposableTarget: {
      authorityKind: 'disposable-registry-promotion', environment: 'staging', registryResourceId: targetId,
      operator: 'isolated-workflow-test-operator', spendCeilingCents: 50, maxDurationMinutes: 10,
      permittedEffects: ['azure-read', 'registry-publish'],
      notBefore: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString()
    },
    transfer: {
      maxBlobs: 16, maxManifests: 8, maxBlobBytes: 64 * 1024, maxManifestBytes: 32 * 1024, maxConfigBytes: 32 * 1024,
      maxExpandedLayerBytes: 128 * 1024, maxImageBytes: 256 * 1024, maxTransferBytes: 16 * 1024 * 1024,
      maxRequests: 512, maxWriteRequests: 64, chunkBytes: 1024, requestTimeoutMs: 30_000,
      deadline: new Date(now.getTime() + 600_000).toISOString()
    },
    checkpoint: null
  };
}

function image() {
  const contents = randomBytes(1600);
  const tar = Buffer.alloc(512 + Math.ceil(contents.length / 512) * 512 + 1024);
  tar.write('app/fixture.bin');
  tar.write('0000644\0', 100);
  tar.write('0000000\0', 108);
  tar.write('0000000\0', 116);
  tar.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124);
  tar.write('00000000000\0', 136);
  tar.fill(32, 148, 156);
  tar.write('0', 156);
  tar.write('ustar\0', 257);
  tar.write('00', 263);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  contents.copy(tar, 512);
  const layer = gzipSync(tar);
  const config = Buffer.from(JSON.stringify({
    architecture: 'amd64', os: 'linux',
    rootfs: { type: 'layers', diff_ids: [sha(tar)] },
    config: {
      Labels: { 'org.opencontainers.image.source': 'https://github.com/owner/repo', 'org.opencontainers.image.revision': 'a'.repeat(40) },
      Env: ['PRIVATE_CONFIG_ONLY=must-never-enter-a-promotion-record']
    }
  }));
  const manifestValue = {
    schemaVersion: 2, mediaType: imageType,
    config: { mediaType: configType, digest: sha(config), size: config.length },
    layers: [{ mediaType: layerType, digest: sha(layer), size: layer.length }]
  };
  const manifest = Buffer.from(JSON.stringify(manifestValue));
  return { tar, layer, config, manifest, manifestValue, digest: sha(manifest) };
}

interface HttpRequest {
  origin: string;
  method: string;
  pathname: string;
  queryKeys: string[];
  bodySize: number;
  bodyDigest: string;
  clientCorrelationId: string | null;
  providerRequestId: string;
}

interface ObjectBytes { bytes: Buffer; mediaType: string }
type HttpFault =
  | 'foreign-upload' | 'lost-start' | 'partial-patch' | 'lost-manifest'
  | 'lost-manifest-body' | 'malformed-write' | 'echo-client-id' | 'missing-request-id'
  | 'foreign-blob' | 'partial-source' | 'wrong-digest' | 'malformed-absence' | 'concurrent-target'
  | null;

class RegistryHttpFixture {
  readonly source = new Map<string, ObjectBytes>();
  readonly target = new Map<string, ObjectBytes>();
  readonly uploads = new Map<string, { bytes: Buffer; state: string }>();
  readonly requests: HttpRequest[] = [];
  readonly commandResults: CommandResult[] = [];
  readonly commands: Array<{ executable: string; args: readonly string[] }> = [];
  readonly issuedTokens: string[] = [];
  readonly registries = new Map([
    [applicationRegistryId, {
      id: applicationRegistryId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
      properties: { loginServer: sourceHost, provisioningState: 'Succeeded', adminUserEnabled: false }
    }],
    [targetId, {
      id: targetId, name: 'crstaging', type: 'Microsoft.ContainerRegistry/registries', location: 'eastus',
      properties: { loginServer: targetHost, provisioningState: 'Succeeded', adminUserEnabled: false }
    }]
  ]);
  readonly account: Record<string, unknown> = {
    id: applicationSubscription, tenantId: applicationTenant, state: 'Enabled', environmentName: 'AzureCloud',
    user: { type: 'servicePrincipal', name: clientId }
  };
  readonly aadClaims: Record<string, unknown> = { oid: applicationPrincipal, tid: applicationTenant, appid: clientId, aud: 'https://management.azure.com/' };
  readonly sourceClaims: Record<string, unknown> = {};
  readonly targetClaims: Record<string, unknown> = {};
  readonly refreshClaims: Record<string, unknown> = {};
  beforeEffect: ((request: HttpRequest) => Promise<void>) | undefined;
  fault: HttpFault = null;
  readonly #nativeFetch = globalThis.fetch;
  readonly #server = createServer((request, response) => {
    void this.#route(request, response).catch(() => response.destroy());
  });
  #address = '';
  readonly currentImage = image();

  constructor() {
    const current = this.currentImage;
    this.source.set(`manifests/${current.digest}`, { bytes: current.manifest, mediaType: imageType });
    this.source.set(`blobs/${sha(current.config)}`, { bytes: current.config, mediaType: 'application/octet-stream' });
    this.source.set(`blobs/${sha(current.layer)}`, { bytes: current.layer, mediaType: 'application/octet-stream' });
  }

  async start() {
    this.#server.listen(0, '127.0.0.1');
    await once(this.#server, 'listening');
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Expected isolated IPv4 HTTP listener.');
    this.#address = `http://127.0.0.1:${address.port}`;
    expect((await this.#nativeFetch(`${this.#address}/fixture-health`)).status).toBe(200);
    const transport: typeof globalThis.fetch = async (resource, init) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (!['management.azure.com', sourceHost, targetHost].includes(url.host) || url.protocol !== 'https:') {
        throw new Error('The fixture forbids every real network destination.');
      }
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      headers.set('x-fixture-origin', url.host);
      return this.#nativeFetch(`${this.#address}${url.pathname}${url.search}`, { ...init, headers });
    };
    vi.stubGlobal('fetch', transport);
  }

  async close() {
    const closed = new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
    this.#server.closeAllConnections();
    await closed;
  }

  seedTarget(): void {
    for (const [key, value] of this.source) this.target.set(key, { bytes: Buffer.from(value.bytes), mediaType: value.mediaType });
  }

  get effects(): HttpRequest[] {
    return this.requests.filter((request) => request.origin === targetHost &&
      request.pathname.startsWith('/v2/') && request.method !== 'GET');
  }

  runner(fallback: CommandRunner): CommandRunner {
    return { run: async (command, options) => {
      if (command.executable !== 'az') return fallback.run(command, options);
      this.commands.push({ executable: command.executable, args: [...command.args] });
      expect(options?.stream).toBe(false);
      expect(options?.maxOutputBytes).toBeLessThanOrEqual(64 * 1024);
      expect(command.args).not.toContain('--password');
      let value: unknown;
      if (command.args.slice(0, 2).join(' ') === 'account show') value = this.account;
      else if (command.args.slice(0, 2).join(' ') === 'account get-access-token') {
        const secret = token(this.aadClaims);
        this.issuedTokens.push(secret);
        value = { accessToken: secret, tokenType: 'Bearer', subscription: this.account.id, tenant: this.account.tenantId };
      } else throw new Error('No unregistered Azure CLI command is admitted by the fixture.');
      const result: CommandResult = {
        command, displayCommand: 'isolated private Azure CLI response', status: 0, signal: null,
        stdout: JSON.stringify(value), stderr: '', timedOut: false
      };
      this.commandResults.push(result);
      return result;
    } };
  }

  async #route(request: IncomingMessage, response: ServerResponse) {
    if (request.url === '/fixture-health') { response.writeHead(200).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    for (const chunk of chunks) chunk.fill(0);
    try {
      const url = new URL(`http://fixture${request.url}`);
      const origin = String(request.headers['x-fixture-origin']);
      const method = request.method ?? 'GET';
      const id = randomUUID();
      const observed: HttpRequest = {
        origin, method, pathname: url.pathname, queryKeys: [...url.searchParams.keys()],
        bodySize: bytes.length, bodyDigest: sha(bytes),
        clientCorrelationId: typeof request.headers['x-ms-client-request-id'] === 'string' ? request.headers['x-ms-client-request-id'] : null,
        providerRequestId: id
      };
      this.requests.push(observed);
      response.setHeader('x-ms-request-id', id);
      const json = (value: unknown, status = 200) => {
        response.setHeader('content-type', 'application/json');
        response.writeHead(status).end(JSON.stringify(value));
      };
      if (origin === 'management.azure.com') {
        if (method !== 'GET' || !this.registries.has(url.pathname)) throw new Error('ARM writes and unbound ARM reads are forbidden.');
        expect(request.headers.authorization).toBe(`Bearer ${token(this.aadClaims)}`);
        json(this.registries.get(url.pathname));
        return;
      }
      const source = origin === sourceHost;
      if (!source && origin !== targetHost) throw new Error('Foreign registry request.');
      const repository = source ? 'team/app' : 'release/app';
      if (url.pathname === '/oauth2/exchange') {
        const form = new URLSearchParams(bytes.toString('utf8'));
        expect(method).toBe('POST');
        expect(form.get('grant_type')).toBe('access_token');
        expect(form.get('tenant')).toBe(applicationTenant);
        expect(form.get('service')).toBe(origin);
        expect(form.get('access_token')).toBe(token(this.aadClaims));
        const secret = token({
          aud: origin, grant_type: 'refresh_token', tenant: applicationTenant, sub: applicationPrincipal, ...this.refreshClaims
        });
        this.issuedTokens.push(secret);
        json({ refresh_token: secret });
        return;
      }
      if (url.pathname === '/oauth2/token') {
        const form = new URLSearchParams(bytes.toString('utf8'));
        expect(method).toBe('POST');
        expect(form.get('service')).toBe(origin);
        expect(form.get('grant_type')).toBe('refresh_token');
        const expectedScopes = source ? [`repository:${repository}:pull`] : [`repository:${repository}:pull`, `repository:${repository}:pull,push`];
        expect(expectedScopes).toContain(form.get('scope'));
        const actions = form.get('scope')!.split(':')[2]!.split(',');
        const secret = token({
          aud: origin, grant_type: 'access_token', sub: applicationPrincipal,
          access: [{ type: 'repository', name: repository, actions }], ...(source ? this.sourceClaims : this.targetClaims)
        });
        this.issuedTokens.push(secret);
        json({ access_token: secret });
        return;
      }
      expect(request.headers.authorization?.startsWith('Bearer ')).toBe(true);
      const jwt = request.headers.authorization!.slice(7).split('.');
      const identity: unknown = JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString());
      if (!isRecord(identity) || !Array.isArray(identity.access) || !isRecord(identity.access[0])) throw new Error('Unscoped fixture request.');
      const scope = identity.access[0];
      expect(scope.name).toBe(repository);
      if (source) expect(scope.actions).toEqual(['pull']);
      else expect([['pull'], ['pull', 'push']]).toContainEqual(scope.actions);
      if (method !== 'GET') {
        expect(source).toBe(false);
        expect(scope.actions).toEqual(['pull', 'push']);
        await this.beforeEffect?.(observed);
        if (this.fault === 'echo-client-id') response.setHeader('x-ms-request-id', observed.clientCorrelationId!);
        if (this.fault === 'missing-request-id') response.removeHeader('x-ms-request-id');
      }
      const prefix = `/v2/${repository}/`;
      if (!url.pathname.startsWith(prefix)) throw new Error('Wrong repository scope.');
      const relative = url.pathname.slice(prefix.length);
      const objects = source ? this.source : this.target;
      if (method === 'GET' && /^(?:manifests|blobs)\/sha256:[a-f0-9]{64}$/u.test(relative)) {
        if (!source && this.fault === 'concurrent-target' && relative.startsWith('manifests/') && this.effects.length > 0) this.seedTarget();
        const value = objects.get(relative);
        if (!value) {
          json(this.fault === 'malformed-absence' ? { message: 'unattributable private response' } :
            { errors: [{ code: relative.startsWith('manifests/') ? 'MANIFEST_UNKNOWN' : 'BLOB_UNKNOWN', message: 'exact fixture object absent' }] }, 404);
          return;
        }
        if (source && this.fault === 'foreign-blob' && relative.startsWith('blobs/')) {
          response.writeHead(307, { location: 'https://foreign.example.invalid/blob?sig=must-not-escape' }).end();
          return;
        }
        response.setHeader('content-type', value.mediaType);
        response.setHeader('docker-content-digest', this.fault === 'wrong-digest' ? `sha256:${'f'.repeat(64)}` : relative.split('/')[1]!);
        if (source && this.fault === 'partial-source' && relative.startsWith('blobs/')) {
          response.writeHead(200, { 'content-length': value.bytes.length });
          response.write(value.bytes.subarray(0, 3));
          response.flushHeaders();
          setTimeout(() => response.destroy(), 5);
          return;
        }
        response.setHeader('content-length', value.bytes.length);
        response.writeHead(200).end(value.bytes);
        return;
      }
      if (method === 'POST' && relative === 'blobs/uploads/') {
        expect(bytes.length).toBe(0);
        const uploadId = randomUUID();
        const state = `PRIVATE_VOLATILE_UPLOAD_STATE_${randomUUID()}`;
        this.uploads.set(uploadId, { bytes: Buffer.alloc(0), state });
        if (this.fault === 'lost-start') { response.destroy(); return; }
        response.setHeader('docker-upload-uuid', uploadId);
        response.setHeader('range', '0-0');
        response.setHeader('location', this.fault === 'foreign-upload' ?
          `https://foreign.example.invalid/v2/release/app/blobs/uploads/${uploadId}?sig=private` :
          `https://${targetHost}/v2/release/app/blobs/uploads/${uploadId}?_state=${state}`);
        response.writeHead(202).end();
        return;
      }
      const uploadId = /^blobs\/uploads\/([a-f0-9-]{36})$/u.exec(relative)?.[1];
      if (uploadId) {
        const upload = this.uploads.get(uploadId);
        if (!upload || url.searchParams.get('_state') !== upload.state) {
          json({ errors: [{ code: 'BLOB_UPLOAD_UNKNOWN' }] }, 404);
          return;
        }
        response.setHeader('docker-upload-uuid', uploadId);
        if (method === 'PATCH') {
          expect(request.headers['content-range']).toBe(`${upload.bytes.length}-${upload.bytes.length + bytes.length - 1}`);
          const take = this.fault === 'partial-patch' ? Math.max(1, Math.floor(bytes.length / 2)) : bytes.length;
          upload.bytes = Buffer.concat([upload.bytes, bytes.subarray(0, take)]);
          response.setHeader('range', `0-${upload.bytes.length - 1}`);
          response.setHeader('location', `https://${targetHost}/v2/release/app/blobs/uploads/${uploadId}?_state=${upload.state}`);
          response.writeHead(202).end();
          return;
        }
        if (method === 'PUT') {
          expect(bytes.length).toBe(0);
          expect(url.searchParams.get('digest')).toBe(sha(upload.bytes));
          this.target.set(`blobs/${sha(upload.bytes)}`, { bytes: Buffer.from(upload.bytes), mediaType: 'application/octet-stream' });
          response.setHeader('docker-content-digest', sha(upload.bytes));
          response.setHeader('location', `/v2/release/app/blobs/${sha(upload.bytes)}`);
          response.writeHead(201).end();
          return;
        }
      }
      if (method === 'PUT' && relative.startsWith('manifests/sha256:')) {
        expect(sha(bytes)).toBe(relative.slice('manifests/'.length));
        expect(request.headers['if-none-match']).toBe('*');
        this.target.set(relative, { bytes: Buffer.from(bytes), mediaType: String(request.headers['content-type']) });
        if (this.fault === 'lost-manifest') { response.destroy(); return; }
        response.setHeader('docker-content-digest', sha(bytes));
        if (this.fault === 'lost-manifest-body') {
          response.writeHead(201, { 'content-length': 100 });
          response.write('x');
          response.flushHeaders();
          setTimeout(() => response.destroy(), 5);
          return;
        }
        response.writeHead(this.fault === 'malformed-write' ? 202 : 201).end();
        return;
      }
      throw new Error('The fixture received an undeclared registry operation.');
    } finally { bytes.fill(0); }
  }
}

function commandResult(command: CommandResult['command']): CommandResult {
  return { command, displayCommand: 'isolated fixture has no Git worktree', status: 128, signal: null, stdout: '', stderr: '', timedOut: false };
}

async function approve(
  input: PhaseAdapterExecutionInput, configuration: ActivationConfiguration, operations: readonly TransitionOperation[],
  storage: Awaited<ReturnType<typeof applicationArtifactFixture>>['storage']
): Promise<PhaseAdapterExecutionInput> {
  const inspection = input.inspection;
  inspection.activationInputs = configuration;
  inspection.state.activationInputs = configuration;
  const reader: CommandRunner = { run: async (command) => commandResult(command) };
  const snapshot = await readActivationInputSnapshot(inspection.projectRoot, inspection.manifest, reader);
  inspection.contexts = activationEvidenceContexts(canonicalPhaseGraph, inspection.state, snapshot, now);
  inspection.loadedState = await loadActivationState(inspection.projectRoot);
  const phase = input.phase;
  const context = inspection.contexts[phase.id];
  const recovery = isRecord(configuration.phases['staging-qualified']?.registryPromotion) &&
    configuration.phases['staging-qualified'].registryPromotion.mode === 'recover';
  const requested = transitionPlanForPhase(phase, inspection.state, context.transition, inspection.projectRoot, undefined, {
    operations, selectionScope: 'activation', fileChanges: [], recovery, configuration
  });
  const expiresAt = new Date(now.getTime() + 900_000).toISOString();
  const envelope = validateApprovalEnvelope({
    ...requested, schemaVersion: 4, id: randomUUID(), approvedAt: now.toISOString(),
    expiresAt, approver: 'isolated-workflow-test-operator'
  });
  await writeGovernanceApprovalAuthority(inspection.projectRoot, canonicalSha256(requested), envelope, storage);
  inspection.approvals = [...inspection.approvals, envelope];
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now });
  const plan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: phase.id,
    createdAt: now.toISOString(), expiresAt, identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash,
    stateHash: inspection.loadedState!.contentHash, baselineDigest: context.baselineSha,
    inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
    mutationClasses: phase.allowedMutations, operations,
    approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
      envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(phase), fileChanges: [], recovery, noSecrets: true, configuration
  });
  await saveTransitionPlan(inspection.projectRoot, plan);
  return { ...input, inspection, plan, recovery, clock: () => now };
}

async function producerFixture() {
  const http = new RegistryHttpFixture();
  await http.start();
  cleanups.push(() => http.close());
  const base = await applicationArtifactFixture({ defaultAzure: true, phasePatch: { expectedDigest: undefined } });
  cleanups.push(base.cleanup);
  const original = http.currentImage;
  base.setReport({
    ...base.report, image: { ...base.report.image, digest: original.digest },
    oci: { manifestBase64: original.manifest.toString('base64'), configBase64: original.config.toString('base64') }
  });
  const manifest = structuredClone(base.input.inspection.manifest);
  if (manifest.project.workload.kind === 'components') throw new Error('Expected generated application fixture.');
  manifest.project.workload.environments = ['dev', 'staging'];
  base.input.inspection.manifest = manifest;
  await writeFile(path.join(base.projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
  const runner = http.runner(base.input.runner);
  let input: PhaseAdapterExecutionInput = { ...base.input, runner, clock: () => now };
  const buildConfiguration = structuredClone(input.inspection.activationInputs!);
  input = await approve(input, buildConfiguration, applicationArtifactOperations(applicationArtifactInputs(input)), base.storage);
  const sourcePlan = input.plan;
  const outcome = await withProjectMutationLock(base.projectRoot, (lease) => executeCompositePhase({ ...input, lease }));
  expect(outcome?.status, outcome?.blocker).toBe('completed');
  if (!outcome || outcome.status !== 'completed' || !isRecord(outcome.evidencePayload) || !outcome.outputs) throw new Error('Registered source producer did not complete.');
  const payload = {
    ...outcome.evidencePayload, planDigest: sourcePlan.planDigest, savedPlanDigest: canonicalSha256(sourcePlan), outputBindings: outcome.outputs
  };
  const record: PhaseEvidenceRecord = {
    evidenceId: `application-artifact-ready-${randomUUID()}`,
    header: evidenceHeaderFor({ inspection: input.inspection, phase: input.phase, plan: sourcePlan, result: 'verified',
      now, payload, liveReadback: outcome.liveReadback }),
    payload, liveReadback: outcome.liveReadback
  };
  const reference = { evidenceId: record.evidenceId, headerDigest: evidenceHeaderDigest(record.header), phaseId: 'application-artifact-ready' as const, result: 'verified' as const };
  const nextState = nextStateForOutcome({
    inspection: input.inspection, phase: input.phase, plan: sourcePlan, resultState: 'verified',
    evidenceReference: reference, now, outputs: outcome.outputs, operation: outcome.operation
  });
  await writeOutcomeTransaction({
    projectRoot: base.projectRoot, plan: sourcePlan, nextState, evidenceRecord: record,
    evidencePathParts: evidencePathParts(record.evidenceId), expectedStateHash: input.inspection.loadedState!.contentHash
  });
  input.inspection.state = nextState;
  input.inspection.evidence = [record];
  input.inspection.contexts['application-artifact-ready'] = {
    ...input.inspection.contexts['application-artifact-ready'], evidenceReferences: [reference], reviewedPlans: [sourcePlan], now
  };
  expect(validateEvidenceFreshness(record, input.inspection.contexts['application-artifact-ready']).valid).toBe(true);
  const promotion = configuration();
  promotion.imageDigest = original.digest;
  promotion.sourceBuild = {
    evidenceId: record.evidenceId, headerDigest: reference.headerDigest,
    planPathParts: transitionPlanPathParts(sourcePlan), savedPlanDigest: canonicalSha256(sourcePlan)
  };
  const stage = canonicalPhaseGraph.phases.find((entry) => entry.id === 'staging-qualified')!;
  const sourceInput = async (value = promotion): Promise<PhaseAdapterExecutionInput> => {
    const config = { ...buildConfiguration, phases: {
      ...buildConfiguration.phases, 'staging-qualified': { registryPromotion: value }
    } };
    const inspection = { ...input.inspection, activationInputs: config, state: { ...input.inspection.state, activationInputs: config } };
    const reader: CommandRunner = { run: async (command) => commandResult(command) };
    const snapshot = await readActivationInputSnapshot(base.projectRoot, inspection.manifest, reader);
    inspection.contexts = activationEvidenceContexts(canonicalPhaseGraph, inspection.state, snapshot, now);
    inspection.contexts['application-artifact-ready'].reviewedPlans = [sourcePlan];
    return { ...input, phase: stage, inspection };
  };
  const configureStage = async (value = promotion) => {
    const config = { ...buildConfiguration, phases: {
      ...buildConfiguration.phases, 'staging-qualified': { registryPromotion: value }
    } };
    input = await approve({ ...input, phase: stage }, config,
      [applicationRegistryPromotionOperation(value, config.budget!)], base.storage);
    input.inspection.contexts['application-artifact-ready'].reviewedPlans = [sourcePlan];
    return input;
  };
  const execute = async (value = input): Promise<ApplicationRegistryPromotionResult> =>
    withProjectMutationLock(base.projectRoot, (lease) => executeApplicationRegistryPromotion({ ...value, lease }));
  http.requests.length = 0;
  http.commands.length = 0;
  return {
    ...base, http, record, sourcePlan, original, promotion, configureStage, sourceInput, execute,
    get currentInput() { return input; }
  };
}

async function privateRecords(root: string): Promise<unknown[]> {
  const values: unknown[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.json')) values.push(JSON.parse(await readFile(target, 'utf8')));
    }
  };
  await walk(root);
  return values;
}

const stage = canonicalPhaseGraph.phases.find((entry) => entry.id === 'staging-qualified')!;
const probeOperation = applicationRegistryPromotionOperation(configuration(), { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 });
let registered = false;
try { assertOperationAllowed(stage, probeOperation); registered = true; }
catch (error) {
  if (!(error instanceof Error) || !/not allowlisted|not declared|no declared execution contract/u.test(error.message)) throw error;
}

describe('exact immutable registry-promotion configuration and local OCI bytes', () => {
  it('plans one distinct source-read/target-publish operation without a build, tag, import or deployment', () => {
    const config = validateApplicationRegistryPromotionConfiguration(configuration());
    const operation = applicationRegistryPromotionOperation(config, { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 });
    expect(operation).toMatchObject({
      phaseId: 'staging-qualified', actionId: 'azure.artifact.promote', mutationClass: 'registry-publish',
      adapter: 'azure-opentofu', destination: { identity: targetId }
    });
    expect(operation.effects?.map((effect) => [effect.mutationClass, effect.destination.identity])).toEqual([
      ['azure-read', applicationRegistryId], ['azure-read', targetId]
    ]);
    expect(operation.inputs.registryPromotion).toEqual(config);
    expect(JSON.stringify(operation)).not.toMatch(/latest|build-dispatch|registry-password|access_token/u);
  });

  it.each([
    ['nil principal', (value: ReturnType<typeof configuration>) => { value.binding.principalId = '00000000-0000-0000-0000-000000000000'; }],
    ['wrong target subscription', (value: ReturnType<typeof configuration>) => { value.targetRegistryResourceId = value.targetRegistryResourceId.replace(applicationSubscription, applicationTenant); }],
    ['same registry', (value: ReturnType<typeof configuration>) => { value.targetRegistryResourceId = value.sourceRegistryResourceId; }],
    ['same login server', (value: ReturnType<typeof configuration>) => { value.targetLoginServer = value.sourceLoginServer; }],
    ['foreign registry host', (value: ReturnType<typeof configuration>) => { value.targetLoginServer = 'example.invalid'; }],
    ['credential-bearing host', (value: ReturnType<typeof configuration>) => { value.targetLoginServer = `user:password@${targetHost}`; }],
    ['tag instead of digest', (value: ReturnType<typeof configuration>) => { value.imageDigest = 'latest'; }],
    ['different disposable target', (value: ReturnType<typeof configuration>) => { value.disposableTarget.registryResourceId = applicationRegistryId; }],
    ['negative spend', (value: ReturnType<typeof configuration>) => { value.disposableTarget.spendCeilingCents = -1; }],
    ['expanded effect list', (value: ReturnType<typeof configuration>) => { Object.assign(value.disposableTarget, { permittedEffects: ['azure-read', 'registry-publish', 'azure-resource-provision'] }); }],
    ['deadline expansion', (value: ReturnType<typeof configuration>) => { value.transfer.deadline = '2026-09-16T00:00:00.000Z'; }],
    ['unbounded bytes', (value: ReturnType<typeof configuration>) => { value.transfer.maxTransferBytes = Number.MAX_SAFE_INTEGER; }],
    ['unbounded writes', (value: ReturnType<typeof configuration>) => { value.transfer.maxWriteRequests = 513; }],
    ['zero chunk', (value: ReturnType<typeof configuration>) => { value.transfer.chunkBytes = 0; }],
    ['missing recovery identity', (value: ReturnType<typeof configuration>) => { value.mode = 'recover'; }],
    ['foreign source plan path', (value: ReturnType<typeof configuration>) => { value.sourceBuild.planPathParts = ['..', 'credential.json']; }]
  ] as const)('rejects %s before all credential/provider access', (_label, mutate) => {
    const config = configuration();
    mutate(config);
    expect(() => validateApplicationRegistryPromotionConfiguration(config)).toThrow();
  });

  it('rejects authorization booleans, callbacks, token fields and aliases', () => {
    for (const field of ['authorized', 'approve', 'readback', 'credentials', 'accessToken', 'targetTag']) {
      expect(() => validateApplicationRegistryPromotionConfiguration({ ...configuration(), [field]: field === 'approve' ? () => true : true })).toThrow();
    }
  });

  it('rejects structural authority and fabricated readback objects without touching credentials', async () => {
    // @ts-expect-error A negative runtime test must not get a branded authority by structural typing.
    await expect(assertApplicationRegistryPromotionAuthority({ assertCurrent: async () => undefined })).rejects.toThrow(/forged/u);
    // @ts-expect-error A fabricated receipt does not have the private byte-verification issuance.
    expect(() => AzureApplicationRegistryCopyClient.assertIssuedReadback({}, {})).toThrow(/actual target bytes/u);
  });

  it('parses exact OCI manifests and concrete platform-bound indexes from real local bytes', () => {
    const built = image();
    expect(inspectApplicationRegistryOciManifest(built.manifest, built.digest, configuration().transfer)).toEqual({
      kind: 'image', mediaType: imageType, config: built.manifestValue.config, layers: built.manifestValue.layers
    });
    const index = Buffer.from(JSON.stringify({
      schemaVersion: 2, mediaType: indexType, manifests: [{
        digest: built.digest, size: built.manifest.length, mediaType: imageType, platform: { os: 'linux', architecture: 'amd64' }
      }]
    }));
    expect(inspectApplicationRegistryOciManifest(index, sha(index), configuration().transfer).kind).toBe('index');
  });

  it.each(['foreign-url', 'embedded-data', 'foreign-layer-type', 'manifest-hash', 'descriptor-size', 'manifest-size', 'wrong-config-type', 'subject', 'schema'] as const)(
    'rejects OCI %s rather than inferring an image or following another origin', (kind) => {
      const built = image();
      const document = structuredClone(built.manifestValue);
      if (kind === 'foreign-url') Object.assign(document.layers[0]!, { urls: ['https://foreign.invalid/layer?sig=private'] });
      if (kind === 'embedded-data') Object.assign(document.layers[0]!, { data: Buffer.from('embedded bytes').toString('base64') });
      if (kind === 'foreign-layer-type') document.layers[0]!.mediaType = 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip';
      if (kind === 'descriptor-size') document.layers[0]!.size = 2 ** 31;
      if (kind === 'wrong-config-type') document.config.mediaType = 'application/octet-stream';
      if (kind === 'subject') Object.assign(document, { subject: document.config });
      if (kind === 'schema') document.schemaVersion = 1;
      const bytes = Buffer.from(JSON.stringify(document));
      const bounds = configuration().transfer;
      if (kind === 'manifest-size') bounds.maxManifestBytes = bytes.length - 1;
      expect(() => inspectApplicationRegistryOciManifest(bytes, kind === 'manifest-hash' ? `sha256:${'d'.repeat(64)}` : sha(bytes), bounds)).toThrow();
    }
  );

  it.each(['missing-platform', 'foreign-os', 'feature-expansion', 'duplicate-child', 'empty', 'index-size'] as const)(
    'rejects %s in an OCI index', (kind) => {
      const built = image();
      const child: Record<string, unknown> = {
        digest: built.digest, size: built.manifest.length, mediaType: imageType,
        platform: { os: 'linux', architecture: 'amd64' }
      };
      if (kind === 'missing-platform') delete child.platform;
      if (kind === 'foreign-os') child.platform = { os: 'windows', architecture: 'amd64' };
      if (kind === 'feature-expansion') child.platform = { os: 'linux', architecture: 'amd64', 'os.features': ['foreign'] };
      const bytes = Buffer.from(JSON.stringify({
        schemaVersion: 2, mediaType: indexType, manifests: kind === 'empty' ? [] : kind === 'duplicate-child' ? [child, child] : [child]
      }));
      const bounds = configuration().transfer;
      if (kind === 'index-size') bounds.maxManifests = 0;
      expect(() => inspectApplicationRegistryOciManifest(bytes, sha(bytes), bounds)).toThrow();
    }
  );

  it.each(['gzip', 'zstd', 'tar'] as const)('verifies actual %s layer digest, length, expansion and rootfs diff ID', async (encoding) => {
    const built = image();
    const bytes = encoding === 'gzip' ? built.layer : encoding === 'zstd' ? zstdCompressSync(built.tar) : built.tar;
    const mediaType = encoding === 'gzip' ? layerType : `application/vnd.oci.image.layer.v1.tar${encoding === 'zstd' ? '+zstd' : ''}`;
    expect(await verifyApplicationRegistryOciLayer({
      bytes, descriptor: { digest: sha(bytes), size: bytes.length, mediaType }, diffId: sha(built.tar),
      maxExpandedBytes: built.tar.length, timeoutMs: 1000
    })).toEqual({ digest: sha(bytes), diffId: sha(built.tar), compressedBytes: bytes.length, expandedBytes: built.tar.length });
  });

  it.each(['hash', 'size', 'diff-id', 'expansion', 'encoding', 'foreign-type'] as const)(
    'refuses a layer with wrong %s with no disk extraction', async (kind) => {
      const built = image();
      const bytes = kind === 'encoding' ? Buffer.from('not a gzip stream') : built.layer;
      await expect(verifyApplicationRegistryOciLayer({
        bytes,
        descriptor: {
          digest: kind === 'hash' ? `sha256:${'f'.repeat(64)}` : sha(bytes),
          size: kind === 'size' ? bytes.length + 1 : bytes.length,
          mediaType: kind === 'foreign-type' ? 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip' : layerType
        },
        diffId: kind === 'diff-id' ? `sha256:${'f'.repeat(64)}` : sha(built.tar),
        maxExpandedBytes: kind === 'expansion' ? built.tar.length - 1 : built.tar.length, timeoutMs: 1000
      })).rejects.toThrow();
    }
  );
});

describe('real registered source producer and honest future-action boundary', () => {
  it('obtains source evidence from the registered build producer using default ARM/ACR HTTP and actual local OCI bytes', async () => {
    const f = await producerFixture();
    expect(f.record.payload).toMatchObject({
      kind: 'application-artifact-ready.v1', digest: f.original.digest,
      provenance: { configDigest: sha(f.original.config), registryResourceId: applicationRegistryId, sourceSha: 'a'.repeat(40) }
    });
    const bytes = await readFile(path.join(f.projectRoot, ...evidencePathParts(f.record.evidenceId)), 'utf8');
    expect(JSON.parse(bytes)).toEqual(f.record);
    const records = await privateRecords(f.home);
    expect(records.some((record) => isRecord(record) && record.kind === 'github-workflow-effect-prepared')).toBe(true);
    expect(f.http.commandResults.every((result) => result.stdout === '' && result.stderr === '')).toBe(true);
    expect(f.http.effects).toHaveLength(0);
    expect(bytes).not.toContain('PRIVATE_CONFIG_ONLY');
    const verified = await readApplicationRegistryPromotionSource(await f.sourceInput());
    expect(verified).toMatchObject({
      reference: f.promotion.sourceBuild,
      provenance: { imageRef: `${sourceHost}/team/app@${f.original.digest}`, configDigest: sha(f.original.config), runId: 100, jobId: 1000 },
      originalPlanDigest: f.sourcePlan.planDigest, originalApprovalEnvelopeHash: f.sourcePlan.approval.envelopeHash
    });
    expect(verified.originalDispatchDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.http.requests).toHaveLength(0);
    expect(f.http.commands).toHaveLength(0);
  });

  it.each(['header', 'saved-plan', 'digest', 'repository', 'source-registry', 'missing-approval', 'injected-record', 'unreferenced'] as const)(
    'rejects an original source with wrong %s through the actual source-custody verifier', async (kind) => {
      const f = await producerFixture();
      const config = structuredClone(f.promotion);
      if (kind === 'header') config.sourceBuild.headerDigest = 'f'.repeat(64);
      if (kind === 'saved-plan') config.sourceBuild.savedPlanDigest = 'f'.repeat(64);
      if (kind === 'digest') config.imageDigest = `sha256:${'f'.repeat(64)}`;
      if (kind === 'repository') config.sourceRepository = 'other/app';
      if (kind === 'source-registry') config.sourceRegistryResourceId = applicationRegistryId.replace('crliftoff', 'crother');
      const input = await f.sourceInput(config);
      if (kind === 'missing-approval') input.inspection.approvals = [];
      if (kind === 'injected-record') input.inspection.evidence = [{ ...f.record, payload: { kind: 'application-artifact-ready.v1', verified: true } }];
      if (kind === 'unreferenced') {
        input.inspection.state = structuredClone(input.inspection.state);
        input.inspection.state.phases['application-artifact-ready'].evidence = [];
      }
      await expect(readApplicationRegistryPromotionSource(input)).rejects.toThrow();
      expect(f.http.requests).toHaveLength(0);
      expect(f.http.commands).toHaveLength(0);
    }
  );

  it('never simulates canonical registration or replaces the real authority guard', () => {
    if (registered) expect(() => assertOperationAllowed(stage, probeOperation)).not.toThrow();
    else expect(() => assertOperationAllowed(stage, probeOperation)).toThrow(/not allowlisted|not declared|no declared execution contract/u);
  });
});

// These tests require the coordinator's real registration. No graph mutation,
// approval mocks, injected success readbacks or fabricated source receipts enable them.
describe.skipIf(!registered)('registered promotion: real HTTP, issued private approval and held project lease', () => {
  it('copies exact config/layer/manifest bytes to the different ACR and independently re-reads them', async () => {
    const f = await producerFixture();
    await f.configureStage();
    f.http.beforeEffect = async (request) => {
      const records = await privateRecords(f.home);
      expect(records.some((record) => isRecord(record) &&
        record.clientCorrelationId === request.clientCorrelationId && record.preparedAt === now.toISOString())).toBe(true);
    };
    const result = await f.execute();
    expect(result.status, result.status === 'blocked' ? result.blocker : undefined).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.disposition).toBe('copied');
    expect(result.receipt).toMatchObject({
      sourceRegistryResourceId: applicationRegistryId, targetRegistryResourceId: targetId, imageDigest: f.original.digest,
      sourceImageRef: `${sourceHost}/team/app@${f.original.digest}`, targetImageRef: `${targetHost}/release/app@${f.original.digest}`,
      source: { provenance: { registryResourceId: applicationRegistryId, configDigest: sha(f.original.config) } }
    });
    expect(f.http.target.get(`manifests/${f.original.digest}`)?.bytes.equals(f.original.manifest)).toBe(true);
    expect(f.http.target.get(`blobs/${sha(f.original.config)}`)?.bytes.equals(f.original.config)).toBe(true);
    expect(f.http.target.get(`blobs/${sha(f.original.layer)}`)?.bytes.equals(f.original.layer)).toBe(true);
    const effects = f.http.effects;
    expect(effects.some((request) => request.method === 'PATCH')).toBe(true);
    expect(effects.every((request) => request.pathname.startsWith('/v2/release/app/') && request.clientCorrelationId &&
      request.clientCorrelationId !== request.providerRequestId)).toBe(true);
    expect(effects.filter((request) => request.pathname.includes('/manifests/')).map((request) => request.pathname))
      .toEqual([`/v2/release/app/manifests/${f.original.digest}`]);
    const records = JSON.stringify(await privateRecords(f.home));
    const publicResult = JSON.stringify(result);
    for (const secret of f.http.issuedTokens) {
      expect(records).not.toContain(secret);
      expect(publicResult).not.toContain(secret);
      expect(JSON.stringify(f.http.commands)).not.toContain(secret);
    }
    expect(records).not.toMatch(/PRIVATE_VOLATILE_UPLOAD_STATE|PRIVATE_CONFIG_ONLY|_state=|[?&]sig=/u);
    expect(publicResult).not.toMatch(/PRIVATE_VOLATILE_UPLOAD_STATE|PRIVATE_CONFIG_ONLY|_state=|[?&]sig=/u);
    expect(f.http.commandResults.every((value) => value.stdout === '' && value.stderr === '')).toBe(true);
    expect(result.usage.writeRequests).toBe(effects.length);
    expect(result.usage.transferredBytes).toBeLessThanOrEqual(f.promotion.transfer.maxTransferBytes);
  });

  it('uses zero registry writes for an existing identical target and for a retry', async () => {
    const f = await producerFixture();
    f.http.seedTarget();
    await f.configureStage();
    const first = await f.execute();
    expect(first.status).toBe('completed');
    expect(first.status === 'completed' && first.disposition).toBe('already-present');
    const second = await f.execute();
    expect(second.status).toBe('completed');
    expect(f.http.effects).toHaveLength(0);
    expect(f.http.requests.filter((request) => request.method === 'GET' && request.origin === targetHost &&
      request.pathname.includes('/blobs/')).length).toBeGreaterThanOrEqual(4);
  });

  it('does not overwrite conflicting target bytes, even at an asserted digest', async () => {
    const f = await producerFixture();
    await f.configureStage();
    f.http.target.set(`manifests/${f.original.digest}`, { bytes: Buffer.from('conflicting target'), mediaType: imageType });
    const result = await f.execute();
    expect(result.status).toBe('blocked');
    expect(f.http.effects).toHaveLength(0);
    expect(f.http.target.get(`manifests/${f.original.digest}`)?.bytes.toString()).toBe('conflicting target');
  });

  it('adopts only exact independently read concurrent target bytes without overwriting its manifest', async () => {
    const f = await producerFixture();
    await f.configureStage();
    f.http.fault = 'concurrent-target';
    const result = await f.execute();
    expect(result.status, result.status === 'blocked' ? result.blocker : undefined).toBe('completed');
    expect(f.http.effects.filter((request) => request.pathname.includes('/manifests/'))).toHaveLength(0);
  });

  it.each(['no-lease', 'fake-lease', 'unissued-approval', 'actor-change', 'binding-change', 'deadline-change', 'plan-operation-change'] as const)(
    'refuses %s before credentials or provider access', async (kind) => {
      const f = await producerFixture();
      const input = await f.configureStage();
      if (kind === 'unissued-approval') {
        input.inspection.approvals = input.inspection.approvals.map((envelope) => envelope.id === input.plan.approval.envelopeId
          ? { ...envelope, approver: 'unissued-operator' } : envelope);
      }
      if (kind === 'actor-change') f.promotion.binding.principalId = clientId;
      if (kind === 'binding-change') f.promotion.sourceRepository = 'other/source';
      if (kind === 'deadline-change') input.clock = () => new Date(now.getTime() + 700_000);
      if (kind === 'plan-operation-change') input.plan.operations = [...input.plan.operations, input.plan.operations[0]!];
      const result = kind === 'no-lease' ? await executeApplicationRegistryPromotion(input) :
        kind === 'fake-lease' ? await executeApplicationRegistryPromotion({ ...input, lease: { assertHeld: async () => undefined } }) :
          await f.execute(input);
      expect(result.status).toBe('blocked');
      expect(f.http.requests).toHaveLength(0);
      expect(f.http.commands).toHaveLength(0);
    }
  );

  it.each(['disabled', 'subscription', 'tenant', 'principal', 'client', 'cloud', 'expired', 'premature', 'audience'] as const)(
    'rejects the actual wrong Azure account/token %s before registry access', async (kind) => {
      const f = await producerFixture();
      await f.configureStage();
      if (kind === 'disabled') f.http.account.state = 'Disabled';
      if (kind === 'subscription') f.http.account.id = applicationTenant;
      if (kind === 'tenant') f.http.account.tenantId = applicationSubscription;
      if (kind === 'principal') f.http.aadClaims.oid = clientId;
      if (kind === 'client') f.http.aadClaims.appid = applicationPrincipal;
      if (kind === 'cloud') f.http.account.environmentName = 'AzureUSGovernment';
      if (kind === 'expired') f.http.aadClaims.exp = now.getTime() / 1000;
      if (kind === 'premature') f.http.aadClaims.nbf = now.getTime() / 1000 + 5000;
      if (kind === 'audience') f.http.aadClaims.aud = 'https://foreign.example.invalid';
      expect((await f.execute()).status).toBe('blocked');
      expect(f.http.requests.some((request) => request.origin !== 'management.azure.com')).toBe(false);
      expect(f.http.effects).toHaveLength(0);
    }
  );

  it.each(['source-id', 'target-id', 'source-host', 'target-host', 'source-admin', 'target-admin'] as const)(
    'independently rejects wrong ARM %s before all registry writes', async (kind) => {
      const f = await producerFixture();
      await f.configureStage();
      const registry = f.http.registries.get(kind.startsWith('source') ? applicationRegistryId : targetId)!;
      if (kind.endsWith('-id')) registry.id = kind.startsWith('source') ? targetId : applicationRegistryId;
      if (kind.endsWith('-host')) registry.properties.loginServer = 'another.azurecr.io';
      if (kind.endsWith('-admin')) registry.properties.adminUserEnabled = true;
      expect((await f.execute()).status).toBe('blocked');
      expect(f.http.effects).toHaveLength(0);
    }
  );

  it.each(['source-push', 'source-repository', 'target-broad', 'target-repository', 'source-actor', 'target-actor', 'refresh-tenant', 'target-audience'] as const)(
    'rejects wrong scoped token %s rather than treating exchange success as authority', async (kind) => {
      const f = await producerFixture();
      await f.configureStage();
      if (kind === 'source-push') f.http.sourceClaims.access = [{ type: 'repository', name: 'team/app', actions: ['pull', 'push'] }];
      if (kind === 'source-repository') f.http.sourceClaims.access = [{ type: 'repository', name: 'other/app', actions: ['pull'] }];
      if (kind === 'target-broad') f.http.targetClaims.access = [{ type: 'repository', name: 'release/app', actions: ['pull', 'push', 'delete'] }];
      if (kind === 'target-repository') f.http.targetClaims.access = [{ type: 'repository', name: 'team/app', actions: ['pull', 'push'] }];
      if (kind === 'source-actor') f.http.sourceClaims.sub = clientId;
      if (kind === 'target-actor') f.http.targetClaims.sub = clientId;
      if (kind === 'refresh-tenant') f.http.refreshClaims.tenant = applicationSubscription;
      if (kind === 'target-audience') f.http.targetClaims.aud = sourceHost;
      expect((await f.execute()).status).toBe('blocked');
      expect(f.http.effects).toHaveLength(0);
      expect(f.http.requests.some((request) => request.pathname.startsWith('/v2/'))).toBe(false);
    }
  );

  it.each(['foreign-blob', 'partial-source', 'wrong-digest', 'malformed-absence'] as const)(
    'stops on real HTTP %s without a provider write or fabricated completion', async (fault) => {
      const f = await producerFixture();
      await f.configureStage();
      f.http.fault = fault;
      const result = await f.execute();
      expect(result.status).toBe('blocked');
      expect(f.http.effects).toHaveLength(0);
      expect(JSON.stringify(result)).not.toMatch(/must-not-escape|unattributable private response/u);
    }
  );

  it.each(['foreign-upload', 'lost-start', 'partial-patch', 'echo-client-id', 'missing-request-id'] as const)(
    'preserves original private effects after %s and never blindly repeats on retry', async (fault) => {
      const f = await producerFixture();
      await f.configureStage();
      f.http.fault = fault;
      const first = await f.execute();
      expect(first.status).toBe('blocked');
      if (first.status !== 'blocked') return;
      expect(first.checkpoint).not.toBeNull();
      expect(first.effects.length).toBeGreaterThan(0);
      const count = f.http.effects.length;
      f.http.fault = null;
      const second = await f.execute();
      expect(second.status).toBe('blocked');
      expect(f.http.effects).toHaveLength(count);
      expect(second.status === 'blocked' && second.checkpoint).toEqual(first.checkpoint);
      const serialized = JSON.stringify(await privateRecords(f.home));
      expect(serialized).not.toMatch(/PRIVATE_VOLATILE_UPLOAD_STATE|_state=|foreign\.example|[?&]sig=/u);
      if (fault === 'partial-patch') {
        expect(first.effects.some((effect) => effect.response?.uploadId && effect.response.uploadState === 'volatile-state-required')).toBe(true);
      }
      if (fault === 'lost-start') expect(first.effects[0]?.response).toBeNull();
    }
  );

  it.each(['lost-manifest', 'lost-manifest-body', 'malformed-write'] as const)(
    'recovers %s only through actual exact target byte readback under a new issued approval', async (fault) => {
      const f = await producerFixture();
      await f.configureStage();
      f.http.fault = fault;
      const first = await f.execute();
      expect(first.status).toBe('blocked');
      if (first.status !== 'blocked' || !first.checkpoint) throw new Error('Expected retained promotion custody.');
      const effect = first.effects.at(-1)!;
      expect(effect.prepared.kind).toBe('put-manifest');
      if (fault === 'lost-manifest-body') expect(effect.response?.providerRequestId).toBeTruthy();
      const writes = f.http.effects.length;
      f.http.fault = null;
      const recover = { ...f.promotion, mode: 'recover' as const, checkpoint: first.checkpoint };
      const input = await f.configureStage(recover);
      const result = await withProjectMutationLock(f.projectRoot, (lease) => recoverApplicationRegistryPromotion({ ...input, lease }));
      expect(result.status, result.status === 'blocked' ? result.blocker : undefined).toBe('completed');
      expect(result.status === 'completed' && result.disposition).toBe('recovered');
      expect(f.http.effects).toHaveLength(writes);
      expect(result.status === 'completed' && result.receipt.checkpoint).toEqual(first.checkpoint);
    }
  );

  it('requires the exact original recovery reference and does not choose a latest operation', async () => {
    const f = await producerFixture();
    await f.configureStage();
    f.http.fault = 'lost-start';
    const first = await f.execute();
    if (first.status !== 'blocked' || !first.checkpoint) throw new Error('Expected retained upload start.');
    const input = await f.configureStage({
      ...f.promotion, mode: 'recover', checkpoint: { ...first.checkpoint, preparedDigest: 'e'.repeat(64) }
    });
    f.http.requests.length = 0;
    await expect(f.execute(input)).rejects.toThrow(/checkpoint|metadata/u);
    expect(f.http.requests).toHaveLength(0);
  });

  it.each(['writes', 'blob-count', 'image-bytes', 'requests', 'expanded-bytes', 'deadline'] as const)(
    'enforces the concrete %s bound, not a nominal success flag', async (bound) => {
      const f = await producerFixture();
      if (bound === 'writes') f.promotion.transfer.maxWriteRequests = 1;
      if (bound === 'blob-count') f.promotion.transfer.maxBlobs = 1;
      if (bound === 'image-bytes') {
        f.promotion.transfer.maxImageBytes = 1024;
        f.promotion.transfer.maxBlobBytes = 1024;
        f.promotion.transfer.maxConfigBytes = 1024;
        f.promotion.transfer.maxManifestBytes = 1024;
      }
      if (bound === 'requests') {
        f.promotion.transfer.maxRequests = 1;
        f.promotion.transfer.maxWriteRequests = 1;
      }
      if (bound === 'expanded-bytes') f.promotion.transfer.maxExpandedLayerBytes = f.original.tar.length - 1;
      const input = await f.configureStage();
      if (bound === 'deadline') input.clock = () => new Date(Date.parse(f.promotion.transfer.deadline));
      expect((await f.execute(input)).status).toBe('blocked');
      expect(f.http.effects).toHaveLength(0);
    }
  );

  it('uses readback mode without acquiring target push permission or writing registry bytes', async () => {
    const f = await producerFixture();
    f.http.seedTarget();
    const input = await f.configureStage({ ...f.promotion, mode: 'readback' });
    const result = await withProjectMutationLock(f.projectRoot, (lease) => readbackApplicationRegistryPromotion({ ...input, lease }));
    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.disposition).toBe('readback');
    expect(f.http.effects).toHaveLength(0);
    expect(f.http.issuedTokens.map((secret) => {
      const value: unknown = JSON.parse(Buffer.from(secret.split('.')[1]!, 'base64url').toString('utf8'));
      return value;
    }).filter((value) => isRecord(value) && value.aud === targetHost && value.grant_type === 'access_token'))
      .toMatchObject([{ access: [{ type: 'repository', name: 'release/app', actions: ['pull'] }] }]);
  });

  it('cannot complete authority with an injected success-shaped readback', async () => {
    const f = await producerFixture();
    const input = await f.configureStage();
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const authority = await createApplicationRegistryPromotionAuthority({ ...input, lease });
      // @ts-expect-error Only the actual independently issued readback can complete.
      await expect(authority.complete({ schemaVersion: 1, imageDigest: f.original.digest })).rejects.toThrow(/actual target bytes/u);
      expect(await readApplicationRegistryPromotionCheckpoint(authority)).toBeNull();
    });
    expect(f.http.effects).toHaveLength(0);
  });

  it('keeps live readback custody bound to the exact issued authority across completion composition', async () => {
    const f = await producerFixture();
    f.http.seedTarget();
    const input = await f.configureStage({ ...f.promotion, mode: 'readback' });
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const authority = await createApplicationRegistryPromotionAuthority({ ...input, lease });
      const other = await createApplicationRegistryPromotionAuthority({ ...input, lease });
      const client = new AzureApplicationRegistryCopyClient(authority);
      authority.enter();
      try {
        const readback = await client.execute();
        const decoded = AzureApplicationRegistryCopyClient.validateReadback(readback);
        expect(decoded).toEqual(readback);
        expect(decoded).not.toBe(readback);
        for (const unissued of [structuredClone(readback), decoded]) {
          await expect(authority.complete(unissued)).rejects.toMatchObject({ code: 'registry-copy-readback-authority' });
        }
        const observation = readback.targetBlobs[0]!;
        const requestId = observation.requestId;
        observation.requestId = randomUUID();
        await expect(authority.complete(readback)).rejects.toMatchObject({ code: 'registry-copy-readback-authority' });
        observation.requestId = requestId;
        await expect(other.complete(readback)).rejects.toMatchObject({ code: 'registry-copy-readback-authority' });
        await expect(authority.complete.call(other, readback)).rejects.toMatchObject({ code: 'registry-promotion-authority' });
        const forged = { ...authority, assertCurrent: vi.fn(async () => undefined) };
        // @ts-expect-error Copying public members cannot copy private admission.
        await expect(authority.complete.call(forged, readback)).rejects.toMatchObject({ code: 'registry-promotion-authority' });
        expect(forged.assertCurrent).not.toHaveBeenCalled();
        expect(await readApplicationRegistryPromotionCheckpoint(authority)).toBeNull();
        const receipt = await authority.complete(readback);
        Object.defineProperty(authority, 'configuration', {
          value: { ...authority.configuration, targetLoginServer: 'other.azurecr.io', targetRepository: 'other/image' }
        });
        expect(await authority.complete(readback)).toEqual(receipt);
        expect((await readApplicationRegistryPromotionCheckpoint(authority))?.completed).toEqual(receipt);
        await expect(assertApplicationRegistryPromotionAuthority(authority)).resolves.toBeUndefined();
      } finally {
        client.dispose();
        authority.leave();
      }
    });
    expect(f.http.effects).toHaveLength(0);
  });

  it('rejects changes to actual original build evidence rather than accepting injected inspection success', async () => {
    const f = await producerFixture();
    const input = await f.configureStage();
    await writeFile(path.join(f.projectRoot, ...evidencePathParts(f.record.evidenceId)), JSON.stringify({ ...f.record, evidenceId: 'another-build' }));
    expect((await f.execute(input)).status).toBe('blocked');
    expect(f.http.commands).toHaveLength(0);
    expect(f.http.requests).toHaveLength(0);
  });

  it('exposes a non-mutating pure plan for the coordinator stage without editing source artifact identity', async () => {
    const f = await producerFixture();
    const input = await f.configureStage();
    const plan = planApplicationRegistryPromotion(input);
    expect(plan.operations).toEqual([applicationRegistryPromotionOperation(applicationRegistryPromotionInputs(input), input.plan.configuration!.budget!)]);
    expect(f.record.payload).toMatchObject({ imageRef: `${sourceHost}/team/app@${f.original.digest}` });
    expect(f.http.effects).toHaveLength(0);
  });
});

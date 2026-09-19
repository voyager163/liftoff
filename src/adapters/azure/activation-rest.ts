import { isUtf8 } from 'node:buffer';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { commandSucceeded } from '../../governance-activation/transition-process.js';
import type { CommandRunner } from '../../process-runner.js';
import { AzureResponseError, NIL_UUID, UUID_PATTERN, parseAzureProviderStatus, type ProviderNamespaceStatus } from './production-adapter.js';

export interface AzureArmBinding {
  subscriptionId: string;
  tenantId: string;
  principalId: string;
}

export interface AzureArmRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  resourceId: string;
  apiVersion: string;
  body?: unknown;
  clientRequestId?: string;
}

export interface AzureArmResponse {
  status: number;
  requestId?: string;
  correlationId?: string;
  operationUrl?: string;
  retryAfterSeconds?: number;
  data: unknown;
}

export interface AzureArmTransport {
  request(request: AzureArmRequest, binding: AzureArmBinding): Promise<AzureArmResponse>;
}

export class AzureArmError extends Error {
  constructor(
    readonly code: string, message: string, readonly status?: number,
    readonly requestId?: string, readonly dispatched?: boolean
  ) {
    super(message);
    this.name = 'AzureArmError';
  }
}

const timeoutMs = 30_000;
const maxResponseBytes = 4 * 1024 * 1024;
const providerApiVersion = '2021-04-01';
const namespacePattern = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
const apiVersionPattern = /^\d{4}-\d{2}-\d{2}(?:-preview)?$/u;

export function azureArmBinding(value: AzureArmBinding): AzureArmBinding {
  if (![value.subscriptionId, value.tenantId, value.principalId].every((entry) =>
    typeof entry === 'string' && UUID_PATTERN.test(entry) && entry !== NIL_UUID)) {
    throw new AzureArmError('invalid-binding', 'ARM access requires exact non-nil subscription, tenant and principal object IDs.');
  }
  return {
    subscriptionId: value.subscriptionId.toLowerCase(), tenantId: value.tenantId.toLowerCase(),
    principalId: value.principalId.toLowerCase()
  };
}

export function azureArmUrl(resourceId: string, apiVersion: string, subscriptionId: string): string {
  if (typeof resourceId !== 'string' || resourceId.length > 2048 ||
    !apiVersionPattern.test(apiVersion) || /[\\%?#\s\u0000-\u001f\u007f]/u.test(resourceId) ||
    !resourceId.toLowerCase().startsWith(`/subscriptions/${subscriptionId.toLowerCase()}/`) ||
    resourceId.split('/').slice(1).some((part) => !/^[A-Za-z0-9_.()-]+$/u.test(part) || part === '.' || part === '..')) {
    throw new AzureArmError('invalid-endpoint', 'ARM requests must use an exact safe resource path in the selected subscription and a pinned API version.');
  }
  return `https://management.azure.com${resourceId}?api-version=${apiVersion}`;
}

function operationUrl(value: string, subscriptionId: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AzureArmError('invalid-operation-url', 'ARM returned a malformed operation URL.');
  }
  const versions = url.searchParams.getAll('api-version');
  if (url.origin !== 'https://management.azure.com' || url.username || url.password || url.hash ||
    versions.length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'api-version') ||
    azureArmUrl(url.pathname, versions[0]!, subscriptionId) !== url.href) {
    throw new AzureArmError('invalid-operation-url', 'ARM operation polling must remain in the exact selected subscription without redirects or credential-bearing URLs.');
  }
  return url.href;
}

function responseId(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!UUID_PATTERN.test(value) || value === NIL_UUID) throw new AzureArmError('invalid-response', 'ARM returned a malformed provider-issued request identity.');
  return value.toLowerCase();
}

async function cliToken(
  runner: CommandRunner, projectRoot: string, binding: AzureArmBinding, now: () => number, commandTimeoutMs: number
): Promise<Buffer> {
  const result = await runner.run({
    executable: 'az',
    args: ['account', 'get-access-token', '--subscription', binding.subscriptionId,
      '--tenant', binding.tenantId, '--resource', 'https://management.azure.com/', '--output', 'json', '--only-show-errors']
  }, {
    cwd: projectRoot, timeoutMs: commandTimeoutMs, maxOutputBytes: 64 * 1024, stream: false,
    env: { AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true', AZURE_CORE_NO_COLOR: 'true' }
  });
  if (!commandSucceeded(result) || result.aborted || result.outputLimitExceeded) {
    result.stdout = '';
    result.stderr = '';
    throw new AzureArmError('authentication-prerequisite', 'Azure CLI could not provide bounded scoped ARM credentials; credential diagnostics were withheld.');
  }
  let token: unknown;
  try { token = JSON.parse(result.stdout); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AzureArmError('authentication-response', 'Azure CLI returned malformed credential metadata; response bytes were withheld.');
  } finally {
    result.stdout = '';
    result.stderr = '';
  }
  if (!isRecord(token) || typeof token.accessToken !== 'string' || token.accessToken.length > 48 * 1024 ||
    token.tokenType !== 'Bearer' || typeof token.subscription !== 'string' ||
    token.subscription.toLowerCase() !== binding.subscriptionId || typeof token.tenant !== 'string' ||
    token.tenant.toLowerCase() !== binding.tenantId) {
    throw new AzureArmError('credential-binding', 'The ARM credential metadata does not match the exact reviewed tenant and subscription.');
  }
  const segments = token.accessToken.split('.');
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))) {
    throw new AzureArmError('credential-binding', 'This ARM token does not expose the supported bound identity claims; no principal is inferred.');
  }
  const bytes = Buffer.from(segments[1]!, 'base64url');
  let claims: unknown;
  try {
    if (!isUtf8(bytes) || bytes.toString('base64url') !== segments[1]) {
      throw new AzureArmError('credential-binding', 'ARM token identity claims are not canonically encoded.');
    }
    claims = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof AzureArmError)) throw error;
    throw new AzureArmError('credential-binding', 'ARM token identity claims are malformed; credential bytes were withheld.');
  } finally { bytes.fill(0); }
  if (!isRecord(claims) || typeof claims.tid !== 'string' || claims.tid.toLowerCase() !== binding.tenantId ||
    typeof claims.oid !== 'string' || claims.oid.toLowerCase() !== binding.principalId ||
    typeof claims.aud !== 'string' || !['https://management.azure.com/', 'https://management.azure.com', 'https://management.core.windows.net/',
      '797f4846-ba00-4fd7-ba43-dac1f8f63013'].includes(claims.aud) ||
    typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now() + timeoutMs ||
    claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now())) {
    throw new AzureArmError('credential-binding', 'ARM token scope, principal or validity differs from the exact reviewed binding.');
  }
  const secret = Buffer.from(token.accessToken, 'utf8');
  delete token.accessToken;
  return secret;
}

export function createAzureCliArmTransport(
  runner: CommandRunner,
  projectRoot: string,
  options: {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    /** Absolute performance.now() deadline shared by a reviewed observation window. */
    deadline?: number;
  } = {}
): AzureArmTransport {
  const deadline = options.deadline;
  const requestBudget = () => {
    if (deadline === undefined) return timeoutMs;
    if (!Number.isFinite(deadline)) {
      throw new AzureArmError('invalid-deadline', 'The ARM observation window requires a finite monotonic deadline.', undefined, undefined, false);
    }
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) {
      throw new AzureArmError('observation-window-ended',
        'The reviewed ARM observation window ended; retain the exact checkpoint and resume without redispatch.',
        undefined, undefined, false);
    }
    return Math.min(timeoutMs, remaining);
  };
  return {
    async request(request, requestedBinding) {
      const binding = azureArmBinding(requestedBinding);
      const url = azureArmUrl(request.resourceId, request.apiVersion, binding.subscriptionId);
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ||
        request.method === 'GET' && request.body !== undefined ||
        request.clientRequestId !== undefined && (!UUID_PATTERN.test(request.clientRequestId) || request.clientRequestId === NIL_UUID) ||
        request.method !== 'GET' && !request.clientRequestId) {
        throw new AzureArmError('invalid-request', 'ARM mutation requires its pre-recorded client correlation ID; GET cannot carry a mutation body.');
      }
      let token: Buffer;
      try { token = await cliToken(runner, projectRoot, binding, options.now ?? Date.now, requestBudget()); }
      catch (error) {
        if (!(error instanceof AzureArmError)) throw error;
        throw new AzureArmError(error.code, error.message, error.status, error.requestId, false);
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dispatched = false;
      let status: number | undefined;
      let issuedRequestId: string | undefined;
      try {
        timer = setTimeout(() => controller.abort(), requestBudget());
        dispatched = true;
        const response = await (options.fetch ?? globalThis.fetch)(url, {
          method: request.method, redirect: 'error', signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token.toString('utf8')}`, Accept: 'application/json',
            ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(request.clientRequestId ? { 'x-ms-client-request-id': request.clientRequestId, 'x-ms-return-client-request-id': 'true' } : {})
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
        });
        status = response.status;
        issuedRequestId = responseId(response.headers.get('x-ms-request-id'));
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.body) for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > maxResponseBytes) {
            controller.abort();
            throw new AzureArmError('response-limit', 'ARM response exceeded the bounded public metadata size.');
          }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        let data: unknown = null;
        try {
          if (!isUtf8(bytes)) throw new AzureArmError('invalid-response', 'ARM response is not valid UTF-8.');
          data = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
        } catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof AzureArmError)) throw error;
          throw new AzureArmError('invalid-response', 'ARM returned malformed JSON; response bytes were withheld.');
        }
        const requestId = issuedRequestId;
        const correlationId = responseId(response.headers.get('x-ms-correlation-request-id'));
        const asyncUrl = response.headers.get('azure-asyncoperation') ?? response.headers.get('operation-location');
        const retry = response.headers.get('retry-after');
        if (retry !== null && (!/^\d+$/u.test(retry) || Number(retry) > 120)) {
          throw new AzureArmError('invalid-response', 'ARM returned an unsupported bounded polling interval.');
        }
        requestBudget();
        return {
          status: response.status, data,
          ...(requestId ? { requestId } : {}),
          ...(correlationId ? { correlationId } : {}),
          ...(asyncUrl ? { operationUrl: operationUrl(asyncUrl, binding.subscriptionId) } : {}),
          ...(retry === null ? {} : { retryAfterSeconds: Number(retry) })
        };
      } catch (error) {
        if (error instanceof AzureArmError) throw new AzureArmError(error.code, error.message, status, issuedRequestId, dispatched);
        throw new AzureArmError(controller.signal.aborted ? 'request-timeout' : 'transport-failure',
          'The bounded ARM request did not produce a verified response; submitted effects require checkpointed readback, never blind retry.',
          status, issuedRequestId, dispatched);
      } finally {
        clearTimeout(timer);
        token.fill(0);
      }
    }
  };
}

export interface AzureProviderObservation extends ProviderNamespaceStatus {
  requestId: string;
}

export class AzureProviderClient {
  readonly binding: AzureArmBinding;
  constructor(readonly transport: AzureArmTransport, binding: AzureArmBinding) {
    this.binding = Object.freeze(azureArmBinding(binding));
  }

  private namespace(value: string): string {
    if (typeof value !== 'string' || !namespacePattern.test(value)) throw new AzureArmError('invalid-namespace', 'An exact provider namespace is required.');
    return value;
  }

  private provider(response: AzureArmResponse, namespace: string): AzureProviderObservation {
    if (response.status !== 200) {
      const reason = response.status === 401 || response.status === 403 ? 'authentication or scoped permission was denied' :
        response.status === 404 ? 'the exact namespace is absent or unavailable to this identity' :
          response.status === 409 ? 'current provider state conflicts with the reviewed request' :
            response.status === 429 ? 'the bounded provider rate limit was reached' : 'the provider did not confirm the requested result';
      throw new AzureArmError('provider-response', `ARM provider observation: ${reason} (HTTP ${response.status}).`, response.status, response.requestId, true);
    }
    if (!response.requestId) throw new AzureArmError('request-identity-missing', 'ARM did not return a provider-issued request ID; a client correlation ID cannot replace it.');
    const requestId = responseId(response.requestId);
    if (!requestId) throw new AzureArmError('request-identity-missing', 'ARM did not return a valid provider request identity.');
    try {
      return { ...parseAzureProviderStatus(response.data, this.binding.subscriptionId, namespace), requestId };
    } catch (error) {
      if (!(error instanceof AzureResponseError)) throw error;
      throw new AzureArmError(error.code, error.message, response.status, requestId, true);
    }
  }

  async read(namespace: string): Promise<AzureProviderObservation> {
    const ns = this.namespace(namespace);
    return this.provider(await this.transport.request({
      method: 'GET', resourceId: `/subscriptions/${this.binding.subscriptionId}/providers/${ns}`, apiVersion: providerApiVersion
    }, this.binding), ns);
  }

  async register(namespace: string, clientRequestId: string): Promise<AzureProviderObservation> {
    const ns = this.namespace(namespace);
    return this.provider(await this.transport.request({
      method: 'POST', resourceId: `/subscriptions/${this.binding.subscriptionId}/providers/${ns}/register`,
      apiVersion: providerApiVersion, clientRequestId
    }, this.binding), ns);
  }
}

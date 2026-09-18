import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { CommandRunner } from '../../process-runner.js';
import { commandSucceeded } from '../../governance-activation/transition-process.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { AzureArmError, azureArmBinding, type AzureArmBinding } from './activation-rest.js';
import { applicationImageDigest, applicationImageRepository, applicationRegistryHost } from './application-provisioning.js';

const timeoutMs = 30_000;
const maximumBytes = 128 * 1024;

function invalid(message: string, status?: number): never {
  throw new AzureArmError('application-registry-readback', message, status);
}

function claims(token: unknown, now: number): Record<string, unknown> {
  if (typeof token !== 'string' || token.length > 64 * 1024) invalid('The scoped registry credential is absent or oversized; credential bytes were withheld.');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) {
    invalid('The scoped registry credential has no supported identity claims.');
  }
  const bytes = Buffer.from(parts[1]!, 'base64url');
  try {
    if (!isUtf8(bytes) || bytes.toString('base64url') !== parts[1]) invalid('Credential identity claims are not canonically encoded.');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value) || !Number.isSafeInteger(value.exp) || Number(value.exp) * 1000 <= now + timeoutMs ||
      value.nbf !== undefined && (!Number.isSafeInteger(value.nbf) || Number(value.nbf) * 1000 > now)) {
      invalid('The scoped registry credential is expired, premature or malformed.');
    }
    return value;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return invalid('The scoped registry credential contains malformed identity metadata.');
  } finally { bytes.fill(0); }
}

async function aadToken(runner: CommandRunner, projectRoot: string, binding: AzureArmBinding, now: () => number): Promise<Buffer> {
  const result = await runner.run({
    executable: 'az',
    args: ['account', 'get-access-token', '--subscription', binding.subscriptionId, '--tenant', binding.tenantId,
      '--resource', 'https://management.azure.com/', '--output', 'json', '--only-show-errors']
  }, {
    cwd: projectRoot, timeoutMs, maxOutputBytes: 64 * 1024, stream: false,
    env: { AZURE_CORE_COLLECT_TELEMETRY: 'false', AZURE_CORE_ONLY_SHOW_ERRORS: 'true', AZURE_CORE_NO_COLOR: 'true' }
  });
  try {
    if (!commandSucceeded(result) || result.aborted || result.outputLimitExceeded) invalid('Unable to obtain the exact scoped registry-read credential; private diagnostics were withheld.');
    const value: unknown = JSON.parse(result.stdout);
    if (!isRecord(value) || typeof value.accessToken !== 'string' || value.tokenType !== 'Bearer' ||
      typeof value.subscription !== 'string' || value.subscription.toLowerCase() !== binding.subscriptionId ||
      typeof value.tenant !== 'string' || value.tenant.toLowerCase() !== binding.tenantId) {
      invalid('Registry credential metadata does not match the exact approved subscription and tenant.');
    }
    const identity = claims(value.accessToken, now());
    if (typeof identity.oid !== 'string' || identity.oid.toLowerCase() !== binding.principalId ||
      typeof identity.tid !== 'string' || identity.tid.toLowerCase() !== binding.tenantId ||
      !['https://management.azure.com/', 'https://management.azure.com', 'https://management.core.windows.net/',
        '797f4846-ba00-4fd7-ba43-dac1f8f63013'].includes(String(identity.aud))) {
      invalid('Registry access requires the exact reviewed Azure principal and ARM token audience; ambient identity is not substituted.');
    }
    const token = Buffer.from(value.accessToken);
    delete value.accessToken;
    return token;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return invalid('Azure CLI returned malformed scoped credential metadata; private response bytes were withheld.');
  } finally { result.stdout = ''; result.stderr = ''; }
}

export async function readApplicationRegistryManifest(input: {
  runner: CommandRunner;
  projectRoot: string;
  binding: AzureArmBinding;
  loginServer: string;
  repository: string;
  digest: string;
  beforeAccess: () => Promise<void>;
  now: () => number;
}): Promise<{ digest: string; size: number; requestId: string | null }> {
  const binding = azureArmBinding(input.binding);
  const host = applicationRegistryHost(input.loginServer);
  const repository = applicationImageRepository(input.repository);
  const expectedDigest = applicationImageDigest(input.digest);
  const origin = `https://${host}`;
  const request = async (pathname: string, method: 'GET' | 'POST', secret: Buffer | undefined, form?: URLSearchParams) => {
    await input.beforeAccess();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await globalThis.fetch(`${origin}${pathname}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          Accept: method === 'GET'
            ? 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' : 'application/json',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(secret ? { Authorization: `Bearer ${secret.toString('utf8')}` } : {})
        },
        ...(form ? { body: form.toString() } : {})
      });
      if (response.status !== 200) invalid('The exact registry token exchange or immutable manifest request was not accepted.', response.status);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maximumBytes) {
          controller.abort();
          invalid('The exact registry response exceeded its bounded metadata size.', response.status);
        }
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), headers: response.headers };
    } catch (error) {
      if (error instanceof AzureArmError) throw error;
      return invalid('The bounded registry read did not produce a verified response; no provider or credential diagnostics were disclosed.');
    } finally { clearTimeout(timer); }
  };
  const exchange = async (pathname: string, form: URLSearchParams, field: 'refresh_token' | 'access_token') => {
    const response = await request(pathname, 'POST', undefined, form);
    try {
      if (!isUtf8(response.bytes)) invalid('The registry credential response is not valid UTF-8.');
      const value: unknown = JSON.parse(response.bytes.toString('utf8'));
      if (!isRecord(value) || typeof value[field] !== 'string') invalid('The registry did not return its actual scoped credential.');
      const token = value[field];
      const identity = claims(token, input.now());
      if (identity.aud !== host || identity.grant_type !== field ||
        field === 'refresh_token' && identity.tenant !== binding.tenantId) {
        invalid('The registry credential is bound to another service, tenant or grant.');
      }
      if (field === 'access_token') {
        if (!Array.isArray(identity.access) || identity.access.length !== 1) invalid('Registry readback requires one exact repository pull scope.');
        const access = identity.access[0];
        if (!isRecord(access) || access.type !== 'repository' || access.name !== repository ||
          !Array.isArray(access.actions) || access.actions.length !== 1 || access.actions[0] !== 'pull') {
          invalid('Registry credential expands or changes the exact approved repository pull scope.');
        }
      }
      delete value[field];
      return Buffer.from(token);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid('The registry credential response is malformed; private bytes were withheld.');
    } finally { response.bytes.fill(0); }
  };
  let aad: Buffer | undefined, refresh: Buffer | undefined, access: Buffer | undefined;
  try {
    await input.beforeAccess();
    aad = await aadToken(input.runner, input.projectRoot, binding, input.now);
    refresh = await exchange('/oauth2/exchange', new URLSearchParams({
      grant_type: 'access_token', service: host, tenant: binding.tenantId, access_token: aad.toString('utf8')
    }), 'refresh_token');
    aad.fill(0);
    access = await exchange('/oauth2/token', new URLSearchParams({
      grant_type: 'refresh_token', service: host, scope: `repository:${repository}:pull`, refresh_token: refresh.toString('utf8')
    }), 'access_token');
    refresh.fill(0);
    const response = await request(`/v2/${repository}/manifests/${expectedDigest}`, 'GET', access);
    try {
      if (response.headers.get('docker-content-digest') !== expectedDigest ||
        `sha256:${createHash('sha256').update(response.bytes).digest('hex')}` !== expectedDigest) {
        invalid('The exact registry manifest bytes or Docker-Content-Digest differ from the source-bound build artifact.');
      }
      await input.beforeAccess();
      const requestId = response.headers.get('x-ms-request-id');
      if (requestId !== null && !/^[A-Za-z0-9:_-]{1,200}$/u.test(requestId)) invalid('Registry returned malformed request identity metadata.');
      return { digest: expectedDigest, size: response.bytes.length, requestId };
    } finally { response.bytes.fill(0); }
  } finally { aad?.fill(0); refresh?.fill(0); access?.fill(0); }
}

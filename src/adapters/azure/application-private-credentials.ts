import { isUtf8 } from 'node:buffer';
import type { DarwinStateSystemBridge, StateExecutionContext } from '../../domain/repair/stateful.js';
import { boundedStateOperation } from '../../domain/repair/stateful-bounded.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  applicationPrivateAssert as must, applicationPrivateResourceTypes, ApplicationPrivateError,
  type ApplicationPrivateTarget, type ApplicationPrivateWriter
} from '../../application/azure-activation/application-private-contracts.js';
import { azureArmBinding, azureArmUrl } from './activation-rest.js';

export async function readApplicationPrivateResponse(response: Response, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  must(reader, 'private-response-empty');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      bytes += part.value.byteLength;
      must(bytes <= limit, 'private-response-bound');
    }
    const buffer = Buffer.concat(chunks);
    try {
      must(isUtf8(buffer), 'private-response-format');
      let parsed: unknown;
      try { parsed = JSON.parse(buffer.toString('utf8')); } catch { must(false, 'private-response-format'); }
      must(isRecord(parsed), 'private-response-format');
      return parsed;
    } finally { buffer.fill(0); }
  } finally {
    await reader.cancel().catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function permitted(pattern: string, action: string): boolean {
  return /^[A-Za-z0-9.*\/]+$/u.test(pattern) &&
    new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '.*')}$`, 'iu').test(action);
}

/**
 * A distinct write-capable credential contract. The released read-only state
 * host/reader must not be relabeled as a writer. Token claims are checked after
 * an authenticated, redirect-free AAD exchange and actual scoped ARM reads.
 */
export class ApplicationPrivateAzureWriter {
  constructor(private readonly options: {
    reference: ApplicationPrivateWriter;
    bridge: DarwinStateSystemBridge;
    authorize(): Promise<void>;
    now?: () => number;
    fetch?: typeof globalThis.fetch;
  }) {
    this.options.reference = Object.freeze(structuredClone(options.reference));
    azureArmBinding(options.reference);
    must(/^org\.liftoff\.azure-application-writer\.[A-Za-z0-9_.:-]{1,160}$/u.test(options.reference.service),
      'application-writer-reference');
  }

  toJSON() { return { credential: 'private-application-writer-reference' }; }

  async resolve(
    context: StateExecutionContext, targets: readonly ApplicationPrivateTarget[], signal?: AbortSignal
  ): Promise<Record<string, string>> {
    const ref = this.options.reference;
    must(ref.account === context.projectId && ref.principalId === context.principalId &&
      targets.length > 0 && targets.length <= 32, 'writer-context');
    await this.options.authorize();
    const bounded = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
    let privateBytes: Buffer | undefined;
    let token: Record<string, unknown> | undefined;
    const headers: Record<string, string> = {};
    try {
      const observed = await this.options.bridge.request('keychain-secret', { reference: ref }, bounded);
      must(observed.uid === process.getuid?.() && typeof observed.value === 'string', 'writer-keychain');
      privateBytes = Buffer.from(observed.value, 'base64');
      delete observed.value;
      must(isUtf8(privateBytes) && privateBytes.length > 0 && privateBytes.length <= 4096, 'writer-keychain');
      const secret = privateBytes.toString('utf8');
      must(!/[\u0000\r\n]/u.test(secret), 'writer-keychain');
      const send = async (url: string, init: RequestInit) => {
        await this.options.authorize();
        return boundedStateOperation(bounded, async () => {
          const response = await (this.options.fetch ?? globalThis.fetch)(url, {
            ...init, signal: bounded, redirect: 'error', credentials: 'omit'
          });
          must(response.ok, 'writer-access');
          return readApplicationPrivateResponse(response);
        });
      };
      token = await send(`https://login.microsoftonline.com/${ref.tenantId}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: ref.clientId, client_secret: secret, grant_type: 'client_credentials',
          scope: 'https://management.azure.com/.default'
        }).toString()
      });
      must(typeof token.access_token === 'string' && token.access_token.length <= 48 * 1024 &&
        token.token_type === 'Bearer' && typeof token.expires_in === 'number' && token.expires_in >= 120, 'writer-token');
      const parts = token.access_token.split('.');
      must(parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part)), 'writer-token');
      const claimBytes = Buffer.from(parts[1]!, 'base64url');
      let claims: Record<string, unknown>;
      try {
        must(isUtf8(claimBytes) && claimBytes.toString('base64url') === parts[1], 'writer-token');
        const parsed: unknown = JSON.parse(claimBytes.toString('utf8'));
        must(isRecord(parsed), 'writer-token');
        claims = parsed;
      } finally { claimBytes.fill(0); }
      const now = this.options.now?.() ?? Date.now();
      must(claims.tid === ref.tenantId && claims.oid === ref.principalId &&
        (claims.appid === ref.clientId || claims.azp === ref.clientId) &&
        ['https://management.azure.com', 'https://management.azure.com/', 'https://management.core.windows.net/']
          .includes(String(claims.aud)) &&
        Number.isSafeInteger(claims.exp) && Number(claims.exp) * 1000 > now + 60_000 &&
        (claims.nbf === undefined || Number.isSafeInteger(claims.nbf) && Number(claims.nbf) * 1000 <= now), 'writer-principal-or-scope');
      headers.authorization = `Bearer ${token.access_token}`;
      const scopes = new Map<string, Set<string>>();
      for (const target of targets) {
        const group = target.resourceId.split('/').slice(0, 5).join('/');
        const newGroup = targets.some((item) => item.type === 'azurerm_resource_group' &&
          item.resourceId === group && item.actions.includes('create'));
        const scope = target.role?.scope ?? (target.type === 'azurerm_resource_group' || newGroup
          ? `/subscriptions/${ref.subscriptionId}` : group);
        const required = scopes.get(scope) ?? new Set<string>();
        const type = target.type === 'azurerm_resource_group'
          ? 'Microsoft.Resources/subscriptions/resourceGroups' : applicationPrivateResourceTypes[target.type].arm;
        required.add(`${type}/read`);
        if (target.actions.some((action) => action !== 'no-op')) required.add(`${type}/write`);
        scopes.set(scope, required);
      }
      for (const [scope, required] of scopes) {
        const endpoint = `${scope}/providers/Microsoft.Authorization/permissions`;
        const permission = await send(azureArmUrl(endpoint, '2022-04-01', ref.subscriptionId), { method: 'GET', headers });
        must(Array.isArray(permission.value) && permission.value.length > 0 && permission.value.length <= 128 &&
          permission.nextLink === undefined, 'writer-permissions');
        const grants = permission.value.map((value) => {
          must(isRecord(value) && Array.isArray(value.actions) && Array.isArray(value.notActions) &&
            value.actions.every((action) => typeof action === 'string') &&
            value.notActions.every((action) => typeof action === 'string') && !value.condition, 'writer-permissions');
          return { actions: value.actions as string[], notActions: value.notActions as string[] };
        });
        must([...required].every((action) => grants.some((grant) =>
          grant.actions.some((pattern) => permitted(pattern, action)) &&
          !grant.notActions.some((pattern) => permitted(pattern, action)))), 'writer-permission-denied');
      }
      await this.options.authorize();
      return {
        ARM_TENANT_ID: ref.tenantId, ARM_SUBSCRIPTION_ID: ref.subscriptionId, ARM_CLIENT_ID: ref.clientId,
        ARM_CLIENT_SECRET: secret, ARM_USE_OIDC: 'false', ARM_USE_MSI: 'false', ARM_USE_CLI: 'false'
      };
    } catch (error) {
      if (error instanceof ApplicationPrivateError) throw error;
      throw new ApplicationPrivateError(bounded.aborted ? 'writer-timeout' : 'writer-access');
    } finally {
      privateBytes?.fill(0);
      if (token) delete token.access_token;
      delete headers.authorization;
    }
  }
}

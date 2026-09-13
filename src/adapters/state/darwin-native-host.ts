import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  type DarwinAzureReaderReference, type DarwinStateSystemBridge, type NativeStateHost,
  type ProtectedVolumeAttestor, type StateExecutionContext
} from '../../domain/repair/stateful.js';
import { stateAssert, stateObjectDigest } from '../../domain/repair/stateful-invariants.js';
import { boundedStateOperation } from '../../domain/repair/stateful-bounded.js';
import { assertPrivateStatePath } from './protected-workspace.js';
import { readPrivateNativeFile } from './native-files.js';
import { nativeStateHostId } from './native-system.js';
import { stopOwnedStateProcessesIn, terminateRegisteredStateProcess } from './owned-process.js';

function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const credentialAttributes = /\b(?:client_id|client_secret|client_certificate(?:_path|_password)?|tenant_id|oidc_token|oidc_request_token|oidc_request_url|use_cli|use_msi|use_oidc|msi_endpoint|metadata_host)\s*=/;

function withoutHclComments(source: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === '#' || (char === '/' && source[index + 1] === '/')) {
      while (index < source.length && source[index] !== '\n') index++;
      result += '\n';
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      stateAssert(end >= 0, 'unsafe-planning-contract');
      result += ' ';
      index = end + 1;
    } else {
      // Complex heredoc/template parsing belongs to the semantic adapter; this
      // stricter executable profile never guesses across an ambiguous string.
      stateAssert(!(char === '<' && source[index + 1] === '<'), 'unsafe-planning-contract');
      result += char;
    }
  }
  stateAssert(!quoted, 'unsafe-planning-contract');
  return result;
}

export async function assertEnvironmentOnlyProviders(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.terraform') continue;
    stateAssert(!entry.isSymbolicLink(), 'unsafe-path');
    if (entry.isDirectory()) {
      await assertEnvironmentOnlyProviders(path.join(directory, entry.name));
      continue;
    }
    if (!entry.name.endsWith('.tf') && !entry.name.endsWith('.tf.json')) continue;
    stateAssert(entry.isFile() && !/(?:^|_)override\.tf(?:\.json)?$/.test(entry.name), 'unsafe-planning-contract');
    const bytes = await readPrivateNativeFile(path.join(directory, entry.name), 4 * 1024 * 1024);
    try {
      const raw = Buffer.from(bytes).toString('utf8');
      if (entry.name.endsWith('.json')) {
        const root = JSON.parse(raw);
        const inspect = (value: unknown): void => {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            stateAssert(!credentialAttributes.test(`${key} =`), 'unsafe-planning-contract');
            if (key === 'resource_provider_registrations') stateAssert(item === 'none', 'unsafe-planning-contract');
            if (key === 'skip_provider_registration') stateAssert(item === true, 'unsafe-planning-contract');
            inspect(item);
          }
        };
        inspect(root.provider);
      } else {
        const text = withoutHclComments(raw);
        // This is a deny-only guard, not an HCL transformer or ownership parser.
        // Ambiguous provider syntax remains unsupported by this narrow profile.
        const starts = [...text.matchAll(/\bprovider\s+"([^"]+)"\s*\{/g)];
        for (const start of starts) {
          stateAssert(start[1] === 'azurerm', 'unsafe-planning-contract');
          let depth = 1;
          let end = start.index! + start[0].length;
          let quoted = false;
          let escaped = false;
          for (; end < text.length && depth; end++) {
            const char = text[end];
            if (quoted) {
              if (escaped) escaped = false;
              else if (char === '\\') escaped = true;
              else if (char === '"') quoted = false;
            } else if (char === '"') quoted = true;
            else if (char === '{') depth++;
            else if (char === '}') depth--;
          }
          stateAssert(depth === 0, 'unsafe-planning-contract');
          const block = text.slice(start.index!, end);
          stateAssert(!credentialAttributes.test(block), 'unsafe-planning-contract');
          for (const assignment of block.matchAll(/\bresource_provider_registrations\s*=\s*([^\r\n}]+)/g)) {
            stateAssert(/^"none"\s*(?:#.*|\/\/.*)?$/.test(assignment[1].trim()), 'unsafe-planning-contract');
          }
          for (const assignment of block.matchAll(/\bskip_provider_registration\s*=\s*([^\r\n}]+)/g)) {
            stateAssert(/^true\s*(?:#.*|\/\/.*)?$/.test(assignment[1].trim()), 'unsafe-planning-contract');
          }
        }
      }
    } finally { bytes.fill(0); }
  }
}

export class DarwinKeychainAzureReader {
  readonly identityDigest: string;
  constructor(private readonly options: {
    reference: DarwinAzureReaderReference;
    bridge: DarwinStateSystemBridge;
    fetch?: typeof globalThis.fetch;
  }) {
    const ref = options.reference;
    const uuid = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
    stateAssert([ref.tenantId, ref.subscriptionId, ref.clientId, ref.principalId].every((value) => uuid.test(value))
      && /^org\.liftoff\.azure-state-reader\.[a-zA-Z0-9_.:-]{1,160}$/.test(ref.service), 'access-denied');
    this.identityDigest = stateObjectDigest(ref);
    this.options.reference = Object.freeze(structuredClone(ref));
  }

  private async json(url: string, options: RequestInit, signal: AbortSignal): Promise<Record<string, any>> {
    return boundedStateOperation(signal, async () => {
      const response = await (this.options.fetch ?? globalThis.fetch)(url, { ...options, signal, redirect: 'error' });
      stateAssert(response.ok, 'access-denied');
      const reader = response.body?.getReader();
      stateAssert(reader, 'incomplete-observation');
      const buffers: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          stateAssert(bytes <= 1024 * 1024, 'storage-limit');
          buffers.push(item.value);
        }
        return JSON.parse(Buffer.concat(buffers).toString('utf8'));
      } finally { await reader.cancel().catch(() => undefined); for (const buffer of buffers) buffer.fill(0); }
    });
  }

  async resolve(context: StateExecutionContext, resourceIds: readonly string[], signal?: AbortSignal): Promise<Readonly<Record<string, string>>> {
    const ref = this.options.reference;
    stateAssert(ref.account === context.projectId && ref.principalId === context.principalId, 'ownership-mismatch');
    stateAssert(resourceIds.length <= 128, 'storage-limit');
    const bounded = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
    const value = await this.options.bridge.request('keychain-secret', { reference: ref }, bounded);
    stateAssert(value.uid === process.getuid?.() && typeof value.value === 'string', 'access-denied');
    const secretBytes = Buffer.from(value.value, 'base64');
    delete value.value;
    try {
      const secret = secretBytes.toString('utf8');
      stateAssert(secret.length > 0 && secret.length <= 4096 && !/[\x00\r\n]/.test(secret), 'access-denied');
      const token = await this.json(`https://login.microsoftonline.com/${ref.tenantId}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: ref.clientId, client_secret: secret, grant_type: 'client_credentials',
          scope: 'https://management.azure.com/.default'
        }).toString()
      }, bounded);
      stateAssert(typeof token.access_token === 'string' && token.expires_in >= 120, 'access-denied');
      const claims = JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url').toString('utf8'));
      stateAssert(claims.tid === ref.tenantId && claims.oid === ref.principalId
        && (claims.appid === ref.clientId || claims.azp === ref.clientId)
        && ['https://management.azure.com', 'https://management.azure.com/', 'https://management.core.windows.net/'].includes(claims.aud)
        && Number.isFinite(claims.exp) && claims.exp * 1000 > Date.now() + 60_000, 'access-denied');
      const scopes = [...new Set([`/subscriptions/${ref.subscriptionId}`, ...resourceIds])];
      for (const scope of scopes) {
        stateAssert(scope.split('/')[2]?.toLowerCase() === ref.subscriptionId.toLowerCase()
          && /^\/[a-zA-Z0-9_./()-]+$/.test(scope) && !scope.split('/').includes('..'), 'invalid-binding');
        const url = new URL(`https://management.azure.com${scope}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`);
        let next: string | null = url.href;
        let pages = 0;
        let grants = 0;
        while (next) {
          stateAssert(++pages <= 10, 'incomplete-observation');
          const parsed = new URL(next);
          stateAssert(parsed.origin === url.origin && parsed.pathname === url.pathname && !parsed.username && !parsed.password, 'access-denied');
          const result = await this.json(parsed.href, { headers: { authorization: `Bearer ${token.access_token}` } }, bounded);
          stateAssert(Array.isArray(result.value), 'incomplete-observation');
          for (const permission of result.value) {
            stateAssert(Array.isArray(permission.actions) && Array.isArray(permission.dataActions ?? []), 'incomplete-observation');
            const actions = [...permission.actions, ...(permission.dataActions ?? [])];
            stateAssert(actions.every((action: unknown) => typeof action === 'string' && /\/read$/i.test(action)), 'access-denied');
            grants += actions.length;
          }
          stateAssert(result.nextLink === undefined || typeof result.nextLink === 'string', 'incomplete-observation');
          next = result.nextLink ?? null;
        }
        stateAssert(grants > 0, 'access-denied');
      }
      return {
        ARM_TENANT_ID: ref.tenantId, ARM_SUBSCRIPTION_ID: ref.subscriptionId,
        ARM_CLIENT_ID: ref.clientId, ARM_CLIENT_SECRET: secret,
        ARM_USE_OIDC: 'false', ARM_USE_MSI: 'false', ARM_USE_CLI: 'false'
      };
    } finally { secretBytes.fill(0); }
  }
}

/**
 * Observes an encrypted, private staging directory and a genuinely read-only
 * Azure identity. Isolation here is staging/HOME/config isolation, NOT an OS
 * sandbox; only the separately inspected fixed provider/module contract may run.
 */
export class DarwinObservedStateHost implements NativeStateHost {
  #environments = new Map<string, { environment: Readonly<Record<string, string>>; expiresAt: number }>();
  constructor(private readonly options: {
    root: string;
    context: StateExecutionContext;
    volume: ProtectedVolumeAttestor;
    reader: DarwinKeychainAzureReader;
  }) {}

  async verify(directory: string): ReturnType<NativeStateHost['verify']> {
    stateAssert(process.platform === 'darwin' && this.options.context.hostId === nativeStateHostId()
      && within(this.options.root, directory), 'unsupported-native-platform');
    await assertPrivateStatePath(directory, this.options.context, this.options.volume, true);
    await assertEnvironmentOnlyProviders(this.options.root);
    const backendBytes = await readPrivateNativeFile(path.join(directory, 'liftoff-state-backend.tf.json'), 16_384);
    let statePath: string;
    try {
      const backend = JSON.parse(Buffer.from(backendBytes).toString('utf8'));
      statePath = backend.terraform?.backend?.local?.path;
      stateAssert(typeof statePath === 'string' && within(this.options.root, statePath), 'unsafe-path');
    } finally { backendBytes.fill(0); }
    const existing = await lstat(statePath).catch(() => null);
    const resourceIds: string[] = [];
    if (existing?.isFile() && existing.size > 0) {
      const stateBytes = await readPrivateNativeFile(statePath, 32 * 1024 * 1024);
      try {
        const state = JSON.parse(Buffer.from(stateBytes).toString('utf8'));
        stateAssert(state.version === 4 && Array.isArray(state.resources), 'unsupported-state');
        for (const resource of state.resources) {
          for (const instance of resource.instances ?? []) {
            const id = instance.attributes?.id;
            if (resource.mode === 'data' && resource.type === 'azurerm_client_config') continue;
            stateAssert(typeof id === 'string' && id.startsWith('/subscriptions/'), 'unsupported-state');
            resourceIds.push(id);
          }
        }
      } finally { stateBytes.fill(0); }
    }
    const environment = await this.options.reader.resolve(this.options.context, resourceIds);
    this.#environments.set(directory, { environment, expiresAt: Date.now() + 30_000 });
    return { directory, encryptedVolume: true, isolated: true, providerIdentityReadOnly: true, providerRegistrationDisabled: true };
  }

  async privateEnvironment(directory: string): Promise<Readonly<Record<string, string>>> {
    const verified = this.#environments.get(directory);
    stateAssert(verified && verified.expiresAt > Date.now(), 'access-denied');
    this.#environments.delete(directory);
    return verified.environment;
  }

  async terminateProcessTree(pid: number): Promise<void> {
    await terminateRegisteredStateProcess(pid);
  }

  async quiesce(): Promise<void> {
    await stopOwnedStateProcessesIn(this.options.root);
    this.#environments.clear();
  }
}

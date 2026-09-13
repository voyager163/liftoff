import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DarwinFileVaultVolumeAttestor, DarwinKeychainStateKeyProvider, observeDarwinStateVolume
} from '../src/adapters/state/darwin-capabilities.js';
import { DarwinKeychainAzureReader, assertEnvironmentOnlyProviders } from '../src/adapters/state/darwin-native-host.js';
import { nativeStateHostId } from '../src/adapters/state/native-system.js';
import type { DarwinAzureReaderReference, DarwinStateSystemBridge } from '../src/domain/repair/stateful.js';
import { context } from './fixtures/state-migration/fakes.js';

const scratch = path.join(process.cwd(), '.cache', `state-darwin-capability-tests-${process.pid}`);
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

describe('independently observed Darwin capabilities', () => {
  it('requires encrypted APFS/FileVault, current owner-only access, the actual host, and the bound volume', async () => {
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const current = { ...context(), hostId: nativeStateHostId() };
    let changes: Record<string, unknown> = {};
    const bridge: DarwinStateSystemBridge = {
      async request() {
        return {
          ok: true, canonicalDirectory: scratch, deviceNode: '/dev/disk3s5',
          volumeId: '11111111-1111-1111-1111-111111111111', filesystem: 'apfs', fileVault: true,
          encrypted: true, locked: false, ownerUid: process.getuid?.(), mode: 0o700, aclEntries: 0, ...changes
        };
      }
    };
    const observed = await observeDarwinStateVolume(bridge, scratch);
    expect(observed.fileVault).toBe(true);
    for (const patch of [
      { encrypted: false }, { fileVault: false }, { locked: true }, { filesystem: 'nfs' },
      { ownerUid: -1 }, { mode: 0o755 }, { aclEntries: 1 }, { volumeId: '22222222-2222-2222-2222-222222222222' }
    ]) {
      changes = patch;
      const attestor = new DarwinFileVaultVolumeAttestor({
        bridge, root: scratch, volumeId: '11111111-1111-1111-1111-111111111111'
      });
      await expect(attestor.verify(scratch, current)).rejects.toBeInstanceOf(Error);
    }
    changes = {};
    const attestor = new DarwinFileVaultVolumeAttestor({
      bridge, root: scratch, volumeId: '11111111-1111-1111-1111-111111111111'
    });
    if (process.platform === 'darwin') {
      expect(await attestor.verify(scratch, current)).toMatchObject({ encryptedVolume: true, privateAccess: true, hostId: current.hostId });
    }
    await expect(attestor.verify(scratch, { ...current, hostId: 'operator-supplied-true-is-not-proof' })).rejects.toBeInstanceOf(Error);
  });

  it('uses an existing exact keychain reference, verifies ownership, clears key bytes and never returns them publicly', async () => {
    const calls: string[] = [];
    const fixtureKey = Buffer.alloc(32, 17).toString('base64');
    const bridge: DarwinStateSystemBridge = {
      async request(operation) {
        calls.push(operation);
        return operation === 'keychain-metadata'
          ? { ok: true, present: true, uid: process.getuid?.() }
          : { ok: true, value: Buffer.from(fixtureKey).toString('base64'), uid: process.getuid?.() };
      }
    };
    const provider = new DarwinKeychainStateKeyProvider({
      keychainPath: path.join(scratch, 'synthetic-existing.keychain-db'),
      service: 'org.liftoff.state.synthetic-workspace', account: context().projectId
    }, bridge);
    const current = { ...context(), hostId: nativeStateHostId() };
    expect(await provider.describe(provider.keyRef, current)).toMatchObject({ ownerId: current.projectId, storage: 'external-key-provider' });
    expect(calls).toEqual(['keychain-metadata']);
    let captured: Uint8Array | null = null;
    const result = await provider.withKey(provider.keyRef, async (key) => {
      captured = key;
      expect(key.length).toBe(32);
      return 'opaque-result';
    });
    expect(result).toBe('opaque-result');
    expect(captured).toEqual(Buffer.alloc(32));
    expect(JSON.stringify(provider)).not.toContain(fixtureKey);
    await expect(provider.describe(provider.keyRef, { ...current, projectId: 'wrong-project' })).rejects.toMatchObject({ code: 'key-unavailable' });
    await expect(provider.withKey('unknown-key', async () => undefined)).rejects.toMatchObject({ code: 'key-unavailable' });
  });
});

describe('existing Azure read-only account capability (fake transport, no live credential reads)', () => {
  const reference: DarwinAzureReaderReference = {
    keychainPath: path.join(scratch, 'synthetic-reader.keychain-db'),
    service: 'org.liftoff.azure-state-reader.synthetic', account: context().projectId,
    tenantId: '11111111-1111-1111-1111-111111111111',
    subscriptionId: '22222222-2222-2222-2222-222222222222',
    clientId: '33333333-3333-3333-3333-333333333333',
    principalId: '44444444-4444-4444-4444-444444444444'
  };
  const current = { ...context(), hostId: nativeStateHostId(), principalId: reference.principalId };
  function fixture(actions = ['*/read']) {
    const bridge: DarwinStateSystemBridge = {
      async request() { return { ok: true, uid: process.getuid?.(), value: Buffer.from('SYNTHETIC_NON_CREDENTIAL').toString('base64') }; }
    };
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({
      tid: reference.tenantId, oid: reference.principalId, appid: reference.clientId,
      aud: 'https://management.azure.com/', exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url')}.synthetic-signature`;
    const requests: { url: string; options?: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify(String(url).startsWith('https://login.microsoftonline.com/')
        ? { access_token: token, expires_in: 3600 }
        : { value: [{ actions, dataActions: [] }] }), { status: 200 });
    });
    return { provider: new DarwinKeychainAzureReader({ reference, bridge, fetch }), requests };
  }

  it('derives readiness from token identity plus current effective permissions, not a true flag', async () => {
    const { provider, requests } = fixture();
    const scope = `/subscriptions/${reference.subscriptionId}/resourceGroups/synthetic`;
    const environment = await provider.resolve(current, [scope]);
    expect(environment.ARM_CLIENT_ID).toBe(reference.clientId);
    expect(environment.ARM_USE_CLI).toBe('false');
    expect(environment.ARM_USE_OIDC).toBe('false');
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.options?.redirect === 'error')).toBe(true);
    expect(requests[0].url).not.toContain('SYNTHETIC_NON_CREDENTIAL');
    expect(requests[0].options?.body).toContain('client_secret=SYNTHETIC_NON_CREDENTIAL');
  });

  it.each([['*'], ['Microsoft.Resources/subscriptions/resourceGroups/write'], ['Microsoft.Storage/storageAccounts/listKeys/action'], []])(
    'blocks non-read-only or unproven permissions %j', async (...actions) => {
      const { provider } = fixture(actions);
      await expect(provider.resolve(current, [])).rejects.toMatchObject({ code: 'access-denied' });
    }
  );

  it('blocks provider credential overrides and automatic registrations before native execution', async () => {
    const directory = path.join(scratch, 'provider-policy');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, 'providers.tf');
    await writeFile(filename, 'provider "azurerm" {\n resource_provider_registrations = "none"\n features {}\n}\n');
    await expect(assertEnvironmentOnlyProviders(directory)).resolves.toBeUndefined();
    await writeFile(filename, 'provider "azurerm" {\n client_secret = "SYNTHETIC_OVERRIDE"\n}\n');
    await expect(assertEnvironmentOnlyProviders(directory)).rejects.toMatchObject({ code: 'unsafe-planning-contract' });
    await writeFile(filename, 'provider /* comment */ "azurerm" {\n client_secret /* comment */ = "SYNTHETIC_OVERRIDE"\n}\n');
    await expect(assertEnvironmentOnlyProviders(directory)).rejects.toMatchObject({ code: 'unsafe-planning-contract' });
    await writeFile(filename, 'provider "azurerm" {\n resource_provider_registrations = "all"\n}\n');
    await expect(assertEnvironmentOnlyProviders(directory)).rejects.toMatchObject({ code: 'unsafe-planning-contract' });
  });
});

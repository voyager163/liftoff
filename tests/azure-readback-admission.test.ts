import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import {
  executeAzureAccountShow, executeAzureProviderShow, executeAzureProviderRegister, executeAzureBlobPropertiesShow,
  executeAzureAcrShow, executeAzureIdentityShow, executeAzureAcrManifestsShow, executeAzureContainerAppShow, executeAzureStorageAccountShow
} from '../src/adapters/azure/production-adapter.js';

const subscription = '11111111-2222-4333-8444-555555555555';
const tenant = '66666666-7777-4888-8999-000000000001';
const resource = (type: string, name: string) => `/subscriptions/${subscription}/resourceGroups/rg-app/providers/${type}/${name}`;
const registry = {
  id: resource('Microsoft.ContainerRegistry/registries', 'crfixture'), name: 'crfixture',
  loginServer: 'crfixture.azurecr.io', provisioningState: 'Succeeded'
};
const app = {
  id: resource('Microsoft.App/containerApps', 'ca-fixture'), name: 'ca-fixture',
  properties: { provisioningState: 'Succeeded', runningStatus: 'Running' }
};

function runnerFor(data: unknown, result: Partial<CommandResult> = {}) {
  const calls: Parameters<CommandRunner['run']>[] = [];
  const runner: CommandRunner = {
    async run(command, options) {
      calls.push([command, options]);
      return { status: 0, stdout: JSON.stringify(data), stderr: '', displayCommand: 'bounded fixture Azure request', ...result };
    }
  };
  return { runner, calls };
}

describe('Azure readback admission without inferred provider success', () => {
  it('observes exact account and provider identities with explicit command bounds', async () => {
    const account = runnerFor({ id: subscription, tenantId: tenant, state: 'Enabled' });
    expect(await executeAzureAccountShow(account.runner, process.cwd(), subscription, tenant)).toEqual({
      success: true, account: { id: subscription, tenantId: tenant, state: 'Enabled' }
    });
    const provider = runnerFor({
      id: `/subscriptions/${subscription}/providers/Microsoft.App`, namespace: 'Microsoft.App', registrationState: 'Registered'
    });
    expect(await executeAzureProviderShow(provider.runner, process.cwd(), subscription, 'Microsoft.App')).toEqual({
      success: true, status: {
        resourceId: `/subscriptions/${subscription}/providers/Microsoft.App`, namespace: 'Microsoft.App', state: 'Registered'
      }
    });
    for (const [, options] of [...account.calls, ...provider.calls]) {
      expect(options).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, stream: false });
    }
  });

  it.each([null, [], { id: 1, tenantId: tenant, state: 'Enabled' }, { id: subscription, tenantId: 1, state: 'Enabled' }])(
    'rejects malformed account objects and typed identities %#', async (response) => {
      const f = runnerFor(response);
      expect(await executeAzureAccountShow(f.runner, process.cwd(), subscription, tenant)).toMatchObject({ success: false });
    }
  );

  it('rejects nil targets before invoking Azure', async () => {
    const f = runnerFor({ id: subscription, tenantId: tenant, state: 'Enabled' });
    expect(await executeAzureAccountShow(f.runner, process.cwd(), '00000000-0000-0000-0000-000000000000', tenant)).toMatchObject({ success: false });
    expect(f.calls).toEqual([]);
  });

  it.each([{}, { registrationState: 'Registered' }, {
    id: `/subscriptions/${subscription}/providers/Microsoft.Storage`, namespace: 'Microsoft.Storage', registrationState: 'Registered'
  }, { id: `/subscriptions/${subscription}/providers/Microsoft.App`, namespace: 'Microsoft.App', registrationState: 'Unknown' }])(
    'does not substitute expected provider identity or state into response %#', async (response) => {
      const f = runnerFor(response);
      expect(await executeAzureProviderShow(f.runner, process.cwd(), subscription, 'Microsoft.App')).toMatchObject({ success: false });
      expect(await executeAzureProviderRegister(f.runner, process.cwd(), subscription, 'Microsoft.App')).toMatchObject({ success: false });
    }
  );

  it.each([{ timedOut: true }, { outputLimitExceeded: true }, { aborted: true }])(
    'withholds account success when the process result is incomplete %#', async (flags) => {
      const f = runnerFor({ id: subscription, tenantId: tenant, state: 'Enabled' }, flags);
      expect(await executeAzureAccountShow(f.runner, process.cwd(), subscription, tenant)).toMatchObject({ success: false });
    }
  );

  it.each([{}, { isVersioningEnabled: 'false' }, { isVersioningEnabled: 1 }])('does not coerce or invent blob versioning %#', async (response) => {
    const f = runnerFor(response);
    expect(await executeAzureBlobPropertiesShow(f.runner, process.cwd(), subscription, 'rg-app', 'stfixture')).toMatchObject({ success: false });
  });

  it('retains an actually disabled versioning setting as false', async () => {
    const f = runnerFor({ isVersioningEnabled: false });
    expect(await executeAzureBlobPropertiesShow(f.runner, process.cwd(), subscription, 'rg-app', 'stfixture')).toEqual({
      success: true, isVersioningEnabled: false
    });
  });

  it('does not infer Succeeded or Running from existing resource IDs', async () => {
    const acr = runnerFor({ ...registry, provisioningState: undefined });
    expect(await executeAzureAcrShow(acr.runner, process.cwd(), subscription, 'crfixture')).toMatchObject({ success: false });
    for (const properties of [{}, { provisioningState: 'Succeeded' }, { runningStatus: 'Running' }]) {
      const container = runnerFor({ ...app, properties });
      expect(await executeAzureContainerAppShow(container.runner, process.cwd(), subscription, 'rg-app', 'ca-fixture')).toMatchObject({ success: false });
    }
  });

  it('preserves actual non-success states without converting them to healthy results', async () => {
    const f = runnerFor({ ...app, properties: { provisioningState: 'Failed', runningStatus: 'Stopped' } });
    expect(await executeAzureContainerAppShow(f.runner, process.cwd(), subscription, 'rg-app', 'ca-fixture')).toMatchObject({
      success: true, app: { provisioningState: 'Failed', runningStatus: 'Stopped' }
    });
  });

  it('rejects malformed registry endpoints and container hostnames', async () => {
    const acr = runnerFor({ ...registry, loginServer: 'https://crfixture.azurecr.io/?unsafe=true' });
    expect(await executeAzureAcrShow(acr.runner, process.cwd(), subscription, 'crfixture')).toMatchObject({ success: false });
    const container = runnerFor({ ...app, properties: { ...app.properties, configuration: { ingress: { fqdn: 'host/path' } } } });
    expect(await executeAzureContainerAppShow(container.runner, process.cwd(), subscription, 'rg-app', 'ca-fixture')).toMatchObject({ success: false });
  });

  it('rejects foreign registry, identity, storage and application scopes', async () => {
    const acr = runnerFor({ ...registry, id: registry.id.replace(subscription, tenant) });
    expect(await executeAzureAcrShow(acr.runner, process.cwd(), subscription, 'crfixture')).toMatchObject({ success: false });
    const identity = runnerFor({
      id: resource('Microsoft.ManagedIdentity/userAssignedIdentities', 'id-fixture'), name: 'id-fixture', clientId: tenant, principalId: tenant
    });
    expect(await executeAzureIdentityShow(identity.runner, process.cwd(), subscription, 'rg-other', 'id-fixture')).toMatchObject({ success: false });
    const storage = runnerFor({ id: resource('Microsoft.Storage/storageAccounts', 'stfixture'), name: 'stother' });
    expect(await executeAzureStorageAccountShow(storage.runner, process.cwd(), subscription, 'rg-app', 'stfixture')).toMatchObject({ success: false });
    const container = runnerFor({ ...app, id: app.id.replace('/rg-app/', '/rg-other/') });
    expect(await executeAzureContainerAppShow(container.runner, process.cwd(), subscription, 'rg-app', 'ca-fixture')).toMatchObject({ success: false });
  });

  it.each([
    [{ tags: [] }], [{ digest: `sha256:${'a'.repeat(64)}` }], [{ digest: 'placeholder', tags: ['latest'] }],
    [{ digest: `sha256:${'a'.repeat(64)}`, tags: ['latest', 42] }], [null]
  ])('rejects malformed manifest inventories without dropping entries %#', async (response) => {
    const f = runnerFor(response);
    expect(await executeAzureAcrManifestsShow(f.runner, process.cwd(), subscription, 'crfixture', 'app')).toMatchObject({ success: false });
  });

  it('does not echo malformed provider JSON in diagnostics', async () => {
    const f = runnerFor(null, { stdout: '{"unexpected":"private-response-bytes"' });
    const result = await executeAzureAcrShow(f.runner, process.cwd(), subscription, 'crfixture');
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).not.toContain('private-response-bytes');
  });

  it('preserves an explicitly untagged immutable manifest instead of inferring missing tag data', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const f = runnerFor([{ digest, tags: null }]);
    expect(await executeAzureAcrManifestsShow(f.runner, process.cwd(), subscription, 'crfixture', 'app')).toEqual({
      success: true, manifests: [{ digest, tags: [] }]
    });
  });
});

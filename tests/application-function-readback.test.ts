import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AzureArmRequest, AzureArmResponse } from '../src/adapters/azure/activation-rest.js';
import { applicationFunctionReadRequests, readApplicationFunctionConfiguration } from '../src/adapters/azure/application-function-readback.js';

const binding = {
  subscriptionId: '11111111-2222-4333-8444-555555555555',
  tenantId: '66666666-7777-4888-8999-000000000001',
  principalId: '88888888-9999-4aaa-8bbb-cccccccccccc'
};
const resourceId = `/subscriptions/${binding.subscriptionId}/resourceGroups/function-test/providers/Microsoft.Web/sites/worker`;
const storageKey = Buffer.alloc(64, 19).toString('base64');
const setting = 'SYNTHETIC_PRIVATE_FUNCTION_CONFIGURATION';

function fixture() {
  const requests: AzureArmRequest[] = [];
  const web: AzureArmResponse = { status: 200, requestId: randomUUID(), data: {
    id: `${resourceId}/config/web`, name: 'web', type: 'Microsoft.Web/sites/config',
    properties: { linuxFxVersion: 'Python|3.12' }
  } };
  const settings: Record<string, unknown> = {
    AzureWebJobsStorage: `DefaultEndpointsProtocol=https;AccountName=stfunction;AccountKey=${storageKey};EndpointSuffix=core.windows.net`,
    PRIVATE_SETTING: setting
  };
  const response: AzureArmResponse = { status: 200, requestId: randomUUID(), data: {
    id: `${resourceId}/config/appsettings`, name: 'appsettings', type: 'Microsoft.Web/sites/config', properties: settings
  } };
  let authorizations = 0;
  const expectedState = { storage_account_name: 'stfunction', storage_account_access_key: storageKey,
    app_settings: { PRIVATE_SETTING: setting } };
  const invoke = () => readApplicationFunctionConfiguration({
    resourceId, address: 'module.application.azurerm_linux_function_app.worker', binding, expectedState,
    authorize: async () => { authorizations++; },
    transport: { async request(request, actualBinding) {
      expect(actualBinding).toEqual(binding);
      expect(authorizations).toBe(requests.length + 1);
      requests.push(request);
      return request.resourceId.endsWith('/web') ? web : response;
    } }
  });
  return { invoke, web, response, settings, expectedState, requests };
}

describe('actual private Function configuration readback', () => {
  it('uses exact documented GET and read-only POST resources without credential or body arguments', async () => {
    const f = fixture(), observed = await f.invoke();
    expect(f.requests).toEqual(applicationFunctionReadRequests(resourceId).map(({ responseId: _responseId, ...request }) => request));
    expect(observed.values).toEqual({ storage_account_name: 'stfunction',
      site_config: [{ application_stack: [{ python_version: '3.12' }] }] });
    expect(observed.dependencies.map((entry) => entry.readbackRequestId)).toEqual([f.web.requestId, f.response.requestId]);
    expect(observed.dependencies[1]!.method).toBe('POST');
    expect(JSON.stringify(observed)).not.toContain(storageKey);
    expect(JSON.stringify(observed)).not.toContain(setting);
  });

  it.each(['wrong-account', 'wrong-key', 'wrong-setting', 'missing-setting'] as const)(
    'rejects %s against actual private candidate facts, not a copied expectation', async (fault) => {
      const f = fixture();
      if (fault === 'wrong-account') f.expectedState.storage_account_name = 'anotheraccount';
      if (fault === 'wrong-key') f.expectedState.storage_account_access_key = Buffer.alloc(64, 20).toString('base64');
      if (fault === 'wrong-setting') f.settings.PRIVATE_SETTING = 'different';
      if (fault === 'missing-setting') delete f.settings.PRIVATE_SETTING;
      await expect(f.invoke()).rejects.toThrow(/function-private/);
    }
  );

  it.each(['duplicate', 'foreign-endpoint', 'http', 'bad-key', 'missing-storage', 'unknown-setting-type'] as const)(
    'fails closed on %s configuration without returning a verified projection', async (fault) => {
      const f = fixture();
      if (fault === 'duplicate') f.settings.AzureWebJobsStorage += ';AccountName=other';
      if (fault === 'foreign-endpoint') f.settings.AzureWebJobsStorage += ';BlobEndpoint=https://foreign.example/';
      if (fault === 'http') f.settings.AzureWebJobsStorage = String(f.settings.AzureWebJobsStorage).replace('https;', 'http;');
      if (fault === 'bad-key') f.settings.AzureWebJobsStorage = String(f.settings.AzureWebJobsStorage).replace(storageKey, 'invalid');
      if (fault === 'missing-storage') delete f.settings.AzureWebJobsStorage;
      if (fault === 'unknown-setting-type') f.settings.PRIVATE_SETTING = { unauthorized: true };
      await expect(f.invoke()).rejects.toThrow(/function-/);
    }
  );

  it('preserves the actual failing read-only POST request identity rather than a mutation or preceding GET ID', async () => {
    const f = fixture();
    f.response.status = 403;
    await expect(f.invoke()).rejects.toMatchObject({ receipt: {
      requestedResourceId: `${resourceId}/config/appsettings/list`, readbackRequestId: f.response.requestId, status: 403
    } });
  });

  it('does not let a valid site GET stand in for absent separate runtime/configuration observations', async () => {
    const f = fixture();
    f.web.data = { id: resourceId, type: 'Microsoft.Web/sites', properties: { state: 'Running' } };
    await expect(f.invoke()).rejects.toThrow(/function-configuration/);
    expect(f.requests).toHaveLength(1);
  });
});

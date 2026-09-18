import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { applicationPrivateAssert as must, ApplicationPrivateError } from '../../application/azure-activation/application-private-errors.js';
import type { ApplicationPrivateObservation } from '../../application/azure-activation/application-private-contracts.js';
import { applicationUuid } from './application-provisioning.js';
import type { AzureArmBinding, AzureArmTransport } from './activation-rest.js';
import { ApplicationPrivateResourceReadbackError } from './application-private-readback-errors.js';

export function applicationFunctionReadRequests(resourceId: string) {
  return [
    { method: 'GET' as const, resourceId: `${resourceId}/config/web`, responseId: `${resourceId}/config/web`, apiVersion: '2024-11-01' },
    { method: 'POST' as const, resourceId: `${resourceId}/config/appsettings/list`, responseId: `${resourceId}/config/appsettings`, apiVersion: '2024-11-01' }
  ];
}

function storageConnection(value: unknown): { accountName: string; accountKey: string } {
  must(typeof value === 'string' && value.length <= 2048, 'function-storage-binding');
  const fields = new Map<string, string>();
  for (const entry of value.split(';').filter((part) => part !== '')) {
    const index = entry.indexOf('=');
    must(index > 0 && index < entry.length - 1, 'function-storage-binding');
    const key = entry.slice(0, index).toLowerCase();
    must(!fields.has(key) && ['defaultendpointsprotocol', 'accountname', 'accountkey', 'endpointsuffix'].includes(key),
      'function-storage-binding');
    fields.set(key, entry.slice(index + 1));
  }
  const name = fields.get('accountname'), key = fields.get('accountkey');
  must(fields.size === 4 && fields.get('defaultendpointsprotocol') === 'https' &&
    fields.get('endpointsuffix') === 'core.windows.net' && typeof name === 'string' &&
    /^[a-z0-9]{3,24}$/u.test(name) && typeof key === 'string', 'function-storage-binding');
  const decoded = Buffer.from(key, 'base64');
  try { must(decoded.length === 64 && decoded.toString('base64') === key, 'function-storage-binding'); }
  finally { decoded.fill(0); }
  return { accountName: name, accountKey: key };
}

/** App settings use the documented read-only POST API. Sensitive values never enter the observation or its public projection. */
export async function readApplicationFunctionConfiguration(input: {
  resourceId: string;
  address: string;
  binding: AzureArmBinding;
  transport: AzureArmTransport;
  authorize(): Promise<void>;
  expectedState?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{
  values: Record<string, unknown>;
  privateDigest: string;
  dependencies: ApplicationPrivateObservation['dependencies'];
}> {
  const dependencies: ApplicationPrivateObservation['dependencies'][number][] = [];
  const responses: Record<string, unknown>[] = [];
  for (const request of applicationFunctionReadRequests(input.resourceId)) {
    await input.authorize();
    must(!input.signal?.aborted, 'function-readback-cancelled');
    const response = await input.transport.request({
      method: request.method, resourceId: request.resourceId, apiVersion: request.apiVersion
    }, input.binding);
    const requestId = applicationUuid(response.requestId, 'Actual Function configuration read');
    try {
      must(response.status === 200 && isRecord(response.data) && response.data.id === request.responseId &&
        response.data.type === 'Microsoft.Web/sites/config' && isRecord(response.data.properties),
      'function-configuration-readback');
      responses.push(response.data.properties);
      dependencies.push({
        resourceId: request.responseId, resourceType: 'Microsoft.Web/sites/config', readbackRequestId: requestId, method: request.method
      });
    } catch (error) {
      throw new ApplicationPrivateResourceReadbackError(error instanceof ApplicationPrivateError ? error.code : 'function-configuration-readback', {
        address: input.address, requestedResourceId: request.resourceId, readbackRequestId: requestId, status: response.status
      });
    }
  }
  const web = responses[0]!, settings = responses[1]!;
  must(Object.keys(settings).length <= 256 && Object.entries(settings).every(([key, value]) =>
    key.length > 0 && key.length <= 256 && typeof value === 'string' && value.length <= 16384), 'function-app-settings-shape');
  must(typeof web.linuxFxVersion === 'string' && /^Python\|[0-9]+\.[0-9]+$/iu.test(web.linuxFxVersion), 'function-runtime-shape');
  const connection = storageConnection(settings.AzureWebJobsStorage);
  const state = input.expectedState;
  if (state) {
    must(state.storage_account_name === connection.accountName && state.storage_account_access_key === connection.accountKey &&
      isRecord(state.app_settings), 'function-private-storage-readback');
    for (const [key, expected] of Object.entries(state.app_settings)) {
      must(typeof expected === 'string' && settings[key] === expected, 'function-private-setting-readback');
    }
  }
  return {
    values: {
      storage_account_name: connection.accountName,
      site_config: [{ application_stack: [{ python_version: web.linuxFxVersion.slice('Python|'.length) }] }]
    },
    privateDigest: canonicalSha256({ web, settings }),
    dependencies
  };
}

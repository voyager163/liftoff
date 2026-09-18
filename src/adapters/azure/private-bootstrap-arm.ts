import {
  AzureArmError, azureArmUrl, createAzureCliArmTransport,
  type AzureArmBinding, type AzureArmResponse, type AzureArmTransport
} from './activation-rest.js';
import type { CommandRunner } from '../../process-runner.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { PrivateArmResource } from '../../application/azure-activation/private-resource-plans.js';

export interface BootstrapArmPort {
  read(resource: PrivateArmResource, binding: AzureArmBinding): Promise<AzureArmResponse>;
  create(resource: PrivateArmResource, binding: AzureArmBinding, clientRequestId: string): Promise<AzureArmResponse>;
  poll(operationUrl: string, binding: AzureArmBinding): Promise<AzureArmResponse>;
}

export interface BootstrapConditionalCreateQualification {
  assertQualified(request: {
    resourceType: string; apiVersion: string; binding: AzureArmBinding; location: string | null;
    recipe: 'azure-arm-if-none-match/1';
  }): Promise<void>;
}

export function createPrivateBootstrapArmPort(
  runner: CommandRunner, projectRoot: string,
  options: { transport?: AzureArmTransport; fetch?: typeof globalThis.fetch; qualification?: BootstrapConditionalCreateQualification } = {}
): BootstrapArmPort {
  const read = options.transport ?? createAzureCliArmTransport(runner, projectRoot, { fetch: options.fetch });
  const create = createAzureCliArmTransport(runner, projectRoot, {
    fetch: (url, init) => {
      if (init?.method !== 'PUT') throw new AzureArmError('private-create-only', 'Bootstrap transport permits only exact conditional resource creation.');
      const headers = new Headers(init.headers);
      headers.set('If-None-Match', '*');
      return (options.fetch ?? globalThis.fetch)(url, { ...init, headers });
    }
  });
  return {
    read: (resource, binding) => read.request({ method: 'GET', resourceId: resource.resourceId, apiVersion: resource.apiVersion }, binding),
    async create(resource, binding, clientRequestId) {
      if (resource.bodyDigest !== canonicalSha256(resource.body) ||
        !/^(?:Microsoft\.Network\/|GitHub\.Network\/networkSettings$)/u.test(resource.resourceType)) {
        throw new AzureArmError('private-create-only', 'Bootstrap cannot create application, identity, storage or arbitrary ARM resources.');
      }
      if (!options.qualification) throw new AzureArmError('conditional-create-unqualified',
        'This exact ARM provider/API has no independently established conditional-create semantics. An If-None-Match header alone cannot prevent a provider that ignores it from replacing a racing resource.',
        undefined, undefined, false);
      try {
        await options.qualification.assertQualified({
          resourceType: resource.resourceType, apiVersion: resource.apiVersion, binding,
          location: resource.location, recipe: 'azure-arm-if-none-match/1'
        });
      } catch {
        throw new AzureArmError('conditional-create-unqualified',
          'The exact provider/API conditional-create capability did not pass independent admission; no mutation was dispatched.',
          undefined, undefined, false);
      }
      return create.request({
        method: 'PUT', resourceId: resource.resourceId, apiVersion: resource.apiVersion,
        body: resource.body, clientRequestId
      }, binding);
    },
    poll(operationUrl, binding) {
      const url = new URL(operationUrl);
      const version = url.searchParams.get('api-version') ?? '';
      if (url.href !== azureArmUrl(url.pathname, version, binding.subscriptionId)) {
        throw new AzureArmError('private-poll-binding', 'Bootstrap polling cannot leave the returned exact ARM operation.');
      }
      return read.request({ method: 'GET', resourceId: url.pathname, apiVersion: version }, binding);
    }
  };
}

function projection(expected: unknown, actual: unknown): unknown {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new AzureArmError('private-resource-drift', 'Actual network membership differs from the exact reviewed resource.');
    return expected.map((entry, index) => projection(entry, actual[index]));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) throw new AzureArmError('private-resource-drift', 'The expected private network resource structure is missing.');
    return Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, projection(value, actual[key])]));
  }
  if (expected !== actual) throw new AzureArmError('private-resource-drift', 'An access-establishing network property differs from the exact reviewed value.');
  return actual;
}

export function observePrivateArmResource(resource: PrivateArmResource, response: AzureArmResponse): {
  resourceId: string;
  resourceType: string;
  requestId: string;
  bodyDigest: string;
  githubNetworkSettingsId: string | null;
} {
  if (response.status !== 200 || typeof response.requestId !== 'string' || !isRecord(response.data) ||
    typeof response.data.id !== 'string' || response.data.id.toLowerCase() !== resource.resourceId.toLowerCase() ||
    typeof response.data.type !== 'string' || response.data.type.toLowerCase() !== resource.resourceType.toLowerCase() ||
    !isRecord(response.data.properties) || response.data.properties.provisioningState !== 'Succeeded') {
    throw new AzureArmError('private-resource-incomplete', 'ARM has not independently confirmed the exact access resource as provisioned.');
  }
  const body = projection(resource.body, response.data);
  let githubNetworkSettingsId: string | null = null;
  if (resource.resourceType === 'GitHub.Network/networkSettings') {
    const id = isRecord(response.data.tags) ? response.data.tags.GitHubId : null;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)) {
      throw new AzureArmError('private-network-identity', 'The Azure network settings readback has no actual provider-issued GitHubId.');
    }
    githubNetworkSettingsId = id;
  }
  return { resourceId: resource.resourceId, resourceType: resource.resourceType, requestId: response.requestId,
    bodyDigest: canonicalSha256(body), githubNetworkSettingsId };
}

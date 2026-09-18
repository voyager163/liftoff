import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';
import { StateMigrationError } from '../../domain/repair/stateful.js';
import { azureArmBinding, azureArmUrl, createAzureCliArmTransport, type AzureArmBinding, type AzureArmTransport } from './activation-rest.js';
import { readAzureCliPrivateToken, validatePrivateStatePathTarget, type PrivateStatePathTarget } from './private-state-path.js';
import { azureStateUrl } from '../state/azure-blob.js';
import type { CommandRunner } from '../../process-runner.js';
import type { PrivateBackendRunReport } from '../../application/azure-activation/private-backend-workflow.js';
import type { PrivateLeaseChallenge, PrivateLeaseStep } from '../../application/azure-activation/private-backend-lease.js';

export interface PrivateBackendAuditBinding {
  workspaceResourceId: string;
  workspaceId: string;
  reader: AzureArmBinding;
}

export interface PrivateBackendAuditObservation {
  kind: 'private-backend-independent-audit/1';
  workspaceResourceId: string;
  workspaceId: string;
  readerPrincipalId: string;
  requestIds: readonly string[];
  records: readonly {
    step: PrivateLeaseStep;
    clientRequestId: string;
    operationName: string;
    status: number;
    loggedAt: string;
    resourceId: string;
    principalId: string;
    correlationId: string;
  }[];
  observedAt: string;
  digest: string;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const columns = [
  'TimeGenerated', 'ClientRequestId', 'OperationName', 'StatusCode', 'ResourceId', 'SubscriptionId',
  'RequesterTenantId', 'RequesterObjectId', 'RequesterAppId', 'AuthenticationType', 'Protocol',
  'TlsVersion', 'TargetUri', 'Etag', 'CallerIpAddress', 'UserAgentHeader', 'CorrelationId', 'OperationCount'
] as const;

function record(value: unknown): Record<string, unknown> {
  stateAssert(isRecord(value), 'incomplete-observation');
  return value;
}

function providerId(value: unknown): string {
  stateAssert(typeof value === 'string' && uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000', 'incomplete-observation');
  return value;
}

export function validatePrivateBackendAuditBinding(value: PrivateBackendAuditBinding, target: PrivateStatePathTarget): PrivateBackendAuditBinding {
  stateAssert(isRecord(value) && Object.keys(value).sort().join(',') === 'reader,workspaceId,workspaceResourceId', 'invalid-binding');
  stateAssert(isRecord(value.reader) && Object.keys(value.reader).sort().join(',') === 'principalId,subscriptionId,tenantId', 'invalid-binding');
  const reader = azureArmBinding(value.reader);
  stateAssert(reader.subscriptionId === target.binding.subscriptionId && reader.tenantId === target.binding.tenantId &&
    uuid.test(value.workspaceId) && value.workspaceId !== '00000000-0000-0000-0000-000000000000', 'invalid-binding');
  azureArmUrl(value.workspaceResourceId, '2022-10-01', reader.subscriptionId);
  stateAssert(/\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+$/u.test(value.workspaceResourceId), 'invalid-binding');
  return { ...structuredClone(value), reader };
}

export class PrivateBackendAuditClient {
  readonly binding: PrivateBackendAuditBinding;
  readonly target: PrivateStatePathTarget;
  private readonly arm: AzureArmTransport;

  constructor(private readonly options: {
    runner: CommandRunner;
    projectRoot: string;
    target: PrivateStatePathTarget;
    binding: PrivateBackendAuditBinding;
    arm?: AzureArmTransport;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    authorize(): Promise<void>;
  }) {
    this.target = validatePrivateStatePathTarget(options.target);
    this.binding = validatePrivateBackendAuditBinding(options.binding, this.target);
    this.arm = options.arm ?? createAzureCliArmTransport(options.runner, options.projectRoot);
  }

  private async read(resourceId: string, apiVersion: string, ids: string[]) {
    await this.options.authorize();
    const response = await this.arm.request({ method: 'GET', resourceId, apiVersion }, this.binding.reader);
    stateAssert(response.status === 200, 'access-denied');
    ids.push(providerId(response.requestId));
    return record(response.data);
  }

  private async controls(ids: string[]): Promise<string> {
    const target = this.target;
    const workspace = await this.read(this.binding.workspaceResourceId, '2022-10-01', ids);
    stateAssert(workspace.id === this.binding.workspaceResourceId &&
      record(workspace.properties).customerId === this.binding.workspaceId, 'ownership-mismatch');
    const accountId = `/subscriptions/${target.binding.subscriptionId}/resourceGroups/${target.backend.resourceGroup}` +
      `/providers/Microsoft.Storage/storageAccounts/${target.backend.account}`;
    const account = await this.read(accountId, '2023-05-01', ids);
    const properties = record(account.properties);
    stateAssert(account.id === accountId && account.location === target.region &&
      record(account.tags)['liftoff-repository-id'] === target.backend.ownerId &&
      properties.publicNetworkAccess === 'Disabled' && properties.allowBlobPublicAccess === false &&
      ['TLS1_2', 'TLS1_3'].includes(String(properties.minimumTlsVersion)) &&
      record(properties.primaryEndpoints).blob === `https://${target.backend.account}.blob.core.windows.net/`, 'ownership-mismatch');
    const service = await this.read(`${accountId}/blobServices/default`, '2023-05-01', ids);
    const blob = record(service.properties);
    stateAssert(blob.isVersioningEnabled === true && record(blob.deleteRetentionPolicy).enabled === true &&
      Number(record(blob.deleteRetentionPolicy).days) > 0, 'unsupported-encryption');
    const container = await this.read(`${accountId}/blobServices/default/containers/${target.backend.container}`, '2023-05-01', ids);
    stateAssert(record(container.properties).publicAccess === 'None', 'access-denied');
    const endpoint = await this.read(target.privateEndpointId, '2024-05-01', ids);
    const ep = record(endpoint.properties);
    stateAssert(endpoint.id === target.privateEndpointId && endpoint.location === target.region &&
      ep.provisioningState === 'Succeeded' && record(ep.subnet).id === target.subnetId &&
      Array.isArray(ep.privateLinkServiceConnections) && ep.privateLinkServiceConnections.length === 1 &&
      Array.isArray(ep.networkInterfaces) && ep.networkInterfaces.length === 1, 'ownership-mismatch');
    const connection = record(record(ep.privateLinkServiceConnections[0]).properties);
    stateAssert(connection.privateLinkServiceId === accountId &&
      canonicalSha256(connection.groupIds) === canonicalSha256(['blob']) &&
      record(connection.privateLinkServiceConnectionState).status === 'Approved', 'access-denied');
    const nicId = record(ep.networkInterfaces[0]).id;
    stateAssert(typeof nicId === 'string', 'incomplete-observation');
    const nic = await this.read(nicId, '2024-05-01', ids);
    const nicProps = record(nic.properties);
    stateAssert(nic.id === nicId && record(nicProps.privateEndpoint).id === target.privateEndpointId &&
      Array.isArray(nicProps.ipConfigurations) && nicProps.ipConfigurations.length === 1 &&
      record(record(nicProps.ipConfigurations[0]).properties).privateIPAddress === target.endpointAddress, 'ownership-mismatch');
    return accountId;
  }

  async inspect(): Promise<{ accountResourceId: string; requestIds: readonly string[] }> {
    const requestIds: string[] = [];
    const accountResourceId = await this.controls(requestIds);
    return { accountResourceId, requestIds };
  }

  async verify(report: PrivateBackendRunReport, challenge: PrivateLeaseChallenge, azureClientId: string): Promise<PrivateBackendAuditObservation> {
    stateAssert(report.probe?.outcome === 'verified' && report.network && report.job &&
      report.probe.intentDigest === challenge.intentDigest && report.principalId === this.target.binding.principalId, 'verification-incomplete');
    const requestIds: string[] = [];
    const accountId = await this.controls(requestIds);
    const blobUri = azureStateUrl(this.target.backend, 'blob');
    const userAgent = `liftoff-private-lease/${challenge.intentDigest}/${report.runId}/${report.runAttempt}/${report.correlationId}`;
    const ids = Object.values(challenge.clientRequestIds);
    stateAssert(ids.length === 4 && ids.every((value) => uuid.test(value)), 'invalid-binding');
    const before = report.probe.metadata.find((entry) => entry.stage === 'before')?.observedAt;
    const after = report.probe.metadata.find((entry) => entry.stage === 'after')?.observedAt;
    stateAssert(before && after && Number.isFinite(Date.parse(before)) && Number.isFinite(Date.parse(after)) &&
      Date.parse(after) >= Date.parse(before) && Date.parse(after) - Date.parse(before) <= 120_000, 'verification-incomplete');
    const start = new Date(Date.parse(before) - 1000).toISOString();
    const end = new Date(Date.parse(after) + 1000).toISOString();
    const query = [
      'StorageBlobLogs',
      `| where TimeGenerated between (datetime(${start}) .. datetime(${end}))`,
      `| where ClientRequestId in (${ids.map((value) => JSON.stringify(value)).join(',')})`,
      `| where _SubscriptionId == ${JSON.stringify(this.target.binding.subscriptionId)}`,
      `| where _ResourceId in~ (${JSON.stringify(accountId)},${JSON.stringify(`${accountId}/blobServices/default`)})`,
      '| project TimeGenerated,ClientRequestId,OperationName,StatusCode,ResourceId=tostring(_ResourceId),SubscriptionId=tostring(_SubscriptionId),',
      'RequesterTenantId,RequesterObjectId,RequesterAppId,AuthenticationType,Protocol,TlsVersion,',
      'TargetUri=strcat("https://",tostring(parse_url(Uri).Host),tostring(parse_url(Uri).Path)),',
      'Etag,CallerIpAddress,UserAgentHeader,CorrelationId,OperationCount',
      '| take 17'
    ].join('\n');
    await this.options.authorize();
    const signal = AbortSignal.timeout(20_000);
    const token = await readAzureCliPrivateToken(this.options.runner, this.options.projectRoot, this.binding.reader, 'log-analytics', signal, this.options.now);
    let data: Record<string, unknown>;
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(
        `https://api.loganalytics.azure.com/v1/workspaces/${this.binding.workspaceId}/query`, {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json',
            'x-ms-client-request-id': randomUUID(), Prefer: 'wait=15' },
          body: JSON.stringify({ query, timespan: `${start}/${end}` })
        }
      );
      stateAssert(response.status === 200, 'access-denied');
      requestIds.push(providerId(response.headers.get('x-ms-request-id')));
      let total = 0;
      const chunks: Uint8Array[] = [];
      if (response.body) for await (const bytes of response.body) {
        total += bytes.length;
        stateAssert(total <= 256 * 1024, 'storage-limit');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      try { stateAssert(isUtf8(bytes), 'incomplete-observation'); data = record(JSON.parse(bytes.toString('utf8'))); }
      finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      throw new StateMigrationError(signal.aborted ? 'timeout' : 'incomplete-observation');
    } finally { token.token = ''; }
    stateAssert(data.error === undefined && Array.isArray(data.tables) && data.tables.length === 1, 'incomplete-observation');
    const table = record(data.tables[0]);
    stateAssert(Array.isArray(table.columns) && table.columns.length === columns.length &&
      table.columns.every((column, index) => record(column).name === columns[index]) &&
      Array.isArray(table.rows) && table.rows.length === 4, 'verification-incomplete');
    const rows = table.rows.map((row) => {
      stateAssert(Array.isArray(row) && row.length === columns.length, 'incomplete-observation');
      return Object.fromEntries(columns.map((name, index) => [name, row[index]]));
    });
    const records = report.probe.effects.map((effect) => {
      const matching = rows.filter((row) => row.ClientRequestId === effect.clientRequestId);
      stateAssert(matching.length === 1, 'verification-incomplete');
      const row = matching[0]!;
      const operation = effect.action === 'acquire' ? 'AcquireBlobLease' : effect.action === 'renew' ? 'RenewBlobLease' : 'ReleaseBlobLease';
      const callerIp = typeof row.CallerIpAddress === 'string' ? row.CallerIpAddress.replace(/:\d+$/u, '') : '';
      stateAssert(effect.outcome === 'returned' && effect.status !== null && effect.startedAt && effect.observedAt &&
        row.OperationName === operation && Number(row.StatusCode) === effect.status &&
        typeof row.ResourceId === 'string' &&
        [accountId.toLowerCase(), `${accountId}/blobServices/default`.toLowerCase()].includes(row.ResourceId.toLowerCase()) &&
        row.SubscriptionId === this.target.binding.subscriptionId && row.RequesterTenantId === this.target.binding.tenantId &&
        row.RequesterObjectId === this.target.binding.principalId && row.RequesterAppId === azureClientId &&
        row.AuthenticationType === 'OAuth' && String(row.Protocol).toLowerCase() === 'https' &&
        ['TLS 1.2', 'TLS 1.3'].includes(String(row.TlsVersion)) &&
        row.TargetUri === blobUri && row.UserAgentHeader === userAgent && callerIp === report.network!.route.source &&
        (effect.status === 409 || row.Etag === challenge.expectedEtag) && row.OperationCount === 0 &&
        typeof row.TimeGenerated === 'string' &&
        Date.parse(row.TimeGenerated) >= Date.parse(effect.startedAt) - 1000 &&
        Date.parse(row.TimeGenerated) <= Date.parse(effect.observedAt) + 1000 &&
        typeof row.CorrelationId === 'string' && uuid.test(row.CorrelationId), 'verification-incomplete');
      return {
        step: effect.step, clientRequestId: effect.clientRequestId, operationName: operation, status: effect.status,
        loggedAt: row.TimeGenerated, resourceId: String(row.ResourceId), principalId: this.target.binding.principalId,
        correlationId: row.CorrelationId
      };
    });
    await this.options.authorize();
    const observed = {
      kind: 'private-backend-independent-audit/1' as const, workspaceResourceId: this.binding.workspaceResourceId,
      workspaceId: this.binding.workspaceId, readerPrincipalId: this.binding.reader.principalId, requestIds, records,
      observedAt: new Date(this.options.now?.() ?? Date.now()).toISOString()
    };
    return { ...observed, digest: canonicalSha256(observed) };
  }
}

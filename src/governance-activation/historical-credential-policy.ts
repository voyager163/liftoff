import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import {
  historyArray, historyDigest, historyEnum, historyExact, historyFail, historyLiteral,
  historyPathParts, historyString, historyStrings, historyTimestamp, historicalV1Identity, historicalV2Identity,
  historicalIdentity
} from './history-contracts.js';
import { assertSafeHistoricalRecord } from './historical-safety.js';

/** Schema 1 was unchanged between v1 and v2; the wrappers still require their exact family. */
export function validateHistoricalV2CredentialPolicy(value: unknown): void {
  readHistoricalCredentialPolicy(value, historicalV2Identity, 'historicalV2CredentialPolicy');
}

export function validateHistoricalV1CredentialPolicy(value: unknown): void {
  readHistoricalCredentialPolicy(value, historicalV1Identity, 'historicalV1CredentialPolicy');
}

function readHistoricalCredentialPolicy(value: unknown, identityReader: typeof historicalIdentity, label: string): void {
  assertSafeHistoricalRecord(value, label);
  const item = historyExact(value, [
    'schemaVersion', 'identity', 'repository', 'owner', 'authKind', 'displayNameTemplate', 'displayName',
    'secretName', 'createdAt', 'expiresAt', 'rotationLeadDays', 'rotationDueAt', 'permissions', 'allowedWorkflows',
    'nonForwarding', 'status', 'proof', 'app', 'pat'
  ], label);
  historyLiteral(item.schemaVersion, 1, `${label}.schemaVersion`);
  identityReader(item.identity, `${label}.identity`);
  const repository = historyExact(item.repository, ['id', 'owner', 'name', 'fullName'], `${label}.repository`);
  for (const key of ['id', 'owner', 'name', 'fullName']) historyString(repository[key], `${label}.repository.${key}`);
  historyLiteral(repository.fullName, `${repository.owner}/${repository.name}`, `${label}.repository.fullName`);
  historyLiteral(item.owner, historyString(repository.owner, label), `${label}.owner`);
  historyLiteral(item.displayNameTemplate, '<repo>-runner-preflight-read', `${label}.displayNameTemplate`);
  historyLiteral(item.displayName, `${historyString(repository.name, label).toLowerCase()}-runner-preflight-read`, `${label}.displayName`);
  historyLiteral(item.secretName, 'RUNNER_CONFIGURATION_READ_TOKEN', `${label}.secretName`);
  historyLiteral(item.nonForwarding, true, `${label}.nonForwarding`);
  const createdAt = historyTimestamp(item.createdAt, `${label}.createdAt`);
  const expiresAt = historyTimestamp(item.expiresAt, `${label}.expiresAt`);
  historyLiteral(item.rotationLeadDays, 7, `${label}.rotationLeadDays`);
  historyLiteral(item.rotationDueAt, new Date(Date.parse(expiresAt) - 7 * 86_400_000).toISOString(), `${label}.rotationDueAt`);
  historyEnum(item.status, ['active', 'expiring', 'expired', 'compromised'], `${label}.status`);
  const permissions = historyExact(item.permissions, ['repository', 'organization'], `${label}.permissions`);
  for (const [key, expected] of [
    ['repository', ['metadata:read']],
    ['organization', ['hosted-runners:read', 'network-configurations:read']]
  ] as const) {
    const found = historyStrings(permissions[key], `${label}.permissions.${key}`);
    if (canonicalSha256([...found].sort()) !== canonicalSha256([...expected].sort())) historyFail(label, 'permissions differ from the published bounded policy.');
  }
  const paths = new Set<string>();
  for (const entry of historyArray(item.allowedWorkflows, `${label}.allowedWorkflows`)) {
    const workflow = historyExact(entry, ['path', 'jobs'], `${label}.allowedWorkflows`);
    const name = historyString(workflow.path, `${label}.allowedWorkflows.path`);
    const parts = historyPathParts(name.split('/'), `${label}.allowedWorkflows.path`);
    if (parts.length !== 3 || parts[0] !== '.github' || parts[1] !== 'workflows' || paths.has(name.toLowerCase())) {
      historyFail(label, 'requires unique portable GitHub workflow identities.');
    }
    paths.add(name.toLowerCase());
    const jobs = historyStrings(workflow.jobs, `${label}.allowedWorkflows.jobs`);
    if (!jobs.length || new Set(jobs).size !== jobs.length) historyFail(label, 'requires nonempty unique workflow jobs.');
  }
  if (!paths.size) historyFail(label, 'requires a nonempty workflow allowlist.');
  const proof = historyExact(item.proof, ['verifiedAt', 'readbackDigest', 'readbackProvider', 'payloadFree'], `${label}.proof`);
  historyTimestamp(proof.verifiedAt, `${label}.proof.verifiedAt`);
  historyDigest(proof.readbackDigest, `${label}.proof.readbackDigest`);
  historyEnum(proof.readbackProvider, ['github-api', 'adapter-fixture'], `${label}.proof.readbackProvider`);
  historyLiteral(proof.payloadFree, true, `${label}.proof.payloadFree`);
  const authKind = historyEnum(item.authKind, ['github-app', 'fine-grained-pat'], `${label}.authKind`);
  if (authKind === 'github-app') {
    if (item.pat !== null) historyFail(`${label}.pat`, 'App policy cannot contain PAT metadata.');
    const app = historyExact(item.app, ['installationId', 'appSlug', 'selection', 'repositoryFullName', 'permissionsVerifiedAt', 'token'], `${label}.app`);
    if (typeof app.installationId !== 'number' || !Number.isSafeInteger(app.installationId) || app.installationId <= 0) historyFail(label, 'requires a positive App installation ID.');
    historyString(app.appSlug, `${label}.app.appSlug`);
    historyLiteral(app.selection, 'selected-repository', `${label}.app.selection`);
    historyLiteral(app.repositoryFullName, historyString(repository.fullName, label), `${label}.app.repositoryFullName`);
    historyTimestamp(app.permissionsVerifiedAt, `${label}.app.permissionsVerifiedAt`);
    const token = historyExact(app.token, ['strategy', 'ttlSeconds', 'generatedBy'], `${label}.app.token`);
    historyLiteral(token.strategy, 'installation-token', `${label}.app.token.strategy`);
    historyLiteral(token.generatedBy, 'github-app', `${label}.app.token.generatedBy`);
    if (typeof token.ttlSeconds !== 'number' || !Number.isSafeInteger(token.ttlSeconds) || token.ttlSeconds <= 0 || token.ttlSeconds > 3600) historyFail(label, 'requires the bounded installation-token lifetime.');
  } else {
    if (item.app !== null) historyFail(`${label}.app`, 'PAT policy cannot contain App metadata.');
    const pat = historyExact(item.pat, ['lifetimeDays', 'selectedRepositoryOnly', 'createdBy'], `${label}.pat`);
    historyLiteral(pat.lifetimeDays, 30, `${label}.pat.lifetimeDays`);
    historyLiteral(pat.selectedRepositoryOnly, true, `${label}.pat.selectedRepositoryOnly`);
    historyLiteral(pat.createdBy, 'manual-masked-entry', `${label}.pat.createdBy`);
    if (Date.parse(expiresAt) - Date.parse(createdAt) !== 30 * 86_400_000) historyFail(label, 'requires the original 30-day PAT lifetime.');
  }
}

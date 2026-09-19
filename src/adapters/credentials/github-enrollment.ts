import { createPrivateKey, sign } from 'node:crypto';
import { inspect } from 'node:util';
import type { CommandRunner } from '../../process-runner.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { runnerPreflightSecretName } from '../../domain/governance/activation/types.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { UpdatePreviewOptions } from '../filesystem/update-previews.js';
import type { ProtectedCredentialChannel } from './protected-input.js';
import { detectCredentialLeaks } from '../../governance-activation/credentials.js';
import {
  GitHubActivationClient, GitHubActivationError, createGitHubCliTransport,
  githubName, githubRepository, object, positiveId, text, type GitHubActivationTransport
} from '../github/activation-rest.js';
import { assertCredentialAuthority } from './credential-authority.js';
import {
  readCredentialCheckpoints, type CredentialPreparedCheckpoint
} from './credential-checkpoints.js';
import {
  credentialApiPermissions, observeCredentialPermissions, validateObservedCredentialPermissions,
  assertCredentialProviderPolicyPermitted, credentialPermissionBoundary,
  type ObservedCredentialPermissions, type CredentialProviderPermissionBoundary
} from './credential-permissions.js';
export { credentialApiPermissions } from './credential-permissions.js';

export type GitHubCredentialConfiguration =
  | { kind: 'github-app'; appId: number; installationId: number }
  | { kind: 'fine-grained-pat'; tokenId: number; owner: string; appUnavailableReason: string };

export const credentialProductionContractGaps = {
  conditionalCreate: 'This reviewed create-only request cannot be expressed by the documented GitHub create-or-update PUT. It remains unavailable; it will not be silently changed into replacement. Existing-App verification does not require this write.',
  patIdentity: 'The supported PAT observations do not bind the supplied bearer to this exact approved grant. Owner or expiry matching is insufficient; token-specific permission and lifetime proof remains unresolved.'
} as const;

export interface CredentialPrincipal { id: number; login: string }
export interface GitHubCredentialTarget {
  repository: string;
  repositoryId: number;
  ownerId: number;
  actor: CredentialPrincipal;
  principal: CredentialPrincipal;
  configuration: GitHubCredentialConfiguration;
  source: 'protected-input' | 'existing-app-private-key' | 'custody-envelope-v1';
  protectedReference: string;
  /** Existing GitHub secret values have no documented provider version. */
  custodyVersion: string | null;
  metadata: {
    /** App installation creation; approved PAT inventory does not expose token creation. */
    createdAt: string | null;
    accessGrantedAt: string | null;
    expiresAt: string | null;
    grantId: number | null;
    appSlug: string | null;
    observedPermissions: ObservedCredentialPermissions;
    permissionsDigest: string;
  };
}

export interface GitHubSecretMetadata {
  name: typeof runnerPreflightSecretName;
  createdAt: string;
  updatedAt: string;
}

export function validateGitHubSecretMetadata(value: unknown): GitHubSecretMetadata {
  const metadata = object(value, 'Secret metadata');
  if (Object.keys(metadata).sort().join(',') !== 'createdAt,name,updatedAt' || metadata.name !== runnerPreflightSecretName) {
    throw new GitHubActivationError('credential-secret-target', 'The exact repository secret metadata binding is required.');
  }
  const createdAt = iso(metadata.createdAt), updatedAt = iso(metadata.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new GitHubActivationError('credential-secret-time', 'Provider secret metadata timestamps contradict one another.');
  return { name: runnerPreflightSecretName, createdAt, updatedAt };
}

export interface CredentialEnrollmentPlan {
  kind: 'github-credential-enrollment.v1';
  target: GitHubCredentialTarget;
  expectedSecret: null;
  permissionBoundary: CredentialProviderPermissionBoundary;
}

export interface GitHubSecretWriteReceipt {
  status: 201;
  providerRequestId: string;
  providerVersion: null;
}

export class GitHubCredentialWriteError extends GitHubActivationError {
  constructor(
    readonly effect: 'not-dispatched' | 'rejected' | 'uncertain',
    readonly providerRequestId: string | null = null,
    status?: number
  ) {
    super('credential-enrollment-effect',
      effect === 'not-dispatched' ? 'Credential enrollment was not dispatched.' :
        effect === 'rejected' ? 'The provider rejected credential enrollment.' :
          'Credential enrollment has an uncertain provider outcome; do not retry or replace the stored value.', status);
  }
}

export interface CredentialSubmission {
  executionInput: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  prepared: CredentialPreparedCheckpoint;
  storage?: UpdatePreviewOptions;
}

export interface GitHubSecretWriter {
  readonly semantics: 'create-or-update';
  encrypt(repository: string, name: typeof runnerPreflightSecretName, value: Uint8Array): Promise<ProtectedGitHubSecretCiphertext>;
  write(repository: string, name: typeof runnerPreflightSecretName, value: Uint8Array, submission: CredentialSubmission): Promise<GitHubSecretWriteReceipt>;
}

export class ProtectedGitHubSecretCiphertext {
  #bytes: Buffer | undefined;
  constructor(readonly keyId: string, bytes: Uint8Array) { this.#bytes = Buffer.from(bytes); }
  use<T>(consume: (bytes: Uint8Array, keyId: string) => T): T {
    if (!this.#bytes) throw new GitHubActivationError('credential-released', 'Encrypted credential memory has been released.');
    return consume(this.#bytes, this.keyId);
  }
  release(): void { this.#bytes?.fill(0); this.#bytes = undefined; }
  toJSON(): never { throw new GitHubActivationError('credential-publication', 'Encrypted credential material cannot be serialized into a public record.'); }
  [inspect.custom](): string { return '[ProtectedGitHubSecretCiphertext]'; }
}

function same(actual: unknown, expected: unknown): boolean {
  return canonicalSha256(actual) === canonicalSha256(expected);
}

export function credentialUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw new GitHubActivationError('credential-reference', 'Credential custody requires an explicit non-secret UUID version.');
  }
  return value;
}

export function credentialReference(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('github-actions-secret:')) {
    const suffix = `/${runnerPreflightSecretName}`;
    if (!value.endsWith(suffix)) throw new GitHubActivationError('credential-reference', 'Only the fixed repository preflight secret may be selected.');
    githubRepository(value.slice('github-actions-secret:'.length, -suffix.length));
    return value;
  }
  if (typeof value !== 'string' || !value.startsWith('protected-input:')) {
    throw new GitHubActivationError('credential-reference', 'Use an opaque protected-input reference, never a token, key, path or command.');
  }
  credentialUuid(value.slice('protected-input:'.length));
  return value;
}

export function credentialPrincipal(value: unknown): CredentialPrincipal {
  const principal = object(value, 'Credential principal');
  if (Object.keys(principal).length !== 2 || !Object.hasOwn(principal, 'id') || !Object.hasOwn(principal, 'login') ||
    typeof principal.login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?$/u.test(principal.login)) {
    throw new GitHubActivationError('credential-principal', 'An exact numeric provider principal and login are required.');
  }
  return { id: positiveId(principal.id), login: principal.login };
}

export function parseGitHubCredentialConfiguration(value: unknown): GitHubCredentialConfiguration {
  const config = object(value, 'credential-ready configuration');
  const allowed = config.kind === 'github-app' ? ['kind', 'appId', 'installationId'] :
    ['kind', 'tokenId', 'owner', 'appUnavailableReason'];
  if (Object.keys(config).length !== allowed.length || Object.keys(config).some((key) => !allowed.includes(key))) {
    throw new GitHubActivationError('credential-config', 'Credential configuration requires exact public identities only; unknown fields, values and arbitrary grants are forbidden.');
  }
  if (config.kind === 'github-app') return {
    kind: 'github-app', appId: positiveId(config.appId, 'Approved App ID'), installationId: positiveId(config.installationId, 'Approved installation ID')
  };
  if (config.kind !== 'fine-grained-pat') {
    throw new GitHubActivationError('credential-config', 'Select an approved scoped App or an explicitly justified fine-grained PAT. There is no default credential.');
  }
  const reason = text(config.appUnavailableReason, 'App unavailability reason');
  if (detectCredentialLeaks([{ source: 'imported-evidence', label: 'credential configuration', text: reason }]).status !== 'clear') {
    throw new GitHubActivationError('credential-config', 'Credential values are forbidden in public configuration.');
  }
  return { kind: 'fine-grained-pat', tokenId: positiveId(config.tokenId, 'Approved PAT ID'),
    owner: githubName(config.owner, 'Credential owner'), appUnavailableReason: reason };
}

function iso(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new GitHubActivationError('credential-metadata', 'The provider did not return a valid credential metadata timestamp.');
  }
  return new Date(value).toISOString();
}

export function validateGitHubCredentialTarget(value: unknown): GitHubCredentialTarget {
  const target = object(value, 'Credential target');
  const fields = ['repository', 'repositoryId', 'ownerId', 'actor', 'principal', 'configuration', 'source', 'protectedReference', 'custodyVersion', 'metadata'];
  if (Object.keys(target).length !== fields.length || fields.some((field) => !Object.hasOwn(target, field))) {
    throw new GitHubActivationError('credential-target', 'Credential target contains unknown or missing public bindings.');
  }
  const metadata = object(target.metadata);
  const metadataFields = ['createdAt', 'accessGrantedAt', 'expiresAt', 'grantId', 'appSlug', 'observedPermissions', 'permissionsDigest'];
  const config = parseGitHubCredentialConfiguration(target.configuration);
  const observedPermissions = validateObservedCredentialPermissions(metadata.observedPermissions, config.kind);
  const repository = githubRepository(target.repository);
  const source = target.source;
  if (!['protected-input', 'existing-app-private-key', 'custody-envelope-v1'].includes(String(source)) ||
    (source === 'existing-app-private-key'
      ? config.kind !== 'github-app' || target.custodyVersion !== null ||
        target.protectedReference !== `github-actions-secret:${repository}/${runnerPreflightSecretName}`
      : typeof target.protectedReference !== 'string' || !target.protectedReference.startsWith('protected-input:'))) {
    throw new GitHubActivationError('credential-source', 'Select the exact existing App secret or protected enrollment source; no material or version is inferred.');
  }
  if (Object.keys(metadata).length !== metadataFields.length || metadataFields.some((field) => !Object.hasOwn(metadata, field)) ||
    metadata.permissionsDigest !== canonicalSha256(observedPermissions.permissions) ||
    (config.kind === 'github-app' ? metadata.grantId !== null || metadata.expiresAt !== null || metadata.accessGrantedAt !== null :
      metadata.appSlug !== null || metadata.createdAt !== null)) {
    throw new GitHubActivationError('credential-target', 'Credential metadata does not identify the exact bounded class and permission set.');
  }
  return {
    repository, repositoryId: positiveId(target.repositoryId), ownerId: positiveId(target.ownerId),
    actor: credentialPrincipal(target.actor), principal: credentialPrincipal(target.principal), configuration: config,
    source: source as GitHubCredentialTarget['source'],
    protectedReference: credentialReference(target.protectedReference),
    custodyVersion: source === 'existing-app-private-key' ? null : credentialUuid(target.custodyVersion),
    metadata: {
      createdAt: config.kind === 'github-app' ? iso(metadata.createdAt) : null,
      accessGrantedAt: config.kind === 'github-app' ? null : iso(metadata.accessGrantedAt),
      expiresAt: metadata.expiresAt === null ? null : iso(metadata.expiresAt),
      grantId: config.kind === 'github-app' ? null : positiveId(metadata.grantId),
      appSlug: config.kind === 'github-app' ? githubName(metadata.appSlug) : null,
      observedPermissions, permissionsDigest: canonicalSha256(observedPermissions.permissions)
    }
  };
}

export async function readGitHubSecretMetadata(client: GitHubActivationClient, repository: string): Promise<GitHubSecretMetadata | null> {
  const repo = githubRepository(repository);
  const secrets = await client.list(`/repos/${repo}/actions/secrets`, 'secrets');
  const selected = secrets.filter((entry) => entry.name === runnerPreflightSecretName);
  if (selected.length > 1) throw new GitHubActivationError('credential-secret-target', 'Secret inventory is ambiguous.');
  if (!selected.length) return null;
  const response = await client.get(`/repos/${repo}/actions/secrets/${runnerPreflightSecretName}`);
  if (response.name !== runnerPreflightSecretName) throw new GitHubActivationError('credential-secret-target', 'Secret metadata belongs to another target.');
  if (response.created_at !== selected[0]!.created_at || response.updated_at !== selected[0]!.updated_at) {
    throw new GitHubActivationError('credential-secret-drift', 'Secret metadata changed during independent inventory readback.');
  }
  return validateGitHubSecretMetadata({ name: runnerPreflightSecretName, createdAt: response.created_at, updatedAt: response.updated_at });
}

/** Public provider observations, not the secret and not user assertions, determine the exact scope. */
export async function inspectGitHubCredentialTarget(input: {
  client: GitHubActivationClient;
  repository: string;
  publishedRepositoryId: string;
  configuration: GitHubCredentialConfiguration;
  principal: CredentialPrincipal;
  source: GitHubCredentialTarget['source'];
  protectedReference: string;
  custodyVersion: string | null;
  now: Date;
}): Promise<GitHubCredentialTarget> {
  const repository = githubRepository(input.repository);
  const [owner, name] = repository.split('/') as [string, string];
  if (!/^[1-9]\d*$/u.test(input.publishedRepositoryId)) throw new GitHubActivationError('credential-repository', 'Credential enrollment requires the actual published repository ID, never a local or inferred identity.');
  const repositoryId = positiveId(Number(input.publishedRepositoryId));
  const configuration = parseGitHubCredentialConfiguration(input.configuration);
  const principal = credentialPrincipal(input.principal);
  const actorData = await input.client.get('/user');
  const actor = credentialPrincipal({ id: actorData.id, login: actorData.login });
  const repo = await input.client.get(`/repos/${repository}`);
  const account = object(repo.owner);
  const ownerId = positiveId(account.id);
  if (repo.id !== repositoryId || repo.full_name !== repository || account.login !== owner || account.type !== 'Organization') {
    throw new GitHubActivationError('credential-repository', 'Live repository ID, owner or organization differs from verified publication.');
  }
  const person = await input.client.get(`/users/${principal.login}`);
  if (person.id !== principal.id || person.login !== principal.login) throw new GitHubActivationError('credential-principal', 'Live credential principal differs from the exact selected identity.');
  let metadata: GitHubCredentialTarget['metadata'];
  if (configuration.kind === 'github-app') {
    const installs = await input.client.list(`/orgs/${owner}/installations`, 'installations');
    const matching = installs.filter((entry) => entry.id === configuration.installationId);
    const installation = matching[0];
    if (matching.length !== 1 || !installation || installation.app_id !== configuration.appId ||
      object(installation.account).id !== ownerId || installation.repository_selection !== 'selected' ||
      installation.suspended_at !== null ||
      `${githubName(installation.app_slug)}[bot]` !== principal.login || person.type !== 'Bot') {
      throw new GitHubActivationError('credential-app-scope', 'The actual App installation, owner, principal or least permissions differ from the selected credential.');
    }
    const selected = await input.client.list(`/user/installations/${configuration.installationId}/repositories`, 'repositories');
    if (selected.length !== 1 || selected[0]!.id !== repositoryId || selected[0]!.full_name !== repository) {
      throw new GitHubActivationError('credential-repository-scope', 'Independent App installation inventory must contain only the selected repository.');
    }
    const observedPermissions = observeCredentialPermissions('github-app', installation.permissions);
    metadata = { createdAt: iso(installation.created_at), accessGrantedAt: null, expiresAt: null, grantId: null,
      appSlug: githubName(installation.app_slug), observedPermissions, permissionsDigest: canonicalSha256(observedPermissions.permissions) };
  } else {
    if (configuration.owner !== principal.login || person.type !== 'User') throw new GitHubActivationError('credential-owner', 'PAT owner and selected user principal disagree.');
    const grants = await input.client.list(`/orgs/${owner}/personal-access-tokens?owner[]=${configuration.owner}`);
    const matching = grants.filter((entry) => entry.token_id === configuration.tokenId);
    const grant = matching[0];
    if (matching.length !== 1 || !grant || object(grant.owner).id !== principal.id ||
      object(grant.owner).login !== principal.login || grant.repository_selection !== 'subset' ||
      grant.token_expired !== false ||
      grant.token_name !== `${name.toLowerCase()}-runner-preflight-read`) {
      throw new GitHubActivationError('credential-pat-scope', 'The independent PAT grant metadata is absent, ambiguous or outside least privilege.');
    }
    const accessGrantedAt = iso(grant.access_granted_at);
    const expiresAt = grant.token_expires_at === null ? null : iso(grant.token_expires_at);
    if (Date.parse(accessGrantedAt) > input.now.getTime() || expiresAt !== null && Date.parse(expiresAt) <= input.now.getTime()) {
      throw new GitHubActivationError('credential-expiry', 'The provider grant is future-dated or its token is expired.');
    }
    const grantId = positiveId(grant.id);
    const selected = await input.client.list(`/orgs/${owner}/personal-access-tokens/${grantId}/repositories`);
    if (selected.length !== 1 || selected[0]!.id !== repositoryId || selected[0]!.full_name !== repository) {
      throw new GitHubActivationError('credential-repository-scope', 'The PAT grant is not restricted to the one published repository.');
    }
    const observedPermissions = observeCredentialPermissions('fine-grained-pat', grant.permissions);
    metadata = { createdAt: null, accessGrantedAt, expiresAt, grantId, appSlug: null,
      observedPermissions, permissionsDigest: canonicalSha256(observedPermissions.permissions) };
  }
  return validateGitHubCredentialTarget({ repository, repositoryId, ownerId, actor, principal, configuration,
    source: input.source, protectedReference: input.protectedReference, custodyVersion: input.custodyVersion, metadata });
}

export function createAppJwt(key: Uint8Array, appId: number, now: Date): Buffer {
  const copy = Buffer.from(key);
  try {
    const privateKey = createPrivateKey(copy);
    if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('key type');
    const issued = Math.floor(now.getTime() / 1000) - 60;
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({
      iat: issued, exp: issued + 540, iss: String(positiveId(appId))
    })).toString('base64url')}`;
    return Buffer.from(`${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`);
  } catch {
    throw new GitHubActivationError('invalid-app-key', 'Protected input must be the approved RSA App key of at least 2048 bits; diagnostics were withheld.');
  } finally { copy.fill(0); }
}

async function assertSubmission(repository: string, name: string, submission: CredentialSubmission): Promise<void> {
  if (name !== runnerPreflightSecretName || submission.prepared.target.repository !== githubRepository(repository)) {
    throw new GitHubActivationError('credential-scope', 'Only the exact reviewed preflight secret may be enrolled.');
  }
  await assertCredentialAuthority(submission.executionInput, submission.operation, submission.storage);
  const current = await readCredentialCheckpoints(submission.executionInput, submission.prepared.target, submission.storage);
  if (!current || current.settled || !same(current.prepared, submission.prepared) ||
    current.prepared.operationDigest !== canonicalSha256(submission.operation)) {
    throw new GitHubActivationError('credential-submission', 'Enrollment requires its exact durable unresolved pre-effect checkpoint.');
  }
}

function encryptionScope(repository: string, name: string, value: Uint8Array): void {
  githubRepository(repository);
  if (name !== runnerPreflightSecretName || value.length < 1 || value.length > 48 * 1024) {
    throw new GitHubActivationError('credential-encryption-scope', 'Protected encryption requires the exact reviewed preflight secret and bounded nonempty input.');
  }
}

async function encryptionKey(client: GitHubActivationClient, repository: string) {
  const value = await client.get(`/repos/${githubRepository(repository)}/actions/secrets/public-key`);
  const keyId = text(value.key_id, 'Repository encryption key ID');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(keyId) || /(?:github_pat_|gh[pousr]_)/u.test(keyId) || typeof value.key !== 'string') {
    throw new GitHubActivationError('credential-encryption-key', 'Repository public encryption key metadata is invalid.');
  }
  const bytes = Buffer.from(value.key, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value.key) throw new GitHubActivationError('credential-encryption-key', 'Repository public key must be canonical 32-byte Curve25519 data.');
  return { keyId, bytes };
}

export function githubRestSecretWriter(
  client: GitHubActivationClient,
  seal: (value: Uint8Array, publicKey: Uint8Array) => Promise<Uint8Array>
): GitHubSecretWriter {
  return {
    semantics: 'create-or-update',
    async encrypt(repository, name, value) {
      encryptionScope(repository, name, value);
      const key = await encryptionKey(client, repository);
      let encrypted: Uint8Array | undefined;
      try {
        encrypted = await seal(value, key.bytes);
        if (encrypted.length !== value.length + 48) throw new GitHubActivationError('credential-encryption', 'Encryption did not return a libsodium sealed box.');
        return new ProtectedGitHubSecretCiphertext(key.keyId, encrypted);
      } catch (error) {
        if (error instanceof GitHubActivationError) throw error;
        throw new GitHubActivationError('credential-encryption', 'Protected encryption failed; diagnostics were withheld.');
      } finally { encrypted?.fill(0); }
    },
    async write(repository, name, _value, submission) {
      await assertSubmission(repository, name, submission);
      throw new GitHubActivationError('credential-provider-concurrency', credentialProductionContractGaps.conditionalCreate);
    }
  };
}

/** gh performs documented local libsodium encryption with protected stdin, never raw argv or a generated input file. */
export function githubCliSecretWriter(runner: CommandRunner, cwd: string): GitHubSecretWriter {
  const client = new GitHubActivationClient(createGitHubCliTransport(runner, cwd));
  return {
    semantics: 'create-or-update',
    async encrypt(repository, name, value) {
      encryptionScope(repository, name, value);
      const before = await encryptionKey(client, repository);
      const result = await runner.run({
        executable: 'gh', args: ['secret', 'set', name, '--repo', `github.com/${repository}`, '--app', 'actions', '--no-store']
      }, {
        cwd, stdin: value, redactValues: [Buffer.from(value).toString('utf8')], stream: false,
        timeoutMs: 30_000, maxOutputBytes: 128 * 1024, env: { GH_HOST: 'github.com', GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }
      });
      if (result.status !== 0 || result.errorCode || result.timedOut || result.outputLimitExceeded || result.aborted ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.stdout.trim())) {
        throw new GitHubActivationError('credential-encryption', 'GitHub CLI protected encryption failed; its output was withheld.');
      }
      const encrypted = Buffer.from(result.stdout.trim(), 'base64');
      try {
        const after = await encryptionKey(client, repository);
        if (encrypted.length !== value.length + 48 || encrypted.toString('base64') !== result.stdout.trim() ||
          before.keyId !== after.keyId || !before.bytes.equals(after.bytes)) {
          throw new GitHubActivationError('credential-encryption-key', 'Public encryption key or sealed-box shape changed during preparation.');
        }
        return new ProtectedGitHubSecretCiphertext(before.keyId, encrypted);
      } finally { encrypted.fill(0); }
    },
    async write(repository, name, _value, submission) {
      await assertSubmission(repository, name, submission);
      throw new GitHubActivationError('credential-provider-concurrency', credentialProductionContractGaps.conditionalCreate);
    }
  };
}

export interface CredentialEnrollmentResult {
  target: GitHubCredentialTarget;
  receipt: GitHubSecretWriteReceipt;
  prepared: CredentialPreparedCheckpoint;
  usage: 'not-yet-proven';
}

export async function enrollGitHubCredential(input: {
  executionInput: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  plan: CredentialEnrollmentPlan;
  client: GitHubActivationClient;
  channel: ProtectedCredentialChannel;
  secretWriter: GitHubSecretWriter;
  credentialTransport?: (value: Uint8Array) => GitHubActivationTransport;
  storage?: UpdatePreviewOptions;
}): Promise<CredentialEnrollmentResult> {
  const { executionInput, operation, plan } = input;
  await assertCredentialAuthority(executionInput, operation, input.storage ?? executionInput.adapters.githubActivation?.storage);
  if (Object.keys(plan).sort().join(',') !== 'expectedSecret,kind,permissionBoundary,target' ||
    plan.kind !== 'github-credential-enrollment.v1' || plan.expectedSecret !== null ||
    operation.actionId !== 'github.credential.enroll-masked' || Object.keys(operation.inputs).join(',') !== 'enrollment' ||
    !same(operation.inputs.enrollment, plan)) {
    throw new GitHubActivationError('credential-plan', 'Enrollment requires the exact independently reviewed create-only credential plan.');
  }
  const target = validateGitHubCredentialTarget(plan.target);
  if (!same(plan.permissionBoundary, credentialPermissionBoundary(target.metadata.observedPermissions))) {
    throw new GitHubActivationError('credential-permission-plan', 'The enrollment plan omits or changes the raw provider grant and its additional read reach.');
  }
  if (target.source !== 'protected-input') throw new GitHubActivationError('credential-source', 'New enrollment requires its own protected-input source; existing secret readiness grants no write authority.');
  const current = await inspectGitHubCredentialTarget({
    client: input.client, repository: target.repository, publishedRepositoryId: String(target.repositoryId),
    configuration: target.configuration, principal: target.principal, source: target.source, protectedReference: target.protectedReference,
    custodyVersion: target.custodyVersion, now: executionInput.clock?.() ?? executionInput.now
  });
  if (!same(current, target)) throw new GitHubActivationError('credential-drift', 'Repository, actor, principal, grant or least permissions changed after review.');
  if (await readGitHubSecretMetadata(input.client, target.repository)) {
    throw new GitHubActivationError('credential-preserve-existing', 'The target secret already exists. Its value is not readable for rollback and will not be overwritten.');
  }
  assertCredentialProviderPolicyPermitted(current.metadata.observedPermissions);
  if (target.configuration.kind === 'fine-grained-pat') throw new GitHubActivationError('credential-pat-identity', credentialProductionContractGaps.patIdentity);
  // No imaginary atomic transport capability can make this exact requested effect executable.
  throw new GitHubActivationError('credential-provider-concurrency', credentialProductionContractGaps.conditionalCreate);
}

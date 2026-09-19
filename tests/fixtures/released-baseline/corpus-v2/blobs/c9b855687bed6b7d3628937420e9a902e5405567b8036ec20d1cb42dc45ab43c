import { createPrivateKey, sign } from 'node:crypto';
import type { CommandRunner } from '../../process-runner.js';
import type { ActivationIdentity, CredentialPolicy } from '../../domain/governance/activation/types.js';
import { runnerPreflightSecretName } from '../../domain/governance/activation/types.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  buildFineGrainedPatCredentialPolicy, buildGitHubAppCredentialPolicy, canonicalCredentialRepository
} from '../../governance-activation/credentials.js';
import type { ProtectedCredentialChannel } from './protected-input.js';
import {
  GitHubActivationClient, GitHubActivationError, createAuthenticatedGitHubTransport, expectStatus,
  githubName, githubRepository, object, positiveId, text, type GitHubActivationTransport
} from '../github/activation-rest.js';

export type GitHubCredentialConfiguration =
  | { kind: 'github-app'; appId: number; installationId: number }
  | { kind: 'fine-grained-pat'; tokenId: number; owner: string; appUnavailableReason: string };

export const credentialApiPermissions = {
  metadata: 'read', organization_hosted_runners: 'read', organization_network_configurations: 'read'
} as const;

export interface GitHubSecretWriter {
  write(repository: string, name: typeof runnerPreflightSecretName, value: Uint8Array): Promise<void>;
}

export function githubCliSecretWriter(runner: CommandRunner, cwd: string): GitHubSecretWriter {
  return {
    async write(repository, name, value) {
      githubRepository(repository);
      if (name !== runnerPreflightSecretName) throw new GitHubActivationError('credential-scope', 'Only the reviewed runner preflight secret may be enrolled.');
      // gh performs GitHub's public-key sealed-box encryption. Secret bytes are stdin, never argv.
      const result = await runner.run({
        executable: 'gh', args: ['secret', 'set', name, '--repo', repository, '--app', 'actions']
      }, {
        cwd, stdin: value, redactValues: [Buffer.from(value).toString('utf8')], stream: false,
        timeoutMs: 30_000, maxOutputBytes: 32_768, env: { GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }
      });
      if (result.status !== 0 || result.errorCode || result.timedOut || result.outputLimitExceeded || result.aborted) {
        throw new GitHubActivationError('secret-write', 'GitHub did not confirm encrypted Actions secret enrollment. Check the approved repository secrets-write permission.');
      }
    }
  };
}

export function githubRestSecretWriter(
  client: GitHubActivationClient,
  seal: (value: Uint8Array, publicKey: Uint8Array) => Promise<Uint8Array>
): GitHubSecretWriter {
  return {
    async write(repository, name, value) {
      githubRepository(repository);
      if (name !== runnerPreflightSecretName) throw new GitHubActivationError('credential-scope', 'The secret name is outside the reviewed enrollment policy.');
      const key = await client.get(`/repos/${repository}/actions/secrets/public-key`);
      const publicKey = Buffer.from(text(key.key, 'GitHub secret public key'), 'base64');
      if (publicKey.length !== 32) throw new GitHubActivationError('invalid-key', 'GitHub secret encryption key is not a 32-byte Curve25519 key.');
      const encrypted = await seal(value, publicKey);
      if (encrypted.length !== value.length + 48) throw new GitHubActivationError('invalid-encryption', 'Secret encryption did not produce a libsodium sealed box.');
      await client.write('PUT', `/repos/${repository}/actions/secrets/${name}`, {
        key_id: text(key.key_id, 'GitHub key ID'), encrypted_value: Buffer.from(encrypted).toString('base64')
      });
    }
  };
}

export function parseGitHubCredentialConfiguration(value: unknown): GitHubCredentialConfiguration {
  const config = object(value, 'credential-ready configuration');
  const allowed = config.kind === 'github-app' ? ['kind', 'appId', 'installationId'] :
    ['kind', 'tokenId', 'owner', 'appUnavailableReason'];
  if (Object.keys(config).some((key) => !allowed.includes(key))) {
    throw new GitHubActivationError('credential-config', 'Credential configuration contains unknown fields. Values, commands, and arbitrary permission grants are forbidden.');
  }
  if (config.kind === 'github-app') {
    return { kind: 'github-app', appId: positiveId(config.appId, 'Approved App ID'),
      installationId: positiveId(config.installationId, 'Approved installation ID') };
  }
  if (config.kind !== 'fine-grained-pat') {
    throw new GitHubActivationError('credential-config', 'Select an existing approved scoped GitHub App, or explicitly justify its unavailable fine-grained PAT fallback.');
  }
  return { kind: 'fine-grained-pat', tokenId: positiveId(config.tokenId, 'Approved PAT ID'),
    owner: githubName(config.owner, 'Credential owner'),
    appUnavailableReason: text(config.appUnavailableReason, 'Reason an approved scoped App is unavailable') };
}

function samePermissions(actual: unknown): boolean {
  const permissions = object(actual, 'Credential permissions');
  return canonicalSha256(permissions) === canonicalSha256(credentialApiPermissions);
}

export function createAppJwt(key: Uint8Array, appId: number, now: Date): Buffer {
  try {
    const privateKey = createPrivateKey(Buffer.from(key));
    if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error('key type');
    }
    const issued = Math.floor(now.getTime() / 1000) - 60;
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({
      iat: issued, exp: issued + 540, iss: String(positiveId(appId))
    })).toString('base64url')}`;
    return Buffer.from(`${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`);
  } catch {
    throw new GitHubActivationError('invalid-app-key', 'Protected input must be the approved GitHub App RSA private key (at least 2048 bits). Key bytes were withheld.');
  }
}

export interface CredentialEnrollmentResult {
  policy: CredentialPolicy;
  usage: {
    repositoryId: number;
    repository: string;
    principal: string;
    installationId: number | null;
    probeEndpoints: readonly string[];
    permissionsDigest: string;
    secretUpdatedAt: string;
  };
}

export async function enrollGitHubCredential(input: {
  repository: string;
  repositoryId: number;
  configuration: GitHubCredentialConfiguration;
  identity: ActivationIdentity;
  client: GitHubActivationClient;
  channel: ProtectedCredentialChannel;
  secretWriter: GitHubSecretWriter;
  credentialTransport?: (value: Uint8Array) => GitHubActivationTransport;
  now: Date;
  assertAuthorized: () => Promise<void>;
}): Promise<CredentialEnrollmentResult> {
  const repository = githubRepository(input.repository);
  const [owner, name] = repository.split('/') as [string, string];
  const repoIdentity = canonicalCredentialRepository({ id: String(input.repositoryId), owner, name });
  const makeTransport = input.credentialTransport ?? createAuthenticatedGitHubTransport;
  const config = parseGitHubCredentialConfiguration(input.configuration);
  await input.assertAuthorized();
  const secret = await input.channel.read(config.kind === 'github-app' ? 'GitHub App private key' : 'fine-grained PAT');
  let jwt: Buffer | undefined;
  let token: Buffer | undefined;
  let tokenClient: GitHubActivationClient | undefined;
  let installation: Record<string, unknown> | undefined;
  let pat: Record<string, unknown> | undefined;
  let principal = '';
  let tokenExpiresAt = '';
  try {
    if (!secret.length || secret.length > 32_768) {
      throw new GitHubActivationError('invalid-credential', 'The protected credential is empty or exceeds the size bound.');
    }
    if (config.kind === 'github-app') {
      jwt = createAppJwt(secret, config.appId, input.now);
      const appClient = new GitHubActivationClient(makeTransport(jwt));
      installation = await appClient.get(`/app/installations/${config.installationId}`);
      if (installation.app_id !== config.appId || installation.id !== config.installationId ||
        object(installation.account).login !== owner || installation.repository_selection !== 'selected' ||
        installation.suspended_at !== null || !samePermissions(installation.permissions)) {
        throw new GitHubActivationError('credential-scope', 'The approved App installation is suspended, over-scoped, or bound to another owner. No installation or grant will be created automatically.');
      }
      await input.assertAuthorized();
      const issued = object(await appClient.write('POST', `/app/installations/${config.installationId}/access_tokens`, {
        repository_ids: [input.repositoryId], permissions: credentialApiPermissions
      }));
      if (!samePermissions(issued.permissions)) throw new GitHubActivationError('credential-scope', 'GitHub minted a token with permissions different from the exact reviewed preflight scope.');
      token = Buffer.from(text(issued.token, 'Installation credential'));
      tokenExpiresAt = text(issued.expires_at, 'Installation expiry');
      if (Date.parse(tokenExpiresAt) <= input.now.getTime() ||
        Date.parse(tokenExpiresAt) > input.now.getTime() + 3_600_000) {
        throw new GitHubActivationError('credential-expiry', 'Installation tokens must be current and expire within one hour.');
      }
      tokenClient = new GitHubActivationClient(makeTransport(token));
      const selected = await tokenClient.list('/installation/repositories', 'repositories');
      if (selected.length !== 1 || selected[0]!.id !== input.repositoryId || selected[0]!.full_name !== repository) {
        throw new GitHubActivationError('credential-scope', 'The installation credential is not restricted to the exact selected repository.');
      }
      principal = `${text(installation.app_slug, 'App slug')}[bot]`;
    } else {
      const raw = secret.toString('utf8').trim();
      if (!/^github_pat_[A-Za-z0-9_]{40,250}$/u.test(raw)) {
        throw new GitHubActivationError('credential-kind', 'The fallback must be a fine-grained PAT, never a classic PAT or an unrelated token.');
      }
      token = Buffer.from(raw);
      tokenClient = new GitHubActivationClient(makeTransport(token));
      const ownerResponse = expectStatus(await tokenClient.transport.request({ method: 'GET', path: '/user' }), [200], 'Verify enrolled PAT identity');
      const actor = object(ownerResponse.data);
      if (actor.login !== config.owner) throw new GitHubActivationError('credential-owner', 'The enrolled PAT belongs to a different GitHub identity.');
      principal = config.owner;
      // The organization grant API is the authoritative scope/expiry reader, not user-entered metadata.
      const grants = await input.client.list(`/orgs/${owner}/personal-access-tokens?owner[]=${config.owner}`);
      const matching = grants.filter((grant) => grant.token_id === config.tokenId);
      if (matching.length !== 1) throw new GitHubActivationError('credential-metadata', 'An organization owner must make the approved fine-grained PAT grant metadata readable; its token ID is absent or ambiguous.');
      pat = matching[0]!;
      const permissions = object(pat.permissions);
      const requiredPermissions = {
        repository: { metadata: 'read' },
        organization: { organization_hosted_runners: 'read', organization_network_configurations: 'read' },
        other: {}
      };
      tokenExpiresAt = text(pat.token_expires_at, 'PAT expiry');
      const headerExpiry = ownerResponse.headers['github-authentication-token-expiration'] ??
        ownerResponse.headers['x-github-authentication-token-expiration'];
      const createdAt = Date.parse(text(pat.created_at, 'PAT creation'));
      if (pat.repository_selection !== 'subset' || pat.token_expired !== false || object(pat.owner).login !== config.owner ||
        canonicalSha256(permissions) !== canonicalSha256(requiredPermissions) ||
        pat.token_name !== `${name.toLowerCase()}-runner-preflight-read` ||
        !headerExpiry || Date.parse(headerExpiry) !== Date.parse(tokenExpiresAt) ||
        Date.parse(tokenExpiresAt) - createdAt !== 30 * 24 * 60 * 60 * 1000 ||
        Date.parse(tokenExpiresAt) <= input.now.getTime() ||
        grants.filter((grant) => object(grant.owner).login === config.owner && grant.token_expires_at === tokenExpiresAt).length !== 1) {
        throw new GitHubActivationError('credential-scope', 'PAT grant/identity/unique provider expiry does not match the exact selected-repository, read-only, 30-day fallback policy.');
      }
      const selected = await input.client.list(`/orgs/${owner}/personal-access-tokens/${positiveId(pat.id, 'PAT grant ID')}/repositories`);
      if (selected.length !== 1 || selected[0]!.id !== input.repositoryId || selected[0]!.full_name !== repository) {
        throw new GitHubActivationError('credential-scope', 'PAT grant is not restricted to this single repository.');
      }
    }
    const probeEndpoints = [
      `/repos/${repository}`, `/orgs/${owner}/actions/hosted-runners`, `/orgs/${owner}/settings/network-configurations`
    ];
    const observed = await tokenClient.get(probeEndpoints[0]!);
    if (observed.id !== input.repositoryId || observed.full_name !== repository) {
      throw new GitHubActivationError('credential-use', 'Actual credential use returned a different repository identity.');
    }
    await tokenClient.list(probeEndpoints[1]!, 'runners');
    await tokenClient.list(probeEndpoints[2]!, 'network_configurations');
    await input.assertAuthorized();
    await input.secretWriter.write(repository, runnerPreflightSecretName, config.kind === 'github-app' ? secret : token!);
    const readback = await input.client.get(`/repos/${repository}/actions/secrets/${runnerPreflightSecretName}`);
    const secretUpdatedAt = text(readback.updated_at, 'Secret update timestamp');
    if (readback.name !== runnerPreflightSecretName || Date.parse(secretUpdatedAt) < input.now.getTime() - 1000) {
      throw new GitHubActivationError('secret-readback', 'GitHub secret write has no independent current metadata readback. Enrollment remains unverified.');
    }
    const usage = {
      repositoryId: input.repositoryId, repository, principal, installationId: config.kind === 'github-app' ? config.installationId : null,
      probeEndpoints, permissionsDigest: canonicalSha256(credentialApiPermissions), secretUpdatedAt
    };
    const allowedWorkflows = [
      { path: '.github/workflows/liftoff-bootstrap.yml', jobs: ['credential-use'] },
      { path: '.github/workflows/liftoff-runner.yml', jobs: ['runner-preflight'] }
    ];
    const policy = config.kind === 'github-app' ? buildGitHubAppCredentialPolicy({
      repository: repoIdentity, identity: input.identity, createdAt: input.now, allowedWorkflows,
      installation: {
        installationId: config.installationId, appSlug: text(installation!.app_slug, 'App slug'),
        approved: true, verified: true, selection: 'selected-repository', repositories: [repoIdentity],
        permissions: { repository: ['metadata:read'], organization: ['hosted-runners:read', 'network-configurations:read'] },
        permissionsVerifiedAt: input.now.toISOString(), readbackDigest: canonicalSha256(usage),
        token: { canGenerate: true, ttlSeconds: Math.floor((Date.parse(tokenExpiresAt) - input.now.getTime()) / 1000) }
      }
    }) : buildFineGrainedPatCredentialPolicy({
      repository: repoIdentity, identity: input.identity, createdAt: new Date(String(pat!.created_at)), allowedWorkflows,
      proof: { verifiedAt: input.now.toISOString(), readbackDigest: canonicalSha256(usage), readbackProvider: 'github-api', payloadFree: true }
    });
    return { policy, usage };
  } finally {
    // Revoke only the ephemeral token minted here; never revoke the operator's pre-existing credential.
    if (config.kind === 'github-app' && tokenClient) {
      try { await tokenClient.write('DELETE', '/installation/token'); }
      catch { /* The token is bounded to one hour; no diagnostics may expose it. */ }
    }
    secret.fill(0);
    jwt?.fill(0);
    token?.fill(0);
  }
}

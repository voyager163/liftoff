import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@inquirer/prompts', () => ({ password: vi.fn() }));

import { password } from '@inquirer/prompts';
import {
  createAppJwt, credentialApiPermissions, enrollGitHubCredential, githubCliSecretWriter, githubRestSecretWriter,
  parseGitHubCredentialConfiguration, type GitHubCredentialConfiguration, type GitHubSecretWriter
} from '../src/adapters/credentials/github-enrollment.js';
import {
  privateTtyCredentialChannel, protectedStdinCredentialChannel, type ProtectedCredentialChannel
} from '../src/adapters/credentials/protected-input.js';
import {
  GitHubActivationClient, GitHubActivationError, type GitHubActivationTransport, type GitHubRequest, type GitHubResponse
} from '../src/adapters/github/activation-rest.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { runnerPreflightSecretName } from '../src/domain/governance/activation/types.js';
import { validateCredentialPolicy } from '../src/domain/governance/activation/validators.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

const now = new Date('2026-09-25T00:00:00.000Z');
const repository = 'acme/widget';
const repositoryId = 555;
const secretPath = `/repos/${repository}/actions/secrets/${runnerPreflightSecretName}`;
const mintedToken = ['ghs', 'SYNTHETIC', 'INSTALLATION', 'TOKEN', 'FOR', 'TESTS', '0123456789'].join('_');
const fineGrainedPat = ['github', 'pat', 'SYNTHETIC', 'FINE', 'GRAINED', 'VALUE', 'FOR', 'TESTS', 'ONLY', '0123456789ABCDEF'].join('_');
const classicPat = ['ghp', 'A'.repeat(36)].join('_');
const appConfiguration: GitHubCredentialConfiguration = { kind: 'github-app', appId: 12, installationId: 77 };
const patConfiguration: GitHubCredentialConfiguration = {
  kind: 'fine-grained-pat', tokenId: 4242, owner: 'octo-owner', appUnavailableReason: 'The organization has no approved preflight App.'
};
const rsa = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' }
});

function thrownSync(action: () => unknown): GitHubActivationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubActivationError);
    return error as GitHubActivationError;
  }
  throw new Error('Expected a GitHub credential refusal.');
}

async function rejection(promise: Promise<unknown>): Promise<GitHubActivationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubActivationError);
    return error as GitHubActivationError;
  }
  throw new Error('Expected a GitHub credential refusal.');
}

const ok = (data: unknown, status = 200, headers: Record<string, string> = {}): GitHubResponse => ({ status, headers, data });
type Route = GitHubResponse | ((request: GitHubRequest) => GitHubResponse);

class RouteTransport implements GitHubActivationTransport {
  constructor(private readonly label: string, private readonly routes: Record<string, Route>, private readonly events: string[]) {}

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    const key = `${request.method} ${request.path}`;
    this.events.push(`${this.label}:${key}`);
    const route = this.routes[key];
    if (!route) throw new Error(`Unexpected GitHub request ${this.label}:${key}`);
    return typeof route === 'function' ? route(request) : route;
  }
}

const listPage = (path: string) => `GET ${path}${path.includes('?') ? '&' : '?'}per_page=100&page=1`;

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: 77, app_id: 12, app_slug: 'liftoff-preflight', account: { login: 'acme' }, repository_selection: 'selected',
    suspended_at: null, permissions: { ...credentialApiPermissions }, ...overrides
  };
}

function patGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: 901, token_id: 4242, owner: { login: 'octo-owner' }, repository_selection: 'subset', token_expired: false,
    token_name: 'widget-runner-preflight-read', token_expires_at: '2026-10-24T00:00:00.000Z', created_at: '2026-09-24T00:00:00.000Z',
    permissions: {
      repository: { metadata: 'read' },
      organization: { organization_hosted_runners: 'read', organization_network_configurations: 'read' },
      other: {}
    },
    ...overrides
  };
}

interface Scenario {
  app: Record<string, Route>;
  token: Record<string, Route>;
  main: Record<string, Route>;
  secret: Buffer;
  configuration: GitHubCredentialConfiguration;
  writer?: (value: string) => void;
  authorize?: (count: number) => void;
}

function appScenario(overrides: Partial<Pick<Scenario, 'app' | 'token' | 'main'>> = {}): Scenario {
  return {
    configuration: appConfiguration,
    secret: Buffer.from(rsa.privateKey),
    app: {
      'GET /app/installations/77': ok(installation()),
      'POST /app/installations/77/access_tokens': ok({
        token: mintedToken, expires_at: new Date(now.getTime() + 59 * 60_000).toISOString(), permissions: { ...credentialApiPermissions }
      }, 201),
      ...overrides.app
    },
    token: {
      [listPage('/installation/repositories')]: ok({ total_count: 1, repositories: [{ id: repositoryId, full_name: repository }] }),
      [`GET /repos/${repository}`]: ok({ id: repositoryId, full_name: repository }),
      [listPage('/orgs/acme/actions/hosted-runners')]: ok({ total_count: 0, runners: [] }),
      [listPage('/orgs/acme/settings/network-configurations')]: ok({ total_count: 0, network_configurations: [] }),
      'DELETE /installation/token': ok(null, 204),
      ...overrides.token
    },
    main: { [`GET ${secretPath}`]: ok({ name: runnerPreflightSecretName, updated_at: now.toISOString() }), ...overrides.main }
  };
}

function patScenario(overrides: Partial<Pick<Scenario, 'token' | 'main'>> = {}): Scenario {
  return {
    configuration: patConfiguration,
    secret: Buffer.from(`  ${fineGrainedPat}\n`),
    app: {},
    token: {
      'GET /user': ok({ login: 'octo-owner' }, 200, { 'github-authentication-token-expiration': '2026-10-24 00:00:00 UTC' }),
      [`GET /repos/${repository}`]: ok({ id: repositoryId, full_name: repository }),
      [listPage('/orgs/acme/actions/hosted-runners')]: ok({ total_count: 0, runners: [] }),
      [listPage('/orgs/acme/settings/network-configurations')]: ok({ total_count: 0, network_configurations: [] }),
      ...overrides.token
    },
    main: {
      [listPage('/orgs/acme/personal-access-tokens?owner[]=octo-owner')]: ok([patGrant()]),
      [listPage('/orgs/acme/personal-access-tokens/901/repositories')]: ok([{ id: repositoryId, full_name: repository }]),
      [`GET ${secretPath}`]: ok({ name: runnerPreflightSecretName, updated_at: now.toISOString() }),
      ...overrides.main
    }
  };
}

async function enroll(scenario: Scenario, input: { repository?: string; configuration?: unknown } = {}) {
  const events: string[] = [];
  const credentials: string[] = [];
  const credentialBuffers: Uint8Array[] = [];
  const written: string[] = [];
  let authorizations = 0;
  const channel: ProtectedCredentialChannel = {
    kind: 'protected-stdin',
    read: vi.fn(async () => { events.push('read'); return scenario.secret; })
  };
  const secretWriter: GitHubSecretWriter = {
    async write(target, name, value) {
      events.push(`write:${target}:${name}`);
      const copy = Buffer.from(value).toString('utf8');
      scenario.writer?.(copy);
      written.push(copy);
    }
  };
  const transports = {
    app: new RouteTransport('app', scenario.app, events),
    token: new RouteTransport('token', scenario.token, events)
  };
  const outcome = enrollGitHubCredential({
    repository: input.repository ?? repository,
    repositoryId,
    configuration: (input.configuration ?? scenario.configuration) as GitHubCredentialConfiguration,
    identity: currentActivationIdentity,
    client: new GitHubActivationClient(new RouteTransport('main', scenario.main, events)),
    channel,
    secretWriter,
    credentialTransport: (credential) => {
      const value = Buffer.from(credential).toString('utf8');
      credentials.push(value);
      credentialBuffers.push(credential);
      return value.startsWith('eyJ') ? transports.app : transports.token;
    },
    now,
    assertAuthorized: async () => {
      authorizations += 1;
      events.push('authorize');
      scenario.authorize?.(authorizations);
    }
  }).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
  const settled = await outcome;
  const zeroed = [scenario.secret, ...credentialBuffers].every((buffer) => buffer.every((byte) => byte === 0));
  return { ...settled, events, credentials, written, channel, zeroed };
}

describe('credential enrollment configuration and App key boundaries', () => {
  it('accepts only the reviewed App or justified fine-grained PAT fallback shapes', () => {
    expect(parseGitHubCredentialConfiguration(appConfiguration)).toEqual(appConfiguration);
    expect(parseGitHubCredentialConfiguration(patConfiguration)).toEqual(patConfiguration);
    for (const value of [
      { ...appConfiguration, permissions: { contents: 'write' } },
      { ...patConfiguration, value: fineGrainedPat },
      { kind: 'classic-pat' },
      {}
    ]) {
      expect(thrownSync(() => parseGitHubCredentialConfiguration(value)).code).toBe('credential-config');
    }
    expect(thrownSync(() => parseGitHubCredentialConfiguration('github-app')).code).toBe('invalid-response');
    expect(thrownSync(() => parseGitHubCredentialConfiguration({ ...appConfiguration, appId: 0 })).message)
      .toBe('Approved App ID must be a positive provider resource ID.');
    expect(thrownSync(() => parseGitHubCredentialConfiguration({ ...patConfiguration, owner: '../owner' })).code).toBe('invalid-input');
    expect(thrownSync(() => parseGitHubCredentialConfiguration({ ...patConfiguration, appUnavailableReason: '' })).code).toBe('invalid-response');
  });

  it('mints a short-lived RS256 App JWT from an approved 2048-bit RSA key', () => {
    const jwt = createAppJwt(Buffer.from(rsa.privateKey), 12, now).toString('utf8');
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const issuedAt = Math.floor(now.getTime() / 1000) - 60;
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iat: issuedAt, exp: issuedAt + 540, iss: '12' });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey(rsa.publicKey), Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('refuses malformed, weak, and non-RSA App keys without echoing key bytes', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const elliptic = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    for (const key of ['-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n', weak.privateKey, elliptic.privateKey]) {
      const error = thrownSync(() => createAppJwt(Buffer.from(key), 12, now));
      expect(error.code).toBe('invalid-app-key');
      expect(error.message).toMatch(/Key bytes were withheld/);
      expect(error.message).not.toContain('not-a-key');
    }
  });
});

describe('Actions secret writers', () => {
  class SecretRunner implements CommandRunner {
    readonly calls: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];

    constructor(private readonly result: Partial<CommandResult> = {}) {}

    async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
      this.calls.push({ command, options });
      return { command, displayCommand: 'gh secret set', status: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...this.result };
    }
  }

  it('passes the reviewed secret to gh on stdin with redaction and never in argv', async () => {
    const runner = new SecretRunner();
    const value = Buffer.from(fineGrainedPat);
    await githubCliSecretWriter(runner, '/project').write(repository, runnerPreflightSecretName, value);
    expect(runner.calls).toHaveLength(1);
    const [{ command, options }] = runner.calls;
    expect(command).toEqual({ executable: 'gh', args: ['secret', 'set', runnerPreflightSecretName, '--repo', repository, '--app', 'actions'] });
    expect(command.args.join(' ')).not.toContain(fineGrainedPat);
    expect(options).toMatchObject({
      cwd: '/project', stdin: value, redactValues: [fineGrainedPat], stream: false, timeoutMs: 30_000, maxOutputBytes: 32_768,
      env: { GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }
    });
  });

  it('refuses out-of-policy names and repositories before running gh', async () => {
    const runner = new SecretRunner();
    const writer = githubCliSecretWriter(runner, '/project');
    expect((await rejection(writer.write(repository, 'OTHER_SECRET' as typeof runnerPreflightSecretName, Buffer.from('x')))).code).toBe('credential-scope');
    expect((await rejection(writer.write('acme', runnerPreflightSecretName, Buffer.from('x')))).code).toBe('repository-required');
    expect(runner.calls).toEqual([]);
  });

  it('reports unconfirmed gh secret writes without provider output or secret bytes', async () => {
    for (const failure of [
      { status: 1, stderr: `HTTP 403 ${fineGrainedPat}` }, { errorCode: 'ENOENT' }, { timedOut: true },
      { outputLimitExceeded: true }, { aborted: true }
    ] satisfies Partial<CommandResult>[]) {
      const error = await rejection(githubCliSecretWriter(new SecretRunner(failure), '/project')
        .write(repository, runnerPreflightSecretName, Buffer.from(fineGrainedPat)));
      expect(error.code).toBe('secret-write');
      expect(error.message).not.toContain(fineGrainedPat);
      expect(error.message).not.toContain('HTTP 403');
    }
  });

  function restWriter(routes: Record<string, Route>, seal: (value: Uint8Array, key: Uint8Array) => Promise<Uint8Array>) {
    const events: string[] = [];
    const transport = new RouteTransport('main', routes, events);
    const bodies: unknown[] = [];
    const client = new GitHubActivationClient({ request: async (request) => { bodies.push(request.body); return transport.request(request); } });
    return { writer: githubRestSecretWriter(client, seal), events, bodies };
  }

  const publicKey = Buffer.alloc(32, 9);
  const keyRoute = { [`GET /repos/${repository}/actions/secrets/public-key`]: ok({ key: publicKey.toString('base64'), key_id: 'kid-1' }) };

  it('seals values with the repository public key and writes only the sealed box', async () => {
    const seal = vi.fn(async (value: Uint8Array, _key: Uint8Array) => new Uint8Array(value.length + 48).fill(7));
    const { writer, events, bodies } = restWriter({ ...keyRoute, [`PUT ${secretPath}`]: ok(null, 204) }, seal);
    await writer.write(repository, runnerPreflightSecretName, Buffer.from(fineGrainedPat));
    expect(seal).toHaveBeenCalledTimes(1);
    expect(Buffer.from(seal.mock.calls[0]![1])).toEqual(publicKey);
    expect(events).toEqual([`main:GET /repos/${repository}/actions/secrets/public-key`, `main:PUT ${secretPath}`]);
    expect(bodies[1]).toEqual({ key_id: 'kid-1', encrypted_value: Buffer.alloc(fineGrainedPat.length + 48, 7).toString('base64') });
    expect(JSON.stringify(bodies)).not.toContain(fineGrainedPat);
  });

  it('refuses invalid keys, non-sealed ciphertext, and out-of-policy names before writing', async () => {
    const cases: Array<[Record<string, Route>, (value: Uint8Array) => Promise<Uint8Array>, string]> = [
      [{ [`GET /repos/${repository}/actions/secrets/public-key`]: ok({ key: Buffer.alloc(31).toString('base64'), key_id: 'kid-1' }) },
        async (value) => new Uint8Array(value.length + 48), 'invalid-key'],
      [keyRoute, async (value) => new Uint8Array(value.length), 'invalid-encryption'],
      [{ [`GET /repos/${repository}/actions/secrets/public-key`]: ok({ key: publicKey.toString('base64') }) },
        async (value) => new Uint8Array(value.length + 48), 'invalid-response']
    ];
    for (const [routes, seal, code] of cases) {
      const { writer, events } = restWriter(routes, seal);
      expect((await rejection(writer.write(repository, runnerPreflightSecretName, Buffer.from('value')))).code).toBe(code);
      expect(events.some((event) => event.startsWith('main:PUT'))).toBe(false);
    }
    const { writer, events } = restWriter(keyRoute, async (value) => new Uint8Array(value.length + 48));
    expect((await rejection(writer.write(repository, 'OTHER' as typeof runnerPreflightSecretName, Buffer.from('value')))).code).toBe('credential-scope');
    expect(events).toEqual([]);
  });

  it('surfaces a denied sealed-secret write as a bounded provider response', async () => {
    const { writer } = restWriter({ ...keyRoute, [`PUT ${secretPath}`]: ok({ message: 'Resource not accessible' }, 403) },
      async (value) => new Uint8Array(value.length + 48));
    expect(await rejection(writer.write(repository, runnerPreflightSecretName, Buffer.from('value'))))
      .toMatchObject({ code: 'provider-response', status: 403 });
  });
});

describe('GitHub App credential enrollment', () => {
  it('verifies the exact installation, token scope, repository use, secret readback, and revokes the minted token', async () => {
    const scenario = appScenario();
    const { result, error, events, credentials, written, zeroed } = await enroll(scenario);
    expect(error).toBeUndefined();
    expect(events).toEqual([
      'authorize', 'read', 'app:GET /app/installations/77', 'authorize', 'app:POST /app/installations/77/access_tokens',
      `token:${listPage('/installation/repositories')}`, `token:GET /repos/${repository}`,
      `token:${listPage('/orgs/acme/actions/hosted-runners')}`, `token:${listPage('/orgs/acme/settings/network-configurations')}`,
      'authorize', `write:${repository}:${runnerPreflightSecretName}`, `main:GET ${secretPath}`, 'token:DELETE /installation/token'
    ]);
    expect(written).toEqual([rsa.privateKey]);
    expect(zeroed).toBe(true);
    expect(credentials[0]!.split('.')).toHaveLength(3);
    expect(credentials[1]).toBe(mintedToken);
    expect(result!.cleanupWarnings).toEqual([]);
    expect(result!.usage).toEqual({
      repositoryId, repository, principal: 'liftoff-preflight[bot]', installationId: 77,
      probeEndpoints: [`/repos/${repository}`, '/orgs/acme/actions/hosted-runners', '/orgs/acme/settings/network-configurations'],
      permissionsDigest: canonicalSha256(credentialApiPermissions), secretUpdatedAt: now.toISOString()
    });
    expect(validateCredentialPolicy(result!.policy)).toEqual(result!.policy);
    expect(result!.policy).toMatchObject({
      authKind: 'github-app', pat: null,
      app: { installationId: 77, appSlug: 'liftoff-preflight', token: { ttlSeconds: 59 * 60 } },
      proof: { readbackDigest: canonicalSha256(result!.usage), readbackProvider: 'github-api', payloadFree: true }
    });
    const serialized = JSON.stringify(result);
    for (const secret of [mintedToken, credentials[0]!, rsa.privateKey.split('\n')[1]!]) expect(serialized).not.toContain(secret);
  });

  it('checks configuration and authority before reading any protected input', async () => {
    const denied = appScenario();
    denied.authorize = () => { throw new Error('The credential-enrollment approval expired.'); };
    const expired = await enroll(denied);
    expect(expired.error).toEqual(new Error('The credential-enrollment approval expired.'));
    expect(expired.events).toEqual(['authorize']);
    expect(expired.channel.read).not.toHaveBeenCalled();

    const invalidConfiguration = await enroll(appScenario(), { configuration: { ...appConfiguration, grant: 'contents:write' } });
    expect((invalidConfiguration.error as GitHubActivationError).code).toBe('credential-config');
    expect(invalidConfiguration.events).toEqual([]);

    const invalidRepository = await enroll(appScenario(), { repository: 'acme' });
    expect((invalidRepository.error as GitHubActivationError).code).toBe('repository-required');
    expect(invalidRepository.events).toEqual([]);
  });

  it('zeroes rejected empty, oversized, and malformed protected inputs before provider access', async () => {
    for (const [secret, code] of [
      [Buffer.alloc(0), 'invalid-credential'], [Buffer.alloc(32_769, 65), 'invalid-credential'], [Buffer.from('not a private key'), 'invalid-app-key']
    ] as const) {
      const scenario = { ...appScenario(), secret: Buffer.from(secret) };
      const { error, events, written } = await enroll(scenario);
      expect((error as GitHubActivationError).code).toBe(code);
      expect(events).toEqual(['authorize', 'read']);
      expect(written).toEqual([]);
      expect(scenario.secret.every((byte) => byte === 0)).toBe(true);
    }
  });

  it('never mints a token for a suspended, over-scoped, or foreign installation', async () => {
    for (const overrides of [
      { suspended_at: '2026-09-01T00:00:00.000Z' }, { repository_selection: 'all' }, { account: { login: 'other-org' } },
      { app_id: 13 }, { id: 78 }, { permissions: { ...credentialApiPermissions, contents: 'write' } }, { permissions: { metadata: 'read' } }
    ]) {
      const { error, events, written } = await enroll(appScenario({ app: { 'GET /app/installations/77': ok(installation(overrides)) } }));
      expect((error as GitHubActivationError).code).toBe('credential-scope');
      expect(events).toEqual(['authorize', 'read', 'app:GET /app/installations/77']);
      expect(written).toEqual([]);
    }
  });

  it('revokes a minted token whose returned scope or lifetime is invalid before any use', async () => {
    const minted = (overrides: Record<string, unknown>) => ({
      'POST /app/installations/77/access_tokens': ok({
        token: mintedToken, expires_at: new Date(now.getTime() + 59 * 60_000).toISOString(),
        permissions: { ...credentialApiPermissions }, ...overrides
      }, 201)
    });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ permissions: { ...credentialApiPermissions, administration: 'write' } }, 'credential-scope'],
      [{ permissions: null }, 'invalid-response'],
      [{ expires_at: new Date(now.getTime() - 1000).toISOString() }, 'credential-expiry'],
      [{ expires_at: now.toISOString() }, 'credential-expiry'],
      [{ expires_at: new Date(now.getTime() + 61 * 60_000).toISOString() }, 'credential-expiry'],
      [{ expires_at: 'not-a-timestamp' }, 'credential-expiry'],
      [{ expires_at: 42 }, 'invalid-response']
    ];
    for (const [overrides, code] of cases) {
      const { error, events, written, zeroed } = await enroll(appScenario({ app: minted(overrides) }));
      expect((error as GitHubActivationError).code, JSON.stringify(overrides)).toBe(code);
      expect(events.slice(-2)).toEqual(['app:POST /app/installations/77/access_tokens', 'token:DELETE /installation/token']);
      expect(events.some((event) => event.startsWith('token:GET'))).toBe(false);
      expect(written).toEqual([]);
      expect(zeroed).toBe(true);
      expect((error as Error).message).not.toContain(mintedToken);
    }
  });

  it('cannot revoke or use a credential the provider did not return', async () => {
    const { error, events, written, zeroed } = await enroll(appScenario({ app: {
      'POST /app/installations/77/access_tokens': ok({ expires_at: new Date(now.getTime() + 59 * 60_000).toISOString() }, 201)
    } }));
    expect((error as GitHubActivationError).code).toBe('invalid-response');
    expect(events.at(-1)).toBe('app:POST /app/installations/77/access_tokens');
    expect(written).toEqual([]);
    expect(zeroed).toBe(true);
  });

  it('preserves the primary rejection and reports an unconfirmed revocation without provider data', async () => {
    const { error, events, written, zeroed } = await enroll(appScenario({
      app: { 'POST /app/installations/77/access_tokens': ok({
        token: mintedToken, expires_at: new Date(now.getTime() + 59 * 60_000).toISOString(),
        permissions: { ...credentialApiPermissions, administration: 'write' }
      }, 201) },
      token: { 'DELETE /installation/token': ok({ message: `revocation failed for ${mintedToken}` }, 500) }
    }));
    expect(error).toBeInstanceOf(GitHubActivationError);
    expect((error as GitHubActivationError).code).toBe('credential-scope');
    expect((error as Error).message).toMatch(/^GitHub minted a token with permissions different from the exact reviewed preflight scope\./u);
    expect((error as Error).message).toMatch(/revocation .* could not be confirmed/iu);
    expect((error as Error).message).toMatch(/diagnostics were withheld/u);
    expect((error as Error).message).not.toContain(mintedToken);
    expect((error as Error).message).not.toContain('HTTP 500');
    expect(events.at(-1)).toBe('token:DELETE /installation/token');
    expect(written).toEqual([]);
    expect(zeroed).toBe(true);
  });

  it('never asserts a lifetime bound from an untrusted expiry when revocation is unconfirmed', async () => {
    const primary = 'Installation tokens must be current and expire within one hour.';
    for (const expiresAt of ['not-a-timestamp', new Date(now.getTime() + 61 * 60_000).toISOString(), '2099-01-01T00:00:00.000Z']) {
      const { error, events, zeroed } = await enroll(appScenario({
        app: { 'POST /app/installations/77/access_tokens': ok({
          token: mintedToken, expires_at: expiresAt, permissions: { ...credentialApiPermissions }
        }, 201) },
        token: { 'DELETE /installation/token': ok({ message: 'unavailable' }, 503) }
      }));
      expect((error as GitHubActivationError).code, expiresAt).toBe('credential-expiry');
      const message = (error as Error).message;
      expect(message.startsWith(primary)).toBe(true);
      const cleanupNote = message.slice(primary.length);
      expect(cleanupNote).toMatch(/could not be confirmed/u);
      expect(cleanupNote).not.toMatch(/within one hour|expires/iu);
      expect(message).not.toContain(expiresAt);
      expect(events.at(-1)).toBe('token:DELETE /installation/token');
      expect(zeroed).toBe(true);
    }
  });

  it('withholds unexpected callback diagnostics when revocation after a minted token is unconfirmed', async () => {
    const sentinel = ['sentinel', 'secret', 'from', 'writer', 'stderr'].join('-');
    const scenario = appScenario({ token: { 'DELETE /installation/token': ok({ message: sentinel }, 500) } });
    scenario.writer = () => { throw new Error(`raw writer failure ${sentinel} ${mintedToken}`); };
    const { error, events, zeroed } = await enroll(scenario);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubActivationError);
    expect((error as Error).message).toMatch(/unexpected error; its diagnostics were withheld/u);
    expect((error as Error).message).toMatch(/could not be confirmed/u);
    expect((error as Error).message).not.toContain(sentinel);
    expect((error as Error).message).not.toContain(mintedToken);
    expect(events).not.toContain(`main:GET ${secretPath}`);
    expect(events.at(-1)).toBe('token:DELETE /installation/token');
    expect(zeroed).toBe(true);

    const denied = appScenario({ token: { 'DELETE /installation/token': ok(null, 500) } });
    denied.authorize = (count) => { if (count === 3) throw new Error(`approval callback leaked ${sentinel}`); };
    const refused = await enroll(denied);
    expect((refused.error as Error).message).not.toContain(sentinel);
    expect((refused.error as Error).message).toMatch(/could not be confirmed/u);
    expect(refused.written).toEqual([]);
    expect(refused.zeroed).toBe(true);
  });

  it('revokes the minted token when repository scope, use, or probes fail and writes no secret', async () => {
    const cases: Array<[Record<string, Route>, string]> = [
      [{ [listPage('/installation/repositories')]: ok({ total_count: 2, repositories: [
        { id: repositoryId, full_name: repository }, { id: 556, full_name: 'acme/other' }
      ] }) }, 'credential-scope'],
      [{ [listPage('/installation/repositories')]: ok({ total_count: 1, repositories: [{ id: 556, full_name: repository }] }) }, 'credential-scope'],
      [{ [`GET /repos/${repository}`]: ok({ id: 556, full_name: repository }) }, 'credential-use'],
      [{ [listPage('/orgs/acme/actions/hosted-runners')]: ok({ message: 'Resource not accessible by integration' }, 403) }, 'provider-response'],
      [{ [listPage('/orgs/acme/settings/network-configurations')]: ok({ total_count: 2, network_configurations: [] }) }, 'incomplete-pagination']
    ];
    for (const [token, code] of cases) {
      const { error, events, written } = await enroll(appScenario({ token }));
      expect((error as GitHubActivationError).code).toBe(code);
      expect(events.at(-1)).toBe('token:DELETE /installation/token');
      expect(events.filter((event) => event === 'authorize')).toHaveLength(2);
      expect(written).toEqual([]);
    }
  });

  it('keeps enrollment unverified without an independent current secret readback', async () => {
    for (const readback of [
      ok({ name: runnerPreflightSecretName, updated_at: new Date(now.getTime() - 5000).toISOString() }),
      ok({ name: 'OTHER_SECRET', updated_at: now.toISOString() }),
      ok({ message: 'Not Found' }, 404)
    ]) {
      const { error, events, written } = await enroll(appScenario({ main: { [`GET ${secretPath}`]: readback } }));
      expect(['secret-readback', 'provider-response']).toContain((error as GitHubActivationError).code);
      expect(written).toEqual([rsa.privateKey]);
      expect(events.at(-1)).toBe('token:DELETE /installation/token');
    }
  });

  it('propagates a failed secret write without claiming readback and still revokes the minted token', async () => {
    const scenario = appScenario();
    scenario.writer = () => { throw new GitHubActivationError('secret-write', 'GitHub did not confirm encrypted Actions secret enrollment.'); };
    const { error, events } = await enroll(scenario);
    expect((error as GitHubActivationError).code).toBe('secret-write');
    expect(events).not.toContain(`main:GET ${secretPath}`);
    expect(events.at(-1)).toBe('token:DELETE /installation/token');
  });

  it('reports a failed best-effort revocation as a sanitized cleanup warning without masking verified enrollment', async () => {
    const { result, error, zeroed } = await enroll(appScenario({ token: { 'DELETE /installation/token': ok({ message: `boom ${mintedToken}` }, 500) } }));
    expect(error).toBeUndefined();
    expect(result!.usage.installationId).toBe(77);
    expect(result!.cleanupWarnings).toHaveLength(1);
    expect(result!.cleanupWarnings[0]).toMatch(/revocation .* could not be confirmed/iu);
    expect(result!.cleanupWarnings[0]).toMatch(/diagnostics were withheld/u);
    expect(JSON.stringify(result)).not.toContain(mintedToken);
    expect(JSON.stringify(result)).not.toContain('boom');
    expect(zeroed).toBe(true);
  });
});

describe('fine-grained PAT fallback enrollment', () => {
  it('verifies owner, provider grant metadata, exact expiry, single-repository scope, use, and readback', async () => {
    const scenario = patScenario();
    const { result, error, events, credentials, written, zeroed } = await enroll(scenario);
    expect(error).toBeUndefined();
    expect(events).toEqual([
      'authorize', 'read', 'token:GET /user', `main:${listPage('/orgs/acme/personal-access-tokens?owner[]=octo-owner')}`,
      `main:${listPage('/orgs/acme/personal-access-tokens/901/repositories')}`, `token:GET /repos/${repository}`,
      `token:${listPage('/orgs/acme/actions/hosted-runners')}`, `token:${listPage('/orgs/acme/settings/network-configurations')}`,
      'authorize', `write:${repository}:${runnerPreflightSecretName}`, `main:GET ${secretPath}`
    ]);
    expect(credentials).toEqual([fineGrainedPat]);
    expect(written).toEqual([fineGrainedPat]);
    expect(zeroed).toBe(true);
    expect(result!.cleanupWarnings).toEqual([]);
    expect(result!.usage).toMatchObject({ principal: 'octo-owner', installationId: null, repositoryId });
    expect(validateCredentialPolicy(result!.policy)).toEqual(result!.policy);
    expect(result!.policy).toMatchObject({
      authKind: 'fine-grained-pat', app: null, createdAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-10-24T00:00:00.000Z',
      proof: { readbackDigest: canonicalSha256(result!.usage), readbackProvider: 'github-api', payloadFree: true }
    });
    expect(JSON.stringify(result)).not.toContain(fineGrainedPat);
  });

  it('rejects classic tokens before creating any credential transport', async () => {
    const { error, events, credentials, written } = await enroll({ ...patScenario(), secret: Buffer.from(classicPat) });
    expect((error as GitHubActivationError).code).toBe('credential-kind');
    expect((error as Error).message).not.toContain(classicPat);
    expect(events).toEqual(['authorize', 'read']);
    expect(credentials).toEqual([]);
    expect(written).toEqual([]);
  });

  it('rejects a PAT owned by another identity or with unverifiable identity', async () => {
    const other = await enroll(patScenario({ token: { 'GET /user': ok({ login: 'intruder' }, 200, {
      'github-authentication-token-expiration': '2026-10-24 00:00:00 UTC'
    }) } }));
    expect((other.error as GitHubActivationError).code).toBe('credential-owner');
    const expired = await enroll(patScenario({ token: { 'GET /user': ok({ message: 'Bad credentials' }, 401) } }));
    expect(expired.error).toMatchObject({ code: 'provider-response', status: 401 });
    for (const attempt of [other, expired]) {
      expect(attempt.written).toEqual([]);
      expect(attempt.events.some((event) => event.startsWith('main:'))).toBe(false);
    }
  });

  it('requires unambiguous organization grant metadata', async () => {
    for (const grants of [[], [patGrant(), patGrant({ id: 902 })], [patGrant({ token_id: 1 })]]) {
      const { error, written } = await enroll(patScenario({ main: {
        [listPage('/orgs/acme/personal-access-tokens?owner[]=octo-owner')]: ok(grants)
      } }));
      expect((error as GitHubActivationError).code).toBe('credential-metadata');
      expect(written).toEqual([]);
    }
  });

  it('rejects a PAT already inside the required rotation lead window', async () => {
    const nearExpiry = '2026-10-01T00:00:00.000Z';
    const { error, events, written } = await enroll(patScenario({
      token: {
        'GET /user': ok(
          { login: 'octo-owner' },
          200,
          { 'github-authentication-token-expiration': '2026-10-01 00:00:00 UTC' }
        )
      },
      main: {
        [listPage('/orgs/acme/personal-access-tokens?owner[]=octo-owner')]: ok([
          patGrant({ created_at: '2026-09-01T00:00:00.000Z', token_expires_at: nearExpiry })
        ])
      }
    }));
    expect((error as GitHubActivationError).code).toBe('credential-expiry');
    expect(events.some((event) => event.includes('/repositories'))).toBe(false);
    expect(written).toEqual([]);
  });

  it('rejects grants outside the exact read-only, selected-repository, 30-day policy', async () => {
    const header = (value?: string) => ({ token: { 'GET /user': ok({ login: 'octo-owner' }, 200,
      value === undefined ? {} : { 'x-github-authentication-token-expiration': value }) } });
    const grantCase = (grants: unknown[]) => ({ main: { [listPage('/orgs/acme/personal-access-tokens?owner[]=octo-owner')]: ok(grants) } });
    const cases: Array<[Partial<Pick<Scenario, 'token' | 'main'>>, string]> = [
      [grantCase([patGrant({ repository_selection: 'all' })]), 'credential-scope'],
      [grantCase([patGrant({ token_expired: true })]), 'credential-scope'],
      [grantCase([patGrant({ token_name: 'widget-deploy-write' })]), 'credential-scope'],
      [grantCase([patGrant({ owner: { login: 'intruder' } })]), 'credential-scope'],
      [grantCase([patGrant({ permissions: { repository: { metadata: 'read', contents: 'write' }, organization: {
        organization_hosted_runners: 'read', organization_network_configurations: 'read'
      }, other: {} } })]), 'credential-scope'],
      [grantCase([patGrant({ created_at: '2026-09-23T00:00:00.000Z' })]), 'credential-scope'],
      [grantCase([patGrant({ created_at: '2026-08-01T00:00:00.000Z', token_expires_at: '2026-08-31T00:00:00.000Z' })]), 'credential-expiry'],
      [grantCase([patGrant(), patGrant({ id: 903, token_id: 5151 })]), 'credential-scope'],
      [header(), 'credential-scope'],
      [header('2026-10-25 00:00:00 UTC'), 'credential-scope']
    ];
    for (const [overrides, code] of cases) {
      const { error, events, written } = await enroll(patScenario(overrides));
      expect((error as GitHubActivationError).code).toBe(code);
      expect(events.some((event) => event.includes('/repositories'))).toBe(false);
      expect(written).toEqual([]);
    }
  });

  it('rejects grants that are not restricted to the single selected repository and never revokes the operator PAT', async () => {
    const { error, events, written } = await enroll(patScenario({ main: {
      [listPage('/orgs/acme/personal-access-tokens/901/repositories')]: ok([
        { id: repositoryId, full_name: repository }, { id: 556, full_name: 'acme/other' }
      ])
    } }));
    expect((error as GitHubActivationError).code).toBe('credential-scope');
    expect(written).toEqual([]);
    expect(events.some((event) => event.includes('DELETE'))).toBe(false);
  });
});

describe('protected credential input channels', () => {
  const ttyDescriptors = {
    stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
    stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  };

  function setTty(stdin: boolean, stdout: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true, writable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true, writable: true });
  }

  afterEach(() => {
    for (const [name, descriptor] of Object.entries(ttyDescriptors)) {
      const stream = name === 'stdin' ? process.stdin : process.stdout;
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete (stream as { isTTY?: boolean }).isTTY;
    }
  });

  it('reads an explicitly selected protected stdin stream exactly and releases it', async () => {
    const input = new PassThrough();
    const channel = protectedStdinCredentialChannel(true, input, 1000);
    expect(channel.kind).toBe('protected-stdin');
    const pending = channel.read('fine-grained PAT');
    input.write('github');
    input.end('-value');
    await expect(pending).resolves.toEqual(Buffer.from('github-value'));
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.isPaused()).toBe(true);
  });

  it('requires explicit non-TTY selection before attaching to stdin', async () => {
    const input = new PassThrough();
    expect((await rejection(protectedStdinCredentialChannel(false, input).read('fine-grained PAT'))).code).toBe('private-input-required');
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    expect((await rejection(protectedStdinCredentialChannel(true, tty).read('GitHub App private key'))).code).toBe('private-input-required');
    expect(input.listenerCount('data') + tty.listenerCount('data')).toBe(0);
  });

  it('fails closed on empty, oversized, interrupted, and stalled protected input', async () => {
    const scenarios: Array<(input: PassThrough) => void> = [
      (input) => input.end(),
      (input) => input.write(Buffer.alloc(32_769, 65)),
      (input) => input.emit('error', new Error(`pipe closed while reading ${fineGrainedPat}`)),
      () => undefined
    ];
    for (const act of scenarios) {
      const input = new PassThrough();
      const pending = protectedStdinCredentialChannel(true, input, 25).read('fine-grained PAT');
      act(input);
      const error = await rejection(pending);
      expect(error.code).toBe('protected-input-failed');
      expect(error.message).not.toContain(fineGrainedPat);
      expect(input.listenerCount('data')).toBe(0);
    }
  });

  it('requires a private TTY before prompting', async () => {
    setTty(false, true);
    expect((await rejection(privateTtyCredentialChannel().read('fine-grained PAT'))).code).toBe('private-input-required');
    setTty(true, false);
    expect((await rejection(privateTtyCredentialChannel().read('fine-grained PAT'))).code).toBe('private-input-required');
    expect(password).not.toHaveBeenCalled();
  });

  it('prompts without echo and bounds private TTY input', async () => {
    setTty(true, true);
    const channel = privateTtyCredentialChannel();
    expect(channel.kind).toBe('private-tty');
    vi.mocked(password).mockResolvedValueOnce(fineGrainedPat);
    await expect(channel.read('fine-grained PAT')).resolves.toEqual(Buffer.from(fineGrainedPat));
    expect(password).toHaveBeenCalledWith({ message: 'Private fine-grained PAT (never copied into output):', mask: '' });
    for (const value of ['', 'x'.repeat(32_769)]) {
      vi.mocked(password).mockResolvedValueOnce(value);
      expect((await rejection(channel.read('GitHub App private key'))).code).toBe('invalid-credential');
    }
  });
});

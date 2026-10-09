import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSavedTransitionPlan,
  canonicalSha256,
  credentialPolicyPathParts,
  executeApplyNext,
  runnerPreflightWorkflowAllowlist,
  type ActivationConfiguration,
  type UserActivationState
} from '../src/governance-activation/index.js';
import {
  type GitHubActivationTransport,
  type GitHubRequest,
  type GitHubResponse
} from '../src/adapters/github/activation-rest.js';
import type { ProtectedCredentialChannel } from '../src/adapters/credentials/protected-input.js';
import type { GitHubSecretWriter } from '../src/adapters/credentials/github-enrollment.js';
import { runnerPreflightSecretName } from '../src/domain/governance/activation/types.js';
import { validateCredentialPolicy } from '../src/domain/governance/activation/validators.js';
import {
  LocalOnlyRunner,
  coverageActivationInputs,
  coverageInspection,
  coverageNow,
  coverageState,
  isolateUserLocalStorage,
  isolatedGitEnvironment,
  issuePriorApproval,
  readState,
  resetDirectory,
  scratchDirectory,
  writeCoverageProject
} from './fixtures/governance-coverage/transition-project.js';

const scratch = scratchDirectory('credential-readiness');
const repository = 'owner/repo';
const repositoryId = 555;
const tokenId = 4242;
const pat = `github_pat_${'A'.repeat(60)}`;
const createdAt = '2026-09-03T00:00:00.000Z';
const expiresAt = '2026-10-03T00:00:00.000Z';
const secretPath = `/repos/${repository}/actions/secrets/${runnerPreflightSecretName}`;
let storage: Awaited<ReturnType<typeof isolateUserLocalStorage>>;
let gitEnvironment: NodeJS.ProcessEnv;

beforeAll(async () => {
  await resetDirectory(scratch);
  storage = await isolateUserLocalStorage();
  gitEnvironment = await isolatedGitEnvironment(scratch);
});

afterAll(async () => {
  await storage.restore();
  await rm(scratch, { recursive: true, force: true });
});

type Route = GitHubResponse | ((request: GitHubRequest) => GitHubResponse);

class RouteTransport implements GitHubActivationTransport {
  readonly requests: GitHubRequest[] = [];

  constructor(private readonly routes: Record<string, Route>) {}

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(request);
    const route = this.routes[`${request.method} ${request.path}`];
    if (!route) throw new Error(`Unexpected GitHub request ${request.method} ${request.path}`);
    return typeof route === 'function' ? route(request) : route;
  }
}

function ok(data: unknown, status = 200, headers: Record<string, string> = {}): GitHubResponse {
  return { status, headers, data };
}

function list(pathname: string): string {
  return `GET ${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100&page=1`;
}

function credentialInputs(): ActivationConfiguration {
  return {
    ...coverageActivationInputs(),
    phases: {
      'credential-ready': {
        kind: 'fine-grained-pat',
        tokenId,
        owner: 'octo-owner',
        appUnavailableReason: 'The organization has no approved preflight App.'
      }
    }
  };
}

function credentialState(): UserActivationState {
  const state = coverageState({
    applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: true },
    phaseOutputs: { 'phase-0-complete': { values: { repositoryId }, resources: [] } }
  });
  state.phases['phase-0-complete'] = {
    state: 'verified',
    updatedAt: coverageNow.toISOString(),
    evidence: [],
    approvals: [],
    blockers: []
  };
  return state;
}

describe('production credential readiness', () => {
  it('enrolls through protected input and persists only policy, evidence, and independent readback metadata', async () => {
    const root = await writeCoverageProject(path.join(scratch, 'pat-success'));
    await mkdir(path.join(root, 'governance', 'credentials'), { recursive: true });
    const runner = new LocalOnlyRunner(gitEnvironment);
    const state = credentialState();
    const activationInputs = credentialInputs();
    const planning = await coverageInspection({
      root,
      phaseId: 'credential-ready',
      state,
      activationInputs
    });
    const plan = (await buildSavedTransitionPlan({ inspection: planning, runner, now: coverageNow }))!;
    expect(plan.operations.map((operation) => operation.actionId)).toEqual([
      'github.credential.enroll-masked',
      'github.credential.verify-policy',
      'local.credential-policy.write',
      'governance.evidence.write',
      'governance.activation-state.write'
    ]);
    expect(plan.operations.find((operation) => operation.actionId === 'local.credential-policy.write')).toMatchObject({
      adapter: 'local-state',
      mutationClass: 'write-credential-policy',
      destination: { pathParts: credentialPolicyPathParts }
    });
    expect(JSON.stringify(plan)).not.toContain(pat);

    const approval = await issuePriorApproval(root, state, plan);
    const inspection = await coverageInspection({
      root,
      phaseId: 'credential-ready',
      state,
      approvals: [approval],
      activationInputs
    });
    const main = new RouteTransport({
      [list('/orgs/owner/personal-access-tokens?owner[]=octo-owner')]: ok([{
        id: 901,
        token_id: tokenId,
        owner: { login: 'octo-owner' },
        repository_selection: 'subset',
        token_expired: false,
        token_name: 'repo-runner-preflight-read',
        token_expires_at: expiresAt,
        created_at: createdAt,
        permissions: {
          repository: { metadata: 'read' },
          organization: {
            organization_hosted_runners: 'read',
            organization_network_configurations: 'read'
          },
          other: {}
        }
      }]),
      [list('/orgs/owner/personal-access-tokens/901/repositories')]: ok([{ id: repositoryId, full_name: repository }]),
      [`GET ${secretPath}`]: ok({ name: runnerPreflightSecretName, updated_at: coverageNow.toISOString() })
    });
    const credential = new RouteTransport({
      'GET /user': ok(
        { login: 'octo-owner' },
        200,
        { 'github-authentication-token-expiration': '2026-10-03 00:00:00 UTC' }
      ),
      [`GET /repos/${repository}`]: ok({ id: repositoryId, full_name: repository }),
      [list('/orgs/owner/actions/hosted-runners')]: ok({ total_count: 0, runners: [] }),
      [list('/orgs/owner/settings/network-configurations')]: ok({ total_count: 0, network_configurations: [] })
    });
    const secretBytes = Buffer.from(pat);
    const channel: ProtectedCredentialChannel = {
      kind: 'protected-stdin',
      async read() {
        return secretBytes;
      }
    };
    const writes: string[] = [];
    const secretWriter: GitHubSecretWriter = {
      async write(target, name, value) {
        expect(target).toBe(repository);
        expect(name).toBe(runnerPreflightSecretName);
        writes.push(Buffer.from(value).toString('utf8'));
      }
    };

    const result = await executeApplyNext({
      inspection,
      reinspect: () => coverageInspection({
        root,
        phaseId: 'credential-ready',
        state,
        approvals: [approval],
        activationInputs
      }),
      runner,
      now: coverageNow,
      credentialEnrollment: { protectedStdin: true },
      adapters: {
        githubActivation: {
          transport: main,
          protectedCredentialChannel: channel,
          credentialTransport(value) {
            expect(Buffer.from(value).toString('utf8')).toBe(pat);
            return credential;
          },
          secretWriter
        }
      }
    });

    expect(result).toMatchObject({
      applied: true,
      authorized: true,
      reason: 'phase-executed',
      selectedPhase: 'credential-ready',
      executedPhase: 'credential-ready',
      cleanupWarnings: []
    });
    expect(result.executedOperations.map((operation) => operation.actionId)).toEqual(expect.arrayContaining([
      'github.credential.enroll-masked',
      'github.credential.verify-policy',
      'local.credential-policy.write',
      'governance.evidence.write',
      'governance.activation-state.write'
    ]));
    expect(writes).toEqual([pat]);
    expect(secretBytes.every((byte) => byte === 0)).toBe(true);
    expect(runner.providerCalls).toEqual([]);

    const policyFile = path.join(root, ...credentialPolicyPathParts);
    const policy = validateCredentialPolicy(JSON.parse(await readFile(policyFile, 'utf8')));
    expect(policy).toMatchObject({
      authKind: 'fine-grained-pat',
      repository: { id: String(repositoryId), fullName: repository },
      owner: 'owner',
      secretName: runnerPreflightSecretName,
      allowedWorkflows: runnerPreflightWorkflowAllowlist,
      proof: { readbackProvider: 'github-api', payloadFree: true }
    });
    expect((await stat(policyFile)).mode & 0o777).toBe(0o600);

    const evidence = JSON.parse(await readFile(path.join(root, ...result.evidence!.pathParts), 'utf8')) as {
      payload: {
        kind: string;
        policyDigest: string;
        usageDigest: string;
        configurationDigest: string;
        usage: unknown;
      };
      liveReadback: Array<{ provider: string; resourceId: string; readbackDigest: string; matches: boolean }>;
    };
    expect(evidence.payload).toMatchObject({
      kind: 'credential-ready.v1',
      policyDigest: canonicalSha256(policy),
      usageDigest: policy.proof.readbackDigest,
      configurationDigest: canonicalSha256(activationInputs.phases['credential-ready'])
    });
    expect(canonicalSha256(evidence.payload.usage)).toBe(evidence.payload.usageDigest);
    expect(evidence.liveReadback).toContainEqual(expect.objectContaining({
      provider: 'github',
      resourceId: secretPath,
      readbackDigest: evidence.payload.usageDigest,
      matches: true
    }));
    expect((await readState(root))?.phases['credential-ready'].state).toBe('verified');

    const serialized = JSON.stringify({ result, policy, evidence });
    expect(serialized).not.toContain(pat);
    expect(serialized).not.toMatch(/github_pat_|gh[pousr]_/u);
    expect(main.requests.some((request) => request.method === 'GET' && request.path === secretPath)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../src/adapters/github/activation-rest.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import { planGitHubPhase, executeGitHubPhase } from '../src/governance-activation/phase-github.js';
import type {
  PhasePlanningInput,
  PhaseAdapterExecutionInput,
  GovernanceTransitionInspection
} from '../src/governance-activation/transition-ports.js';
import type {
  PhaseId,
  PhaseGraphNode,
  SavedTransitionPlan,
  UserActivationState
} from '../src/domain/governance/activation/types.js';
import { phaseIds, phaseScope } from '../src/domain/governance/activation/types.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { evidenceContextForPhase } from '../src/domain/governance/activation/evidence.js';
import { evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../src/domain/governance/activation/approvals.js';
import { planDigestFor } from '../src/domain/governance/activation/operations.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { currentGovernanceManifest } from './governance-activation-fixtures.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { ProtectedCredentialChannel } from '../src/adapters/credentials/protected-input.js';

class MockTransport implements GitHubActivationTransport {
  public requests: GitHubRequest[] = [];
  public responses: Map<string, (req: GitHubRequest) => GitHubResponse> = new Map();

  on(key: string, fn: (req: GitHubRequest) => GitHubResponse): void {
    this.responses.set(key, fn);
  }

  async request(req: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(req);
    const key = `${req.method} ${req.path.split('?')[0]}`;
    const fn = this.responses.get(key);
    if (fn) return fn(req);
    return { status: 404, headers: {}, data: { message: `Not found: ${key}` } };
  }
}

function mockNode(id: PhaseId): PhaseGraphNode {
  return canonicalPhaseGraph.phases.find((phase) => phase.id === id)!;
}

function mockState(): UserActivationState {
  return {
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: '123', name: 'owner/repo', defaultBranch: 'develop' },
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: '2026-09-15T00:00:00.000Z', evidence: [], approvals: [], blockers: []
    }])) as UserActivationState['phases'],
    createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
  };
}

function contextFor(phaseId: PhaseId, state: UserActivationState) {
  return evidenceContextForPhase(phaseId, {
    repositoryId: state.repository.id, baselineSha: canonicalSha256('unexecuted fixture baseline'),
    inputDigest: canonicalSha256({ phaseId, purpose: 'missing-authority admission fixture' }),
    now: new Date('2026-09-15T00:00:00.000Z')
  });
}

function mockPlan(phaseId: PhaseId): SavedTransitionPlan {
  const phase = mockNode(phaseId);
  const state = mockState();
  const context = contextFor(phaseId, state);
  const request = transitionPlanForPhase(phase, state, context.transition, '/test', undefined, { operations: [] });
  const evaluation = evaluateApprovalForTransitionPlan(request, [], { now: new Date('2026-09-15T00:00:00.000Z') });
  return {
    schemaVersion: 2,
    scope: phaseScope(phaseId),
    phaseId,
    createdAt: '2026-09-15T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    identity: currentActivationIdentity,
    graphHash: canonicalPhaseGraphHash,
    stateHash: null,
    baselineDigest: context.baselineSha,
    inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations: [], approvalPlanDigest: request.planDigest }),
    mutationClasses: phase.allowedMutations,
    operations: [],
    approval: {
      gateKind: phase.approvalGate.kind,
      required: phase.approvalGate.required,
      evaluation,
      envelopeId: null,
      envelopeHash: null
    },
    rollbackPlan: {
      phaseId,
      strategy: phase.rollback.kind,
      target: phase.rollback.target,
      operations: [],
      retained: [],
      cleanupWarnings: []
    },
    noSecrets: true
  };
}

function mockInspection(overrides: Partial<GovernanceTransitionInspection> = {}): GovernanceTransitionInspection {
  const state = overrides.state ?? mockState();

  return {
    projectRoot: '/test',
    manifest: parseManifest(currentGovernanceManifest('GitHub missing-authority regression')),
    graph: canonicalPhaseGraph,
    graphHash: canonicalPhaseGraphHash,
    scope: 'activation',
    state,
    approvals: [],
    evidence: [],
    contexts: Object.fromEntries(phaseIds.map((id) => [id, contextFor(id, state)])) as GovernanceTransitionInspection['contexts'],
    readiness: { nextReadyPhase: null, phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'blocked', blockers: ['No source or approval authority has been established.']
    }])) as GovernanceTransitionInspection['readiness']['phases'] },
    sourceOfTruth: {
      status: 'none', selected: null, candidates: [],
      createPlan: { status: 'blocked', workflowKind: 'openspec', changeId: 'governance-fixture',
        reason: 'Missing source and approval authority is intentional in this rejection fixture.', requiredFacts: [] }
    },
    ...overrides
  };
}

const dummyRunner: CommandRunner = {
  run: async () => { throw new Error('Unapproved metadata fixtures cannot invoke provider commands.'); }
};

describe('Production Phase GitHub Dispatching', () => {
  it('plans dedicated repository phases', async () => {
    const inspection = mockInspection({ scope: 'repository' });
    inspection.state.remoteBinding = {
      id: '123', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git',
      verifiedAt: '2026-09-15T00:00:00.000Z'
    };
    const planningInput: PhasePlanningInput = {
      inspection,
      phase: mockNode('repository-discovered'),
      runner: dummyRunner,
      now: new Date('2026-09-15T00:00:00.000Z')
    };

    const discoveryPlan = await planGitHubPhase(planningInput);
    expect(discoveryPlan).not.toBeNull();
    expect(discoveryPlan!.operations.some((op) => op.actionId === 'github.repository.discover')).toBe(true);

    const workflowInput: PhasePlanningInput = {
      inspection,
      phase: mockNode('repository-workflow-source-ready'),
      runner: dummyRunner,
      now: new Date('2026-09-15T00:00:00.000Z')
    };
    const workflowPlan = await planGitHubPhase(workflowInput);
    expect(workflowPlan).not.toBeNull();
    expect(workflowPlan!.operations).toEqual([]);
    expect(workflowPlan!.blockers?.join(' ')).toContain('Supply exact sourceSha');

    const checksInput: PhasePlanningInput = {
      inspection,
      phase: mockNode('repository-checks-qualified'),
      runner: dummyRunner,
      now: new Date('2026-09-15T00:00:00.000Z')
    };
    const checksPlan = await planGitHubPhase(checksInput);
    expect(checksPlan).not.toBeNull();
    expect(checksPlan!.operations).toEqual([]);
    expect(checksPlan!.blockers?.length).toBeGreaterThan(0);

    const rulesetsInput: PhasePlanningInput = {
      inspection,
      phase: mockNode('repository-rulesets-applied'),
      runner: dummyRunner,
      now: new Date('2026-09-15T00:00:00.000Z')
    };
    const rulesetsPlan = await planGitHubPhase(rulesetsInput);
    expect(rulesetsPlan).not.toBeNull();
    expect(rulesetsPlan!.operations).toEqual([]);
    expect(rulesetsPlan!.blockers?.join(' ')).toContain('mainHold mode explicitly');
  });

  it('refuses metadata-only credential enrollment before taking custody or writing a secret', async () => {
    const transport = new MockTransport();
    let secretWrittenName = '';
    let secretMetadataChecked = false;

    // PAT user check
    transport.on('GET /user', () => ({
      status: 200,
      headers: { 'github-authentication-token-expiration': '2026-10-15T00:00:00.000Z' },
      data: { login: 'owner', id: 999 }
    }));

    // Org PAT grants
    transport.on('GET /orgs/owner/personal-access-tokens', () => ({
      status: 200,
      headers: {},
      data: [
        {
          id: 10,
          token_id: 1,
          token_name: 'repo-runner-preflight-read',
          token_expired: false,
          token_expires_at: '2026-10-15T00:00:00.000Z',
          created_at: '2026-09-15T00:00:00.000Z',
          repository_selection: 'subset',
          owner: { login: 'owner' },
          permissions: {
            repository: { metadata: 'read' },
            organization: { organization_hosted_runners: 'read', organization_network_configurations: 'read' },
            other: {}
          }
        }
      ]
    }));

    transport.on('GET /orgs/owner/personal-access-tokens/10/repositories', () => ({
      status: 200,
      headers: {},
      data: [{ id: 123, full_name: 'owner/repo' }]
    }));

    // Secret readback
    transport.on('GET /repos/owner/repo/actions/secrets/RUNNER_CONFIGURATION_READ_TOKEN', () => {
      secretMetadataChecked = true;
      return {
        status: 200,
        headers: {},
        data: {
          name: 'RUNNER_CONFIGURATION_READ_TOKEN',
          created_at: '2026-09-15T00:00:00.000Z',
          updated_at: '2026-09-15T00:00:00.000Z'
        }
      };
    });

    transport.on('GET /repos/owner/repo', () => ({
      status: 200,
      headers: {},
      data: { id: 123, full_name: 'owner/repo' }
    }));

    transport.on('GET /orgs/owner/actions/hosted-runners', () => ({
      status: 200,
      headers: {},
      data: { total_count: 0, runners: [] }
    }));

    transport.on('GET /orgs/owner/settings/network-configurations', () => ({
      status: 200,
      headers: {},
      data: { total_count: 0, network_configurations: [] }
    }));

    const rawSecret = 'github_pat_11AAAAAAA0000000000000000000000000000000000000000000000000000000000000000000000000';
    const secretBuffer = Buffer.from(rawSecret, 'utf8');
    let credentialReads = 0;

    const mockChannel: ProtectedCredentialChannel = {
      kind: 'protected-stdin',
      async read() {
        credentialReads += 1;
        return secretBuffer;
      }
    };

    const testRoot = path.join(process.cwd(), 'tests', `.test-credential-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });

    try {
      const inspection = mockInspection({ projectRoot: testRoot });
      const executionInput: PhaseAdapterExecutionInput = {
        inspection,
        plan: mockPlan('credential-ready'),
        phase: mockNode('credential-ready'),
        runner: dummyRunner,
        adapters: {
          githubActivation: {
            transport,
            protectedCredentialChannel: mockChannel,
            credentialTransport: () => transport,
            secretWriter: {
              async write(repository, name, val) {
                secretWrittenName = name;
                throw new Error('No secret mutation was approved.');
              }
            }
          }
        },
        now: new Date('2026-09-15T00:00:00.000Z'),
        credentialEnrollment: { protectedStdin: true }
      };

      const outcome = await executeGitHubPhase(executionInput);

      expect(outcome).not.toBeNull();
      expect(outcome!.status).toBe('blocked');
      expect(outcome!.evidencePayload).toBeUndefined();
      expect(outcome!.liveReadback).toBeUndefined();
      expect(secretWrittenName).toBe('');
      expect(secretMetadataChecked).toBe(false);
      expect(credentialReads).toBe(0);
      expect(transport.requests).toEqual([]);
      expect(JSON.stringify(outcome)).not.toContain(rawSecret);
      expect(JSON.stringify(outcome)).not.toContain(canonicalSha256(rawSecret));
    } finally {
      secretBuffer.fill(0);
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it('does not turn an unrelated ready-runner inventory into dedicated assignment and network proof', async () => {
    const transport = new MockTransport();
    transport.on('GET /orgs/owner/actions/hosted-runners', () => ({
      status: 200,
      headers: {},
      data: {
        total_count: 1,
        runners: [{ id: 1, name: 'dedicated-runner', status: 'Ready' }]
      }
    }));

    const inspection = mockInspection();
    const executionInput: PhaseAdapterExecutionInput = {
      inspection,
      plan: mockPlan('runner-ready'),
      phase: mockNode('runner-ready'),
      runner: dummyRunner,
      adapters: { githubActivation: { transport } },
      now: new Date('2026-09-15T00:00:00.000Z')
    };

    const outcome = await executeGitHubPhase(executionInput);
    expect(outcome!.status).toBe('blocked');
    expect(outcome!.evidencePayload).toBeUndefined();
    expect(outcome!.liveReadback).toBeUndefined();
    expect(transport.requests).toEqual([]);

    // Unaccessible runners
    const unaccessibleTransport = new MockTransport();
    unaccessibleTransport.on('GET /orgs/owner/actions/hosted-runners', () => ({
      status: 403,
      headers: {},
      data: { message: 'Must have admin access to organization' }
    }));

    const unaccessibleInput: PhaseAdapterExecutionInput = {
      ...executionInput,
      adapters: { githubActivation: { transport: unaccessibleTransport } }
    };

    const failedOutcome = await executeGitHubPhase(unaccessibleInput);
    expect(failedOutcome!.status).toBe('blocked');
    expect(failedOutcome!.blocker).toContain('only to its selected bootstrap activation phase');
    expect(unaccessibleTransport.requests).toEqual([]);
  });

  it('never qualifies an application image from a repository-wide artifact listing', async () => {
    const transport = new MockTransport();
    transport.on('GET /repos/owner/repo/actions/artifacts', () => ({
      status: 200,
      headers: {},
      data: {
        total_count: 1,
        artifacts: [{ id: 801, name: 'container-image', size_in_bytes: 1048576 }]
      }
    }));

    const inspection = mockInspection();
    const executionInput: PhaseAdapterExecutionInput = {
      inspection,
      plan: mockPlan('application-artifact-ready'),
      phase: mockNode('application-artifact-ready'),
      runner: dummyRunner,
      adapters: { githubActivation: { transport } },
      now: new Date('2026-09-15T00:00:00.000Z')
    };

    const outcome = await executeGitHubPhase(executionInput);
    expect(outcome!.status).toBe('blocked');
    expect(outcome!.evidencePayload).toBeUndefined();
    expect(outcome!.liveReadback).toBeUndefined();
    expect(transport.requests).toEqual([]);
  });

  it('does not use an unrelated latest run as dev proof without an exact operation and job binding', async () => {
    const transport = new MockTransport();
    transport.on('GET /repos/owner/repo/actions/runs', () => ({
      status: 200,
      headers: {},
      data: {
        total_count: 1,
        workflow_runs: [
          {
            id: 901,
            workflow_id: 11,
            path: '.github/workflows/dev-proof.yml',
            head_sha: 'a'.repeat(40),
            status: 'completed',
            conclusion: 'success'
          }
        ]
      }
    }));

    transport.on('GET /repos/owner/repo/actions/runs/901/jobs', () => ({
      status: 200,
      headers: {},
      data: { total_count: 1, jobs: [{ id: 1001, name: 'dev-check', conclusion: 'success' }] }
    }));

    const inspection = mockInspection();
    const executionInput: PhaseAdapterExecutionInput = {
      inspection,
      plan: mockPlan('dev-proof'),
      phase: mockNode('dev-proof'),
      runner: dummyRunner,
      adapters: { githubActivation: { transport } },
      now: new Date('2026-09-15T00:00:00.000Z')
    };

    const outcome = await executeGitHubPhase(executionInput);
    expect(outcome!.status).toBe('blocked');
    expect(outcome!.blocker).toContain('Development proof requires exactly its registered fields');
    expect(transport.requests).toEqual([]);

    // Failing workflow run
    const failingTransport = new MockTransport();
    failingTransport.on('GET /repos/owner/repo/actions/runs', () => ({
      status: 200,
      headers: {},
      data: {
        total_count: 1,
        workflow_runs: [
          {
            id: 902,
            workflow_id: 11,
            path: '.github/workflows/dev-proof.yml',
            head_sha: 'a'.repeat(40),
            status: 'completed',
            conclusion: 'failure'
          }
        ]
      }
    }));

    const failingInput: PhaseAdapterExecutionInput = {
      ...executionInput,
      adapters: { githubActivation: { transport: failingTransport } }
    };

    const failedOutcome = await executeGitHubPhase(failingInput);
    expect(failedOutcome!.status).toBe('blocked');
    expect(failedOutcome!.blocker).toContain('Development proof requires exactly its registered fields');
    expect(failingTransport.requests).toEqual([]);
  });

  it('never labels an unrelated success/failure pair as controlled full-activation green/red proof', async () => {
    const transport = new MockTransport();
    transport.on('GET /repos/owner/repo/actions/runs', () => ({
      status: 200,
      headers: {},
      data: {
        total_count: 2,
        workflow_runs: [
          { id: 101, name: 'verify-green', status: 'completed', conclusion: 'success' },
          { id: 102, name: 'verify-red', status: 'completed', conclusion: 'failure' }
        ]
      }
    }));

    const inspection = mockInspection();
    const executionInput: PhaseAdapterExecutionInput = {
      inspection,
      plan: mockPlan('green-red-proof'),
      phase: mockNode('green-red-proof'),
      runner: dummyRunner,
      adapters: { githubActivation: { transport } },
      now: new Date('2026-09-15T00:00:00.000Z')
    };

    const outcome = await executeGitHubPhase(executionInput);
    expect(outcome!.status).toBe('blocked');
    expect(outcome!.evidencePayload).toBeUndefined();
    expect(outcome!.liveReadback).toBeUndefined();
    expect(transport.requests).toEqual([]);

    // Missing red failure
    const greenOnlyTransport = new MockTransport();
    greenOnlyTransport.on('GET /repos/owner/repo/actions/runs', () => ({
      status: 200,
      headers: {},
      data: {
        total_count: 1,
        workflow_runs: [
          { id: 101, name: 'verify-green', status: 'completed', conclusion: 'success' }
        ]
      }
    }));

    const greenOnlyInput: PhaseAdapterExecutionInput = {
      ...executionInput,
      adapters: { githubActivation: { transport: greenOnlyTransport } }
    };

    const failedOutcome = await executeGitHubPhase(greenOnlyInput);
    expect(failedOutcome!.status).toBe('blocked');
    expect(failedOutcome!.blocker).toContain('There is no exact reviewed full-activation green-red-proof operation');
    expect(greenOnlyTransport.requests).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../src/adapters/github/activation-rest.js';
import { GitHubActivationClient, GitHubActivationError } from '../src/adapters/github/activation-rest.js';
import {
  discoverRepositoryGovernance,
  type RepositoryGovernanceDiscoveryReport
} from '../src/adapters/github/production-repository.js';
import {
  qualifyRepositorySourceChecks,
  verifyCommitCheckRun
} from '../src/adapters/github/production-checks.js';
import {
  createMainUpdateHold,
  evaluateMainHoldReplacement
} from '../src/application/repository-governance/producer-main-hold.js';
import {
  planRepositoryDiscovery,
  executeRepositoryDiscovery
} from '../src/application/repository-governance/producer-discovery.js';
import {
  planRepositoryWorkflowSource,
  executeRepositoryWorkflowSource
} from '../src/application/repository-governance/producer-workflow-source.js';
import {
  planRepositoryChecks,
  executeRepositoryChecks
} from '../src/application/repository-governance/producer-checks.js';
import {
  planRepositoryRulesets,
  executeRepositoryRulesets,
  executeRepositoryLiveReadback
} from '../src/application/repository-governance/producer-rulesets.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import type {
  PhaseEvidenceRecord,
  ApprovalEnvelope,
  UserActivationState,
  PhaseGraphNode,
  SavedTransitionPlan
} from '../src/domain/governance/activation/types.js';
import type {
  GovernanceTransitionInspection,
  PhasePlanningInput,
  PhaseAdapterExecutionInput
} from '../src/governance-activation/transition-ports.js';
import type { CommandRunner } from '../src/process-runner.js';
import { githubSourceFixture } from './helpers/github-source-fixture.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';

class MockTransport implements GitHubActivationTransport {
  private readonly handlers: Array<(req: GitHubRequest) => GitHubResponse | undefined> = [];
  readonly requests: GitHubRequest[] = [];

  on(handler: (req: GitHubRequest) => GitHubResponse | undefined): void {
    this.handlers.push(handler);
  }

  async request(req: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(req);
    for (const h of this.handlers) {
      const res = h(req);
      if (res) return res;
    }
    return { status: 404, headers: {}, data: { message: `Not found: ${req.path}` } };
  }
}

describe('Repository Governance Production Discovery', () => {
  it('discovers repository identity, branches, rulesets, and capabilities without Azure', async () => {
    const transport = new MockTransport();
    const repoSha = 'a'.repeat(40);
    const mainSha = 'b'.repeat(40);

    transport.on((req) => {
      if (req.method === 'GET' && req.path === '/repos/owner/repo') {
        return {
          status: 200,
          headers: {},
          data: {
            id: 12345,
            name: 'repo',
            full_name: 'owner/repo',
            default_branch: 'develop',
            private: true,
            owner: { login: 'owner', type: 'Organization', id: 999 },
            permissions: { admin: true, push: true, pull: true },
            security_and_analysis: { secret_scanning: { status: 'enabled' } }
          }
        };
      }
      if (req.method === 'GET' && req.path.split('?')[0] === '/repos/owner/repo/branches') {
        return {
          status: 200,
          headers: {},
          data: [
            { name: 'develop', commit: { sha: repoSha }, protected: true },
            { name: 'main', commit: { sha: mainSha }, protected: true }
          ]
        };
      }
      if (req.method === 'GET' && req.path.startsWith('/repos/owner/repo/actions/workflows')) {
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            workflows: [
              { id: 101, name: 'verify', path: '.github/workflows/verify.yml', state: 'active' }
            ]
          }
        };
      }
      if (req.method === 'GET' && req.path.split('?')[0] === '/repos/owner/repo/rulesets') {
        return {
          status: 200,
          headers: {},
          data: [
            { id: 1, name: 'liftoff-gitflow-develop', source_type: 'Repository', target: 'branch', enforcement: 'active' }
          ]
        };
      }
      if (req.method === 'GET' && req.path === '/repos/owner/repo/rulesets/1') {
        return {
          status: 200,
          headers: {},
          data: {
            id: 1,
            node_id: 'R_kwDO1234',
            name: 'liftoff-gitflow-develop',
            target: 'branch',
            enforcement: 'active',
            source_type: 'Repository',
            source: 'owner/repo',
            conditions: { ref_name: { include: ['refs/heads/develop'], exclude: [] } },
            bypass_actors: [],
            rules: [{ type: 'deletion' }]
          }
        };
      }
      if (req.method === 'GET' && req.path.includes('/check-runs')) {
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [
              {
                id: 501, name: 'verify-source', status: 'completed', conclusion: 'success',
                head_sha: req.path.includes(mainSha) ? mainSha : repoSha, app: { id: 15368, slug: 'github-actions' }
              }
            ]
          }
        };
      }
      if (req.method === 'GET' && req.path === '/repos/owner/repo/actions/permissions') {
        return { status: 200, headers: {}, data: { enabled: true, allowed_actions: 'all' } };
      }
      if (req.method === 'GET' && req.path === '/repos/owner/repo/actions/permissions/workflow') {
        return { status: 200, headers: {}, data: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } };
      }
      if (req.method === 'GET' && req.path.endsWith('/protection')) {
        return { status: 404, headers: {}, data: { message: 'Branch not protected' } };
      }
      if (req.method === 'GET' && req.path.includes('/contents/')) {
        return {
          status: 200, headers: {},
          data: githubSourceFixture('.github/workflows/verify.yml', 'name: verify\non: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n')
        };
      }
      return undefined;
    });

    const client = new GitHubActivationClient(transport);
    const report: RepositoryGovernanceDiscoveryReport = await discoverRepositoryGovernance(client, 'owner/repo');

    expect(report.repository.id).toBe(12345);
    expect(report.repository.name).toBe('owner/repo');
    expect(report.repository.defaultBranch).toBe('develop');
    expect(report.repository.isPrivate).toBe(true);
    expect(report.branches.length).toBe(2);
    expect(report.workflows.length).toBe(1);
    expect(report.rulesets.length).toBe(1);
    expect(report.checksByRef['develop']?.length).toBe(1);
    expect(report.capabilities.actionsEnabled).toBe(true);
  });

  it('reports missing repository with clear 404 explanation', async () => {
    const transport = new MockTransport();
    transport.on((req) => {
      if (req.path === '/repos/owner/absent-repo') {
        return { status: 404, headers: {}, data: { message: 'Not Found' } };
      }
      return undefined;
    });

    const client = new GitHubActivationClient(transport);
    await expect(discoverRepositoryGovernance(client, 'owner/absent-repo')).rejects.toThrow(
      /absent or not visible to the authorized identity/u
    );
  });

  it('reports insufficient permissions on 403', async () => {
    const transport = new MockTransport();
    transport.on((req) => {
      if (req.path === '/repos/owner/forbidden-repo') {
        return { status: 403, headers: {}, data: { message: 'Must have push access' } };
      }
      return undefined;
    });

    const client = new GitHubActivationClient(transport);
    await expect(discoverRepositoryGovernance(client, 'owner/forbidden-repo')).rejects.toThrow(
      /lacks read access to repository/u
    );
  });
});

describe('Repository Governance Source Checks Qualification', () => {
  it('qualifies real positive checks with success conclusion', async () => {
    const transport = new MockTransport();
    const headSha = 'c'.repeat(40);

    transport.on((req) => {
      if (req.method === 'GET' && req.path.includes(`/commits/${headSha}/check-runs`)) {
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [
              {
                id: 601,
                name: 'verify',
                status: 'completed',
                conclusion: 'success',
                head_sha: headSha,
                app: { id: 1, slug: 'github-actions' }
              }
            ]
          }
        };
      }
      return undefined;
    });

    const client = new GitHubActivationClient(transport);
    const result = await verifyCommitCheckRun(client, 'owner/repo', headSha, 'verify', 'success');
    expect(result.checkRunId).toBe(601);
    expect(result.conclusion).toBe('success');
  });

  it('rejects skipped or cancelled checks as positive proof', async () => {
    const transport = new MockTransport();
    const headSha = 'd'.repeat(40);

    transport.on((req) => {
      if (req.method === 'GET' && req.path.includes(`/commits/${headSha}/check-runs`)) {
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [
              {
                id: 602,
                name: 'verify',
                status: 'completed',
                conclusion: 'skipped',
                head_sha: headSha
              }
            ]
          }
        };
      }
      return undefined;
    });

    const client = new GitHubActivationClient(transport);
    await expect(verifyCommitCheckRun(client, 'owner/repo', headSha, 'verify', 'success')).rejects.toThrow(
      /cannot satisfy fail-closed verification/u
    );
  });

  it('does not qualify bare check conclusions without exact unmerged workflow and job bindings', async () => {
    const transport = new MockTransport();
    const headSha = 'e'.repeat(40);
    const redSha = 'f'.repeat(40);

    transport.on((req) => {
      if (req.method === 'GET' && req.path.includes(`/commits/${headSha}/check-runs`)) {
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [{ id: 701, name: 'verify', status: 'completed', conclusion: 'success', head_sha: headSha }]
          }
        };
      }
      if (req.method === 'GET' && req.path.includes(`/commits/${redSha}/check-runs`)) {
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [{
              id: 702,
              name: 'deliberate-red',
              status: 'completed',
              conclusion: 'failure',
              head_sha: redSha,
              output: { summary: 'Tests failed: assertion error in sample test' }
            }]
          }
        };
      }
      return undefined;
    });

    const client = new GitHubActivationClient(transport);
    await expect(qualifyRepositorySourceChecks({
      client,
      repository: 'owner/repo',
      headSha,
      contexts: ['verify'],
      deliberateRedFixture: {
        ref: 'refs/heads/fixture/deliberate-red',
        headSha: redSha,
        context: 'deliberate-red'
      }
    })).rejects.toThrow(/exact workflow source, actor, ref, run\/job\/check binding/);
  });

  it('rejects runner infrastructure errors as negative proof', async () => {
    const transport = new MockTransport();
    const redSha = '1'.repeat(40);

    transport.on((req) => {
      if (req.method === 'GET' && req.path.includes(`/commits/${redSha}/check-runs`)) {
        return {
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            check_runs: [{
              id: 703,
              name: 'broken-runner',
              status: 'completed',
              conclusion: 'failure',
              head_sha: redSha,
              output: { summary: 'Runner lost communication with GitHub' }
            }]
          }
        };
      }
      return undefined;
    });

    const client = new GitHubActivationClient(transport);
    await expect(verifyCommitCheckRun(client, 'owner/repo', redSha, 'broken-runner', 'failure')).rejects.toThrow(
      /failed due to infrastructure error/u
    );
  });
});

describe('Repository Main-Update Hold and Replacement', () => {
  const mainSha = 'a'.repeat(40);
  const ownedControls = ['liftoff-gitflow-develop', 'liftoff-gitflow-main', 'liftoff-gitflow-releases', 'liftoff-tags'];

  it('creates main-update hold bound to baseline and controls', () => {
    const hold = createMainUpdateHold({
      repository: 'owner/repo',
      mainSha,
      ownedControls,
      approvalEnvelopeId: 'approval-1'
    });

    expect(hold.boundMainSha).toBe(mainSha);
    expect(hold.status).toBe('active');
    expect(hold.ownedControlsDigest).toBe(canonicalSha256(ownedControls));
  });

  it('retains hold when main tip changes concurrently', () => {
    const hold = createMainUpdateHold({
      repository: 'owner/repo',
      mainSha,
      ownedControls,
      approvalEnvelopeId: 'approval-1'
    });

    const changedMain = '9'.repeat(40);
    const result = evaluateMainHoldReplacement({
      hold,
      currentMainSha: changedMain,
      currentOwnedControls: ownedControls,
      qualificationEvidence: [],
      replacementApproval: null
    });

    expect(result.canRelease).toBe(false);
    expect(result.holdRetained).toBe(true);
    expect(result.reasons.some((r) => r.includes('differs from the reviewed bound baseline'))).toBe(true);
  });

  it('retains hold when production qualification evidence is incomplete', () => {
    const hold = createMainUpdateHold({
      repository: 'owner/repo',
      mainSha,
      ownedControls,
      approvalEnvelopeId: 'approval-1'
    });

    // Evidence only contains repository-checks-qualified, NOT staging-qualified or green-red-proof
    const repoEvidence: PhaseEvidenceRecord[] = [{
      evidenceId: 'repo-checks-proof',
      header: {
        schemaVersion: 4,
        repositoryId: 'R_123',
        identity: {} as never,
        phaseGraphHash: 'hash',
        phaseId: 'repository-checks-qualified' as never,
        phaseContractDigest: 'digest',
        inputDigest: 'digest',
        baselineSha: mainSha,
        transition: {} as never,
        producedAt: '2026-09-15T00:00:00.000Z',
        producer: 'test',
        result: 'verified',
        bodyDigest: 'digest'
      },
      payload: { kind: 'repository-checks-qualified.v1' }
    }];

    const result = evaluateMainHoldReplacement({
      hold,
      currentMainSha: mainSha,
      currentOwnedControls: ownedControls,
      qualificationEvidence: repoEvidence,
      replacementApproval: null
    });

    expect(result.canRelease).toBe(false);
    expect(result.reasons.some((r) => r.includes('repository proof cannot satisfy production release'))).toBe(true);
  });

  it('retains the hold when supplied flags lack current proof contexts and an exact replacement plan', () => {
    const hold = createMainUpdateHold({
      repository: 'owner/repo',
      mainSha,
      ownedControls,
      approvalEnvelopeId: 'approval-1'
    });

    const fullEvidence: PhaseEvidenceRecord[] = [
      {
        evidenceId: 'staging-proof',
        header: {
          schemaVersion: 4,
          repositoryId: 'R_123',
          identity: {} as never,
          phaseGraphHash: 'hash',
          phaseId: 'staging-qualified',
          phaseContractDigest: 'digest',
          inputDigest: 'digest',
          baselineSha: mainSha,
          transition: {} as never,
          producedAt: '2026-09-15T00:00:00.000Z',
          producer: 'test',
          result: 'verified',
          bodyDigest: 'digest'
        },
        payload: { kind: 'staging-qualified.v1' }
      },
      {
        evidenceId: 'green-red-proof',
        header: {
          schemaVersion: 4,
          repositoryId: 'R_123',
          identity: {} as never,
          phaseGraphHash: 'hash',
          phaseId: 'green-red-proof',
          phaseContractDigest: 'digest',
          inputDigest: 'digest',
          baselineSha: mainSha,
          transition: {} as never,
          producedAt: '2026-09-15T00:00:00.000Z',
          producer: 'test',
          result: 'verified',
          bodyDigest: 'digest'
        },
        payload: { kind: 'green-red-proof.v1' }
      }
    ];

    const approval: ApprovalEnvelope = {
      schemaVersion: 4,
      id: 'prod-release-approval',
      phaseId: 'rulesets-applied',
      gateKind: 'production-rehearsal',
      identity: {} as never,
      baselineSha: mainSha,
      planDigest: 'planDigest',
      resources: [],
      destinations: [],
      permissions: [],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
      policyExceptions: [],
      destructiveScope: [],
      expiresAt: '2030-01-01T00:00:00.000Z',
      approvedAt: '2026-09-15T00:00:00.000Z',
      approver: 'owner'
    };

    const result = evaluateMainHoldReplacement({
      hold,
      currentMainSha: mainSha,
      currentOwnedControls: ownedControls,
      qualificationEvidence: fullEvidence,
      replacementApproval: approval
    });

    expect(result.canRelease).toBe(false);
    expect(result.holdRetained).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe('Repository Governance Producers Execution', () => {
  const dummyRunner: CommandRunner = {
    run: async () => ({ status: 0, stdout: '', stderr: '', executionTimeMs: 1 })
  };

  function createProducerMockInspection(testRoot: string, overrides: Partial<GovernanceTransitionInspection> = {}): GovernanceTransitionInspection {
    const state: UserActivationState = {
      schemaVersion: 4,
      identity: currentActivationIdentity,
      repository: { id: '12345', name: 'owner/repo', defaultBranch: 'develop' },
      activeChange: null,
      applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
      phases: {} as never,
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z'
    };

    return {
      projectRoot: testRoot,
      manifest: {
        version: 8,
        project: { name: 'test', specWorkflow: 'openspec' },
        projectArtifacts: []
      } as never,
      graph: { schemaVersion: 3, hash: 'hash', phases: [] } as never,
      graphHash: 'hash',
      scope: 'repository',
      state,
      approvals: [],
      evidence: [],
      contexts: new Proxy({}, {
        get: (_target, prop) => ({
          identity: state.identity,
          repositoryId: '12345',
          phaseId: String(prop) as never,
          phaseGraphHash: 'hash',
          phaseContractDigest: 'digest',
          baselineSha: 'sha',
          inputDigest: 'digest',
          transition: 'observed'
        })
      }) as never,
      readiness: { nextReadyPhase: null, phases: {} },
      sourceOfTruth: { status: 'none', createPlan: { status: 'ready' } } as never,
      ...overrides
    };
  }

  function createProducerMockPlan(phaseId: string): SavedTransitionPlan {
    return {
      schemaVersion: 2,
      scope: 'repository' as never,
      phaseId: phaseId as never,
      createdAt: '2026-09-15T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      identity: currentActivationIdentity,
      graphHash: 'hash',
      stateHash: 'stateHash',
      baselineDigest: 'baselineDigest',
      inputDigest: 'inputDigest',
      transitionDigest: 'transitionDigest',
      planDigest: 'planDigest',
      mutationClasses: { local: [], remote: [] },
      operations: [
        {
          phaseId: phaseId as never,
          adapter: 'github',
          actionId: phaseId === 'repository-discovered' ? 'github.repository.discover'
            : phaseId === 'repository-checks-qualified' ? 'github.checks.repository-qualified'
            : phaseId === 'repository-rulesets-applied' ? 'github.ruleset.apply'
            : 'github.operation',
          mutationClass: 'github-read',
          inputs: {},
          destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
          remote: true,
          destructive: false
        }
      ],
      approval: {
        gateKind: 'none',
        required: false,
        evaluation: {
          phaseId: phaseId as never,
          gateKind: 'none',
          questionKind: null,
          approvalRequired: false,
          status: 'not-required',
          envelopeId: null,
          envelopeHash: null,
          reasons: [],
          expansionReasons: []
        },
        envelopeId: 'envelope-1',
        envelopeHash: 'hash'
      },
      rollbackPlan: {
        phaseId: phaseId as never,
        strategy: 'none',
        target: null,
        operations: [],
        retained: [],
        cleanupWarnings: []
      },
      noSecrets: true
    };
  }

  it('executes repository discovery successfully when GitFlow branches exist', async () => {
    const transport = new MockTransport();
    const repoSha = '1'.repeat(40);
    const mainSha = '2'.repeat(40);

    transport.on((req) => {
      if (req.method === 'GET' && req.path === '/repos/owner/repo') {
        return {
          status: 200,
          headers: {},
          data: {
            id: 12345,
            name: 'repo',
            full_name: 'owner/repo',
            default_branch: 'develop',
            private: true,
            owner: { login: 'owner', type: 'Organization', id: 999 },
            permissions: { admin: true, push: true, pull: true },
            security_and_analysis: null
          }
        };
      }
      if (req.method === 'GET' && req.path.split('?')[0] === '/repos/owner/repo/branches') {
        return {
          status: 200,
          headers: {},
          data: [
            { name: 'develop', commit: { sha: repoSha }, protected: true },
            { name: 'main', commit: { sha: mainSha }, protected: true }
          ]
        };
      }
      if (req.method === 'GET' && req.path.startsWith('/repos/owner/repo/rulesets')) {
        return { status: 200, headers: {}, data: [] };
      }
      if (req.method === 'GET' && req.path.startsWith('/repos/owner/repo/actions/workflows')) {
        return { status: 200, headers: {}, data: { total_count: 0, workflows: [] } };
      }
      if (req.method === 'GET' && req.path === '/repos/owner/repo/actions/permissions') {
        return { status: 200, headers: {}, data: { enabled: true, allowed_actions: 'all' } };
      }
      if (req.method === 'GET' && req.path === '/repos/owner/repo/actions/permissions/workflow') {
        return { status: 200, headers: {}, data: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } };
      }
      if (req.method === 'GET' && req.path.includes('/check-runs')) {
        return { status: 200, headers: {}, data: { total_count: 0, check_runs: [] } };
      }
      if (req.method === 'GET' && req.path.endsWith('/protection')) {
        return { status: 404, headers: {}, data: { message: 'Branch not protected' } };
      }
      return undefined;
    });

    const testRoot = path.join(process.cwd(), 'tests', `.test-prod-discovery-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });

    try {
      const inspection = createProducerMockInspection(testRoot);
      inspection.state.remoteBinding = {
        id: '12345', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git',
        verifiedAt: '2026-09-15T00:00:00.000Z'
      };
      const executionInput: PhaseAdapterExecutionInput = {
        inspection,
        plan: createProducerMockPlan('repository-discovered'),
        phase: {
          id: 'repository-discovered' as never,
          label: 'Repository Discovered',
          dependencies: [],
          applicability: { kind: 'always' },
          allowedMutations: { local: [], remote: [] },
          evidence: { schema: 'schema', required: true, headerSchemaVersion: 4, liveReadbackProviders: ['github'] },
          approvalGate: { kind: 'none', required: false, envelopeSchemaVersion: 4 },
          rollback: { kind: 'none', target: null, description: 'none' }
        },
        runner: dummyRunner,
        adapters: {
          githubActivation: { transport }
        } as never,
        now: new Date('2026-09-15T00:00:00.000Z')
      };
      executionInput.plan.operations = (await planRepositoryDiscovery(executionInput)).operations;

      const outcome = await executeRepositoryDiscovery(executionInput);
      expect(outcome.status).toBe('completed');
      expect(outcome.resultState).toBe('verified');
      expect(outcome.evidencePayload).toBeDefined();

      const payload = outcome.evidencePayload as Record<string, unknown>;
      expect(payload.kind).toBe('repository-discovered.v1');
      expect(payload.facts).toBeDefined();
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it('blocks repository discovery if develop or main branch is missing', async () => {
    const transport = new MockTransport();

    transport.on((req) => {
      if (req.method === 'GET' && req.path === '/repos/owner/repo') {
        return {
          status: 200,
          headers: {},
          data: {
            id: 12345,
            name: 'repo',
            full_name: 'owner/repo',
            default_branch: 'main',
            private: true,
            owner: { login: 'owner', type: 'Organization', id: 999 },
            permissions: { admin: true, push: true, pull: true },
            security_and_analysis: null
          }
        };
      }
      if (req.method === 'GET' && req.path.split('?')[0] === '/repos/owner/repo/branches') {
        // Missing develop branch!
        return {
          status: 200,
          headers: {},
          data: [
            { name: 'main', commit: { sha: 'a'.repeat(40) }, protected: true }
          ]
        };
      }
      if (req.method === 'GET' && req.path.startsWith('/repos/owner/repo/rulesets')) {
        return { status: 200, headers: {}, data: [] };
      }
      if (req.method === 'GET' && req.path.startsWith('/repos/owner/repo/actions/workflows')) {
        return { status: 200, headers: {}, data: { total_count: 0, workflows: [] } };
      }
      if (req.method === 'GET' && req.path === '/repos/owner/repo/actions/permissions') {
        return { status: 200, headers: {}, data: { enabled: true, allowed_actions: 'all' } };
      }
      if (req.method === 'GET' && req.path === '/repos/owner/repo/actions/permissions/workflow') {
        return { status: 200, headers: {}, data: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } };
      }
      if (req.method === 'GET' && req.path.includes('/check-runs')) {
        return { status: 200, headers: {}, data: { total_count: 0, check_runs: [] } };
      }
      if (req.method === 'GET' && req.path.endsWith('/protection')) {
        return { status: 404, headers: {}, data: { message: 'Branch not protected' } };
      }
      return undefined;
    });

    const testRoot = path.join(process.cwd(), 'tests', `.test-prod-discovery-missing-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });

    try {
      const inspection = createProducerMockInspection(testRoot);
      inspection.state.remoteBinding = {
        id: '12345', name: 'owner/repo', defaultBranch: 'main', pushUrl: 'https://github.com/owner/repo.git',
        verifiedAt: '2026-09-15T00:00:00.000Z'
      };
      const executionInput: PhaseAdapterExecutionInput = {
        inspection,
        plan: createProducerMockPlan('repository-discovered'),
        phase: {
          id: 'repository-discovered' as never,
          label: 'Repository Discovered',
          dependencies: [],
          applicability: { kind: 'always' },
          allowedMutations: { local: [], remote: [] },
          evidence: { schema: 'schema', required: true, headerSchemaVersion: 4, liveReadbackProviders: ['github'] },
          approvalGate: { kind: 'none', required: false, envelopeSchemaVersion: 4 },
          rollback: { kind: 'none', target: null, description: 'none' }
        },
        runner: dummyRunner,
        adapters: {
          githubActivation: { transport }
        } as never,
        now: new Date('2026-09-15T00:00:00.000Z')
      };
      executionInput.plan.operations = (await planRepositoryDiscovery(executionInput)).operations;

      const outcome = await executeRepositoryDiscovery(executionInput);
      expect(outcome.status).toBe('blocked');
      expect(outcome.blocker).toContain('missing required GitFlow permanent branches');
      expect(outcome.blocker).toContain('develop');
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it('executes repository workflow source ready with readback verification', async () => {
    const protocol = new WorkflowGitHubFixture();
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'repository-workflow-source-ready')!;
    const fixture = await workflowOperationFixture(phase.id, async (inspection) => {
      const planned = await planRepositoryWorkflowSource({
        inspection, phase, runner: protocol.runner, now: new Date(workflowFixtureNow)
      });
      if (planned.blockers?.length) throw new Error(planned.blockers.join(' '));
      return planned.operations;
    }, protocol.runner, {
      files: [{ path: workflowFixturePath, content: workflowFixtureSource }],
      configuration: {
        schemaVersion: 1, repository: { name: 'owner/repo' },
        phases: { 'repository-workflow-source-ready': { sourceSha: protocol.baseSha, paths: [workflowFixturePath] } }
      }
    });

    try {
      const execute = () => withProjectMutationLock(fixture.projectRoot, (lease) =>
        executeRepositoryWorkflowSource({ ...fixture.input, lease }));
      const outcome = await execute();
      expect(outcome.status, outcome.blocker).toBe('completed');
      expect(outcome.resultState).toBe('verified');
      const payload = outcome.evidencePayload as Record<string, unknown>;
      expect(payload.sourceSha).toBe(protocol.baseSha);
      expect(payload.rulesetSourceDigest).toBeUndefined();
      expect(outcome.liveReadback?.length).toBeGreaterThan(0);
      const originalBlob = [...protocol.blobs].find(([, bytes]) => bytes.toString('utf8') === workflowFixtureSource);
      expect(originalBlob).toBeDefined();
      protocol.blobs.set(originalBlob![0], Buffer.from(`${workflowFixtureSource}\n# Corrupt provider bytes\n`));
      expect(await execute()).toMatchObject({ status: 'blocked', completedOperations: [] });
      expect(protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses repository ruleset writes when claimed check proof is not current and independently bound', async () => {
    const transport = new MockTransport();
    const rulesetStore: Array<Record<string, unknown>> = [];

    transport.on((req) => {
      const basePath = req.path.split('?')[0];
      if (req.method === 'GET' && req.path.match(/\/repos\/owner\/repo\/rulesets\/\d+/)) {
        const id = Number(req.path.split('/').pop());
        const found = rulesetStore.find((r) => r.id === id);
        return found ? { status: 200, headers: {}, data: found } : { status: 404, headers: {}, data: {} };
      }
      if (req.method === 'GET' && basePath === '/repos/owner/repo/rulesets') {
        return { status: 200, headers: {}, data: rulesetStore };
      }
      if (req.method === 'POST' && basePath === '/repos/owner/repo/rulesets') {
        const body = req.body as Record<string, unknown>;
        const id = rulesetStore.length + 1;
        const created = {
          id,
          node_id: `node-${id}`,
          name: body.name,
          target: body.target,
          enforcement: body.enforcement,
          source_type: 'Repository',
          source: 'owner/repo',
          conditions: body.conditions,
          bypass_actors: body.bypass_actors,
          rules: body.rules
        };
        rulesetStore.push(created);
        return { status: 201, headers: {}, data: created };
      }
      if (req.method === 'GET' && basePath === '/repos/owner/repo/git/ref/heads/main') {
        return {
          status: 200,
          headers: {},
          data: { object: { sha: 'a'.repeat(40) } }
        };
      }
      return undefined;
    });

    const testRoot = path.join(process.cwd(), 'tests', `.test-prod-rulesets-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });

    try {
      const checksEvidence: PhaseEvidenceRecord = {
        evidenceId: 'checks-evidence-1',
        header: {
          schemaVersion: 4,
          repositoryId: '12345',
          identity: currentActivationIdentity,
          phaseGraphHash: 'hash',
          phaseId: 'repository-checks-qualified' as never,
          phaseContractDigest: 'digest',
          inputDigest: 'digest',
          baselineSha: 'sha',
          transition: 'observed',
          producedAt: '2026-09-15T00:00:00.000Z',
          producer: 'test',
          result: 'verified',
          bodyDigest: 'digest'
        },
        payload: { kind: 'repository-checks-qualified.v1' }
      };

      const inspection = createProducerMockInspection(testRoot, {
        evidence: [checksEvidence]
      });
      const executionInput: PhaseAdapterExecutionInput = {
        inspection,
        plan: createProducerMockPlan('repository-rulesets-applied'),
        phase: {
          id: 'repository-rulesets-applied' as never,
          label: 'Repository Rulesets Applied',
          dependencies: [],
          applicability: { kind: 'always' },
          allowedMutations: { local: [], remote: [] },
          evidence: { schema: 'schema', required: true, headerSchemaVersion: 4, liveReadbackProviders: ['github'] },
          approvalGate: { kind: 'none', required: false, envelopeSchemaVersion: 4 },
          rollback: { kind: 'none', target: null, description: 'none' }
        },
        runner: dummyRunner,
        adapters: {
          githubActivation: { transport }
        } as never,
        now: new Date('2026-09-15T00:00:00.000Z')
      };

      const outcome = await executeRepositoryRulesets(executionInput);
      expect(outcome.status).toBe('blocked');
      expect(outcome.evidencePayload).toBeUndefined();
      expect(transport.requests.some((request) => request.method !== 'GET')).toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});

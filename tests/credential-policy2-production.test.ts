import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { runnerPreflightProviderReadDisclosure } from '../src/domain/governance/activation/types.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { applyProjectFileTransaction } from '../src/adapters/filesystem/project-transaction.js';
import type { GitHubActivationTransport } from '../src/adapters/github/activation-rest.js';
import {
  planProductionCredentialReadiness, executeProductionCredentialChallenge, verifyProductionCredentialReadiness
} from '../src/adapters/credentials/production-credentials.js';
import {
  createCredentialPolicyTransactionGuard, parseCredentialPolicyBytes, planCredentialPolicyTransaction, readbackCredentialPolicy
} from '../src/adapters/credentials/credential-policy-transaction.js';
import { credentialUsageWorkflowPath } from '../src/adapters/credentials/credential-usage-challenge.js';
import { credentialPolicyPathParts } from '../src/governance-activation/credentials.js';
import { saveTransitionPlan } from '../src/governance-activation/transition-records.js';
import {
  credentialFixture, fixtureExistingAppTarget, approveCredentialOperations
} from './helpers/credential-fixture.js';
import { credentialZip, publicUsageReport, usageChallenge, usageProvider } from './helpers/credential-usage-fixture.js';

const fixtures: Awaited<ReturnType<typeof credentialFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function journey(pendingFirst = false) {
  const { runId: _runId, ...selection } = usageChallenge;
  const f = await credentialFixture({
    mode: 'challenge', credential: fixtureExistingAppTarget.configuration, principal: fixtureExistingAppTarget.principal,
    source: fixtureExistingAppTarget.source, protectedReference: fixtureExistingAppTarget.protectedReference,
    custodyVersion: null, challenge: selection
  });
  fixtures.push(f);
  f.provider.setSecret({
    name: 'RUNNER_CONFIGURATION_READ_TOKEN', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z'
  });
  const usage = usageProvider();
  if (pendingFirst) {
    usage.run.status = 'in_progress';
    usage.run.conclusion = null;
  }
  const mutations: string[] = [];
  const transport: GitHubActivationTransport = {
    async request(request) {
      const route = request.path.split('?')[0]!;
      if (request.method === 'POST') {
        expect(route).toBe('/repos/owner/repo/actions/workflows/81/dispatches');
        if (!isRecord(request.body) || !isRecord(request.body.inputs) ||
            typeof request.body.inputs.liftoff_operation_id !== 'string') throw new Error('Missing actual dispatch correlation.');
        expect(request.body.ref).toBe('develop');
        expect(request.body.inputs.challenge).toBe(usageChallenge.challengeId);
        mutations.push(route);
        const correlation = request.body.inputs.liftoff_operation_id;
        usage.run.display_title = `liftoff-${correlation}`;
        const report = publicUsageReport();
        report.correlationId = correlation;
        usage.setArchive(credentialZip(Buffer.from(`${JSON.stringify(report)}\n`)));
        f.now.setTime(Date.parse('2026-09-15T00:00:30.000Z'));
        return {
          status: 200, headers: { 'x-github-request-id': 'ABCD:1234:9999' },
          data: {
            workflow_run_id: 82, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/82',
            html_url: 'https://github.com/owner/repo/actions/runs/82'
          }
        };
      }
      if (request.method !== 'GET') throw new Error('Unreviewed fixture mutation.');
      if (route === '/repos/owner/repo/git/ref/heads/develop') {
        return { status: 200, headers: {}, data: { ref: 'refs/heads/develop', object: { type: 'commit', sha: usageChallenge.sourceSha } } };
      }
      if (route === '/repos/owner/repo/actions/workflows/81') {
        return { status: 200, headers: {}, data: { id: 81, path: credentialUsageWorkflowPath, state: 'active' } };
      }
      if (route.startsWith('/repos/owner/repo/contents/') || route.startsWith('/repos/owner/repo/actions/runs/') ||
          route.startsWith('/repos/owner/repo/actions/artifacts/') || route === '/repos/owner/repo/check-runs/84') {
        return usage.transport.request(request);
      }
      return f.provider.transport.request(request);
    }
  };
  const phase = f.inspection.graph.phases.find((entry) => entry.id === 'credential-ready')!;
  const adapters = { githubActivation: { transport, storage: f.storage } };
  const planning = () => ({ inspection: f.inspection, phase, runner: f.runner, now: f.now, adapters });
  const challenge = await planProductionCredentialReadiness(planning());
  expect(challenge.blockers).toEqual([]);
  expect(challenge.operations).toHaveLength(1);
  const issued = await approveCredentialOperations(f, challenge.operations);
  let input = { ...issued, adapters };
  await saveTransitionPlan(f.projectRoot, input.plan);
  let result = await withProjectMutationLock(f.projectRoot, (lease) =>
    executeProductionCredentialChallenge({ ...input, lease }));
  if (pendingFirst) {
    expect(result.status, JSON.stringify(result)).toBe('pending');
    if (result.status !== 'pending' || !result.operation) throw new Error('Expected the actual running operation.');
    expect(mutations).toHaveLength(1);
    f.inspection.state.phases['credential-ready'].operation = result.operation;
    const originalApprovals = input.inspection.approvals;
    const recovered = await approveCredentialOperations(f, challenge.operations, { recovery: true });
    input = {
      ...recovered, adapters,
      inspection: { ...recovered.inspection, approvals: [...originalApprovals, ...recovered.inspection.approvals] }
    };
    usage.run.status = 'completed';
    usage.run.conclusion = 'success';
    await saveTransitionPlan(f.projectRoot, input.plan);
    result = await withProjectMutationLock(f.projectRoot, (lease) =>
      executeProductionCredentialChallenge({ ...input, lease }));
  }
  expect(result.status, JSON.stringify(result)).toBe('review-required');
  if (result.status !== 'review-required') throw new Error('Expected original-custody usage completion.');
  expect(result.operation.status).toBe('completed');
  expect(mutations).toHaveLength(1);
  const phaseInputs = result.review.payload.nextPhaseInputs;
  if (!isRecord(phaseInputs)) throw new Error('Missing exact next-stage inputs.');
  const configuration = { schemaVersion: 1 as const, phases: { 'credential-ready': phaseInputs } };
  f.inspection.activationInputs = configuration;
  f.inspection.state.activationInputs = configuration;
  f.inspection.state.phases['credential-ready'].operation = result.operation;
  f.inspection.approvals = input.inspection.approvals;
  const finalization = await planProductionCredentialReadiness(planning());
  expect(finalization.blockers, JSON.stringify(finalization)).toBeUndefined();
  expect(finalization.operations.map((operation) => operation.actionId)).toEqual([
    'github.credential.verify-policy', 'local.credential-policy.write'
  ]);
  const mutation = finalization.fileMutations?.[0];
  if (!mutation || mutation.type !== 'write') throw new Error('Missing exact proposed policy bytes.');
  const policy = parseCredentialPolicyBytes(Buffer.from(mutation.content));
  expect(policy).toMatchObject({
    schemaVersion: 2, identity: { policyVersion: '8', credentialPolicySchemaVersion: 2 },
    providerReadDisclosure: runnerPreflightProviderReadDisclosure,
    providerPermissions: fixtureExistingAppTarget.metadata.observedPermissions
  });
  const transaction = (await planCredentialPolicyTransaction(f.projectRoot, policy, { storage: f.storage })).plan;
  expect(canonicalSha256(finalization.operations[1]!.inputs.policyTransaction)).toBe(canonicalSha256(transaction));
  const finalInput = {
    ...await approveCredentialOperations(f, finalization.operations, {
      fileChanges: [{
        pathParts: credentialPolicyPathParts, beforeHash: null, afterHash: transaction.afterHash
      }]
    }),
    adapters
  };
  return { f, input, finalInput, finalization, policy, result, mutations, transaction };
}

describe('schema-2 credential production wiring with bounded provider fixtures', () => {
  it.each([false, true])('uses original custody and separate finalization approval without redispatch (pending first: %s)', async (pendingFirst) => {
    const j = await journey(pendingFirst);
    expect(j.finalInput.plan.approval.envelopeId).not.toBe(j.input.plan.approval.envelopeId);
    await withProjectMutationLock(j.f.projectRoot, async (lease) => {
      const execution = { ...j.finalInput, lease };
      const outcome = await verifyProductionCredentialReadiness(execution);
      expect(outcome.status, JSON.stringify(outcome)).toBe('completed');
      if (outcome.status !== 'completed' || !outcome.fileMutations) throw new Error('Expected verified staged policy.');
      await applyProjectFileTransaction(j.f.projectRoot, outcome.fileMutations, {
        preconditions: outcome.filePreconditions,
        onBeforeMutation: createCredentialPolicyTransactionGuard(execution, j.finalization.operations[1]!, j.transaction, j.f.storage)
      });
      expect(await readbackCredentialPolicy(j.f.projectRoot, j.transaction)).toEqual(j.policy);
    });
    expect(j.mutations).toHaveLength(1);
  });

  it('refuses old-stage approval and changed secret observations without another dispatch or policy write', async () => {
    const j = await journey();
    const stale = await withProjectMutationLock(j.f.projectRoot, (lease) =>
      verifyProductionCredentialReadiness({
        ...j.finalInput, lease, inspection: { ...j.finalInput.inspection, approvals: j.input.inspection.approvals }
      }));
    expect(stale.status).toBe('blocked');
    j.f.provider.setSecret({
      name: 'RUNNER_CONFIGURATION_READ_TOKEN', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-15T00:00:25Z'
    });
    const changed = await withProjectMutationLock(j.f.projectRoot, (lease) =>
      verifyProductionCredentialReadiness({ ...j.finalInput, lease }));
    expect(changed).toMatchObject({ status: 'blocked', blocker: expect.stringMatching(/Secret metadata changed/) });
    expect(j.mutations).toHaveLength(1);
    await expect(readFile(path.join(j.f.projectRoot, ...credentialPolicyPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it as registerTest, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import type { RepositoryControlBinding } from '../src/adapters/github/repository-control-observation.js';
import * as stagingReceipts from '../src/application/azure-activation/staging-qualification-receipt.js';
import * as rehearsalReceipts from '../src/application/azure-activation/rehearsal-qualification-receipt.js';
import { AzureActivationAdmissionError } from '../src/application/azure-activation/authority.js';
import {
  enforcementProductionPredecessorVerifier, readEnforcementProductionPredecessors
} from '../src/application/repository-governance/repository-control-predecessors.js';
import { workflowOperationFixture } from './helpers/workflow-operation-fixture.js';
import { WorkflowGitHubFixture } from './helpers/workflow-publication-fixture.js';

let activeBodies = 0;
const cleanup: Array<() => Promise<void>> = [];
function it(name: string, body: () => Promise<void>) {
  registerTest(name, async () => {
    activeBodies++;
    try { await body(); } finally { activeBodies--; }
  });
}
afterEach(async () => {
  if (activeBodies) throw new Error('Preserving semantic-reader fixture while test work remains unsettled.');
  while (cleanup.length) {
    await cleanup[0]!();
    cleanup.shift();
  }
});

async function fixture() {
  const request = {
    sourceSha: 'b'.repeat(40), artifactDigest: `sha256:${'d'.repeat(64)}`,
    staging: { evidenceId: 'not-produced-staging', headerDigest: 'a'.repeat(64), bodyDigest: 'b'.repeat(64) },
    rehearsal: { evidenceId: 'not-produced-rehearsal', headerDigest: 'c'.repeat(64), bodyDigest: 'd'.repeat(64) }
  };
  const operation: TransitionOperation = {
    phaseId: 'rulesets-applied', adapter: 'github', actionId: 'github.ruleset.readback',
    mutationClass: 'github-read', remote: true, destructive: false,
    destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
    inputs: { repository: 'owner/repo', qualificationReferences: [
      { phaseId: 'staging-qualified', reference: request.staging },
      { phaseId: 'production-rehearsed', reference: request.rehearsal }
    ] }
  };
  const protocol = new WorkflowGitHubFixture();
  const f = await workflowOperationFixture('rulesets-applied', [operation], protocol.runner);
  const identity = await lstat(f.root), resolved = await realpath(f.root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || path.dirname(resolved) !== await realpath(path.resolve('tests'))) {
    throw new Error('The semantic-reader fixture is not its exact owned directory.');
  }
  cleanup.push(async () => {
    const current = await lstat(f.root);
    if (!current.isDirectory() || current.isSymbolicLink() || await realpath(f.root) !== resolved ||
      current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeMs !== identity.birthtimeMs ||
      current.uid !== identity.uid) throw new Error('Preserving semantic-reader fixture with changed creation identity.');
    await rm(resolved, { recursive: true });
  });
  f.input.adapters.githubActivation!.transport = protocol;
  const binding: RepositoryControlBinding = {
    repository: 'owner/repo', repositoryId: 42, repositoryNodeId: 'R_42', ownerId: 9,
    actor: { id: 7, login: 'owner', type: 'User' }, actionsApp: { id: 15368, slug: 'github-actions', ownerId: 9919 }
  };
  const read = (requested = request) => withProjectMutationLock(f.projectRoot, (lease) =>
    readEnforcementProductionPredecessors(f.input, { execution: { ...f.input, lease }, operation }, binding, requested));
  return { ...f, operation, request, protocol, binding, read };
}

describe('current enforcement semantic predecessor admission', () => {
  it('uses actual closed readers and refuses absent original native evidence despite fresh current read approval', async () => {
    const f = await fixture();
    await expect(f.read()).rejects.toThrow(/original activation receipt/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('rejects a different source receipt before reaching a semantic reader', async () => {
    const f = await fixture();
    await expect(f.read({ ...f.request, staging: { ...f.request.staging, bodyDigest: 'e'.repeat(64) } }))
      .rejects.toThrow(/exact original reference/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('requires actual current execution authority and lease, not the original producer grant or planning metadata', async () => {
    const f = await fixture();
    await expect(readEnforcementProductionPredecessors(f.input, undefined, f.binding, f.request))
      .rejects.toThrow(/actual current project\/scope\/phase/u);
    await expect(readEnforcementProductionPredecessors(f.input, { execution: f.input, operation: f.operation }, f.binding, f.request))
      .rejects.toThrow(/project mutation lease/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('rejects current read expiry rather than replaying a caller-supplied earlier clock', async () => {
    const f = await fixture();
    const earlier = new Date(f.input.now);
    f.input.now.setTime(Date.parse(f.input.plan.expiresAt));
    await expect(withProjectMutationLock(f.projectRoot, async (lease) =>
      enforcementProductionPredecessorVerifier(f.input, { execution: { ...f.input, lease }, operation: f.operation }, f.binding)({
        ...f.request, now: earlier
      }))).rejects.toThrow(/expired/u);
    expect(f.protocol.requests).toEqual([]);
  });

  it('routes the exact original reference through current GET-only authority without a fake green-red dispatch', async () => {
    const f = await fixture();
    const planBefore = canonicalSha256(f.input.plan);
    const rehearsal = vi.spyOn(rehearsalReceipts, 'readVerifiedRehearsalQualification');
    const stage = vi.spyOn(stagingReceipts, 'readVerifiedStagingQualification').mockImplementation(async (input, client, reference) => {
      expect(input.inspection).toBe(f.input.inspection);
      expect(input.phase).toBe(f.input.phase);
      expect(input.now).toEqual(f.input.now);
      expect(reference).toEqual(f.request.staging);
      expect(input).not.toHaveProperty('plan');
      await expect(client.transport.request({ method: 'POST', path: '/repos/owner/repo/actions/workflows/4/dispatches' }))
        .rejects.toThrow(/same-repository GitHub GET only/u);
      await expect(client.get('/repos/other/repository')).rejects.toThrow(/same-repository GitHub GET only/u);
      await client.get('/repos/owner/repo');
      throw new AzureActivationAdmissionError('isolated-semantic-reader-refusal', 'No native predecessor was supplied by this routing fixture.');
    });
    try {
      await expect(withProjectMutationLock(f.projectRoot, async (lease) =>
        enforcementProductionPredecessorVerifier(f.input, { execution: { ...f.input, lease }, operation: f.operation }, f.binding)(f.request)))
        .rejects.toThrow(/No native predecessor was supplied/u);
      expect(stage).toHaveBeenCalledOnce();
      expect(rehearsal).not.toHaveBeenCalled();
      expect(f.protocol.requests).toEqual([expect.objectContaining({ method: 'GET', path: '/repos/owner/repo' })]);
      expect(canonicalSha256(f.input.plan)).toBe(planBefore);
    } finally {
      stage.mockRestore();
      rehearsal.mockRestore();
    }
  });
});

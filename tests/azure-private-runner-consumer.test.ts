import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executePrivateRunner, planPrivateRunner, readPrivateRunnerAssignmentForConsumer,
  type PrivateRunnerAssignmentCustodyReference
} from '../src/application/azure-activation/producer-runner.js';
import { validatePrivateRunnerAssignment } from '../src/application/azure-activation/private-runner-assignment-binding.js';
import { assertAzurePhaseAuthority } from '../src/application/azure-activation/authority.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import type { PhasePlanningInput } from '../src/governance-activation/transition-ports.js';
import { privateActivationFixture } from './helpers/private-activation-fixture.js';
import { bootstrapRunnerOutputs, privateRunnerHttpFixture, runnerSource } from './helpers/private-runner-http-fixture.js';

const fixtures: Awaited<ReturnType<typeof privateActivationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function fixture() {
  const source = runnerSource();
  const f = await privateActivationFixture('runner-ready', {
    organizationId: 7, actorId: 9, networkConfigurationName: 'repo-private-network',
    runnerGroupName: source.recipe.runnerGroupName, runnerName: source.recipe.runnerLabel,
    imageId: 'ubuntu-24.04', machineSize: '4-core', maxRunners: 2, source, expiresAt: '2026-09-15T00:30:00.000Z'
  });
  fixtures.push(f);
  f.inspection.state.phases['bootstrap-local'].state = 'verified';
  f.inspection.state.phaseOutputs = { 'bootstrap-local': bootstrapRunnerOutputs() };
  const execution = await f.execution(planPrivateRunner(f.planning()));
  const http = privateRunnerHttpFixture(source);
  const created = await withProjectMutationLock(f.projectRoot, (lease) =>
    executePrivateRunner({ ...execution, lease }, { client: http.client }));
  if (created.status !== 'completed' || !isRecord(created.evidencePayload) || !isRecord(created.evidencePayload.assignment)) {
    throw new Error('The isolated real runner producer did not establish its actual assignment.');
  }
  const expected: PrivateRunnerAssignmentCustodyReference = {
    binding: validatePrivateRunnerAssignment(created.evidencePayload.assignment.binding),
    reference: {
      evidenceId: 'unretained-original-receipt', headerDigest: canonicalSha256('absent-header'),
      bodyDigest: canonicalSha256('absent-body')
    }
  };
  const planning: PhasePlanningInput = { ...f.planning(), adapters: execution.adapters };
  return { f, execution, http, expected, planning };
}

describe('planning-input private runner consumer boundary', () => {
  it('accepts planning input directly but refuses absent original custody before any current provider read', async () => {
    const f = await fixture();
    const calls = f.http.calls.length;
    expect(f.planning).not.toHaveProperty('plan');
    expect(f.planning).not.toHaveProperty('lease');
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) =>
      readPrivateRunnerAssignmentForConsumer(f.planning, f.http.client, f.expected, {
        authorize: () => assertAzurePhaseAuthority({ ...f.execution, lease }, f.execution.plan.operations[0]!)
      }))).rejects.toThrow('explicitly referenced original activation receipt');
    expect(f.http.calls).toHaveLength(calls);
    expect(f.f.calls).toEqual([]);
  });

  it('cannot observe controls without the actual current project lease even with a supplied authorization callback', async () => {
    const f = await fixture();
    const calls = f.http.calls.length;
    const authorize = vi.fn(async () => {});
    await expect(readPrivateRunnerAssignmentForConsumer(f.planning, f.http.client, f.expected, { authorize }))
      .rejects.toThrow('actual current project lease');
    expect(authorize).not.toHaveBeenCalled();
    expect(f.http.calls).toHaveLength(calls);
  });

  it('refuses a selected GitHub store without explicit original private metadata storage instead of trying the user home', async () => {
    const f = await fixture();
    const planning: PhasePlanningInput = {
      ...f.planning, adapters: { githubActivation: { storage: f.f.storage } }
    };
    const calls = f.http.calls.length;
    await expect(withProjectMutationLock(f.f.projectRoot, (lease) =>
      readPrivateRunnerAssignmentForConsumer(planning, f.http.client, f.expected, {
        authorize: () => assertAzurePhaseAuthority({ ...f.execution, lease }, f.execution.plan.operations[0]!)
      }))).rejects.toThrow('no default-home fallback');
    expect(f.http.calls).toHaveLength(calls);
    expect(f.f.calls).toEqual([]);
  });
});

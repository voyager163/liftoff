import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type { ApplicationPrivateAuthority } from './application-private-contracts.js';
import { applicationPrivateAssert as must } from './application-private-contracts.js';
import type { DisposableQualificationAuthority } from './qualification-authority.js';
import { requireDisposableQualificationAuthority } from './qualification-authority.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import { GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import { clientFor } from '../../governance-activation/github-config.js';
import { defaultAzureArmTransport } from './application-artifact-inputs.js';
import { applicationUuid } from '../../adapters/azure/application-provisioning.js';
import { assertAzurePhaseAuthority } from './authority.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import { applicationStagingInputs, stagingDevReadOperation, stagingTargetReadOperation } from './application-staging-inputs.js';
import { planApplicationPrivateResources } from './application-private-planning.js';
import { requireQualificationEvidence } from './qualification-evidence.js';
import { readEnvironmentRuntimeReceipt } from './environment-runtime-receipt.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';

export interface ApplicationStagingPrivateAuthority extends ApplicationPrivateAuthority {
  protocol: 'private-application-staging/1';
  disposable: DisposableQualificationAuthority;
  additionalOperations: readonly TransitionOperation[];
}

const issued = new WeakMap<ApplicationStagingPrivateAuthority, string>();

export async function createStagingPrivateAuthority(input: PhaseAdapterExecutionInput): Promise<ApplicationStagingPrivateAuthority> {
  const config = applicationStagingInputs(input);
  must(config.qualification.stage === 'deploy', 'staging-authority-phase');
  const build = await planApplicationPrivateResources(input);
  must(!build.blockers?.length && build.operations.length > 0, 'staging-private-plan-required');
  const additionalOperations = [stagingDevReadOperation(input, config), stagingTargetReadOperation(input, config)];
  const operations = [...build.operations, ...additionalOperations];
  const digest = canonicalSha256(config);
  const check = async () => {
    const held = await currentProjectMutationLease(input.inspection.projectRoot);
    must(held && input.lease, 'staging-real-project-lease');
    await held.assertHeld();
    must(canonicalSha256(applicationStagingInputs({ ...input, now: input.clock?.() ?? input.now })) === digest &&
      canonicalSha256(input.plan.operations.filter((entry) => entry.remote)) === canonicalSha256(operations),
    'staging-exact-issued-operations');
    for (const operation of operations) {
      if (operation.adapter === 'github') await assertGitHubPhaseAuthority(input, operation);
      else await assertAzurePhaseAuthority(input, operation);
    }
    await requireDisposableQualificationAuthority(input, 'staging', build.operations[0]!);
  };
  await check();
  const disposable = await requireDisposableQualificationAuthority(input, 'staging', build.operations[0]!);
  const base = clientFor(input);
  const client = new GitHubActivationClient({ async request(request) {
    must(request.method === 'GET', 'staging-dev-receipt-read-only');
    await check();
    return base.transport.request(request);
  } });
  must((await client.get('/user')).id === disposable.actor.githubActorId, 'staging-exact-github-reader');
  const { record } = requireQualificationEvidence(input.inspection, 'dev-proof', config.qualification.dev, input.clock?.() ?? input.now);
  must(isRecord(record.payload) && isRecord(record.payload.runtimeObservation) &&
    isRecord(record.payload.runtimeObservation.workflow), 'staging-dev-runtime-source');
  const workflow = record.payload.runtimeObservation.workflow;
  must(typeof workflow.producerSourceSha === 'string' && typeof workflow.sourceSha === 'string' &&
    typeof record.payload.artifactDigest === 'string', 'staging-dev-runtime-source');
  await readEnvironmentRuntimeReceipt(input, client, {
    phaseId: 'dev-proof', reference: config.qualification.dev,
    verifierSource: { producerSourceSha: workflow.producerSourceSha, executionSourceSha: workflow.sourceSha },
    artifactDigest: record.payload.artifactDigest
  });
  await check();
  const response = await defaultAzureArmTransport(input).request({
    method: 'GET', resourceId: disposable.target.resourceId, apiVersion: '2023-05-01'
  }, config.privateExecution.binding);
  applicationUuid(response.requestId, 'Actual staging target pre-read');
  must(response.status === 200 && isRecord(response.data) && response.data.id === disposable.target.resourceId ||
    response.status === 404 && isRecord(response.data) && isRecord(response.data.error) &&
      ['ResourceNotFound', 'ResourceGroupNotFound'].includes(String(response.data.error.code)), 'staging-target-readback');
  const authority: ApplicationStagingPrivateAuthority = Object.freeze({
    protocol: 'private-application-staging/1', input, operation: build.operations[0]!, operations, additionalOperations,
    disposable, assertCurrent: check, assertRelease: check
  });
  issued.set(authority, canonicalSha256({ disposable: authority.disposable, additionalOperations: authority.additionalOperations,
    plan: authority.input.plan }));
  return authority;
}

export async function assertIssuedStagingAuthority(authority: ApplicationStagingPrivateAuthority): Promise<void> {
  must(issued.get(authority) === canonicalSha256({ disposable: authority.disposable,
    additionalOperations: authority.additionalOperations, plan: authority.input.plan }), 'staging-issued-authority-required');
  await authority.assertCurrent();
}

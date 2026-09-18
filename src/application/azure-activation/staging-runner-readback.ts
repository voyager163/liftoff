import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { ExternalOperationState } from '../../domain/governance/activation/types.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import { qualificationFailure } from './qualification-authority.js';
import { requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
import type { PublishedStagingSecurityWorkflowRecipe } from './staging-security-workflow.js';
import { stagingSecurityWorkflowBinding } from './staging-security-artifact.js';
import { validatePrivateRunnerAssignment, verifyPrivateRunnerAssignment } from './private-runner-assignment.js';

/** Creation/assignment admission does not substitute for the actual same-job private DAST observations. */
export async function readStagingRunnerAssignment(
  input: PhasePlanningInput, client: GitHubActivationClient, recipe: PublishedStagingSecurityWorkflowRecipe,
  reference: QualificationEvidenceReference, authorize: () => Promise<void>, run?: ExternalOperationState
) {
  const { record } = requireQualificationEvidence(input.inspection, 'runner-ready', reference, input.now);
  const payload = record.payload;
  if (!isRecord(payload) || payload.kind !== 'runner-ready.v1' ||
    !['network-reachability-only', 'workflow-assignment-only'].includes(String(payload.scope)) ||
    !isRecord(payload.assignment)) {
    qualificationFailure('staging-runner-source', 'The original created or separately reconciled dedicated runner receipt is required; a name, numeric ID or online flag is not admission.');
  }
  const binding = validatePrivateRunnerAssignment(payload.assignment.binding);
  if (binding.repository !== recipe.repository || binding.repositoryId !== recipe.repositoryId ||
    binding.groupId !== recipe.runner.runnerGroupId || binding.runnerGroupName !== recipe.runner.group ||
    binding.runnerName !== recipe.runner.label) {
    qualificationFailure('staging-runner-binding', 'The security source routing differs from the original exact dedicated assignment.');
  }
  const workflow = stagingSecurityWorkflowBinding(recipe);
  return verifyPrivateRunnerAssignment(client, binding, {
    authorize, now: () => input.now,
    sources: [{
      schemaVersion: 1, kind: 'staging-security', repository: recipe.repository, repositoryId: recipe.repositoryId,
      workflowId: recipe.workflowId, workflowDigest: workflow.workflowDigest, sourceSha: recipe.sourceSha,
      ref: recipe.ref, actorId: recipe.actorId,
      recipe: { ...recipe, workflowId: null, sourceSha: null, runner: { group: recipe.runner.group, label: recipe.runner.label } }
    }],
    ...(run ? { run: { workflow, operation: run } } : {})
  });
}

import { canonicalJson, canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { openSource5WorkflowJournal } from '../../src/governance-activation/workflow-source5-journal.js';
import { source5WorkflowOriginalPlanValue } from '../../src/governance-activation/workflow-source5-context.js';
import { issueSource5WorkflowApproval } from '../../src/governance-activation/workflow-source5-authority.js';
import type { ProjectMutationLease } from '../../src/adapters/filesystem/project-lock.js';
import { workflowSource5JournalFixture } from './workflow-source5-journal.js';

/** Isolated record-format provenance, never a real provider or workflow qualification. */
export async function workflowSource5FinalizationFixture(
  value: Awaited<ReturnType<typeof workflowSource5JournalFixture>>, lease: ProjectMutationLease, remaining = false
) {
  const seal = async (review: ReturnType<typeof value.review>) => {
    await value.store.save('plan', review.control.controlKey,
      source5WorkflowOriginalPlanValue(value.projectRoot, review.plan, review.approval), null);
    await issueSource5WorkflowApproval({ ...review, lease }, review.now);
    return review;
  };
  await seal(value);
  const sourceJournal = await openSource5WorkflowJournal({ ...value, lease, initialize: true });
  const base = { bindingDigest: canonicalSha256(value.binding), planDigest: value.plan.planDigest };
  const commitSha = 'c'.repeat(40), treeSha = 'b'.repeat(40);
  await sourceJournal.record(value.operation, 'publication-writing', { ...base, stage: 'writing' });
  await sourceJournal.record(value.operation, 'publication-commit-intent', base);
  await sourceJournal.record(value.operation, 'publication-commit-observed', { ...base, commitSha });
  await sourceJournal.record(value.operation, 'publication-committed', { ...base, stage: 'committed', commitSha });
  await sourceJournal.record(value.operation, 'publication-published', { ...base, stage: 'published', commitSha });
  const observed = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
    ref: value.binding.ref, parentSha: value.binding.parentSha, commitSha, treeSha,
    files: value.binding.files.map(({ path, digest }) => ({ path, digest })) };
  const publication = { kind: 'workflow-source-publication.v1', ...observed, bindingDigest: base.bindingDigest,
    observedAt: value.now.toISOString(), observationDigest: canonicalSha256(observed) };
  await sourceJournal.record(value.operation, 'component-completed', { ...base, proof: publication });
  const origin = { planKey: value.control.controlKey, proofKey: sourceJournal.proofKey(value.operation),
    publicationDigest: canonicalSha256(publication), commitSha, treeSha };
  const binding = { repository: value.binding.repository, repositoryId: value.binding.repositoryId,
    sourceSha: commitSha, treeSha, executionRef: `liftoff-execution-${commitSha}` };
  const runner = { repository: binding.repository, repositoryId: binding.repositoryId, groupId: 17,
    groupName: 'isolated-format-fixture', networkConfigurationId: 'isolated-format-network',
    beforeWorkflows: [], afterWorkflows: [`${binding.repository}/${value.binding.files[0]!.path}@refs/tags/${binding.executionRef}`] };
  const effects = [
    { action: 'github.workflow-source.bind-execution-ref', binding },
    { action: 'github.workflow-source.admit-reviewed', binding: runner }
  ] as const;
  const prior = await seal(value.review({ phaseId: value.control.phaseId, origin, effects }));
  if (remaining) await openSource5WorkflowJournal({ ...prior, lease, initialize: true });
  const reviewed = remaining ? await seal(value.review({ phaseId: value.control.phaseId, origin, effects,
    remainingFrom: { planKey: prior.control.controlKey, operationDigests: prior.plan.operations.slice(0, 2).map(canonicalSha256) }
  })) : prior;
  const journal = await openSource5WorkflowJournal({ ...reviewed, lease, initialize: true });
  const execution = { kind: 'immutable-workflow-execution-ref.v1', binding, protectingRulesetIds: [23],
    barrierDigest: canonicalSha256('format-only-barrier'), providerAdmissionDigest: canonicalSha256('format-only-admission'),
    observationDigest: canonicalSha256('format-only-observation') };
  const runnerProof = { bindingDigest: canonicalSha256(runner), observationDigest: canonicalSha256({
    repositoryId: runner.repositoryId, groupId: runner.groupId, networkConfigurationId: runner.networkConfigurationId,
    selectedWorkflows: [...runner.afterWorkflows].sort() }) };
  await journal.record(reviewed.plan.operations[0]!, 'component-completed', {
    bindingDigest: canonicalSha256(binding), planDigest: reviewed.plan.planDigest, proof: execution
  });
  await journal.record(reviewed.plan.operations[1]!, 'component-completed', {
    bindingDigest: canonicalSha256(runner), planDigest: reviewed.plan.planDigest, proof: runnerProof
  });
  const phase = value.context.records.graph.phases.find(phase => phase.id === reviewed.plan.phaseId)!;
  const records = { plans: [value.plan, reviewed.plan], approvals: [value.approval, reviewed.approval], evidence: [] };
  const evidence = value.context.records.createEvidence({
    plan: reviewed.plan, evidenceId: `source5-${reviewed.control.controlKey}`, repositoryId: value.repositoryAnchor,
    producedAt: reviewed.now.toISOString(), producer: 'record-format-only-fixture', result: 'verified',
    payload: { kind: `${reviewed.plan.phaseId}.v2`, publication, executionAdmission: execution, runnerAdmission: runnerProof,
      ...(reviewed.plan.phaseId === 'workflow-source-ready' ? {
        rulesetSourceDigest: canonicalSha256({ kind: 'isolated-record-format-only-ruleset-source', files: observed.files })
      } : {}) },
    liveReadback: phase.evidence.liveReadbackProviders.map(provider => ({
      schemaVersion: 4, identity: reviewed.plan.identity, phaseGraphHash: reviewed.plan.graphHash,
      repositoryId: value.repositoryAnchor, phaseId: reviewed.plan.phaseId, baselineSha: reviewed.plan.baselineDigest,
      inputDigest: reviewed.plan.inputDigest, transition: { phaseId: reviewed.plan.phaseId,
        baselineSha: reviewed.plan.baselineDigest, inputDigest: reviewed.plan.inputDigest, transitionDigest: reviewed.plan.transitionDigest },
      observedAt: reviewed.now.toISOString(), provider, resourceId: 'record-format-only-fixture', resourceType: 'repository',
      sourceDigest: canonicalSha256(publication), readbackDigest: canonicalSha256(execution), matches: true
    }))
  }, records);
  const state = value.context.records.stateAfterOutcome({
    state: value.installed.state!, plan: reviewed.plan, phaseState: 'verified',
    updatedAt: reviewed.now.toISOString(), evidenceId: evidence.evidenceId
  }, { ...records, evidence: [evidence] });
  const files = [
    { path: `governance/plans/${reviewed.control.controlKey}.json`, content: canonicalJson(reviewed.plan), beforeHash: null },
    { path: `governance/approvals/source5-${reviewed.control.controlKey}.json`, content: canonicalJson(reviewed.approval), beforeHash: null },
    { path: `governance/plans/${origin.planKey}.json`, content: canonicalJson(value.plan), beforeHash: null },
    { path: `governance/approvals/source5-${origin.planKey}.json`, content: canonicalJson(value.approval), beforeHash: null },
    { path: `governance/evidence/source5-${reviewed.control.controlKey}.json`, content: canonicalJson(evidence), beforeHash: null },
    { path: 'governance/activation-state.json', content: canonicalJson(state), beforeHash: canonicalSha256(value.installed.state) }
  ];
  return { reviewed, journal, files, sourceJournal,
    sealFinalization: () => journal.saveFinalization({ kind: 'workflow-source5-finalization', files }),
    writeFiles: async (selected = files) => {
      for (const file of selected) await value.installed.write(file.path.split('/'), file.content);
    } };
}

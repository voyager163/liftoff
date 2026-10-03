import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { capturedFileBytes, copyModernLocalData, localInputFailure } from '../../domain/governance/activation/modern-local-inputs.js';
import type { ModernLocalRuntimeInspection } from '../../domain/governance/activation/modern-local-runtime.js';
import { exactRecord } from '../../domain/project/manifest/fields.js';
import { modernLocalRevalidationPhases } from '../../governance-activation/modern-history-contracts.js';
import { completedSpecKitTasks, specKitBootstrapPath } from '../../governance-activation/spec-kit-seed.js';
import { inspectModernLocalRuntime, planModernLocalRuntime } from '../governance/modern-local-inputs.js';
import { validateCapturedModernSuccessorSource, type ModernSuccessorSource } from '../governance/modern-installed-preflight.js';

type RuntimePlan = Awaited<ReturnType<typeof planModernLocalRuntime>>;
type CompletionSource = {
  workflow: 'openspec' | 'spec-kit';
  status: 'already-completed-source' | 'blocked';
  blockers: string[];
};

function completionSource(source: ModernSuccessorSource, runtime: RuntimePlan): CompletionSource {
  const workflow = source.manifest.project.specWorkflow;
  if (workflow !== 'openspec' && workflow !== 'spec-kit') localInputFailure('No Manual activation successor lane exists.');
  const check = runtime.localPlan?.checks.find(check => check.id === 'framework-source');
  if (!check || check.status !== 'planned' || runtime.inspection.status !== 'observed' ||
      runtime.inspection.local.status !== 'modern-observed') {
    return { workflow, status: 'blocked', blockers: ['Actual selected framework inputs are not independently valid.'] };
  }
  if (workflow === 'openspec') {
    return check.reasons.includes('openspec-archived-source')
      ? { workflow, status: 'already-completed-source', blockers: [] }
      : { workflow, status: 'blocked', blockers: [
        'OpenSpec bootstrap is not already archived and synchronized. A separately reviewed setup transition is required; revalidation never edits or archives it.'
      ] };
  }
  const parts = [...specKitBootstrapPath, 'tasks.md'];
  const file = runtime.inspection.local.snapshot.files.find(file => file.pathParts.join('/') === parts.join('/'));
  const bytes = file && capturedFileBytes(file);
  if (!bytes) localInputFailure('Validated Spec Kit source lacks its actual task bytes.');
  const tasks = bytes.toString('utf8');
  return Buffer.from(tasks).equals(bytes) && completedSpecKitTasks(tasks) === tasks
    ? { workflow, status: 'already-completed-source', blockers: [] }
    : { workflow, status: 'blocked', blockers: [
      'Spec Kit bootstrap tasks are not already the completed matching projection. A separately reviewed setup transition is required; revalidation never edits them.'
    ] };
}

/** Plans fresh finite work; neither source records nor this fingerprint authorize native execution. */
export async function planModernSuccessorRevalidation(input: ModernLocalRuntimeInspection) {
  const runtime = await planModernLocalRuntime(copyModernLocalData(input));
  if (runtime.inspection.status !== 'observed') localInputFailure(runtime.blockers.join(' '));
  const source = await validateCapturedModernSuccessorSource(runtime.inspection.installed.snapshot);
  const completion = completionSource(source, runtime);
  const localBlockers = [...runtime.blockers];
  const phases = modernLocalRevalidationPhases.map(phaseId => {
    const blockers = phaseId === 'local-complete' ? [...localBlockers, ...completion.blockers] : [...localBlockers];
    return {
      phaseId, status: blockers.length ? 'blocked' as const : 'requires-current-proof' as const,
      blockers, reuse: 'not-established' as const
    };
  });
  const body = {
    kind: 'liftoff-modern-successor-revalidation-plan' as const, schemaVersion: 1 as const,
    projectRoot: source.snapshot.root, sourceBinding: source.binding,
    originalTransition: source.journal.semanticInput,
    originalTransitionDigest: source.journal.semanticTransitionDigest,
    originalPreparation: source.journal.preparation, successor: source.journal.successor,
    recordedProgress: source.journal.revalidation,
    runtime: {
      status: runtime.status, captureStatus: runtime.inspection.local.status, installedBinding: runtime.installedBinding,
      observationDigest: runtime.localPlan?.observationDigest ?? null,
      physicalDigest: runtime.localPlan?.physicalDigest ?? null,
      baselineDigest: runtime.localPlan?.baselineDigest ?? null,
      sourceRecipeDigest: runtime.localPlan?.recipeSet.digest ?? null,
      checks: runtime.localPlan?.checks ?? [], blockers: localBlockers
    },
    completionSource: completion, phases,
    effects: {
      projectCode: 'separate-native-execution-approval-required',
      dependencyPreparation: 'separate-approval-required',
      workflowWrites: 'not-authorized', archiveReplay: 'not-authorized',
      providerAccess: 'not-authorized', statePayloadAccess: 'not-authorized',
      publication: 'separate-exact-byte-approval-required'
    } as const,
    execution: 'not-authorized' as const, publication: 'not-authorized' as const
  };
  return { ...body, fingerprint: canonicalSha256(body) };
}
export type ModernSuccessorRevalidationPlan = Awaited<ReturnType<typeof planModernSuccessorRevalidation>>;

export async function inspectModernSuccessorRevalidation(root: string): Promise<ModernSuccessorRevalidationPlan> {
  return planModernSuccessorRevalidation(await inspectModernLocalRuntime(copyModernLocalData(root)));
}

export async function reinspectModernSuccessorRevalidation(root: string, prior: ModernSuccessorRevalidationPlan) {
  ({ root, prior } = copyModernLocalData({ root, prior }));
  exactRecord(prior, ['kind', 'schemaVersion', 'projectRoot', 'sourceBinding', 'originalTransition', 'originalTransitionDigest',
    'originalPreparation', 'successor', 'recordedProgress', 'runtime', 'completionSource', 'phases', 'effects', 'execution', 'publication', 'fingerprint'],
  'Modern successor revalidation plan');
  const { fingerprint, ...body } = prior;
  if (prior.kind !== 'liftoff-modern-successor-revalidation-plan' || prior.schemaVersion !== 1 ||
      fingerprint !== canonicalSha256(body)) localInputFailure('Modern successor revalidation plan has invalid identity or fingerprint.');
  const current = await inspectModernSuccessorRevalidation(root);
  if (current.runtime.captureStatus !== 'modern-observed') {
    localInputFailure('Complete selected local inputs were not observed; a blocked capture cannot establish unchanged revalidation inputs.');
  }
  if (current.fingerprint !== fingerprint) localInputFailure('Modern successor inputs or required work changed; obtain a fresh revalidation plan.');
  return current;
}

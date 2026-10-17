import { types } from 'node:util';
import { inspectModernInstalledActivation } from '../application/governance/modern-installed-preflight.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { assertSource5WorkflowContext, source5WorkflowPhases } from './workflow-source5-context.js';
import type { Source5WorkflowContext, Source5WorkflowPhase } from './workflow-source5-context.js';
import { source5WorkflowPrerequisiteReferences } from './workflow-source5-prerequisites.js';
import type { Source5WorkflowPrerequisiteReferences } from './workflow-source5-prerequisites.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-control-values.js';

export interface Source5WorkflowPrerequisiteObservationInput {
  readonly context: Source5WorkflowContext;
  readonly projectRoot: string;
  readonly phaseId: Source5WorkflowPhase;
}

export interface Source5WorkflowPrerequisiteObservation {
  readonly status: 'blocked';
  readonly currentness: 'not-observed';
  readonly execution: 'not-authorized';
  readonly references: Source5WorkflowPrerequisiteReferences;
  readonly observations: {
    readonly startedAt: string;
    readonly endedAt: string;
    readonly beforeObservedAt: string;
    readonly afterObservedAt: string;
    readonly installedBinding: string;
    readonly physicalDigest: string;
  };
  readonly dependencies: readonly {
    readonly contract: Source5WorkflowPrerequisiteReferences['dependencies'][number]['contract'];
    readonly alternatives: readonly {
      readonly phaseId: Source5WorkflowPrerequisiteReferences['dependencies'][number]['alternatives'][number]['phaseId'];
      readonly recordedState: Source5WorkflowPrerequisiteReferences['dependencies'][number]['alternatives'][number]['recordedState'];
      readonly recordedStateAccepted: boolean;
      readonly currentness: 'not-observed';
      readonly readbackProviders: readonly string[];
      readonly readerCode: 'workflow-current-azure-peer-reader-unavailable' | 'workflow-prerequisite-current-reader-unavailable';
      readonly code: 'workflow-prerequisite-recorded-state' | 'workflow-prerequisite-current-reader-unavailable';
      readonly message: string;
    }[];
  }[];
  readonly completionBlockers: readonly {
    readonly code: 'workflow-current-azure-peer-reader-unavailable';
    readonly message: string;
  }[];
  readonly projectWrites: false;
  readonly providerReads: false;
  readonly providerWrites: false;
  readonly workloadExecution: false;
  readonly prerequisiteSession: null;
}

/** Reads real original references twice; unavailable producers never issue a currentness session. */
export async function observeSource5WorkflowPrerequisites(
  input: Source5WorkflowPrerequisiteObservationInput
): Promise<Source5WorkflowPrerequisiteObservation> {
  if (typeof input !== 'object' || input === null || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 3 ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['context', 'projectRoot', 'phaseId'].includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    return workflowFailure('workflow-source5-prerequisite-request',
      'Prerequisite observation accepts only the constructed context, actual project root and selected phase; caller readers, installed snapshots and proof values are not inputs.');
  }
  assertSource5WorkflowContext(input.context);
  const context = input.context;
  const { projectRoot, phaseId } = captureWorkflowBinding({ projectRoot: input.projectRoot, phaseId: input.phaseId });
  if (typeof projectRoot !== 'string' || !projectRoot || !source5WorkflowPhases.includes(phaseId)) {
    return workflowFailure('workflow-source5-prerequisite-request',
      'Prerequisite observation requires one actual installed project and exact current5 workflow phase.');
  }
  const startedAt = new Date().toISOString();
  const before = await inspectModernInstalledActivation(projectRoot);
  if (before.status !== 'observed') {
    return workflowFailure('workflow-source5-prerequisite-installed', before.blockers.join(' '));
  }
  const references = source5WorkflowPrerequisiteReferences({ context, installed: before, phaseId });
  const phase = context.records.graph.phases.find(phase => phase.id === phaseId)!;
  const dependencies = references.dependencies.map(dependency => ({
    contract: dependency.contract,
    alternatives: dependency.alternatives.map(alternative => {
      const producer = context.records.graph.phases.find(phase => phase.id === alternative.phaseId)!;
      const recordedStateAccepted = dependency.contract.accepts.some(state => state === alternative.recordedState);
      return {
        phaseId: alternative.phaseId, recordedState: alternative.recordedState, recordedStateAccepted,
        currentness: 'not-observed' as const, readbackProviders: producer.evidence.liveReadbackProviders,
        readerCode: producer.evidence.liveReadbackProviders.includes('azure')
          ? 'workflow-current-azure-peer-reader-unavailable' as const
          : 'workflow-prerequisite-current-reader-unavailable' as const,
        code: recordedStateAccepted ? 'workflow-prerequisite-current-reader-unavailable' as const :
          'workflow-prerequisite-recorded-state' as const,
        message: recordedStateAccepted
          ? 'The original recorded outcome is admissible, but its producer-specific independently current reader is not composed. Original records, including inapplicability and approval envelopes, cannot issue current proof.'
          : 'The original recorded state does not satisfy this exact dependency group. No stored or caller-supplied success is substituted.'
      };
    })
  }));
  const completionBlockers = phase.evidence.liveReadbackProviders.includes('azure') ? [{
    code: 'workflow-current-azure-peer-reader-unavailable' as const,
    message: 'This selected phase requires its independently approved current Azure peer. No current5 no-effect peer reader is composed; GitHub success and structurally supplied deployment, custody or health values cannot satisfy it.'
  }] : [];
  const after = await inspectModernInstalledActivation(projectRoot);
  if (after.status !== 'observed' || after.snapshot.root !== before.snapshot.root ||
    after.binding !== before.binding ||
    canonicalSha256(after.snapshot.physical) !== canonicalSha256(before.snapshot.physical)) {
    return workflowFailure('workflow-source5-prerequisite-drift',
      'The independently observed installed original closure or physical identities changed during prerequisite observation; no current session was issued.');
  }
  return captureWorkflowBinding({
    status: 'blocked', currentness: 'not-observed', execution: 'not-authorized', references,
    observations: {
      startedAt, endedAt: new Date().toISOString(), beforeObservedAt: before.snapshot.observedAt,
      afterObservedAt: after.snapshot.observedAt, installedBinding: before.binding,
      physicalDigest: canonicalSha256(before.snapshot.physical)
    },
    dependencies, completionBlockers, projectWrites: false, providerReads: false,
    providerWrites: false, workloadExecution: false, prerequisiteSession: null
  });
}

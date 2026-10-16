import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { installedLocalBinding } from '../domain/governance/activation/modern-local-runtime.js';
import type { InstalledLocalPreflight } from '../domain/governance/activation/modern-local-runtime.js';
import type { ModernActivationState, ModernPhaseId } from '../domain/governance/activation/modern-record-contracts.js';
import { modernPhaseContractDigests } from '../domain/governance/activation/modern-graph.js';
import { capturedFileBytes } from '../domain/governance/activation/modern-local-inputs.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-control-values.js';
import {
  assertSource5WorkflowContext, source5ApprovalHash, source5WorkflowPhases
} from './workflow-source5-context.js';
import type { Source5WorkflowContext, Source5WorkflowPhase } from './workflow-source5-context.js';

type SelectedPhase = Source5WorkflowContext['records']['graph']['phases'][number];

export interface Source5WorkflowOriginalRecordReference {
  readonly pathParts: readonly string[];
  readonly rawDigest: string;
}

export interface Source5WorkflowPrerequisiteReference {
  readonly phaseId: ModernPhaseId;
  readonly recordedState: ModernActivationState['phases'][ModernPhaseId]['state'];
  readonly executionPlanDigest: string | null;
  readonly savedPlans: readonly (Source5WorkflowOriginalRecordReference & {
    readonly savedPlanDigest: string;
    readonly operationDigests: readonly string[];
  })[];
  readonly evidence: readonly (Source5WorkflowOriginalRecordReference & {
    readonly evidenceId: string;
    readonly headerDigest: string;
    readonly recordDigest: string;
  })[];
  readonly approvals: readonly (Source5WorkflowOriginalRecordReference & {
    readonly id: string;
    readonly envelopeHash: string;
  })[];
}

export interface Source5WorkflowPrerequisiteReferences {
  readonly phaseId: Source5WorkflowPhase;
  readonly graphHash: string;
  readonly identityDigest: string;
  readonly phaseContractDigest: string;
  readonly installedBinding: string;
  readonly physicalDigest: string;
  readonly stateHash: string;
  readonly repositoryAnchor: string;
  readonly dependencies: readonly {
    readonly contract: SelectedPhase['dependencies'][number];
    readonly alternatives: readonly Source5WorkflowPrerequisiteReference[];
  }[];
  readonly applicability: SelectedPhase['applicability'];
  readonly approvalGate: SelectedPhase['approvalGate'];
  readonly invalidationInputs: SelectedPhase['invalidationInputs'];
  readonly readbackProviders: SelectedPhase['evidence']['liveReadbackProviders'];
  readonly referenceDigest: string;
  readonly currentness: 'not-observed';
  readonly execution: 'not-authorized';
}

/** Selects original record references, not current producer proof or execution authority. */
export function source5WorkflowPrerequisiteReferences(input: {
  readonly context: Source5WorkflowContext;
  readonly installed: Extract<InstalledLocalPreflight, { status: 'observed' }>;
  readonly phaseId: Source5WorkflowPhase;
}): Source5WorkflowPrerequisiteReferences {
  const { context } = input;
  assertSource5WorkflowContext(context);
  const { installed, phaseId } = captureWorkflowBinding({
    installed: input.installed, phaseId: input.phaseId
  });
  if (!source5WorkflowPhases.includes(phaseId) || installed.status !== 'observed' ||
    installed.classification !== 'current' || !installed.current ||
    installed.binding !== installedLocalBinding(installed.snapshot) ||
    canonicalSha256(installed.current.state.identity) !== canonicalSha256(context.records.identity)) {
    return workflowFailure('workflow-source5-prerequisite-inputs',
      'Workflow prerequisite references require the exact selected current5 installed state and original record closure; source references and stored progress are not current proof.');
  }
  const { records } = installed.current;
  const state = context.records.readState(installed.current.state, records);
  const originals = new Map<string, Source5WorkflowOriginalRecordReference[]>();
  for (const file of installed.snapshot.files) {
    const [parent, namespace, name] = file.pathParts;
    if (parent !== 'governance' || !namespace || !['plans', 'evidence', 'approvals'].includes(namespace) ||
      file.pathParts.length !== 3 || !name?.endsWith('.json')) continue;
    const bytes = capturedFileBytes(file);
    if (!bytes || !file.digest) continue;
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch {
      return workflowFailure('workflow-source5-prerequisite-record',
        'Original prerequisite record references require the actual valid captured JSON namespace bytes.');
    }
    const key = `${namespace}:${canonicalSha256(value)}`;
    originals.set(key, [...(originals.get(key) ?? []), { pathParts: file.pathParts, rawDigest: file.digest }]);
  }
  function original(namespace: 'plans' | 'evidence' | 'approvals', digest: string): Source5WorkflowOriginalRecordReference {
    const matches = originals.get(`${namespace}:${digest}`);
    if (matches?.length !== 1) {
      return workflowFailure('workflow-source5-prerequisite-record',
        'A selected original record is absent from, or ambiguous in, the exact captured installed namespace.');
    }
    return matches[0]!;
  }
  const phase = context.records.graph.phases.find(phase => phase.id === phaseId);
  if (!phase) {
    return workflowFailure('workflow-source5-prerequisite-phase',
      'Workflow prerequisite selection requires a phase in the exact constructed current5 graph.');
  }
  function reference(id: ModernPhaseId): Source5WorkflowPrerequisiteReference {
    const entry = state.phases[id];
    const plans = entry.executionPlanDigest === undefined ? [] :
      (records.plans ?? []).filter(plan => isRecord(plan) && plan.phaseId === id &&
        plan.planDigest === entry.executionPlanDigest).map(plan => context.records.readPlan(plan, records));
    return {
      phaseId: id, recordedState: entry.state,
      executionPlanDigest: entry.executionPlanDigest ?? null,
      savedPlans: plans.map(plan => {
        const savedPlanDigest = canonicalSha256(plan);
        return { ...original('plans', savedPlanDigest), savedPlanDigest,
          operationDigests: plan.operations.map(operation => canonicalSha256(operation)) };
      }),
      evidence: entry.evidence.map(ref => {
        const selected = records.evidence?.find(record => isRecord(record) && record.evidenceId === ref.evidenceId);
        const record = selected === undefined ? undefined : context.records.readEvidence(selected, records);
        if (!record || canonicalSha256(record.header) !== ref.headerDigest) {
          return workflowFailure('workflow-source5-prerequisite-evidence',
            'A selected prerequisite lost its exact original evidence reference.');
        }
        const recordDigest = canonicalSha256(record);
        return { ...original('evidence', recordDigest), evidenceId: ref.evidenceId,
          headerDigest: ref.headerDigest, recordDigest };
      }),
      approvals: entry.approvals.map(id => {
        const approval = records.approvals?.find(approval => isRecord(approval) && approval.id === id);
        if (approval === undefined) {
          return workflowFailure('workflow-source5-prerequisite-approval',
            'A selected prerequisite lost its original approval envelope.');
        }
        const record = context.records.readApproval(approval);
        return { ...original('approvals', canonicalSha256(record)), id, envelopeHash: source5ApprovalHash(context, record) };
      })
    };
  }
  const selected = {
    phaseId, graphHash: context.records.identity.phaseGraphHash,
    identityDigest: canonicalSha256(context.records.identity),
    phaseContractDigest: modernPhaseContractDigests(context.records.graph)[phaseId]!,
    installedBinding: installed.binding, physicalDigest: canonicalSha256(installed.snapshot.physical),
    stateHash: canonicalSha256(state), repositoryAnchor: state.repository.id,
    dependencies: phase.dependencies.map(contract => ({
      contract, alternatives: contract.anyOf.map(reference)
    })),
    applicability: phase.applicability, approvalGate: phase.approvalGate,
    invalidationInputs: phase.invalidationInputs,
    readbackProviders: phase.evidence.liveReadbackProviders
  };
  return captureWorkflowBinding({
    ...selected, referenceDigest: canonicalSha256(selected),
    currentness: 'not-observed', execution: 'not-authorized'
  });
}

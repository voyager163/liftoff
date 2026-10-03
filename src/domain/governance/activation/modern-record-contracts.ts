import type * as Released from './record-contracts.js';
import type { ManifestV8ProjectLeaf, ManifestV8WorkflowId } from '../../project/manifest/v8-project.js';
import type { ModernPhaseGraph } from './modern-graph.js';

export type ModernGovernanceProfile = 'single-maintainer-gitflow' | 'team-gitflow';
export type ModernWorkflow = ManifestV8WorkflowId;
export type ModernDigest = `sha256:${string}`;
export type ModernPhaseId = Exclude<Released.ReleasedV3PhaseId, 'seed-valid' | 'seed-verified' | 'seed-archived'> |
  'local-inputs-valid' | 'local-baseline-verified' | 'local-complete';
export type ModernMutationClass = Released.ReleasedMutationClassV3 |
  'write-spec-kit-seed' | 'write-spec-kit-governance' | 'write-operational-plan';

export interface ModernStaticVersions {
  readonly liftoffVersion: '0.13.0-dev.0';
  readonly manifestArtifactVersion: 8;
  readonly activationContractVersion: 4;
  readonly phaseGraphSchemaVersion: 3;
  readonly activationStateSchemaVersion: 4;
  readonly evidenceHeaderSchemaVersion: 4;
  readonly approvalEnvelopeSchemaVersion: 4;
  readonly supersessionSchemaVersion: 2;
  readonly credentialPolicySchemaVersion: 2;
}

export type ModernProfileIdentity =
  | { readonly profile: 'single-maintainer-gitflow'; readonly policyVersion: '7' }
  | { readonly profile: 'team-gitflow'; readonly policyVersion: '1' };

export type StaticModernActivationIdentity = ModernStaticVersions & ModernProfileIdentity & {
  readonly policyDigest: ModernDigest;
  readonly workflow: ModernWorkflow;
  readonly phaseGraphHash: string;
};

export type ReadableModernActivationIdentity = StaticModernActivationIdentity & {
  readonly sourceSelectionDigest: ModernDigest;
  readonly pluginResolutionDigest: ModernDigest;
  readonly activeLayoutDigest: ModernDigest;
};

export interface ModernActivationSourceContract {
  readonly identity: StaticModernActivationIdentity;
  readonly savedPlanSchemaVersion: 3;
  readonly compatibilityMetadataSchemaVersion: 5;
  readonly policyPathParts: readonly string[];
  readonly graph: ModernPhaseGraph;
}

export type ModernActivationSelection = ManifestV8ProjectLeaf & { readonly profile: ModernGovernanceProfile };

export interface ModernActivationSourceInput {
  readonly recordedIdentity: unknown;
  readonly profile: ModernGovernanceProfile;
  readonly policyVersion: string;
  readonly selection: ModernActivationSelection;
  readonly pluginResolutionDigest: ModernDigest;
  readonly activeLayoutDigest: ModernDigest;
}

export type ModernTransitionOperation = Omit<Released.TransitionOperationFieldsV2<ModernPhaseId>, 'mutationClass' | 'effects'> & {
  readonly mutationClass: ModernMutationClass;
  readonly effects?: readonly {
    readonly mutationClass: ModernMutationClass;
    readonly destination: Released.TransitionOperationDestinationFieldsV1;
    readonly remote: boolean;
    readonly destructive: boolean;
  }[];
};

type State<I extends ReadableModernActivationIdentity> =
  Omit<Released.UserActivationStateFieldsV3<I, ModernPhaseId>, 'activeChange'>;
export type ModernActivationState =
  | (State<ReadableModernActivationIdentity & { readonly workflow: 'manual' }> & { readonly activeChange: null })
  | (State<ReadableModernActivationIdentity & { readonly workflow: 'openspec' }> & {
      readonly activeChange: { readonly id: string; readonly kind: 'openspec' } | null;
    })
  | (State<ReadableModernActivationIdentity & { readonly workflow: 'spec-kit' }> & {
      readonly activeChange: { readonly id: string; readonly kind: 'spec-kit' } | null;
    });

export type ModernEvidenceHeader = Released.EvidenceHeaderFieldsV3<ReadableModernActivationIdentity, ModernPhaseId>;
export type ModernEvidenceRecord = Released.PhaseEvidenceRecordFieldsV3<ReadableModernActivationIdentity, ModernPhaseId>;
export type ModernApprovalEnvelope = Released.ApprovalEnvelopeFieldsV3<ReadableModernActivationIdentity, ModernPhaseId>;
export type ModernCredentialPolicy = Omit<Released.CredentialPolicyFieldsV1<ReadableModernActivationIdentity>, 'schemaVersion'> & {
  readonly schemaVersion: 2;
};
export type ModernSupersessionRecord = Omit<Released.SupersessionRecordFieldsV1<ReadableModernActivationIdentity>, 'schemaVersion'> & {
  readonly schemaVersion: 2;
};
export type ModernSavedTransitionPlan = Omit<Released.SavedTransitionPlanFieldsV2<ReadableModernActivationIdentity, ModernPhaseId>,
  'schemaVersion' | 'operations' | 'mutationClasses' | 'approvalBundle' | 'rollbackPlan'> & {
  readonly schemaVersion: 3;
  readonly operations: readonly ModernTransitionOperation[];
  readonly mutationClasses: { readonly local: readonly ModernMutationClass[]; readonly remote: readonly ModernMutationClass[] };
  readonly approvalBundle?: readonly {
    readonly phaseId: ModernPhaseId;
    readonly inputDigest: string;
    readonly transitionDigest: string;
    readonly operations: readonly ModernTransitionOperation[];
    readonly fileChanges: readonly Released.PlannedFileChangeFieldsV1[];
  }[];
  readonly rollbackPlan: Omit<Released.TransitionRollbackPlanFieldsV2<ModernPhaseId>, 'operations'> & {
    readonly operations: readonly Omit<ModernTransitionOperation, 'effects'>[];
  };
};

export interface NativeLocalCompletionPayload {
  readonly schemaVersion: 1;
  readonly kind: 'local-complete.v1';
  readonly workflow: 'manual';
  readonly frameworkValidation: 'not-required';
  readonly frameworkFinalization: 'not-required';
  readonly baselineEvidenceId: string;
  readonly baselineHeaderDigest: string;
  readonly planDigest: string;
  readonly savedPlanDigest: string;
}

/** Transient decoder dimensions; the released serialized declarations remain unchanged. */
export type RecordOperation<P extends string, M extends string> = {
  [K in keyof Released.TransitionOperationFieldsV2<P>]:
    K extends 'mutationClass' ? M :
    K extends 'effects' ? readonly {
      mutationClass: M; destination: Released.TransitionOperationDestinationFieldsV1; remote: boolean; destructive: boolean;
    }[] : Released.TransitionOperationFieldsV2<P>[K];
};
export type RecordRollback<P extends string, M extends string> = {
  [K in keyof Released.TransitionRollbackPlanFieldsV2<P>]:
    K extends 'operations' ? readonly Omit<RecordOperation<P, M>, 'effects'>[] : Released.TransitionRollbackPlanFieldsV2<P>[K];
};
export type RecordPlan<I extends Released.ActivationIdentityFieldsV1, P extends string, M extends string, S extends number> = {
  [K in keyof Released.SavedTransitionPlanFieldsV2<I, P>]:
    K extends 'schemaVersion' ? S :
    K extends 'operations' ? readonly RecordOperation<P, M>[] :
    K extends 'mutationClasses' ? { local: readonly M[]; remote: readonly M[] } :
    K extends 'rollbackPlan' ? RecordRollback<P, M> :
    K extends 'approvalBundle' ? readonly {
      phaseId: P; inputDigest: string; transitionDigest: string;
      operations: readonly RecordOperation<P, M>[]; fileChanges: readonly Released.PlannedFileChangeFieldsV1[];
    }[] : Released.SavedTransitionPlanFieldsV2<I, P>[K];
};
export type RecordGraph<P extends string, M extends string> = Omit<Released.ManagedPhaseGraphFieldsV2<P>, 'phases'> & {
  phases: readonly (Omit<Released.PhaseGraphNodeFieldsV2<P>, 'allowedMutations'> & {
    allowedMutations: { local: readonly M[]; remote: readonly M[] };
  })[];
};

export type ModernRuntimeRecord =
  | { readonly kind: 'state'; readonly record: ModernActivationState }
  | { readonly kind: 'evidence'; readonly record: ModernEvidenceRecord }
  | { readonly kind: 'approval'; readonly record: ModernApprovalEnvelope }
  | { readonly kind: 'plan'; readonly record: ModernSavedTransitionPlan }
  | { readonly kind: 'credential-policy'; readonly record: ModernCredentialPolicy }
  | { readonly kind: 'supersession'; readonly record: ModernSupersessionRecord };

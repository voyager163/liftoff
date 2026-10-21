import { canonicalSha256 } from './canonical-json.js';
import { buildPhaseDefinitions } from './phase-graph-values.js';
import type { PhaseGraphNodeFieldsV2, ReleasedV3PhaseId } from './record-contracts.js';
import type { ModernDigest, ModernMutationClass, ModernPhaseId, ModernProfileIdentity, ModernStaticVersions, ModernWorkflow } from './modern-record-contracts.js';

export type ModernProfileContract = ModernProfileIdentity & {
  readonly policyDigest: ModernDigest;
};

export type ModernWorkflowContract =
  | { readonly workflow: 'openspec'; readonly framework: 'external'; readonly completion: 'validate-sync-archive'; readonly operationalSource: 'framework-change' }
  | { readonly workflow: 'spec-kit'; readonly framework: 'external'; readonly completion: 'validate-finalize'; readonly operationalSource: 'framework-change' }
  | { readonly workflow: 'manual'; readonly framework: 'not-required'; readonly completion: 'native-receipt'; readonly operationalSource: 'native-reviewed-plan';
      readonly frameworkValidation: 'not-required'; readonly frameworkFinalization: 'not-required'; readonly agents: 'optional' };

export type ModernPhaseGraphNode = Omit<PhaseGraphNodeFieldsV2<ModernPhaseId>, 'allowedMutations'> & {
  readonly allowedMutations: {
    readonly local: readonly ModernMutationClass[];
    readonly remote: readonly ModernMutationClass[];
  };
};

export interface ModernPhaseGraph {
  readonly schemaVersion: 3;
  readonly versions: {
    readonly liftoffVersion: ModernStaticVersions['liftoffVersion'];
    readonly policyVersion: ModernProfileIdentity['policyVersion'];
    readonly activationContractVersion: ModernStaticVersions['activationContractVersion'];
    readonly phaseGraphSchemaVersion: 3;
  };
  readonly profileContract: ModernProfileContract & {
    readonly pullRequestReview:
      | { readonly kind: 'automated-only'; readonly humanApprovals: 0 }
      | { readonly kind: 'independent-human'; readonly humanApprovals: 1; readonly excludeAuthor: true;
          readonly excludeBots: true; readonly invalidateOnRelevantChanges: true; readonly currentHeadRequired: true };
    readonly deploymentReviewers: 'not-required';
    readonly existingCodeowners: 'preserve';
    readonly strongerProtections: 'review-before-reduction';
    readonly backMerge: 'protected-pr-and-exact-head-checks';
    readonly enforcement: 'rulesets-last-after-green-red-proof';
    readonly preExistingDeploymentState: 'planning-only';
  };
  readonly workflowContract: ModernWorkflowContract;
  readonly completionGroups: {
    readonly local: readonly ModernPhaseId[];
    readonly activation: readonly ModernPhaseId[];
    readonly lifecycle: readonly ModernPhaseId[];
  };
  readonly phases: readonly ModernPhaseGraphNode[];
}

export function freezeModernValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeModernValue(child);
    Object.freeze(value);
  }
  return value;
}

function phaseId(id: ReleasedV3PhaseId): ModernPhaseId {
  if (id === 'seed-valid') return 'local-inputs-valid';
  if (id === 'seed-verified') return 'local-baseline-verified';
  if (id === 'seed-archived') return 'local-complete';
  return id;
}

function workflowContract(workflow: ModernWorkflow): ModernWorkflowContract {
  if (workflow === 'manual') return {
    workflow, framework: 'not-required', completion: 'native-receipt', operationalSource: 'native-reviewed-plan',
    frameworkValidation: 'not-required', frameworkFinalization: 'not-required', agents: 'optional'
  };
  return workflow === 'openspec'
    ? { workflow, framework: 'external', completion: 'validate-sync-archive', operationalSource: 'framework-change' }
    : { workflow, framework: 'external', completion: 'validate-finalize', operationalSource: 'framework-change' };
}

/** Pure source graph construction; registration and concrete schema allocation belong to identity.ts. */
export function buildModernPhaseGraph(
  versions: ModernStaticVersions,
  profile: ModernProfileContract,
  workflow: ModernWorkflow,
  disposalContract: 'protected-custody' | 'local-bootstrap' = 'protected-custody'
): ModernPhaseGraph {
  if (versions.activationContractVersion === 6) {
    throw new Error('Publication source6 requires its separate graph constructor; source5 cannot allocate attestation writes.');
  }
  const contract = workflowContract(workflow);
  const phases = buildPhaseDefinitions(versions, 'released-v3', disposalContract).map((original): ModernPhaseGraphNode => {
    const id = phaseId(original.id);
    const local = original.id.startsWith('seed-');
    const mapMutation = (mutation: ModernMutationClass): readonly ModernMutationClass[] => {
      if (workflow === 'manual') {
        if (mutation === 'write-seed-tasks' || mutation === 'write-openspec-seed' || mutation === 'project-governance-tasks') return [];
        if (mutation === 'write-openspec-governance') return ['write-operational-plan'];
      }
      if (workflow === 'spec-kit') {
        if (mutation === 'write-openspec-seed') return ['write-spec-kit-seed'];
        if (mutation === 'write-openspec-governance') return ['write-spec-kit-governance'];
      }
      return [mutation];
    };
    const labels: Partial<Record<ModernPhaseId, string>> = {
      'local-inputs-valid': 'Recorded project and applicable workflow inputs are valid',
      'local-baseline-verified': 'Applicable approved local baseline checks are verified',
      'local-complete': workflow === 'manual' ? 'Native local completion is recorded' :
        workflow === 'openspec' ? 'Verified OpenSpec source is synced and archived' : 'Verified Spec Kit source is finalized'
    };
    const publication = versions.activationContractVersion === 5 &&
      (id === 'bootstrap-workflow-source-ready' || id === 'workflow-source-ready');
    const proof = versions.activationContractVersion === 5 &&
      ['dev-proof', 'staging-qualified', 'production-rehearsed', 'green-red-proof'].includes(id);
    return {
      ...original, id, label: labels[id] ?? original.label,
      dependencies: original.dependencies.map(dependency => ({
        ...dependency, anyOf: dependency.anyOf.map(phaseId),
        ...(id === 'committed' ? { description: 'Recorded local completion precedes repository publication.' } :
          id === 'local-baseline-verified' ? { description: 'Actual local input validation must pass first.' } :
            id === 'local-complete' ? { description: 'Only a verified local baseline may be completed.' } : {})
      })),
      applicability: original.applicability.kind === 'always' ? original.applicability : {
        ...original.applicability, exclusiveWith: original.applicability.exclusiveWith.map(phaseId)
      },
      allowedMutations: {
        local: publication ? [...new Set<ModernMutationClass>([
          ...original.allowedMutations.local.flatMap(mapMutation), 'read-worktree', 'git-commit'
        ])] : original.allowedMutations.local.flatMap(mapMutation),
        remote: publication ? [...new Set<ModernMutationClass>([
          ...original.allowedMutations.remote.flatMap(mapMutation).filter(mutation => mutation !== 'none'),
          'git-push', 'github-read', 'github-write'
        ])] : original.allowedMutations.remote.flatMap(mapMutation)
      },
      evidence: {
        ...original.evidence, ...(local ? { schema: `${id}.v1` } : {}),
        ...(publication || proof ? { schema: `${id}.v2` } : {}),
        ...(publication ? { liveReadbackProviders: ['github' as const] } : {})
      },
      approvalGate: publication && id === 'workflow-source-ready'
        ? { ...original.approvalGate, kind: 'activation-plan', required: true }
        : original.approvalGate,
      rollback: {
        ...original.rollback, target: original.rollback.target === null ? null : phaseId(original.rollback.target),
        ...(local ? { description: 'Preserve the reviewed source and report incomplete local work; never fabricate completion.' } : {})
      }
    };
  });
  return freezeModernValue({
    schemaVersion: versions.phaseGraphSchemaVersion,
    versions: { liftoffVersion: versions.liftoffVersion, policyVersion: profile.policyVersion,
      activationContractVersion: versions.activationContractVersion, phaseGraphSchemaVersion: versions.phaseGraphSchemaVersion },
    profileContract: {
      ...profile,
      pullRequestReview: profile.profile === 'single-maintainer-gitflow'
        ? { kind: 'automated-only', humanApprovals: 0 }
        : { kind: 'independent-human', humanApprovals: 1, excludeAuthor: true, excludeBots: true,
            invalidateOnRelevantChanges: true, currentHeadRequired: true },
      deploymentReviewers: 'not-required', existingCodeowners: 'preserve', strongerProtections: 'review-before-reduction',
      backMerge: 'protected-pr-and-exact-head-checks', enforcement: 'rulesets-last-after-green-red-proof', preExistingDeploymentState: 'planning-only'
    },
    workflowContract: contract,
    completionGroups: {
      local: ['local-inputs-valid', 'local-baseline-verified', 'local-complete'],
      activation: phases.filter(phase => !phase.id.startsWith('local-') && phase.id !== 'bootstrap-state-disposed').map(phase => phase.id),
      lifecycle: ['bootstrap-state-disposed']
    },
    phases
  });
}

export function modernPhaseContractDigests(graph: ModernPhaseGraph): Readonly<Partial<Record<ModernPhaseId, string>>> {
  return Object.freeze(Object.fromEntries(graph.phases.map(({ label: _label, ...behavior }) => [
    behavior.id, canonicalSha256({ profileContract: graph.profileContract, workflowContract: graph.workflowContract, phase: behavior })
  ])));
}

export function buildApplicationPublicationPhaseGraph(
  versions: ModernStaticVersions & { readonly activationContractVersion: 6 },
  profile: ModernProfileContract,
  workflow: ModernWorkflow
): ModernPhaseGraph {
  const previous = buildModernPhaseGraph({ ...versions, activationContractVersion: 5 }, profile, workflow);
  return freezeModernValue({
    ...previous,
    versions: { ...previous.versions, activationContractVersion: versions.activationContractVersion },
    phases: previous.phases.map(phase => phase.id === 'application-artifact-ready' ? {
      ...phase,
      allowedMutations: {
        local: [...phase.allowedMutations.local],
        remote: [...phase.allowedMutations.remote, 'github-attestation-write' as const]
      },
      evidence: { ...phase.evidence, schema: 'application-artifact-ready.v2' }
    } : phase.id === 'application-foundation' ? {
      ...phase, evidence: { ...phase.evidence, schema: 'application-foundation.v2' }
    } : phase)
  });
}

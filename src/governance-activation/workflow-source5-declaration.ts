import { types } from 'node:util';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { workflowFailure } from './workflow-control-values.js';
import { assertSource5WorkflowContext } from './workflow-source5-context.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';

const commonObligations = freezeModernValue([
  { subject: 'current5-program', code: 'workflow-declaration-current5-program-unavailable',
    requirement: 'An independently authenticated immutable release of this exact current5 Liftoff program, including its complete executable closure; an older published package or a local build is not that subject.' },
  { subject: 'provider-integration', code: 'workflow-declaration-integration-unavailable',
    requirement: 'The actual independently authenticated provider integration selector for this exact full job/check identity; no integration ID is inferred from a name or proposed by a caller.' },
  { subject: 'complete-job', code: 'workflow-declaration-complete-job-unavailable',
    requirement: 'The complete literal job and all setup, dependency, validation and cleanup steps, conditions, permissions and immutable action/program/tool subjects; a recognized last command or matching label is insufficient.' },
  { subject: 'runner-and-checkout', code: 'workflow-declaration-immutable-subject-unavailable',
    requirement: 'Independently authenticated checkout/action sources, actual runner/network admission and exact supported shell/runtime/package-manager closure, not a moving runner label or a SHA-shaped string.' },
  { subject: 'controlled-red', code: 'workflow-declaration-negative-subject-unavailable',
    requirement: 'A genuine separately authorized single-parent/single-file non-workflow negative source and unchanged executable recipe, with successful preparation and every other required context green; no forced exit or synthetic status.' }
] as const);

const semanticRecipes = freezeModernValue([
  { key: 'source-integrity', proposedContext: 'Liftoff / source integrity',
    applicability: 'Every selected project.',
    semantics: 'Validate the actual selected manifest, plugins, layout and complete managed/application source closure using this current release.',
    missingSubjects: ['Exact committed input membership and current source-validator executable subjects.'] },
  { key: 'backend-tests', proposedContext: 'Liftoff / backend tests',
    applicability: 'The actual selected backend.',
    semantics: 'Run the actual bound Node/npm, Python/uv/pytest or Go test recipe with its complete supported preparation. On main, verify candidate test provenance instead of rerunning.',
    missingSubjects: ['The selected backend runtime, locked dependencies, preparation, unchanged real test suite and authenticated candidate-test report verifier.'] },
  { key: 'frontend-build', proposedContext: 'Liftoff / frontend build',
    applicability: 'Only an actually selected frontend.',
    semantics: 'Build the actual bound frontend with its complete supported preparation. On main, verify candidate build provenance instead of rebuilding.',
    missingSubjects: ['The selected frontend Node/npm/dependency closure, real build and authenticated candidate-build report verifier.'] },
  { key: 'worker-tests', proposedContext: 'Liftoff / worker tests',
    applicability: 'Only an actually selected worker.',
    semantics: 'Run the actual bound worker uv/pytest recipe. On main, verify candidate worker-test provenance; a local worker test does not establish deployment qualification.',
    missingSubjects: ['The selected worker Python/uv/dependency closure, unchanged real worker suite and authenticated candidate-worker report verifier.'] },
  { key: 'infrastructure', proposedContext: 'Liftoff / infrastructure',
    applicability: 'All applicable actual Compose and OpenTofu inputs.',
    semantics: 'Validate Compose configuration, explicit captured Terraform formatting, and separately qualified backend-disabled locked-provider initialization/validation. On main, verify existing candidate qualification.',
    missingSubjects: ['Immutable Compose/OpenTofu/provider subjects, complete actual input closure, separately approved initialization/network admission and authenticated candidate-infrastructure verifier.'] },
  { key: 'framework-source', proposedContext: 'Liftoff / framework source',
    applicability: 'Actual OpenSpec or Spec Kit source; Manual has no fictional framework job.',
    semantics: 'Run the selected framework strict read-only source validation. On main, verify candidate framework provenance.',
    missingSubjects: ['The complete immutable selected framework distribution, actual source-validation recipe and authenticated candidate-framework verifier.'] },
  { key: 'secret-protection', proposedContext: 'Liftoff / secret protection',
    applicability: 'Every selected project.',
    semantics: 'Verify the licensed platform Secret Protection scan for the exact source with complete supported scan/currentness readback, not a configuration flag or empty alert list.',
    missingSubjects: ['Licensed feature/API coverage, actual complete source-bound scan/report verifier and a platform-supported explicitly approved non-credential negative control.'] },
  { key: 'dependency-review', proposedContext: 'Liftoff / dependency review',
    applicability: 'The complete actual selected dependency inventory and exact comparison.',
    semantics: 'Verify actual Dependency Review policy results for the exact supported comparison. A provider dependency diff alone is not full SCA, license or scan-freshness qualification.',
    missingSubjects: ['Immutable Dependency Review action/program, supported dispatch/comparison semantics, complete dependency/policy coverage and authenticated result verifier.'] },
  { key: 'codeql', proposedContext: 'Liftoff / CodeQL',
    applicability: 'All applicable actual selected languages and source.',
    semantics: 'Validate actual supported CodeQL database/query results. On main, verify their original source-bound reports; backend tests do not implement CodeQL and read-only proof cannot publish SARIF.',
    missingSubjects: ['Immutable CodeQL program/query/runtime subjects, complete language coverage and authenticated original reports from the separately approved SARIF publisher.'] },
  { key: 'checkov', proposedContext: 'Liftoff / Checkov',
    applicability: 'All applicable actual IaC, Dockerfile and Actions inputs.',
    semantics: 'Validate the complete applicable Checkov policy scope without suppression, empty coverage or setup/parse failures standing in for findings. On main, verify the original candidate report.',
    missingSubjects: ['Immutable Checkov/interpreter/policy subjects, complete Terraform/Dockerfile/Actions input/evaluation closure and authenticated candidate-report verifier.'] },
  { key: 'action-references', proposedContext: 'Liftoff / action references',
    applicability: 'The complete actual workflow and local-action closure.',
    semantics: 'Validate all actual action references and the exact narrow expiring SLSA exception. An unavailable admissible non-workflow negative input blocks this context rather than widening the red grammar.',
    missingSubjects: ['Immutable action/metadata/reference-policy closure and an existing genuine admissible single-file negative input, not a canary manifest or changed workflow.'] },
  { key: 'image-qualification', proposedContext: 'Liftoff / image qualification',
    applicability: 'The actual immutable published candidate image.',
    semantics: 'Verify exact-image Trivy qualification, CycloneDX SBOM and SLSA L2 on develop/L3 on release and hotfix. Main verifies existing L3 qualification without rebuilding/rescanning; Grype remains report-only.',
    missingSubjects: ['Authenticated image digest/registry provenance, immutable Trivy/database/report subjects, fixable HIGH/CRITICAL policy and actual expiring allowlist, CycloneDX SBOM and required SLSA attestations.'] },
  { key: 'release-qualification', proposedContext: 'Liftoff / release qualification',
    applicability: 'Release/hotfix and verification of their actual promotion on main.',
    semantics: 'Verify actual Scorecard, genuine private Staging/ZAP and immutable L3/SBOM/digest qualification from separately approved producers, including the exact candidate/main merge relationship.',
    missingSubjects: ['Immutable Scorecard/ZAP/report subjects, independently current Azure peer, VNet-injected runner, actual protected native host, both handover/custody ports and authenticated original release evidence.'] },
  { key: 'staging-qualification', proposedContext: 'Liftoff / staging qualification',
    applicability: 'Main only; not a develop/release/hotfix gate.',
    semantics: 'Verify the genuine independently current Staging qualification and exact promoted digest; GitHub-only success cannot issue missing Azure proof.',
    missingSubjects: ['Independently current authenticated Azure/Staging/ZAP qualification, promoted image/candidate provenance and current protected native host with both handover/custody ports.'] }
] as const);

/** Declares intended semantics only; unresolved subjects cannot become publishable jobs or rulesets. */
export function declareSource5WorkflowSources(input: {
  readonly context: Source5WorkflowContext;
}) {
  if (typeof input !== 'object' || input === null || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 1 || !Object.hasOwn(input, 'context') ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor =>
      !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    return workflowFailure('workflow-declaration-request',
      'The private declaration accepts only the constructed current5 context, not proposed subjects, observations, registrations, commands or authority.');
  }
  assertSource5WorkflowContext(input.context);
  const { records } = input.context;
  const declaration = {
    identity: records.identity, graphHash: canonicalSha256(records.graph),
    inventory: 'intended-not-observed' as const,
    pairing: 'one-declaration-for-workflow-and-ruleset-source' as const,
    publicationDirectories: { workflows: '.github/workflows', rulesets: 'governance/rulesets' },
    pullRequestReview: records.graph.profileContract.pullRequestReview,
    requiredProgram: {
      package: '@msn-control/liftoff', version: records.identity.liftoffVersion,
      activationContractVersion: records.identity.activationContractVersion, authenticatedSubject: null
    },
    recipes: semanticRecipes.map(recipe => ({
      ...recipe, proposedJobId: recipe.key, integrationId: null, completeJob: null,
      commonObligations
    }))
  };
  const blockers = declaration.recipes.flatMap(recipe => [
    ...recipe.commonObligations.map(obligation => ({
      recipeKey: recipe.key, proposedContext: recipe.proposedContext,
      subject: obligation.subject, code: obligation.code, message: obligation.requirement
    })),
    ...recipe.missingSubjects.map(message => ({
      recipeKey: recipe.key, proposedContext: recipe.proposedContext,
      subject: 'semantic-program-and-evidence',
      code: 'workflow-declaration-semantic-subjects-unavailable' as const, message
    }))
  ]);
  return freezeModernValue({
    status: 'blocked' as const, declaration, declarationDigest: canonicalSha256(declaration), blockers,
    publicationSources: [] as const, effects: [] as const,
    requiredContextSemantics: 'not-validated' as const, qualifiedExecutableRecipe: null,
    prerequisiteSession: null, execution: 'not-authorized' as const,
    projectWrites: false as const, providerReads: false as const,
    providerWrites: false as const, workloadExecution: false as const
  });
}

export type Source5WorkflowSourceDeclaration = ReturnType<typeof declareSource5WorkflowSources>;

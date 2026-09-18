import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { PhaseEvidenceSource } from '../../domain/governance/activation/evidence.js';
import type { GovernanceScope } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from '../../governance-activation/transition-ports.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { AzureActivationAdmissionError } from './authority.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { applicationImageDigest } from '../../adapters/azure/application-provisioning.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import { productionRehearsalInterfaceBlocker } from './rehearsal-recipe.js';
import { requireQualificationEvidence, type QualificationEvidenceReference } from './qualification-evidence.js';
import { blockedQualificationOutcome } from './qualification-checkpoints.js';
import { environmentQualificationScopeBlocker } from './qualification-authority.js';
import { executeProductionDevProof } from './producer-dev-proof.js';
import { executeProductionStaging } from './producer-staging-qualification.js';
import { fullProductionChecksProducer } from './producer-full-checks.js';

export const devQualificationInterfaceBlocker =
  'Development proof requires an explicitly referenced completed private application-foundation receipt, immutable build source/artifact, ' +
  'the registered exact runtime observation workflow and independently approved disposable target/actors/effects/spend/time. ' +
  'Missing runtime prerequisites are not implementation completion or live qualification.';

export const stagingQualificationInterfaceBlocker =
  'Staging requires the original completed private deployment, immutable build, published security recipe, separately owned runner assignment ' +
  'and actual same-job security/DAST/private-access observations. Runtime prerequisites, unsupported profile implementation and live qualification remain distinct.';

export const greenRedQualificationInterfaceBlocker =
  'Full-activation controlled fixtures require their exact source-bound ' +
  'unmerged positive/negative ref-family records and actual validation steps, plus genuine full environment predecessors. ' +
  'Repository-only qualified receipts and arbitrary green/red pairs cannot substitute; literal release/** and hotfix/** coverage is required.';

export interface FullActivationProofReferences {
  sourceSha: string;
  artifactDigest: string;
  staging: QualificationEvidenceReference;
  rehearsal: QualificationEvidenceReference;
  greenRed: QualificationEvidenceReference;
}

/**
 * Compatibility facade for header-only callers. Actual qualification uses the
 * asynchronous private-witness and provider readback engines.
 */
export function validateFullActivationProofReceipts(
  inspection: PhaseEvidenceSource, scope: GovernanceScope | undefined, references: FullActivationProofReferences, now: Date
): { valid: false; blocker: string } {
  if ((scope ?? 'activation') !== 'activation') {
    return { valid: false, blocker: environmentQualificationScopeBlocker };
  }
  if (!isRecord(references)) return { valid: false, blocker: 'Full activation requires explicit original receipt, source and artifact references.' };
  if (!Number.isFinite(now.getTime())) return { valid: false, blocker: 'Full activation requires the current explicit verification clock.' };
  try {
    const source = sourceSha(references.sourceSha);
    const artifact = applicationImageDigest(references.artifactDigest);
    for (const [phaseId, reference] of [
      ['staging-qualified', references.staging],
      ['production-rehearsed', references.rehearsal],
      ['green-red-proof', references.greenRed]
    ] as const) {
      const { record } = requireQualificationEvidence(inspection, phaseId, reference, now);
      if (!isRecord(record.payload) || record.payload.sourceSha !== source || record.payload.artifactDigest !== artifact) {
        return { valid: false, blocker: 'Every original full-activation receipt must bind the same exact application source and artifact. A workflow conclusion or rehashed nativeQualification assertion is insufficient.' };
      }
    }
  } catch (error) {
    if (!(error instanceof AzureActivationAdmissionError) && !(error instanceof GitHubActivationError) && !(error instanceof AzureArmError)) throw error;
    return { valid: false, blocker: error.message };
  }
  return {
    valid: false,
    blocker: 'Header-only full proof admission is unavailable. Use the registered asynchronous staging, rehearsal and controlled-check readback engines; public assertions cannot replace original private witnesses or actual provider bytes.'
  };
}

export async function executeDevProofProducer(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  return executeProductionDevProof(input);
}

export async function executeStagingQualificationProducer(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  return executeProductionStaging(input);
}

export async function executeGreenRedProofProducer(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  return fullProductionChecksProducer.execute(input);
}

import type { PhasePlanBuild, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { applicationPrivateAssert as must, type ApplicationPrivateConfiguration } from './application-private-contracts.js';
import {
  applicationPrivateInputs, applicationPrivateOperations, applicationPrivateWindow,
  assertApplicationPrivateArtifact, assertApplicationPrivateReview
} from './application-private-inputs.js';
import { inspectApplicationPrivateSource } from './application-private-source.js';
import { readApplicationPrivateArtifactRoles } from './application-private-artifacts.js';
import { applicationPrivateFailureMessage } from './application-private-custody.js';
import { assertApplicationRehearsalArtifact } from './application-rehearsal-inputs.js';

export async function assertApplicationPrivateExecutionArtifact(
  input: PhasePlanningInput & { clock?: () => Date }, config: ApplicationPrivateConfiguration
): Promise<void> {
  if (config.artifactSet) {
    await readApplicationPrivateArtifactRoles(input, config);
    return;
  }
  if (input.phase.id === 'production-rehearsed') assertApplicationRehearsalArtifact(input, config.artifact);
  else assertApplicationPrivateArtifact(input, config.artifact);
}

/** Plans existing-backend resource execution; initialization remains the phase dispatcher's responsibility. */
export async function planApplicationPrivateResources(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try {
    const config = applicationPrivateInputs(input);
    const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, config);
    assertApplicationPrivateReview(input, config, source);
    if (config.mode !== 'recover' || config.recovery === 'publish-retained') await assertApplicationPrivateExecutionArtifact(input, config);
    const window = applicationPrivateWindow(config);
    must(Date.parse(window.expiresAt) > input.now.getTime(), 'execution-window-expired');
    return { operations: applicationPrivateOperations(input, config, source) };
  } catch (error) { return { operations: [], blockers: [applicationPrivateFailureMessage(error)] }; }
}

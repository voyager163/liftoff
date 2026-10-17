import { inspectModernInstalledActivation } from './modern-installed-preflight.js';
import { modernManifestMatchesObservation } from '../project/manifest.js';
import { resolveModernManifestSourceContext } from '../project/source-context.js';
import { projectCatalog } from '../project/catalog.js';
import { resolveUpdatePreviewLocation } from '../../adapters/filesystem/update-previews.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { createSource5WorkflowContext } from '../../governance-activation/workflow-source5-context.js';
import { planSource5WorkflowReview } from '../../governance-activation/workflow-source5-review.js';
import type { Source5WorkflowReviewRequest } from '../../governance-activation/workflow-source5-review.js';
import { captureWorkflowBinding, workflowFailure } from '../../governance-activation/workflow-binding.js';

export async function inspectModernWorkflowReview(
  projectRoot: string, manifest: LiftoffManifestV8, request: Source5WorkflowReviewRequest
) {
  request = captureWorkflowBinding(request);
  const startedAt = new Date().toISOString();
  const installed = await inspectModernInstalledActivation(projectRoot);
  if (installed.status !== 'observed') {
    return workflowFailure('workflow-source5-review-installed', installed.blockers.join(' '));
  }
  if (manifest.governance.profile === 'none' || !modernManifestMatchesObservation(manifest, installed.snapshot)) {
    return workflowFailure('workflow-source5-review-manifest', 'Workflow review requires the actual unchanged governed modern manifest, not governance-none or a stale selected manifest.');
  }
  const source = resolveModernManifestSourceContext(manifest);
  const context = createSource5WorkflowContext(projectCatalog, {
    recordedIdentity: manifest.governance.activationIdentity, profile: manifest.governance.profile,
    policyVersion: manifest.governance.policyVersion, selection: { ...source.selection, profile: manifest.governance.profile },
    pluginResolutionDigest: source.plugins.resolutionDigest,
    activeLayoutDigest: manifest.governance.activationIdentity.activeLayoutDigest
  });
  const location = await resolveUpdatePreviewLocation(projectRoot);
  if (location.projectRoot !== installed.snapshot.root) {
    return workflowFailure('workflow-source5-review-root', 'The actual installed root and independently resolved project location differ.');
  }
  const review = planSource5WorkflowReview({ context, installed, projectKey: location.projectKey, request });
  const after = await inspectModernInstalledActivation(projectRoot);
  if (after.status !== 'observed' || after.snapshot.root !== installed.snapshot.root ||
    after.binding !== installed.binding ||
    canonicalSha256(after.snapshot.physical) !== canonicalSha256(installed.snapshot.physical)) {
    return workflowFailure('workflow-source5-review-drift', 'Installed source or physical file identities changed while the workflow review was being constructed.');
  }
  return captureWorkflowBinding({
    schemaVersion: 1, kind: 'liftoff-modern-workflow-review', command: 'governance plan',
    projectRoot: installed.snapshot.root, scope: 'activation', status: 'blocked', readOnly: true,
    projectWrites: false, externalMetadataWrites: false, providerWrites: false, workloadExecution: false,
    activationComplete: false, phaseComplete: false, matrixComplete: false, executionAuthorized: false,
    recordedProgressIsCurrentProof: false, review,
    observations: {
      startedAt, endedAt: new Date().toISOString(), beforeObservedAt: installed.snapshot.observedAt,
      afterObservedAt: after.snapshot.observedAt, installedBinding: installed.binding,
      physicalDigest: canonicalSha256(installed.snapshot.physical)
    },
    blockers: [{
      code: 'workflow-current-prerequisite-observer-unavailable',
      phaseId: request.phaseId,
      dependencies: review.prerequisites.dependencies,
      message: 'The independently current modern prerequisite observer is not composed. Stored phase/evidence records and this review cannot authorize source publication, dispatch or phase completion.'
    }, ...(['staging-qualified', 'production-rehearsed'].includes(request.phaseId) ? [{
      code: 'workflow-current-azure-peer-required', phaseId: request.phaseId,
      message: 'Current Azure deployment/promotion/rollback peer evidence must be composed separately; GitHub job success cannot discharge Azure obligations.'
    }] : []), ...(request.phaseId !== 'bootstrap-workflow-source-ready' ? [{
      code: 'workflow-current-native-host-required', phaseId: request.phaseId,
      message: 'Where private state/runner prerequisites apply, ProtectedStateHandoverPort, ProtectedStateCustodyPort and the independently current qualified native host remain required. Runner-group workflow admission is not host qualification.'
    }] : [])]
  });
}

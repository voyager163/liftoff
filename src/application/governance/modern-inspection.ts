import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import type { GovernanceScope } from '../../domain/governance/activation/types.js';
import type { InstalledLocalClassification } from '../../domain/governance/activation/modern-local-runtime.js';
import type { LocalPublicationOutcome } from './modern-local-publication.js';
import type { SuccessorRevalidationOutcome } from '../update/modern-revalidation-publication.js';
import { modernManifestMatchesObservation } from '../project/manifest.js';

export const modernGovernanceReportSchemaVersion = 3;
export type ModernGovernanceInspectionCommand = 'status' | 'resume' | 'verify';

export async function inspectModernGovernance(input: {
  projectRoot: string;
  manifest: LiftoffManifestV8;
  command: ModernGovernanceInspectionCommand;
  scope?: GovernanceScope;
  revalidationPublication?: string;
}) {
  const { inspectCompletionBoundary } = await import('./modern-local-finalization.js');
  const { inspectModernInstalledActivation } = await import('./modern-installed-preflight.js');
  const boundary = await inspectCompletionBoundary(input.projectRoot);
  const transaction = {
    status: boundary.transaction.status,
    committed: boundary.transaction.committed,
    planFingerprint: boundary.transaction.planFingerprint ?? null,
    transactionDigest: boundary.transaction.transactionDigest ?? null,
    reason: boundary.transaction.reason ?? null
  };
  const report = {
    schemaVersion: modernGovernanceReportSchemaVersion,
    kind: 'liftoff-modern-governance-inspection' as const,
    command: `governance ${input.command}`,
    projectRoot: boundary.root,
    scope: input.scope ?? (input.command === 'resume' ? 'local' : 'activation'),
    readOnly: true as const,
    projectWrites: false as const,
    providerWrites: false as const,
    workloadExecution: false as const,
    consistent: false,
    complete: null as boolean | null,
    outcome: 'invalid' as 'invalid' | 'incomplete' | 'complete',
    source: {
      status: 'blocked' as 'blocked' | 'observed',
      classification: null as InstalledLocalClassification | null,
      binding: null as string | null,
      observedAt: null as string | null
    },
    activationDisabled: input.manifest.governance.profile === 'none',
    localComplete: false,
    activationComplete: false,
    lifecycleComplete: false,
    publication: null as LocalPublicationOutcome | SuccessorRevalidationOutcome | null,
    localVerification: 'not-observed' as 'not-observed' | 'current' | 'incomplete',
    recordedPhases: [] as { id: string; state: string; evidenceCount: number; approvalCount: number }[],
    recordedProgressIsCurrentProof: false as const,
    retainedStateObligations: 0,
    transaction,
    blockers: [] as string[]
  };
  if (boundary.transaction.status !== 'absent') {
    report.blockers.push('Local publication requires attributed recovery; inspection did not recover or replay it.');
    return report;
  }
  const installed = await inspectModernInstalledActivation(boundary.root);
  if (installed.status !== 'observed') {
    report.blockers.push(...installed.blockers);
    return report;
  }
  if (installed.classification === 'released-source' || !modernManifestMatchesObservation(input.manifest, installed.snapshot)) {
    report.blockers.push('The captured manifest differs from the selected modern project; inspect the current source again.');
    return report;
  }
  report.source = {
    status: 'observed', classification: installed.classification,
    binding: installed.binding, observedAt: installed.snapshot.observedAt
  };
  report.recordedPhases = Object.entries(installed.current?.state.phases ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([id, phase]) => ({
    id, state: phase.state, evidenceCount: phase.evidence.length, approvalCount: phase.approvals.length
  }));
  report.retainedStateObligations = installed.retention.filter(item => item.status === 'retained').length;
  if (input.revalidationPublication !== undefined) {
    if (installed.classification !== 'successor') {
      throw new Error('A revalidation publication fingerprint requires an activation-history successor, not a fresh or manifest-only project.');
    }
    const { inspectModernSuccessorRevalidationPublication } = await import('../update/modern-revalidation-publication.js');
    report.publication = await inspectModernSuccessorRevalidationPublication(boundary.root, input.revalidationPublication);
  } else if (installed.classification !== 'successor') {
    const { inspectModernLocalCompletion } = await import('./modern-local-publication.js');
    report.publication = await inspectModernLocalCompletion(boundary.root);
  } else {
    report.blockers.push('Select the exact separately approved revalidation publication with --revalidation-publication; recorded journal progress is not current proof.');
  }
  if (report.publication) {
    const current = await inspectModernInstalledActivation(boundary.root);
    if (current.status !== 'observed' || current.binding !== installed.binding) {
      report.blockers.push('Installed source changed during publication inspection; committed progress is retained, but current completion is indeterminate.');
      return report;
    }
  }
  report.localComplete = report.publication?.status === 'local-complete-current' ||
    report.publication?.status === 'revalidation-complete-current';
  report.localVerification = report.localComplete ? 'current' : report.publication ? 'incomplete' : 'not-observed';
  if (!report.localComplete && report.publication) {
    report.blockers.push(`Local publication is ${report.publication.status}; no verification, publication or recovery was executed.`);
  }
  report.consistent = true;
  if (input.scope === undefined && input.command === 'resume' && report.localComplete) report.scope = 'activation';
  report.complete = report.scope === 'local' ? report.localComplete : report.activationDisabled;
  if (report.scope !== 'local' && !report.activationDisabled) {
    report.blockers.push(`Current ${report.scope} completion is not established by local proof or stored phase records.`);
  }
  report.outcome = report.complete ? 'complete' : 'incomplete';
  return report;
}

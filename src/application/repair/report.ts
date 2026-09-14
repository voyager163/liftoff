import type { ExecutionContext } from '../context.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import type { RepairExecutionIdentity } from '../../domain/repair/identity.js';
import type { UpdateApprovalResult } from '../update/approval.js';
import type { RepairDiscovery } from './discovery.js';
import type { mutationDescriptors } from './preview.js';
import type { RepairVerificationReceipt } from './verification-receipt.js';
import type { ApplicationVerificationResult } from './application-types.js';
import type { RepairWorkspaceInspection, RepairWorkspaceRecoveryResult } from './workspaces-types.js';
import { repairCapabilities } from './capabilities.js';

export type RepairScope = 'local-infrastructure' | 'application-layout' | 'repair-recovery';

interface RepairActionBase {
  id: string;
  label: string;
  description: string;
  scope: string;
  cwd: string;
  approvalRequired: boolean;
}

export type RepairNextAction = RepairActionBase & (
  | { kind: 'command'; command: ExternalCommand; displayCommand: string; requiresInput?: string[] }
  | { kind: 'agent'; invocation: string; agent: string }
  | { kind: 'guidance' }
);

export interface RepairReport {
  schemaVersion: 2;
  operationKind: 'check' | 'apply' | 'recover' | 'inspect-layout' | 'verify';
  requestedScope: RepairScope;
  projectRoot: string;
  status: 'current' | 'inspected' | 'available' | 'blocked' | 'verified' | 'applied' | 'failed' | 'recovered' | 'partial';
  committed: boolean;
  repairScopeComplete: boolean;
  verification: 'not-run' | 'not-required' | 'passed' | 'incomplete';
  message: string;
  blockers: string[];
  nextActions: RepairNextAction[];
  capabilities: typeof repairCapabilities;
  identity?: RepairExecutionIdentity;
  approval?: UpdateApprovalResult;
  layout?: string;
  eligibility?: RepairDiscovery;
  fingerprint?: string;
  expiresAt?: string;
  receiptPath?: string;
  historyPath?: string;
  backupPath?: string;
  operations?: ReturnType<typeof mutationDescriptors>;
  validationPolicy?: unknown;
  validationSummary?: string[];
  application?: unknown;
  applicationSummary?: string[];
  verificationReceipt?: RepairVerificationReceipt;
  verificationResult?: ApplicationVerificationResult;
  verificationEffects?: {
    attempted: boolean;
    networkAuthorized: boolean;
    dependencyPreparationAuthorized?: boolean;
    outcome: 'not-run' | 'passed' | 'incomplete';
    boundary: string;
  };
  recovery?: { schemaVersion?: number; identity?: RepairExecutionIdentity };
  privateWorkspaces?: RepairWorkspaceInspection;
  privateWorkspaceRecovery?: RepairWorkspaceRecoveryResult;
}

export function emitRepairReport(context: ExecutionContext, json: boolean, report: RepairReport): void {
  if (json) {
    context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  context.presentation.status(
    report.status === 'failed' ? 'error' :
      ['blocked', 'partial', 'available'].includes(report.status) ? 'warning' : 'success',
    'Project repair', report.message
  );
  context.presentation.definitions('Selected repair scope', [
    { label: 'Project', value: report.projectRoot },
    { label: 'Scope', value: report.requestedScope === 'application-layout' ? 'Reviewed application files' :
      report.requestedScope === 'repair-recovery' ? 'Recorded interrupted repair' : 'Local Azure infrastructure layout' },
    ...(report.layout ? [{ label: 'Layout', value: report.layout }] : []),
    ...(report.eligibility ? [{ label: 'Eligibility', value: report.eligibility.status }] : []),
    ...(report.identity ? [{ label: 'Repair identity', value: `Contract ${report.identity.repairContractVersion}; ${report.identity.recipe.id} v${report.identity.recipe.version}` }] : []),
    ...(report.expiresAt ? [{ label: 'Review expires', value: report.expiresAt }] : []),
    ...(report.receiptPath ? [{ label: 'External receipt', value: report.receiptPath }] : []),
    ...(report.historyPath ? [{ label: 'Preserved history', value: report.historyPath }] : []),
    ...(report.backupPath ? [{ label: 'Private original-byte backup', value: report.backupPath }] : [])
  ]);
  if (report.operations?.length) context.presentation.bullets('Exact project file changes',
    report.operations.map((entry) =>
      `${entry.type} ${entry.pathParts.join('/')}${entry.digest ? ` (SHA-256 ${entry.digest})` : ''}`));
  if (report.applicationSummary?.length) context.presentation.bullets('Application review', report.applicationSummary);
  if (report.validationSummary?.length) context.presentation.bullets('Separate validation effects', report.validationSummary);
  if (report.verificationEffects?.attempted) context.presentation.bullets('Previously authorized effects', [
    `Staged verification ${report.verificationEffects.outcome === 'passed' ? 'passed its declared checks' : 'ran or was attempted without complete verification'}.`,
    ...(report.verificationEffects.dependencyPreparationAuthorized ? ['Locked dependency preparation was separately authorized in a private environment.'] : []),
    report.verificationEffects.boundary
  ]);
  const workspaces = report.privateWorkspaces?.workspaces ?? report.privateWorkspaceRecovery?.retained;
  if (workspaces?.length) context.presentation.bullets('Registered private verification workspaces',
    workspaces.map((workspace) =>
      `${workspace.workspaceId}: ${workspace.phase}; owner ${workspace.owner}; ${workspace.directory}. ` +
      workspace.issues.map((issue) => issue.message).join(' ')));
  if (report.privateWorkspaceRecovery?.results.length) context.presentation.bullets('Private cleanup outcomes',
    report.privateWorkspaceRecovery.results.map((result) =>
      `${result.workspaceId}: ${result.status}; removed ${result.removedEntries} disposable entries.`));
  if (report.blockers.length) context.presentation.bullets('Blockers', report.blockers);
  context.presentation.bullets('Next steps', report.nextActions.map((action) => {
    if (action.kind === 'command') return `${action.label}: ${action.displayCommand}${action.requiresInput?.length ? ' (replace the indicated input first)' : ''}. ${action.description}`;
    if (action.kind === 'agent') return `${action.label}: ${action.invocation} in ${action.agent}, not in your shell. ${action.description}`;
    return `${action.label}: ${action.description}`;
  }));
}

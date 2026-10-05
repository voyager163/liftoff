import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { readPublicGovernanceInputs } from '../../adapters/filesystem/governance-records.js';
import {
  approveModernLocalExecution, approveModernManualNativeExecution, approveModernOpenSpecInitializedBaseline, inspectModernLocalExecution,
  loadLocalExecutionPreview, prepareModernArchivedOpenSpecExecution, prepareModernLocalExecution,
  prepareModernManualNativeExecution, prepareModernOpenSpecExecution, prepareModernOpenSpecInitializedBaseline
} from '../../application/governance/modern-local-approval.js';
import { executeModernLocalExecution } from '../../application/governance/modern-local-execution.js';
import {
  modernLocalCommandReportSchemaVersion, parseModernLocalConsentRequest, parseModernLocalVerificationRequest
} from '../../application/governance/modern-local-request.js';
import type { CommandOutcome } from '../../application/command-outcome.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { LocalExecutionResult } from '../../domain/governance/activation/modern-local-runtime.js';
import { errorMessage } from '../../governance-activation/transition-process.js';
import type { PresentationSession } from '../../terminal.js';
import { modernLocalOperationIssue } from '../args/governance-local.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';
import { json } from './governance-output.js';

export async function governanceLocalCommand(
  parsed: ParsedArgs,
  context: { cwd: string; projectRoot: string; presentation: PresentationSession; outcome?: CommandOutcome }
): Promise<number> {
  const { presentation } = context;
  let projectRoot = context.projectRoot;
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  let executionRequested = false, externalMetadataWriteRequested = false;
  const report = (status: 'planned' | 'approved' | 'not-executed' | LocalExecutionResult['status'], detail: object, code = 0) => {
    if (!jsonMode) presentation.status(code ? 'error' : 'info', 'Local verification', status);
    json(presentation, {
      schemaVersion: modernLocalCommandReportSchemaVersion,
      kind: 'liftoff-modern-local-command', command: `governance ${parsed.subcommand}`,
      projectRoot, scope: 'local', operation: 'verify', status,
      executionRequested, externalMetadataWriteRequested,
      localComplete: false, activationComplete: false, lifecycleComplete: false,
      publicationAuthorized: false, providerOperationsAuthorized: false,
      boundary: 'Private-workspace verification is not a sandbox, workflow finalization, publication, successor revalidation, or full project readiness. Native Manual may separately authorize locked provider downloads and local provider binaries, never Azure/GitHub resource operations.',
      ...detail
    });
    context.outcome?.record(code ? 'failure' : status === 'not-executed' ? 'attention-required' : 'success');
    return code;
  };
  try {
    const issue = modernLocalOperationIssue(parsed);
    if (issue) throw new Error(issue);
    if (parsed.flags['local-operation'] !== 'verify') throw new Error('Explicit --local-operation verify is required.');
    projectRoot = await realpath(projectRoot);
    const inputsFile = readStringFlag(parsed.flags, 'inputs');
    const fingerprint = readStringFlag(parsed.flags, 'plan');
    if (parsed.subcommand === 'plan' && inputsFile) {
      const request = await readPublicGovernanceInputs(path.resolve(context.cwd, inputsFile), 'Local execution', parseModernLocalVerificationRequest);
      externalMetadataWriteRequested = true;
      const { preparation } = request;
      const preview = request.kind === 'verify-local' ? await prepareModernLocalExecution(projectRoot, { kind: request.kind, preparation })
        : request.kind === 'verify-manual-native' ? await prepareModernManualNativeExecution(projectRoot, { kind: request.kind, preparation })
        : request.kind === 'verify-openspec-local' ? await prepareModernOpenSpecExecution(projectRoot, { kind: request.kind, preparation })
        : request.kind === 'verify-openspec-initialized' ? await prepareModernOpenSpecInitializedBaseline(projectRoot, { kind: request.kind, preparation })
        : await prepareModernArchivedOpenSpecExecution(projectRoot, { kind: request.kind, preparation });
      return report('planned', { preview, fingerprint: preview.fingerprint, operationComplete: true, verificationComplete: false });
    }
    if (parsed.subcommand === 'approve' && inputsFile && fingerprint) {
      const request = await readPublicGovernanceInputs(path.resolve(context.cwd, inputsFile), 'Local execution', parseModernLocalConsentRequest);
      const preview = await loadLocalExecutionPreview(projectRoot, fingerprint);
      if ((preview.schemaVersion === 4) !== (request.kind === 'approve-openspec-initialized') ||
          (preview.schemaVersion === 6) !== (request.kind === 'approve-manual-native')) {
        throw new Error('The consent kind must match the exact native Manual, initialized or ordinary local verification preview.');
      }
      externalMetadataWriteRequested = true;
      const consent = request.kind === 'approve-openspec-initialized'
        ? await approveModernOpenSpecInitializedBaseline(projectRoot, fingerprint, {
          scopes: request.scopes, bootstrapScopeAttestation: request.bootstrapScopeAttestation
        })
        : request.kind === 'approve-manual-native' ? await approveModernManualNativeExecution(projectRoot, fingerprint, request.scopes)
        : await approveModernLocalExecution(projectRoot, fingerprint, request.scopes);
      return report('approved', { consent, fingerprint, operationComplete: true, verificationComplete: false });
    }
    if (parsed.subcommand === 'apply-next' && fingerprint) {
      if (readBooleanFlag(parsed.flags, 'execute') !== true) {
        const inspection = await inspectModernLocalExecution(projectRoot, fingerprint);
        return report(inspection.status === 'blocked' ? 'blocked' : 'not-executed', {
          fingerprint, inspection, operationComplete: false, verificationComplete: false, recordedProgressIsCurrentProof: false
        }, inspection.status === 'blocked' ? 1 : 0);
      }
      executionRequested = true;
      externalMetadataWriteRequested = true;
      const result = await executeModernLocalExecution(projectRoot, fingerprint);
      return report(result.status, {
        fingerprint, result, operationComplete: result.complete,
        verificationScope: result.schemaVersion === 5 ? 'manual-locked-local-baseline'
          : result.schemaVersion === 3 ? 'generated-initialization-obligations' : 'captured-local-baseline',
        verificationComplete: result.schemaVersion !== 3 && result.complete
      }, result.complete ? 0 : 1);
    }
    throw new Error('Select an explicit local verification plan, approval, or exact apply-next request.');
  } catch (error) {
    return report('failed', { diagnostics: [errorMessage(error)], operationComplete: false, verificationComplete: false }, 1);
  }
}

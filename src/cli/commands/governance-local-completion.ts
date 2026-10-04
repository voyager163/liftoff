import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { readPublicGovernanceInputs } from '../../adapters/filesystem/governance-records.js';
import {
  approveModernLocalFinalization, finalizeModernLocalCompletion, prepareModernLocalFinalization, readFinalizationPreview
} from '../../application/governance/modern-local-finalization.js';
import {
  approveModernLocalPublication, publishModernLocalCompletion, recoverModernLocalCompletion, type LocalPublicationOutcome
} from '../../application/governance/modern-local-publication.js';
import {
  inspectModernLocalFinalization, inspectModernLocalPublication, reviewModernLocalPublication
} from '../../application/governance/modern-local-completion-inspection.js';
import {
  modernLocalCompletionReportSchemaVersion, parseModernLocalFinalizationRequest, parseModernLocalFinalizationConsent,
  parseModernLocalPublicationRequest, parseModernLocalPublicationConsent
} from '../../application/governance/modern-local-completion-request.js';
import type { CommandOutcome } from '../../application/command-outcome.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import { errorMessage } from '../../governance-activation/transition-process.js';
import type { PresentationSession } from '../../terminal.js';
import { modernLocalOperationIssue } from '../args/governance-local.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';
import { json } from './governance-output.js';

type Status = 'planned' | 'approved' | 'finalized' | 'not-executed' | 'failed' | LocalPublicationOutcome['status'];

export async function governanceLocalCompletionCommand(
  parsed: ParsedArgs,
  context: { cwd: string; projectRoot: string; presentation: PresentationSession; outcome?: CommandOutcome }
): Promise<number> {
  const operation = parsed.flags['local-operation'] === 'finalize' ? 'finalize'
    : parsed.flags['local-operation'] === 'publish' ? 'publish' : null;
  let projectRoot = context.projectRoot;
  let executionRequested = false, externalMetadataWriteRequested = false;
  let publication: LocalPublicationOutcome | null = null;
  const report = (status: Status, detail: object, code = 0) => {
    const projectFileEffectsRequested = executionRequested && operation === 'publish';
    const current = publication?.status === 'local-complete-current' && publication.committed &&
      publication.readbackDigest !== null && !publication.rollbackFailures.length && !publication.cleanupFailures.length;
    if (readBooleanFlag(parsed.flags, 'json') !== true) context.presentation.status(code ? 'error' : 'info', 'Local completion', status);
    json(context.presentation, {
      schemaVersion: modernLocalCompletionReportSchemaVersion, kind: 'liftoff-modern-local-completion-command',
      command: `governance ${parsed.subcommand}`, projectRoot, scope: 'local', operation, status,
      executionRequested, externalMetadataWriteRequested, projectFileEffectsRequested,
      publicationCommitted: publication?.committed ?? (projectFileEffectsRequested ? null : false),
      projectFileEffectsUncertain: projectFileEffectsRequested &&
        (publication === null || publication.rollbackFailures.length > 0 || publication.cleanupFailures.length > 0),
      localComplete: current, activationComplete: false, lifecycleComplete: false, providerOperationsAuthorized: false,
      boundary: 'Selected local finalization and exact-file publication only. Failure does not imply rollback; saved progress is not current proof. No successor, provider, OpenSpec finalization, or whole-directory move/rollback authority.',
      ...detail
    });
    context.outcome?.record(code ? 'failure' : status === 'not-executed' ? 'attention-required' : 'success');
    return code;
  };
  try {
    const issue = modernLocalOperationIssue(parsed);
    if (issue) throw new Error(issue);
    if (!operation) throw new Error('Explicit --local-operation finalize or publish is required.');
    projectRoot = await realpath(projectRoot);
    const inputs = readStringFlag(parsed.flags, 'inputs'), fingerprint = readStringFlag(parsed.flags, 'plan');
    if (parsed.subcommand === 'plan' && inputs) {
      const file = path.resolve(context.cwd, inputs);
      if (operation === 'finalize') {
        const request = await readPublicGovernanceInputs(file, 'Local completion', parseModernLocalFinalizationRequest);
        externalMetadataWriteRequested = true;
        const preview = await prepareModernLocalFinalization(projectRoot, request);
        return report('planned', { preview, fingerprint: preview.fingerprint, operationComplete: true });
      }
      const request = await readPublicGovernanceInputs(file, 'Local completion', parseModernLocalPublicationRequest);
      const review = await reviewModernLocalPublication(projectRoot, request.publicationFingerprint);
      return report('planned', { review, fingerprint: request.publicationFingerprint, operationComplete: true });
    }
    if (parsed.subcommand === 'approve' && inputs && fingerprint) {
      const file = path.resolve(context.cwd, inputs);
      if (operation === 'finalize') {
        const request = await readPublicGovernanceInputs(file, 'Local completion', parseModernLocalFinalizationConsent);
        const preview = await readFinalizationPreview(projectRoot, fingerprint);
        if ((preview.schemaVersion === 2) !== (request.kind === 'approve-spec-kit-finalization')) {
          throw new Error('Finalization consent must match the exact Manual or Spec Kit preview.');
        }
        externalMetadataWriteRequested = true;
        const consent = await approveModernLocalFinalization(projectRoot, fingerprint, request.scopes);
        return report('approved', { fingerprint, consent, operationComplete: true });
      }
      const request = await readPublicGovernanceInputs(file, 'Local completion', parseModernLocalPublicationConsent);
      externalMetadataWriteRequested = true;
      const consent = await approveModernLocalPublication(projectRoot, fingerprint, request.authorization);
      return report('approved', { fingerprint, consent, operationComplete: true });
    }
    if ((parsed.subcommand === 'apply-next' || parsed.subcommand === 'recover') && fingerprint) {
      if (readBooleanFlag(parsed.flags, 'execute') !== true) {
        const inspection = operation === 'finalize' ? await inspectModernLocalFinalization(projectRoot, fingerprint)
          : await inspectModernLocalPublication(projectRoot, fingerprint);
        return report('not-executed', { fingerprint, inspection, operationComplete: false, recordedProgressIsCurrentProof: false });
      }
      executionRequested = true;
      externalMetadataWriteRequested = true;
      if (operation === 'finalize') {
        const result = await finalizeModernLocalCompletion(projectRoot, fingerprint);
        return report('finalized', { fingerprint, result, operationComplete: true });
      }
      publication = parsed.subcommand === 'recover'
        ? await recoverModernLocalCompletion(projectRoot, { publicationFingerprint: fingerprint })
        : await publishModernLocalCompletion(projectRoot, fingerprint);
      const complete = publication.status === 'local-complete-current' && publication.committed && publication.readbackDigest !== null;
      const rolledBack = parsed.subcommand === 'recover' && publication.status === 'rolled-back' && !publication.committed;
      const operationComplete = (complete || rolledBack) && !publication.rollbackFailures.length && !publication.cleanupFailures.length;
      return report(publication.status, { fingerprint, result: publication, operationComplete }, operationComplete ? 0 : 1);
    }
    throw new Error('Select an explicit finalization, publication review, exact approval, execution, or attributed recovery request.');
  } catch (error) {
    return report('failed', { diagnostics: [errorMessage(error)], operationComplete: false }, 1);
  }
}

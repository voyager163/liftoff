import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { readPublicGovernanceInputs } from '../../adapters/filesystem/governance-records.js';
import { prepareModernSuccessorRevalidation } from '../../application/update/modern-revalidation-records.js';
import {
  approveModernSuccessorRevalidationPublication, publishModernSuccessorRevalidation, recoverModernSuccessorRevalidation,
  type SuccessorRevalidationOutcome
} from '../../application/update/modern-revalidation-publication.js';
import {
  inspectModernRevalidationProgress, reviewModernRevalidationPublication
} from '../../application/update/modern-revalidation-inspection.js';
import {
  modernRevalidationCommandReportSchemaVersion, parseModernRevalidationRequest, parseModernRevalidationConsent
} from '../../application/update/modern-revalidation-request.js';
import type { CommandOutcome } from '../../application/command-outcome.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import { errorMessage } from '../../governance-activation/transition-process.js';
import type { PresentationSession } from '../../terminal.js';
import { modernLocalOperationIssue } from '../args/governance-local.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';
import { json } from './governance-output.js';

type Status = 'planned' | 'approved' | 'not-executed' | 'failed' | SuccessorRevalidationOutcome['status'];

export async function governanceLocalRevalidationCommand(
  parsed: ParsedArgs,
  context: { cwd: string; projectRoot: string; presentation: PresentationSession; outcome?: CommandOutcome }
): Promise<number> {
  let projectRoot = context.projectRoot, executionRequested = false, externalMetadataWriteRequested = false;
  let publication: SuccessorRevalidationOutcome | null = null;
  const currentReadback = () => Boolean(publication?.committed && publication.readbackDigest !== null &&
    !publication.rollbackFailures.length && !publication.cleanupFailures.length);
  const report = (status: Status, detail: object, code = 0) => {
    const complete = currentReadback() && publication?.status === 'revalidation-complete-current';
    if (readBooleanFlag(parsed.flags, 'json') !== true) {
      context.presentation.status(code === 1 ? 'error' : code === 2 ? 'warning' : 'info', 'Successor revalidation', status);
    }
    json(context.presentation, {
      schemaVersion: modernRevalidationCommandReportSchemaVersion, kind: 'liftoff-modern-revalidation-command',
      command: `governance ${parsed.subcommand}`, projectRoot, scope: 'local', operation: 'revalidate-successor', status,
      executionRequested, externalMetadataWriteRequested, projectFileEffectsRequested: executionRequested,
      publicationCommitted: publication?.committed ?? (executionRequested ? null : false),
      projectFileEffectsUncertain: executionRequested &&
        (publication === null || publication.rollbackFailures.length > 0 || publication.cleanupFailures.length > 0),
      revalidationComplete: complete, localComplete: complete, activationComplete: false, lifecycleComplete: false,
      providerOperationsAuthorized: false,
      boundary: 'Existing successor local records only, after separately approved verification and exact-byte publication consent. Failure does not imply rollback; saved progress is not current proof. Incomplete committed revalidation remains active. No new successor, workflow finalization, provider, or whole-directory move/rollback authority.',
      ...detail
    });
    context.outcome?.record(code === 1 ? 'failure' : code === 2 || status === 'not-executed' ? 'attention-required' : 'success');
    return code;
  };
  try {
    const issue = modernLocalOperationIssue(parsed);
    if (issue) throw new Error(issue);
    if (parsed.flags['local-operation'] !== 'revalidate-successor') throw new Error('Explicit --local-operation revalidate-successor is required.');
    projectRoot = await realpath(projectRoot);
    const inputs = readStringFlag(parsed.flags, 'inputs'), fingerprint = readStringFlag(parsed.flags, 'plan');
    if (parsed.subcommand === 'plan' && inputs) {
      const request = await readPublicGovernanceInputs(path.resolve(context.cwd, inputs), 'Successor revalidation', parseModernRevalidationRequest);
      let selected: string;
      if (request.kind === 'revalidate-successor') {
        externalMetadataWriteRequested = true;
        selected = (await prepareModernSuccessorRevalidation(projectRoot, request)).publicationFingerprint;
      } else selected = request.publicationFingerprint;
      const review = await reviewModernRevalidationPublication(projectRoot, selected);
      return report('planned', { fingerprint: selected, review, operationComplete: true });
    }
    if (parsed.subcommand === 'approve' && inputs && fingerprint) {
      const request = await readPublicGovernanceInputs(path.resolve(context.cwd, inputs), 'Successor revalidation', parseModernRevalidationConsent);
      externalMetadataWriteRequested = true;
      const consent = await approveModernSuccessorRevalidationPublication(projectRoot, fingerprint, request.authorization);
      return report('approved', { fingerprint, consent, operationComplete: true });
    }
    if ((parsed.subcommand === 'apply-next' || parsed.subcommand === 'recover') && fingerprint) {
      if (readBooleanFlag(parsed.flags, 'execute') !== true) {
        const inspection = await inspectModernRevalidationProgress(projectRoot, fingerprint);
        return report('not-executed', { fingerprint, inspection, operationComplete: false, recordedProgressIsCurrentProof: false });
      }
      executionRequested = true;
      externalMetadataWriteRequested = true;
      if (parsed.subcommand === 'recover') {
        await inspectModernRevalidationProgress(projectRoot, fingerprint);
        publication = await recoverModernSuccessorRevalidation(projectRoot, { publicationFingerprint: fingerprint });
      } else publication = await publishModernSuccessorRevalidation(projectRoot, fingerprint);
      const complete = currentReadback() && publication.status === 'revalidation-complete-current';
      const incomplete = currentReadback() && publication.status === 'revalidation-incomplete';
      const rolledBack = parsed.subcommand === 'recover' && publication.status === 'rolled-back' && !publication.committed &&
        !publication.rollbackFailures.length && !publication.cleanupFailures.length;
      const operationComplete = complete || rolledBack;
      return report(publication.status, { fingerprint, result: publication, operationComplete }, operationComplete ? 0 : incomplete ? 2 : 1);
    }
    throw new Error('Select explicit successor construction/review, exact publication approval, execution, or attributed recovery.');
  } catch (error) {
    return report('failed', { diagnostics: [errorMessage(error)], operationComplete: false }, 1);
  }
}

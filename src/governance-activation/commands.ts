import { readBooleanFlag, readStringFlag } from '../cli/args/readers.js';
import { realpath } from 'node:fs/promises';
import { findProjectRoot } from '../adapters/filesystem/project-discovery.js';
import type { PresentationSession } from '../terminal.js';
import type { ParsedArgs } from '../domain/project/contracts.js';
import type { CommandRunner } from '../process-runner.js';
import { governanceAssessmentCommand } from '../governance-assessment/command.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../domain/governance/activation/approvals.js';
import { executeApplyNext, previewApplyNext } from './transitions.js';
import { phaseIds, type GovernanceScope } from '../domain/governance/activation/types.js';
import { approveGovernancePreview, loadGovernancePreview, saveGovernancePreview } from './public-plans.js';
import { readGovernanceConfiguration } from '../application/repository-governance/configuration.js';
import path from 'node:path';
import type { GovernanceSubcommand, GovernanceInspection, GovernanceInspectionOptions } from '../application/repository-governance/inspection-contracts.js';
import { errorMessage, inspectGovernance, transitionInspection } from '../application/repository-governance/inspection.js';
import { statusJson, planJson } from '../application/repository-governance/reporting.js';
import { governanceAction, governanceNextActions } from '../application/repository-governance/continuation.js';
import { verifyJson } from '../application/repository-governance/verification.js';
import { json, renderStatusHuman, renderPlanHuman, renderCredentialPermissionReview, renderVerifyHuman, renderInspectionFailure, renderApplyNextHuman } from '../cli/governance/presentation.js';
import { sanitizeAssessmentText } from '../domain/governance/assessment/sanitize.js';
import type { UpdatePreviewOptions } from '../adapters/filesystem/update-previews.js';
import type { GovernanceTransitionAdapters } from './transition-ports.js';
import { bindGovernanceTransitionContext } from './transition-context.js';
export { inspectGovernanceTransition } from '../application/repository-governance/inspection.js';

export interface GovernanceCommandContext {
  cwd: string;
  presentation: PresentationSession;
  runner?: CommandRunner;
  storage?: UpdatePreviewOptions;
  adapters?: GovernanceTransitionAdapters;
}

export const governanceSubcommands = new Set<GovernanceSubcommand>([
  'status',
  'plan',
  'approve',
  'apply-next',
  'credential-enroll',
  'recover',
  'resume',
  'verify'
]);

export function parseGovernanceSubcommand(parsed: ParsedArgs): GovernanceSubcommand | undefined {
  if (!parsed.subcommand || !governanceSubcommands.has(parsed.subcommand as GovernanceSubcommand)) {
    return undefined;
  }
  return parsed.subcommand as GovernanceSubcommand;
}

export async function resolveGovernanceProjectRoot(
  parsed: ParsedArgs,
  context: GovernanceCommandContext
): Promise<string | undefined> {
  const positionalProject = parsed.positional[0];
  const flagProject = readStringFlag(parsed.flags, 'project');
  if (positionalProject && flagProject) {
    throw new Error('Provide a project path either positionally or with --project, not both.');
  }
  const explicit = positionalProject ?? flagProject;
  const start = explicit ? path.resolve(context.cwd, explicit) : context.cwd;
  const root = await findProjectRoot(start);
  return root ? await realpath(root) : undefined;
}

export function projectRootError(start: string): { message: string; remedy: string } {
  return {
    message: `No liftoff.manifest.json found in ${start} or any parent directory.`,
    remedy: 'Run this command inside a Liftoff project or provide its path explicitly.'
  };
}

export function governanceScopeFlag(parsed: ParsedArgs): GovernanceScope {
  const value = readStringFlag(parsed.flags, 'scope') ?? 'activation';
  if (value !== 'local' && value !== 'repository' && value !== 'activation' && value !== 'lifecycle') throw new Error('Governance scope must be local, repository, activation, or lifecycle.');
  return value;
}

export async function governanceCommand(parsed: ParsedArgs, context: GovernanceCommandContext): Promise<number> {
  try {
    return await dispatchGovernanceCommand(parsed, context);
  } catch (error) {
    if (parsed.subcommand !== 'verify') throw error;
    const project = readStringFlag(parsed.flags, 'project') ?? parsed.positional[0] ?? context.cwd;
    return renderInspectionFailure('verify', path.resolve(context.cwd, project), error, context.presentation,
      readBooleanFlag(parsed.flags, 'json') ?? false, governanceScopeFlag(parsed));
  }
}

async function dispatchGovernanceCommand(parsed: ParsedArgs, context: GovernanceCommandContext): Promise<number> {
  if (parsed.subcommand === 'assess') {
    const { storage } = bindGovernanceTransitionContext(context);
    return governanceAssessmentCommand(parsed, { ...context, storage });
  }
  const presentation = context.presentation;
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  const subcommand = parseGovernanceSubcommand(parsed);
  if (!subcommand) {
    presentation.error(
      'Missing governance subcommand.',
      'Run `liftoff governance --help` to choose a supported planning, approval, execution, or inspection command.'
    );
    return 1;
  }
  const rawScope = readStringFlag(parsed.flags, 'scope');
  if (rawScope && rawScope !== 'local' && rawScope !== 'repository' && rawScope !== 'activation' && rawScope !== 'lifecycle') {
    throw new Error('Governance scope must be local, repository, activation, or lifecycle.');
  }
  const scope = rawScope as GovernanceScope | undefined;
  let projectRoot: string | undefined;
  try {
    projectRoot = await resolveGovernanceProjectRoot(parsed, context);
  } catch (error) {
    throw new Error(`${errorMessage(error)} Run liftoff governance --help to review accepted project arguments.`);
  }
  if (!projectRoot) {
    const start = parsed.positional[0] ?? readStringFlag(parsed.flags, 'project') ?? context.cwd;
    const failure = projectRootError(path.resolve(context.cwd, start));
    presentation.error(failure.message, failure.remedy);
    return 1;
  }

  const inputsFile = readStringFlag(parsed.flags, 'inputs');
  const { storage, adapters } = bindGovernanceTransitionContext(context);
  const configured = inputsFile ? await readGovernanceConfiguration(inputsFile, context.cwd) : undefined;
  const activationInputs = configured?.configuration;
  const fingerprint = readStringFlag(parsed.flags, 'plan');
  const reviewed = fingerprint ? await loadGovernancePreview(projectRoot, fingerprint, { storage }) : undefined;
  if (reviewed && (scope ?? 'activation') !== (reviewed.plan.selectionScope ?? reviewed.plan.scope)) {
    throw new Error('The selected scope does not match the reviewed plan.');
  }
  if (reviewed?.plan.configurationBinding && configured &&
    canonicalSha256(reviewed.plan.configurationBinding) !== canonicalSha256(configured.binding)) {
    throw new Error('The selected input reference or bytes do not match the reviewed plan.');
  }
  if (subcommand === 'recover' && !reviewed?.plan.recovery) throw new Error('Recovery requires a preview explicitly created with governance plan --recover-phase.');
  if (subcommand === 'apply-next' && reviewed?.plan.recovery) throw new Error('A recovery preview can be executed only with governance recover.');
  if (subcommand === 'credential-enroll' && reviewed?.plan.phaseId !== 'credential-ready') {
    throw new Error('Credential enrollment requires a credential-ready preview, not another activation or repair plan.');
  }
  const requestedRecovery = readStringFlag(parsed.flags, 'recover-phase');
  const recoverPhase = reviewed?.plan.recovery ? reviewed.plan.phaseId : phaseIds.find((id) => id === requestedRecovery);
  const options: GovernanceInspectionOptions = {
    scope: scope ?? 'activation',
    command: subcommand,
    storage,
    ...(activationInputs ?? reviewed?.plan.configuration ? { activationInputs: activationInputs ?? reviewed?.plan.configuration } : {}),
    ...(configured?.binding ?? reviewed?.plan.configurationBinding ? { configurationBinding: configured?.binding ?? reviewed?.plan.configurationBinding } : {}),
    ...(recoverPhase ? { recoverPhase } : {})
  };
  let inspection: GovernanceInspection;
  try {
    inspection = await inspectGovernance(projectRoot, context.runner, new Date(), options);
  } catch (error) {
    if (subcommand === 'verify') {
      return renderInspectionFailure(subcommand, projectRoot, error, presentation, jsonMode, scope);
    }
    throw error;
  }

  if (subcommand === 'status') {
    if (jsonMode) {
      json(presentation, statusJson(inspection, 'status'));
    } else {
      renderStatusHuman(inspection, 'status', presentation);
    }
    return 0;
  }
  if (subcommand === 'plan') {
    let saved: Awaited<ReturnType<typeof saveGovernancePreview>>;
    try {
      saved = await saveGovernancePreview(transitionInspection(inspection), { runner: context.runner, storage, adapters });
    } catch (error) {
      if (jsonMode) json(presentation, {
        ...planJson(inspection), ready: false, reason: 'planning-blocked',
        blockers: [errorMessage(error)], preview: null
      });
      else presentation.error(errorMessage(error), 'Supply the named supported inputs or resolve the prerequisite, then request a fresh plan.');
      return 1;
    }
    if (jsonMode) {
      json(presentation, {
        ...planJson(inspection),
        preview: saved ? { fingerprint: saved.preview.fingerprint, path: saved.path, expiresAt: saved.preview.plan.expiresAt } : null,
        plan: saved?.preview.plan ?? null,
        projectWrites: false,
        providerWrites: false,
        noWrites: true,
        externalPreviewWritten: saved !== null,
        nextActions: governanceNextActions(inspection, saved?.preview)
      });
    } else {
      renderPlanHuman(inspection, presentation, saved?.preview.plan);
      if (saved) {
        presentation.status('info', 'External preview', `${saved.path}; fingerprint ${saved.preview.fingerprint}. This is not approval.`);
        const next = governanceNextActions(inspection, saved.preview)[0];
        if (next) presentation.remedy(next.displayCommand);
      }
    }
    return 0;
  }
  if (subcommand === 'approve') {
    if (!jsonMode && reviewed) renderCredentialPermissionReview(reviewed.plan, presentation);
    const approved = await approveGovernancePreview({
      projectRoot, fingerprint: fingerprint!,
      inspect: async () => transitionInspection(await inspectGovernance(projectRoot, context.runner, new Date(), options)),
      runner: context.runner, storage, adapters
    });
    const refreshed = await inspectGovernance(projectRoot, context.runner, new Date(), options);
    const result = {
      schemaVersion: 3, command: 'governance approve', projectRoot, scope: inspection.scope,
      approved: true, executed: false, envelopeId: approved.envelope.id,
      envelopeHash: canonicalApprovalEnvelopeHash(approved.envelope), expiresAt: approved.envelope.expiresAt,
      nextActions: governanceNextActions(refreshed, { fingerprint: fingerprint!, plan: approved.plan })
    };
    if (jsonMode) json(presentation, result);
    else presentation.status('success', 'Plan approved', `Approval ${approved.envelope.id} was saved without executing its operations.`);
    return 0;
  }
  if (subcommand === 'resume') {
    const result = {
      ...statusJson(inspection, 'resume'),
      deterministicPreflights: ['phase-graph', 'activation-state', 'approvals', 'evidence-freshness', 'readiness'],
      executedOperations: [],
      noWrites: true
    };
    if (jsonMode) {
      json(presentation, result);
    } else {
      renderStatusHuman(inspection, 'resume', presentation);
      presentation.status('info', 'Resume scope', 'Recalculated blockers and readiness only; no verified operation was rerun.');
    }
    return 0;
  }
  if (subcommand === 'verify') {
    try {
      if (jsonMode) {
        const result = await verifyJson(inspection);
        json(presentation, result);
        return result.consistent ? result.complete ? 0 : 2 : 1;
      }
      return await renderVerifyHuman(inspection, presentation);
    } catch (error) {
      return renderInspectionFailure(subcommand, projectRoot, error, presentation, jsonMode, scope);
    }
  }

  const execute = subcommand === 'credential-enroll' || (readBooleanFlag(parsed.flags, 'execute') ?? false);
  const transitionInput = transitionInspection(inspection);
  const result = execute
    ? await executeApplyNext({
        inspection: transitionInput,
        runner: context.runner,
        storage, adapters,
        reviewedPlan: reviewed?.plan,
        recovery: subcommand === 'recover',
        ...(subcommand === 'credential-enroll' ? {
          credentialEnrollment: { protectedStdin: readBooleanFlag(parsed.flags, 'protected-stdin') ?? false }
        } : {}),
        reinspect: async () => transitionInspection(
          await inspectGovernance(projectRoot, context.runner, new Date(), options)
        )
      })
    : await previewApplyNext({
        inspection: transitionInput,
        runner: context.runner,
        adapters,
        execute: false
      });
  let refreshed = inspection;
  let inspectionFailure = 'inspectionFailure' in result ? result.inspectionFailure : undefined;
  if (execute && !inspectionFailure) {
    try {
      refreshed = await inspectGovernance(projectRoot, context.runner, new Date(), { ...options, recoverPhase: undefined });
    } catch (error) {
      inspectionFailure = sanitizeAssessmentText(errorMessage(error));
    }
  }
  if (inspectionFailure) {
    const partial = {
      ...result, command: `governance ${subcommand}`, nextReadyPhase: null,
      readinessStatus: 'indeterminate', inspectionFailure, progress: null,
      nextActions: [governanceAction(inspection, 'status', inspection.scope)]
    };
    if (jsonMode) json(presentation, partial);
    else {
      renderApplyNextHuman(result, presentation);
      presentation.error('Current readiness could not be inspected; the reported committed effects are preserved.', partial.nextActions[0]!.displayCommand);
    }
    return result.applied || result.reason === 'phase-review-required' && !result.noWrites ? 2 : 1;
  }
  const nextActions = governanceNextActions(refreshed);
  if (jsonMode) {
    json(presentation, {
      ...result, command: `governance ${subcommand}`,
      nextReadyPhase: refreshed.readiness.nextReadyPhase,
      progress: refreshed.readiness.completion,
      nextActions
    });
  } else {
    renderApplyNextHuman(result, presentation);
    if (result.reason === 'phase-review-required' && nextActions[0]) {
      presentation.remedy(nextActions[0].displayCommand);
    }
  }
  return result.applied || ['execute-required', 'external-operation-pending', 'phase-review-required'].includes(result.reason) ? 0 : 1;
}

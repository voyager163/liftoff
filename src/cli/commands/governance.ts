import path from 'node:path';
import { readPublicActivationInputs } from '../../adapters/filesystem/governance-records.js';
import { findProjectRoot } from '../../adapters/filesystem/project-discovery.js';
import {
  type GovernanceInspection,
  type GovernanceInspectionOptions,
  inspectGovernance,
  transitionInspection
} from '../../application/governance/inspection.js';
import { canonicalApprovalEnvelopeHash } from '../../domain/governance/activation/approvals.js';
import { type GovernanceScope, phaseIds } from '../../domain/governance/activation/types.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import {
  approveGovernancePreview,
  loadGovernancePreview,
  saveGovernancePreview
} from '../../governance-activation/public-plans.js';
import { errorMessage } from '../../governance-activation/transition-process.js';
import { executeApplyNext, previewApplyNext } from '../../governance-activation/transitions.js';
import { governanceAssessmentCommand } from '../../governance-assessment/command.js';
import type { CommandRunner } from '../../process-runner.js';
import type { PresentationSession } from '../../terminal.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';
import type { CommandOutcome } from '../../application/command-outcome.js';
import {
  type GovernanceSubcommand,
  attachPresentation,
  governanceNextActions,
  json,
  planJson,
  renderApplyNextHuman,
  renderInspectionFailure,
  renderPlanHuman,
  renderStatusHuman,
  renderVerifyHuman,
  statusJson,
  verifyJson
} from './governance-output.js';

interface GovernanceCommandContext {
  outcome?: CommandOutcome;
  cwd: string;
  presentation: PresentationSession;
  runner?: CommandRunner;
}

const governanceSubcommands = new Set<GovernanceSubcommand>([
  'status',
  'plan',
  'approve',
  'apply-next',
  'credential-enroll',
  'recover',
  'resume',
  'verify'
]);

function parseGovernanceSubcommand(parsed: ParsedArgs): GovernanceSubcommand | undefined {
  if (!parsed.subcommand || !governanceSubcommands.has(parsed.subcommand as GovernanceSubcommand)) {
    return undefined;
  }
  return parsed.subcommand as GovernanceSubcommand;
}

async function resolveGovernanceProjectRoot(
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
  return await findProjectRoot(start);
}

function projectRootError(start: string): { message: string; remedy: string } {
  return {
    message: `No liftoff.manifest.json found in ${start} or any parent directory.`,
    remedy: 'Run this command inside a Liftoff project or provide its path explicitly.'
  };
}

export async function governanceCommand(parsed: ParsedArgs, context: GovernanceCommandContext): Promise<number> {
  if (parsed.subcommand === 'assess') {
    return governanceAssessmentCommand(parsed, context);
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
  if (rawScope && rawScope !== 'local' && rawScope !== 'activation' && rawScope !== 'lifecycle') {
    throw new Error('Governance scope must be local, activation, or lifecycle.');
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
  const activationInputs = inputsFile ? await readPublicActivationInputs(path.resolve(context.cwd, inputsFile)) : undefined;
  const fingerprint = readStringFlag(parsed.flags, 'plan');
  const reviewed = fingerprint ? await loadGovernancePreview(projectRoot, fingerprint) : undefined;
  if (reviewed && scope && reviewed.plan.scope !== scope) throw new Error('The selected scope does not match the reviewed plan.');
  if (subcommand === 'recover' && !reviewed?.plan.recovery) throw new Error('Recovery requires a preview explicitly created with governance plan --recover-phase.');
  if (subcommand === 'apply-next' && reviewed?.plan.recovery) throw new Error('A recovery preview can be executed only with governance recover.');
  if (subcommand === 'credential-enroll' && reviewed?.plan.phaseId !== 'credential-ready') {
    throw new Error('Credential enrollment requires a credential-ready preview, not another activation or repair plan.');
  }
  const requestedRecovery = readStringFlag(parsed.flags, 'recover-phase');
  const recoverPhase = reviewed?.plan.recovery ? reviewed.plan.phaseId : phaseIds.find((id) => id === requestedRecovery);
  const options: GovernanceInspectionOptions = {
    ...(scope ? { scope } : {}),
    command: subcommand,
    ...(activationInputs ?? reviewed?.plan.configuration ? { activationInputs: activationInputs ?? reviewed?.plan.configuration } : {}),
    ...(recoverPhase ? { recoverPhase } : {})
  };
  let inspection: GovernanceInspection;
  try {
    inspection = attachPresentation(await inspectGovernance(projectRoot, context.runner, new Date(), options), presentation);
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
      renderStatusHuman(inspection, 'status');
    }
    return 0;
  }
  if (subcommand === 'plan') {
    let saved: Awaited<ReturnType<typeof saveGovernancePreview>>;
    try {
      saved = await saveGovernancePreview(transitionInspection(inspection), { runner: context.runner });
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
      renderPlanHuman(inspection, presentation);
      if (saved) {
        presentation.status('info', 'External preview', `${saved.path}; fingerprint ${saved.preview.fingerprint}. This is not approval.`);
        const next = governanceNextActions(inspection, saved.preview)[0];
        if (next) presentation.remedy([next.command.executable, ...next.command.args.map((arg) => /\s/u.test(arg) ? JSON.stringify(arg) : arg)].join(' '));
      }
    }
    return 0;
  }
  if (subcommand === 'approve') {
    const approved = await approveGovernancePreview({
      projectRoot, fingerprint: fingerprint!,
      inspect: async () => transitionInspection(await inspectGovernance(projectRoot, context.runner, new Date(), options)),
      runner: context.runner
    });
    const refreshed = attachPresentation(await inspectGovernance(projectRoot, context.runner, new Date(), options), presentation);
    const result = {
      schemaVersion: 2, command: 'governance approve', projectRoot, scope,
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
      renderStatusHuman(inspection, 'resume');
      presentation.status('info', 'Resume scope', 'Recalculated blockers and readiness only; no verified operation was rerun.');
    }
    return 0;
  }
  if (subcommand === 'verify') {
    try {
      if (jsonMode) {
        const result = await verifyJson(inspection);
        json(presentation, result);
        return result.ok === true ? 0 : 1;
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
        reviewedPlan: reviewed?.plan,
        recovery: subcommand === 'recover',
        ...(subcommand === 'credential-enroll' ? {
          credentialEnrollment: { protectedStdin: readBooleanFlag(parsed.flags, 'protected-stdin') ?? false }
        } : {}),
        reinspect: async () => transitionInspection(
          attachPresentation(await inspectGovernance(projectRoot, context.runner, new Date(), options), presentation)
        )
      })
    : await previewApplyNext({
        inspection: transitionInput,
        runner: context.runner,
        execute: false
      });
  if (jsonMode) {
    const refreshed = execute
      ? await inspectGovernance(projectRoot, context.runner, new Date(), { ...options, recoverPhase: undefined })
      : inspection;
    json(presentation, {
      ...result, command: `governance ${subcommand}`,
      progress: refreshed.readiness.completion,
      nextActions: governanceNextActions(refreshed)
    });
  } else {
    renderApplyNextHuman(result, presentation);
  }
  context.outcome?.record('cleanupWarnings' in result && result.cleanupWarnings.length > 0 ? 'failure' :
    result.applied ? 'success' : ['execute-required', 'external-operation-pending'].includes(result.reason) ? 'attention-required' : 'failure');
  return result.applied || ['execute-required', 'external-operation-pending'].includes(result.reason) ? 0 : 1;
}

import path from 'node:path';
import {
  adoptionCommandErrorReport,
  adoptionCommandRequestIssue,
  previewAdoptionProject,
  resolveAdoptionProjectBoundary,
  unavailableAdoptionAuthorityReport,
  type AdoptionCommandReport,
  type AdoptionCommandRequest
} from '../../application/adoption/public-command.js';
import type { ExecutionContext } from '../../application/context.js';
import { buildCurrentProjectPlan } from '../../application/project/planning.js';
import { modernProjectSourceInput } from '../../application/project/source-context.js';
import { parseProjectManifest } from '../../application/project/manifest.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { PresentationSession } from '../../terminal.js';
import { buildCurrentArtifacts } from '../../templates.js';
import { optionsFromParsedArgs } from '../project-options.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

function render(report: AdoptionCommandReport, presentation: PresentationSession): void {
  presentation.commandIdentity('adopt', 'Reviewed in-place adoption');
  presentation.definitions('Selected scope', [
    { label: 'Project', value: report.projectRoot },
    { label: 'Boundary', value: report.projectKind },
    { label: 'Operation', value: report.operation },
    { label: 'Status', value: report.status },
    { label: 'Review fingerprint', value: report.review?.fingerprint ?? 'unavailable' },
    { label: 'Destination plan', value: report.destinationPlan?.fingerprint ?? 'unavailable' }
  ]);
  presentation.status(
    report.exitCode === 1 ? 'error' : 'warning',
    report.status,
    report.diagnostics.join(' ')
  );
  if (report.destinationPlan) {
    presentation.table(
      'Destination observations',
      ['Identity', 'Status', 'Path'],
      report.destinationPlan.destinations.map(destination => [
        destination.logicalName,
        destination.status,
        destination.pathParts.join('/')
      ])
    );
  }
  for (const blocker of report.destinationPlan?.blockers ?? []) {
    presentation.status('warning', blocker.code, blocker.pathParts.join('/'));
  }
  for (const action of report.nextActions) {
    presentation.status('info', action.command.join(' '), action.purpose);
  }
  for (const limitation of report.limitations) {
    presentation.status('info', 'Adoption boundary', limitation);
  }
}

function sourceForPlan(plan: ReturnType<typeof buildCurrentProjectPlan>) {
  const manifestArtifact = buildCurrentArtifacts(plan)
    .find(artifact => artifact.logicalName === 'manifest');
  if (!manifestArtifact) throw new Error('Installed target generation did not produce a manifest identity.');
  const manifest = parseProjectManifest(JSON.parse(manifestArtifact.content) as unknown);
  if (manifest.artifactVersion !== 8) {
    throw new Error('Installed target generation did not produce the current manifest schema.');
  }
  return modernProjectSourceInput(manifest);
}

function request(parsed: ParsedArgs): AdoptionCommandRequest {
  const selected = readStringFlag(parsed.flags, 'project') ?? parsed.positional[0];
  return {
    project: selected,
    explicitProject: selected !== undefined,
    check: readBooleanFlag(parsed.flags, 'check') === true,
    approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
    recover: readBooleanFlag(parsed.flags, 'recover') === true,
    json: readBooleanFlag(parsed.flags, 'json') === true
  };
}

function targetOptionsArgs(parsed: ParsedArgs): ParsedArgs {
  const flags = { ...parsed.flags };
  delete flags.project;
  delete flags.check;
  delete flags['approve-plan'];
  delete flags.recover;
  delete flags.json;
  delete flags.help;
  return { command: 'plan', flags, positional: [] };
}

export async function adoptCommand(
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> {
  const selected = request(parsed);
  let report = unavailableAdoptionAuthorityReport(selected);
  if (!report) {
    const issue = adoptionCommandRequestIssue(selected);
    if (issue) {
      report = adoptionCommandErrorReport(selected, selected.project ?? context.cwd, issue);
    } else {
      try {
        const boundary = await resolveAdoptionProjectBoundary(
          selected.project ?? context.cwd,
          selected.explicitProject
        );
        if (boundary.kind === 'liftoff') {
          report = await previewAdoptionProject(
            selected,
            boundary,
            {},
            context.updateNow?.() ?? new Date(),
            context.updatePreview
          );
        } else {
          const options = await optionsFromParsedArgs(
            targetOptionsArgs(parsed),
            context.cwd,
            false
          );
          const plan = buildCurrentProjectPlan({
            ...options,
            projectName: options.projectName ?? path.basename(boundary.projectRoot)
          }, { requireProjectName: true });
          report = await previewAdoptionProject(
            selected,
            boundary,
            sourceForPlan(plan),
            context.updateNow?.() ?? new Date(),
            context.updatePreview
          );
        }
      } catch (error) {
        report = adoptionCommandErrorReport(
          selected,
          selected.project ?? context.cwd,
          error instanceof Error ? error.message : 'Adoption preview failed.'
        );
      }
    }
  }
  context.outcome?.record(report.exitCode === 1 ? 'failure' : 'attention-required');
  if (selected.json) {
    context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    render(report, context.presentation);
  }
  return report.exitCode;
}

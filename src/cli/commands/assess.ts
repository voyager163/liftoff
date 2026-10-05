import path from 'node:path';
import { assessProject, projectAssessmentProfile } from '../../application/assessment/engine.js';
import type { ExecutionContext } from '../../application/context.js';
import { assembleProjectAssessmentReport, type ProjectAssessmentReport } from '../../domain/assessment/report.js';
import { sanitizeAssessmentText } from '../../domain/governance/assessment/sanitize.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { PresentationSession } from '../../terminal.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

function render(report: ProjectAssessmentReport, presentation: PresentationSession) {
  presentation.commandIdentity('assess', 'Read-only whole-project comparison');
  presentation.definitions('Installed comparison target', [
    { label: 'CLI', value: report.target?.cliVersion ?? 'unavailable' },
    { label: 'Profile', value: report.target?.profile ?? 'unavailable' },
    { label: 'Selection', value: report.target?.profileSelection ?? 'unavailable' },
    { label: 'Recorded profile', value: report.project.recordedProfile ?? 'unrecorded' },
    { label: 'Scope', value: 'Bounded local metadata; no network or project execution' }
  ]);
  presentation.status(report.outcome === 'error' ? 'error' : report.exitCode === 0 ? 'success' : 'warning',
    report.outcome, `${report.coverage.fullyObserved}/${report.coverage.applicable} applicable findings observed; ${report.coverage.notObserved} unobserved; ${report.coverage.differences} differences.`);
  presentation.table('Project findings', ['Finding', 'Result', 'Location'], report.findings.map(finding => [
    finding.id, finding.classification, finding.pathParts?.join('/') ?? 'selected scope'
  ]));
  for (const finding of report.findings.filter(item => item.classification !== 'aligned' && item.classification !== 'inapplicable')) {
    presentation.status('info', finding.id, finding.reason);
  }
  for (const diagnostic of report.diagnostics) presentation.status(diagnostic.severity, diagnostic.code, diagnostic.message);
  presentation.status('info', 'No changes made', 'Targets and recommendations are advisory, not approval, write authority, activation evidence or cloud ownership.');
}

export async function assessCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const selected = readStringFlag(parsed.flags, 'project');
  const start = path.resolve(context.cwd, parsed.positional[0] ?? selected ?? '.');
  let report: ProjectAssessmentReport;
  try {
    if (selected !== undefined && parsed.positional[0] !== undefined) {
      throw new Error('Assessment accepts one project path, either positional or --project, not both.');
    }
    const governance = readStringFlag(parsed.flags, 'governance');
    report = await assessProject({
      start, explicitRoot: selected !== undefined || parsed.positional[0] !== undefined,
      ...(governance !== undefined ? { governance: projectAssessmentProfile(governance) } : {}),
      live: readBooleanFlag(parsed.flags, 'live')
    });
  } catch (error) {
    report = assembleProjectAssessmentReport({
      mode: readBooleanFlag(parsed.flags, 'live') ? 'live' : 'local',
      project: { root: sanitizeAssessmentText(start), kind: 'unavailable', manifestVersion: null, recordedProfile: null },
      target: null, snapshot: { inventoryDigest: null, metadataDigest: null, inputsStable: false },
      findings: [], diagnostics: [{
        code: 'project-assessment-failed', severity: 'error',
        message: sanitizeAssessmentText(error instanceof Error ? error.message : 'Whole-project assessment failed.')
      }],
      limitations: ['A trustworthy assessment could not be completed. No outer-root fallback, project mutation, script, network, enrollment or receipt was performed.']
    });
  }
  if (readBooleanFlag(parsed.flags, 'json')) context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
  else render(report, context.presentation);
  return report.exitCode;
}

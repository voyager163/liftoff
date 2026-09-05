import path from 'node:path';
import { stat } from 'node:fs/promises';
import { readBooleanFlag, readStringFlag } from '../args.js';
import { findProjectRoot } from '../file-system.js';
import type { ParsedArgs } from '../types.js';
import type { CommandRunner } from '../process-runner.js';
import type { PresentationSession } from '../terminal.js';
import type { AssessmentReport, AssessmentTarget } from './types.js';
import { canonicalSha256 } from '../governance-activation/canonical-json.js';
import { assessGovernance } from './engine.js';
import { assembleAssessmentReport } from './report.js';
import { loadAssessmentCatalog } from './catalog.js';
import { sanitizeAssessmentText } from './sanitize.js';

export function renderAssessmentReport(report: AssessmentReport, presentation: PresentationSession): void {
  presentation.commandIdentity('governance assess', 'Read-only governance comparison');
  presentation.definitions('Assessment target', [
    { label: 'CLI', value: report.target?.cliVersion ?? 'unavailable' },
    { label: 'Policy', value: report.target?.policyVersion ?? 'unavailable' },
    { label: 'Project policy', value: report.projectIdentity.policyVersion ?? 'unrecorded' },
    { label: 'Scope', value: report.mode === 'live' ? 'Local and explicitly requested live metadata' : 'Local only; no network requests' },
    { label: 'Recorded identity', value: report.projectIdentity.availability }
  ]);
  presentation.status(report.outcome === 'error' ? 'error' : report.outcome === 'aligned' ? 'success' : 'info',
    report.outcome, report.outcome === 'not-applicable'
      ? 'Governance is disabled; no alignment or activation is claimed.'
      : `${report.coverage.fullyObserved}/${report.coverage.applicable} applicable controls fully observed; ${report.coverage.unobserved} unobserved; ${report.coverage.differences} differences.`);
  if (report.outcome === 'partial') {
    presentation.status('warning', 'Incomplete coverage', 'Unobserved live proof, unsupported evaluators, and unknown applicability are not passes.');
  }
  const ordered = [...report.findings].sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 };
    return rank[a.severity] - rank[b.severity] || a.controlId.localeCompare(b.controlId, 'en');
  });
  const display = (value: unknown) => sanitizeAssessmentText(typeof value === 'string' ? value : JSON.stringify(value), 180);
  presentation.table('Governance comparisons', ['Control', 'Result', 'Expected', 'Observed'], ordered.map((finding) => [
    `${finding.controlId}${finding.scope.resource ? ` (${finding.scope.resource})` : ''}`, finding.classification,
    display(finding.expected),
    Object.entries(finding.observations).map(([layer, observation]) =>
      `${layer}: ${observation.availability === 'not-observed' ? 'not observed' : display(observation.facts ?? observation.value)}`
    ).join('; ')
  ]));
  for (const finding of ordered.filter((entry) => entry.classification !== 'aligned' && entry.classification !== 'inapplicable')) {
    presentation.status('info', finding.controlId, finding.reasons.join('; '));
    const origins = Object.values(finding.observations).flatMap((observation) =>
      observation.source ? [`${observation.source.kind}: ${observation.source.location}${observation.source.line ? `:${observation.source.line}` : ''}`] : []
    );
    if (origins.length) presentation.status('info', 'Evidence', [...new Set(origins)].join('; '));
  }
  for (const diagnostic of report.diagnostics) {
    presentation.status(diagnostic.severity === 'error' ? 'error' : 'warning', diagnostic.code, diagnostic.message);
  }
  const actionable = ordered.filter((finding) => ['missing', 'outdated', 'conflicting'].includes(finding.classification));
  if (actionable.length) presentation.bullets('Advisory actions only', [...new Set(actionable.map((finding) =>
    `${finding.recommendation.ownership}: ${finding.recommendation.action}`
  ))]);
  presentation.status('info', 'No changes made', 'Assessment does not update, approve, migrate, or activate governance.');
}

export async function governanceAssessmentCommand(
  parsed: ParsedArgs,
  context: { cwd: string; presentation: PresentationSession; runner?: CommandRunner }
): Promise<number> {
  const mode = readBooleanFlag(parsed.flags, 'live') ?? false;
  const start = path.resolve(context.cwd, parsed.positional[0] ?? readStringFlag(parsed.flags, 'project') ?? '.');
  let report: AssessmentReport;
  let target: AssessmentTarget | null = null;
  try {
    target = loadAssessmentCatalog().target;
    if (!(await stat(start)).isDirectory()) throw new Error('Assessment project path must be a directory.');
    const root = await findProjectRoot(start);
    if (!root) throw new Error('No liftoff.manifest.json found. Run assessment inside a Liftoff project or provide its path.');
    report = await assessGovernance(root, { live: mode, runner: context.runner });
  } catch (error) {
    report = assembleAssessmentReport({
      projectRoot: start, mode: mode ? 'live' : 'local',
      target,
      projectIdentity: { availability: 'unavailable', manifestVersion: null, cliVersion: null, profile: null, policyVersion: null, recordedActivationIdentity: null, stateSource: 'unavailable' },
      snapshot: { capturedAt: new Date().toISOString(), repository: null, localHead: null, worktreeDigest: canonicalSha256({}), inputsStable: false },
      findings: [], diagnostics: [{
        code: 'project-discovery', severity: 'error', source: null,
        message: sanitizeAssessmentText(error instanceof Error ? error.message : 'Project discovery failed.')
      }], failed: true
    });
  }
  if (readBooleanFlag(parsed.flags, 'json')) context.presentation.rawStdout(`${JSON.stringify(report, null, 2)}\n`);
  else renderAssessmentReport(report, context.presentation);
  return report.exitCode;
}

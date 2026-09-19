import path from 'node:path';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import type { AssessmentResult } from '../../domain/standards-assessment/types.js';

export interface AssessCommandArgs {
  path?: string;
  project?: string;
  component?: string;
  profile?: string;
  inputs?: string;
  json?: boolean;
}

export async function runAssess(
  args: AssessCommandArgs,
  context: ExecutionContext
): Promise<{ result: AssessmentResult; exitCode: number }> {
  const targetPath = args.path ?? args.project ?? context.cwd;
  const resolvedTarget = path.isAbsolute(targetPath) ? targetPath : path.resolve(context.cwd, targetPath);

  const result = await (await getApplicationEngines(context))['standards-assessment'].assessProject({
    ...(args.path !== undefined || args.project !== undefined ? { targetPath: resolvedTarget } : {}),
    projectRoot: args.project ? (path.isAbsolute(args.project) ? args.project : path.resolve(context.cwd, args.project)) : undefined,
    componentPath: args.component,
    profile: args.profile,
    inputsPath: args.inputs ? (path.isAbsolute(args.inputs) ? args.inputs : path.resolve(context.cwd, args.inputs)) : undefined,
    invocationCwd: context.cwd
  });

  const isJson = args.json === true;

  if (isJson) {
    context.presentation.rawStdout(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    renderHumanReport(result, context);
  }

  return { result, exitCode: result.exitCode };
}

export const assessCommand = async (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => {
  const jsonFlag = readBooleanFlag(parsed.flags, 'json');
  const isJson = jsonFlag === true;

  const args: AssessCommandArgs = {
    path: parsed.positional[0],
    project: readStringFlag(parsed.flags, 'project'),
    component: readStringFlag(parsed.flags, 'component'),
    profile: readStringFlag(parsed.flags, 'profile'),
    inputs: readStringFlag(parsed.flags, 'inputs'),
    json: isJson
  };

  const { exitCode } = await runAssess(args, context);
  return exitCode;
};

function renderHumanReport(result: AssessmentResult, context: ExecutionContext): void {
  const p = context.presentation;
  p.commandIdentity('assess', 'Assess whole-project standards and profile coverage');

  // Target summary
  p.definitions('Target Boundaries', [
    { label: 'Target path', value: result.target.targetPath },
    { label: 'Project root', value: result.target.projectRoot },
    { label: 'Repository root', value: result.target.repositoryRoot ?? '(none: directory has no Git metadata)' },
    ...(result.target.componentPath ? [{ label: 'Component path', value: result.target.componentPath }] : []),
    { label: 'Liftoff manifest', value: result.target.hasManifest ? `Present (version ${result.target.manifestVersion})` : 'Absent' }
  ]);

  // Profile
  p.definitions('Standards Profile', [
    { label: 'Target profile', value: `${result.profile.name} (${result.profile.id})` },
    { label: 'Profile status', value: result.profile.status },
    { label: 'Revision', value: result.profile.revision }
  ]);

  // Inventory summary
  const catEntries = Object.entries(result.inventory.summary.byCategory)
    .filter(([, count]) => count > 0)
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(', ');

  p.definitions('Inventory', [
    { label: 'Total files', value: String(result.inventory.summary.totalFiles) },
    { label: 'Total bytes', value: String(result.inventory.summary.totalBytes) },
    ...(catEntries ? [{ label: 'Categories', value: catEntries }] : []),
    ...(result.inventory.unobserved.length > 0 ? [{ label: 'Unobserved scopes', value: String(result.inventory.unobserved.length) }] : []),
    ...(result.inventory.protectedExclusions.length > 0 ? [{ label: 'Protected exclusions', value: String(result.inventory.protectedExclusions.length) }] : [])
  ]);

  // Findings
  if (result.findings.length > 0) {
    p.stage('Standards Findings');
    for (const finding of result.findings) {
      const statusKind =
        finding.classification === 'aligned'
          ? 'success'
          : finding.severity === 'error'
            ? 'error'
            : 'warning';
      p.status(statusKind, `[${finding.classification.toUpperCase()}] ${finding.ruleId}: ${finding.title}`);
    }
  }

  // Diagnostics
  if (result.diagnostics.length > 0) {
    p.stage('Diagnostics');
    for (const diag of result.diagnostics) {
      const kind = diag.severity === 'error' ? 'error' : 'warning';
      p.status(kind, `[${diag.code}] ${diag.message}`);
    }
  }

  // Coverage
  p.definitions('Rule Coverage', [
    { label: 'Declared rules', value: String(result.coverage.declaredRules) },
    { label: 'Assessed rules', value: String(result.coverage.assessedRules) },
    { label: 'Aligned rules', value: String(result.coverage.alignedRules) },
    { label: 'Differing rules', value: String(result.coverage.differingRules) },
    { label: 'Missing rules', value: String(result.coverage.missingRules) },
    { label: 'Unknown rules', value: String(result.coverage.unknownRules) }
  ]);

  // Recommendations
  if (result.recommendations.length > 0) {
    p.stage('Context-Bound Next Actions');
    for (const rec of result.recommendations) {
      p.status(rec.status === 'blocked' ? 'warning' : 'info', `${rec.id}: ${rec.title}`);
      if (rec.continuation) {
        p.command(rec.continuation.displayCommand);
        p.definitions('Action context', [
          { label: 'Working directory', value: rec.cwd },
          { label: 'Scope', value: rec.scope },
          { label: 'Qualification', value: rec.qualification }
        ]);
      }
      if (rec.blockedReasons.length) p.bullets('Blocked guidance', rec.blockedReasons);
    }
  }

  // Final Outcome
  p.stage('Assessment Outcome');
  if (result.outcome === 'success') {
    p.status('success', 'Full assessed standards coverage achieved with no differences (exit 0).');
  } else if (result.outcome === 'differences') {
    p.status('warning', 'Valid assessment completed with gaps, differences, or unsupported stack (exit 2).');
  } else {
    p.status('error', 'Assessment error encountered (exit 1).');
  }
}

import { TextDecoder } from 'node:util';
import {
  assembleProjectAssessmentReport, projectAssessmentFinding, providerAssessmentObservation, type ProjectAssessmentReport
} from '../../domain/assessment/report.js';
import { inspectProjectLiveMetadata, observeProjectGitMetadata } from '../../adapters/assessment/live.js';
import { ApplicationFiles, ApplicationInspectionError, applicationDigest } from '../repair/application-files.js';
import { parseProjectManifest } from '../project/manifest.js';
import { resolveModernManifestSourceContext } from '../project/source-context.js';
import { NodeCommandRunner, type CommandRunner } from '../../process-runner.js';

export class ScopedLiveAssessmentError extends Error {
  constructor(message: string, readonly providerAccessAttempted: boolean, cause: unknown) {
    super(message, { cause });
    this.name = 'ScopedLiveAssessmentError';
  }
}

export async function inspectScopedLiveProject(input: {
  inspectLocal: () => Promise<ProjectAssessmentReport>;
  runner?: CommandRunner;
  now?: () => Date;
}): Promise<ProjectAssessmentReport> {
  let providerAccessAttempted = false;
  const supplied = input.runner ?? new NodeCommandRunner();
  const runner: CommandRunner = {
    async run(command, options) {
      if (command.executable === 'gh' || command.executable === 'az') providerAccessAttempted = true;
      return supplied.run(command, options);
    }
  };
  try {
    return await composeScopedLiveProject({ ...input, runner });
  } catch (error) {
    throw new ScopedLiveAssessmentError(
      error instanceof Error ? error.message : 'A trustworthy scoped live assessment could not be completed.',
      providerAccessAttempted, error
    );
  }
}

async function composeScopedLiveProject(input: {
  inspectLocal: () => Promise<ProjectAssessmentReport>;
  runner: CommandRunner;
  now?: () => Date;
}): Promise<ProjectAssessmentReport> {
  const before = await input.inspectLocal();
  if (!before.target || before.mode !== 'local' || !before.snapshot.inputsStable || before.outcome === 'error') {
    throw new ApplicationInspectionError('A stable installed-target local report is required before live collection.');
  }
  const files = new ApplicationFiles(before.project.root, parts =>
    parts.join('/') === 'liftoff.manifest.json' ? null : 'not-an-exact-assessment-input');
  const snapshot = await files.read(['liftoff.manifest.json']);
  const manifestFinding = before.findings.find(finding => finding.id === 'project.manifest');
  if (!manifestFinding || Boolean(snapshot.content) !== (before.project.kind === 'liftoff') ||
      snapshot.content && (manifestFinding.observed.source?.kind !== 'file' ||
        applicationDigest(snapshot.content) !== manifestFinding.observed.source.digest)) {
    throw new ApplicationInspectionError('Project metadata changed before live collection; no provider request was performed.');
  }
  const manifest = snapshot.content ? parseProjectManifest(JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(snapshot.content)
  )) : null;
  const source = manifest?.artifactVersion === 8 ? resolveModernManifestSourceContext(manifest) : null;
  const runner = input.runner;
  const collected = await inspectProjectLiveMetadata({
    root: before.project.root, profile: before.target.profile,
    environments: source?.selection.project.workload.environments ?? [],
    runner, ...(input.now === undefined ? {} : { now: input.now })
  });
  await files.assertUnchanged();
  const checked = await input.inspectLocal();
  if (checked.resultDigest !== before.resultDigest) {
    throw new ApplicationInspectionError('Observed project inputs changed during live collection; collected provider metadata is not current project proof.');
  }
  const finalGit = await observeProjectGitMetadata(before.project.root, runner);
  await files.assertUnchanged();
  const stable = collected.inputsStable && finalGit.digest === collected.gitMetadataDigest;
  const liveFindings = Object.entries(collected.observations).map(([id, observation]) => {
    const infrastructure = id.startsWith('azure.');
    return projectAssessmentFinding({
      id: `live.${id}`, category: infrastructure ? 'infrastructure' : 'governance',
      title: `Scoped provider metadata: ${id}`, pathParts: null,
      applicability: infrastructure ? 'unknown' : 'applicable', supported: false,
      expected: 'supported-current-profile-evaluation',
      observed: providerAssessmentObservation(observation),
      reason: observation.availability === 'observed'
        ? 'Provider metadata was collected within the verified scope. Its original availability and provenance are retained; current-profile conformance and activation proof remain unsupported.'
        : observation.reason ?? 'Scoped metadata was not observed; no provider absence or conformance was inferred.',
      remediation: {
        category: infrastructure ? 'existing-deployment-planning' : 'new-environment-activation',
        available: false, previewCommand: null, separateConsent: true
      }
    });
  });
  return assembleProjectAssessmentReport({
    mode: 'live', project: before.project, target: before.target,
    snapshot: { ...before.snapshot, inputsStable: stable },
    findings: [...before.findings, ...liveFindings],
    diagnostics: [
      ...before.diagnostics,
      ...collected.diagnostics.map(diagnostic => ({
        code: diagnostic.code, severity: diagnostic.severity === 'error' ? 'error' as const : 'warning' as const,
        message: diagnostic.message
      })),
      ...(finalGit.digest === collected.gitMetadataDigest ? [] : [{
        code: 'live-project-git-changed-after-local-verification', severity: 'warning' as const,
        message: 'Observed Git metadata changed during final local verification; the provider snapshot is not current proof.'
      }])
    ],
    limitations: [
      ...before.limitations.map(limitation => `Local observation scope: ${limitation}`),
      'Live mode collects bounded GitHub metadata only for the exact verified local repository binding and declared current environments. No runner/account/Azure discovery, credential enrollment, project script, receipt or recommendation execution occurs.',
      'Original provider availability, values, facts and first-class provenance are retained separately from unsupported current-profile evaluation. Denied or masked reads are not absence or alignment.',
      'Two complete local assessments and final Git metadata reobservation detect observed drift, not atomic filesystem or provider confinement.'
    ]
  });
}

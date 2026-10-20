import { TextDecoder } from 'node:util';
import {
  assembleProjectAssessmentReport, projectAssessmentFinding, providerAssessmentObservation,
  type ProjectAssessmentFinding, type ProjectAssessmentReport
} from '../../domain/assessment/report.js';
import { notObserved } from '../../domain/governance/assessment/sanitize.js';
import { inspectProjectLiveMetadata, observeProjectGitMetadata } from '../../adapters/assessment/live.js';
import { ApplicationFiles, ApplicationInspectionError, applicationDigest } from '../repair/application-files.js';
import { parseProjectManifest } from '../project/manifest.js';
import { resolveModernManifestSourceContext } from '../project/source-context.js';
import { NodeCommandRunner, type CommandRunner } from '../../process-runner.js';
import { loadAssessmentCatalog } from '../../governance-assessment/catalog.js';
import {
  isLiveMetadataEvaluator, observeLiveGovernanceControl
} from '../../domain/governance/assessment/live-observations.js';

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
  const { mode, project, target, snapshot: originalSnapshot, outcome, resultDigest, findings, diagnostics, limitations } =
    await input.inspectLocal();
  const before = structuredClone({
    mode, project, target, snapshot: originalSnapshot, outcome, resultDigest, findings, diagnostics, limitations
  });
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
  const profileCatalog = before.target.profile === 'none' ? null
    : loadAssessmentCatalog(before.target.profile, source?.selection.project.specWorkflow ?? 'openspec');
  if (profileCatalog && (before.target.policy?.version !== profileCatalog.target.policyVersion ||
      before.target.policy.digest !== `sha256:${profileCatalog.target.policyDigest}`)) {
    throw new ApplicationInspectionError('The installed assessment catalog differs from the selected comparison policy; no profile verdict was issued.');
  }
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
  const profileFindings: ProjectAssessmentFinding[] = [];
  if (profileCatalog) {
    const { catalog, target } = profileCatalog;
    const environments = source?.selection.project.workload.environments ?? [];
    for (const control of catalog.controls) {
      if (!isLiveMetadataEvaluator(control.evaluator)) continue;
      const applicable = control.applicability === 'always' || environments.length > 0;
      let observation = applicable ? observeLiveGovernanceControl(control.evaluator, target.profile, collected, environments)
        : notObserved('No declared current environment scope was available; metadata does not establish environment applicability.');
      if (!stable) {
        observation = {
          ...notObserved('Observed Git or ref bindings changed during collection; retained metadata is not a current profile verdict.', observation.source),
          facts: {
            availability: observation.availability, value: observation.value,
            ...(observation.facts === undefined ? {} : { metadata: observation.facts })
          }
        };
      }
      profileFindings.push(projectAssessmentFinding({
        id: `live.profile.${control.id}`, category: 'governance', title: `Observed live metadata: ${control.title}`,
        pathParts: null, applicability: applicable ? 'applicable' : 'unknown',
        supported: true, expected: control.evaluator === 'environments' ? true : control.expected,
        observed: providerAssessmentObservation(observation),
        reason: `${observation.reason ?? 'The observed live value is compared with the installed profile.'} This evaluates only the live metadata layer; declared configuration, execution evidence and activation readiness are not inferred.`,
        remediation: { category: 'new-environment-activation', available: false, previewCommand: null, separateConsent: true }
      }));
    }
  }
  const liveFindings = Object.entries(collected.observations).map(([id, observation]) => {
    const infrastructure = id.startsWith('azure.');
    return projectAssessmentFinding({
      id: `live.${id}`, category: infrastructure ? 'infrastructure' : 'governance',
      title: `Scoped provider metadata: ${id}`, pathParts: null,
      applicability: infrastructure ? 'unknown' : 'applicable', supported: false,
      expected: 'supported-current-profile-evaluation',
      observed: providerAssessmentObservation(observation),
      reason: observation.availability === 'observed'
        ? 'Provider metadata was collected within the verified scope. Its original availability and provenance are retained; this raw observation is not itself a policy verdict or activation proof.'
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
    findings: [...before.findings, ...liveFindings, ...profileFindings],
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
      'Named live.profile findings evaluate only their metadata layer against the installed profile catalog using the shared governance predicates. Original raw observations remain separate; declared configuration, execution, Azure, custody and activation proof are not inferred. Denied or masked reads are not absence or alignment.',
      'Two complete local assessments and final Git metadata reobservation detect observed drift, not atomic filesystem or provider confinement.'
    ]
  });
}

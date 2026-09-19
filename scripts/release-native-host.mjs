import { exactIds } from './release-evidence.mjs';
import { exactKeys, instant, object, positiveId, requireValue, validateWorkflowPolicy } from './release-evidence-github.mjs';

export function validateMinimumNativeHosts(context) {
  const registrations = object(context.scope.verification?.minimumNativeHosts, 'Missing registered minimum-host execution matrix');
  exactIds(Object.keys(registrations), context.scope.requiredNativeTargets, 'Minimum-host execution targets');
  for (const target of context.scope.requiredNativeTargets) {
    const registration = registrations[target];
    exactKeys(registration, ['workflow', 'job', 'runnerLabels'], `Minimum-host ${target} registration`);
    requireValue(typeof registration.workflow === 'string' && registration.workflow.length > 0, `Missing minimum-host ${target} workflow`);
    const policy = validateWorkflowPolicy(context.scope.verification.workflows?.[registration.workflow], `native-minimum-${target}`, context.sourceCommit);
    requireValue(policy.nativeTarget === target && typeof registration.job === 'string' && policy.requiredJobs.includes(registration.job), `Minimum-host ${target} workflow/target/job is not registered`);
    requireValue(Array.isArray(registration.runnerLabels) && registration.runnerLabels.length > 0 && registration.runnerLabels.length <= 10, `Missing bounded minimum-host ${target} runner labels`);
    exactIds(registration.runnerLabels, registration.runnerLabels, `Minimum-host ${target} runner labels`);
  }
  return registrations;
}

export function verifyNativeHostObservation(context, report, target, runtime, minimum = false) {
  const label = `${minimum ? 'Minimum-host' : 'Native'} ${target}`;
  const { data, origin, verifiedFile } = report;
  const host = object(data.host, `${label} measured host`);
  const [os, arch] = target.split('-');
  const platformFields = os === 'linux' ? ['glibcVersion'] : os === 'darwin' ? ['hostVersion', 'darwinRelease'] : ['windowsBuild'];
  exactIds(Object.keys(host), ['os', 'arch', 'kernelRelease', ...platformFields], `${label} observed host fields (policy floors are not measurements)`);
  requireValue(host.os === os && host.arch === arch, `${label} observed operating system/architecture differs from the artifact`);
  requireValue(typeof host.kernelRelease === 'string' && host.kernelRelease.length <= 128 && /^[0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9._+-]+)?$/.test(host.kernelRelease), `${label} kernel release was not measured in a supported native form`);
  if (os === 'darwin') requireValue(host.darwinRelease === host.kernelRelease, `${label} Darwin observations disagree`);
  if (os === 'win32') requireValue(host.windowsBuild === Number(host.kernelRelease.split('.')[2]), `${label} Windows build observations disagree`);
  context.contracts.native.verifyTargetFloor(target, host, runtime);

  positiveId(data.jobId, `${label} measurement job ID`);
  const jobs = verifiedFile.jobs.filter((job) => job.id === Number(data.jobId));
  requireValue(jobs.length === 1, `${label} has no unique authenticated measurement job`);
  const job = jobs[0];
  requireValue(verifiedFile.policy.nativeTarget === target && verifiedFile.policy.requiredJobs.includes(job.name) &&
    job.run_id === verifiedFile.run.id && job.head_sha === context.sourceCommit && job.status === 'completed' && job.conclusion === 'success' &&
    Number.isSafeInteger(job.runner_id) && job.runner_id > 0 && typeof job.runner_name === 'string' && job.runner_name.length > 0,
  `${label} has no independently observed registered target runner/job`);
  const observedAt = instant(data.observedAt, `${label} observation time`);
  const startedAt = instant(job.started_at, `${label} job start`);
  const completedAt = instant(job.completed_at, `${label} job completion`);
  requireValue(startedAt >= instant(verifiedFile.run.run_started_at, `${label} run start`) &&
    completedAt <= instant(verifiedFile.run.updated_at, `${label} run completion`) &&
    startedAt <= observedAt && observedAt <= completedAt && observedAt <= verifiedFile.witnessedAt,
  `${label} observation is outside its authenticated execution/witness interval`);

  if (!minimum) {
    const registration = context.scope.nativeQualificationMatrix.find((entry) => entry.target === target);
    requireValue(typeof registration?.runnerLabel === 'string' && job.labels?.includes(registration.runnerLabel), `${label} did not execute on its registered native runner`);
    return;
  }
  const registration = validateMinimumNativeHosts(context)[target];
  requireValue(origin.workflow === registration.workflow && job.name === registration.job &&
    registration.runnerLabels.every((value) => job.labels?.includes(value)), `${label} did not execute on its separately registered minimum-host workflow/job/runner`);
  const floors = context.contracts.native.nativeTargetFloors[os];
  const exactVersion = (observed, floor, name) => requireValue(
    context.contracts.native.compareNumericVersions(observed, floor) === 0,
    `${label} measured ${name} ${observed} does not exercise the declared minimum ${floor}; a newer host cannot qualify the floor`
  );
  if (os === 'linux') {
    exactVersion(host.kernelRelease.split('-')[0], floors.minimumKernelVersion, 'kernel');
    exactVersion(host.glibcVersion, floors.minimumGlibc, 'glibc');
  } else if (os === 'darwin') {
    exactVersion(host.hostVersion, floors.minimumHostVersion, 'macOS');
    exactVersion(host.darwinRelease, floors.minimumDarwinRelease, 'Darwin');
  } else {
    exactVersion(host.kernelRelease.split('.').slice(0, 3).join('.'), floors.minimumHostVersion, 'Windows');
    requireValue(host.windowsBuild === floors.minimumBuild, `${label} did not exercise the minimum Windows build`);
  }
}

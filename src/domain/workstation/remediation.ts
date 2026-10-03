import { canonicalSha256 } from '../governance/activation/canonical-json.js';
import type { InstallRecipe, LinuxFamily, RemediationRecipe } from '../../workstation-catalog.js';
import type {
  ExecutableIdentity,
  HostEnvironment,
  InstallResult,
  NoProgressRemediationAttempt,
  RemediationAttempt,
  RemediationProgress,
  RequirementProbeResult,
  RequirementReasonCode,
  SelectedRequirement
} from './contracts.js';
import { requiredConstraint, safeDetail } from './probe-classification.js';
import { compareVersions } from './versions.js';

export function parseLinuxFamily(osRelease: string): LinuxFamily {
  const values = Object.fromEntries(
    osRelease.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      return match ? [[match[1], match[2].replace(/^"|"$/g, '').toLowerCase()]] : [];
    })
  );
  const identity = `${values.ID ?? ''} ${values.ID_LIKE ?? ''}`;
  if (/\b(debian|ubuntu|mint)\b/.test(identity)) {
    return 'debian';
  }
  if (/\b(fedora|rhel|centos|rocky|alma)\b/.test(identity)) {
    return 'fedora';
  }
  if (/\b(arch|manjaro)\b/.test(identity)) {
    return 'arch';
  }
  return 'unknown';
}

export function pathRemedy(recipe: InstallRecipe, requirement: SelectedRequirement): string {
  const executable = requirement.definition.probes[0]?.executable ?? requirement.id;
  switch (recipe.manager) {
    case 'brew':
      return `Run \`brew --prefix${requirement.definition.packageIdentities?.brew?.includes('@') ? ` ${requirement.definition.packageIdentities.brew}` : ''}\`, ensure its bin directory is on PATH, open a new terminal, then retry ${executable}.`;
    case 'winget':
      return `Open a new terminal and retry ${executable}; if it is still missing, inspect the WinGet package installation and PATH aliases.`;
    case 'npm':
      return `Run \`npm prefix -g\`, add that installation's bin directory to PATH, open a new terminal, then retry ${executable}.`;
    case 'uv':
      return `Run \`uv tool dir --bin\`, add that directory to PATH, open a new terminal, then retry ${executable}.`;
  }
}

export function manualRemedy(requirement: SelectedRequirement, host: HostEnvironment): string {
  return host.platform === 'linux'
    ? requirement.definition.linuxRemedies[host.linuxFamily]
    : `Install ${requirement.definition.label} manually and retry.`;
}

function fingerprintIdentity(identity: ExecutableIdentity) {
  return {
    executable: identity.executable, resolution: identity.resolution,
    resolvedPath: identity.resolvedPath ?? null, realPath: identity.realPath ?? null,
    kind: identity.kind ?? null, origin: identity.origin, evidence: identity.evidence
  };
}

export function observationFingerprint(probe: RequirementProbeResult): string {
  return canonicalSha256({
    id: probe.requirement.id,
    required: requiredConstraint(probe.requirement),
    state: probe.state,
    reasonCode: probe.reasonCode,
    identity: fingerprintIdentity(probe.identity),
    detectedVersion: probe.detectedVersion ?? null,
    observations: probe.observations.map((observation) => ({
      command: { executable: observation.command.executable, args: observation.command.args },
      identity: fingerprintIdentity(observation.identity),
      status: observation.status,
      timedOut: observation.timedOut,
      errorCode: observation.errorCode ?? null,
      reasonCode: observation.reasonCode,
      detectedVersion: observation.detectedVersion ?? null
    }))
  });
}

export function storedNoProgressAttempt(
  attempt: RemediationAttempt,
  recipeId: string,
  inputFingerprint: string
): NoProgressRemediationAttempt {
  if (attempt.recipeId !== recipeId || attempt.inputFingerprint !== inputFingerprint ||
      attempt.outputFingerprint !== inputFingerprint || attempt.outcome !== 'unchanged') {
    throw new Error('Stored no-progress history does not match the current recipe and unchanged observation binding.');
  }
  return { recipeId, inputFingerprint, outputFingerprint: inputFingerprint, outcome: 'unchanged' };
}

export function historyFailure(
  requirement: SelectedRequirement,
  probe: RequirementProbeResult,
  recipe: RemediationRecipe,
  operation: 'lookup' | 'record',
  error: unknown,
  attempt?: RemediationAttempt,
  command?: string
): InstallResult {
  const detail = error instanceof Error ? safeDetail(error.message) : 'The private no-progress store is unavailable.';
  return {
    requirement, probe, recipe, state: 'failed', reasonCode: 'history-storage-failed', historyError: operation,
    progress: operation === 'record' ? 'unchanged' : 'indeterminate',
    ...(attempt ? { attempt } : {}),
    ...(command ? { command } : {}),
    detail: operation === 'lookup'
      ? `Workstation no-progress history could not be read. No remedy command was run. ${detail}`
      : `The authorized remedy exited zero and the independent probe is unchanged, but its no-progress receipt could not be preserved. ${detail}`,
    remedy: 'Resolve the private workstation remediation history error before retrying; history is not silently ignored or replaced.'
  };
}

export function compareRequirementObservations(
  before: RequirementProbeResult,
  after: RequirementProbeResult
): RemediationProgress {
  if (after.state === 'ready' && after.reasonCode === 'compatible') return 'ready';
  if (observationFingerprint(before) === observationFingerprint(after)) return 'unchanged';
  const discovery = new Set<RequirementReasonCode>(['missing-executable', 'observation-unavailable']);
  if ((discovery.has(before.reasonCode) && !discovery.has(after.reasonCode)) ||
      (before.reasonCode === 'version-unparseable' && Boolean(after.detectedVersion)) ||
      (before.reasonCode === 'incompatible-channel' && after.reasonCode !== 'incompatible-channel' && Boolean(after.detectedVersion)) ||
      (before.reasonCode === 'below-minimum' && after.reasonCode === 'below-minimum' &&
        before.detectedVersion && after.detectedVersion && compareVersions(after.detectedVersion, before.detectedVersion) > 0)) {
    return 'improved';
  }
  return 'changed';
}

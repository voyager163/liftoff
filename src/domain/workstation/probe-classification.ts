import { stripVTControlCharacters } from 'node:util';
import type { CommandResult } from '../../process-runner.js';
import type { ExternalCommand } from '../project/contracts.js';
import type { VersionConstraint } from './constraints.js';
import type {
  ExecutableIdentity,
  RequirementProbeResult,
  RequirementReasonCode,
  RequirementState,
  SelectedRequirement
} from './contracts.js';
import {
  compareVersionCores,
  extractVersion,
  isPrereleaseVersion,
  matchesReleaseLine
} from './versions.js';

const MISSING_ERROR_CODES = new Set(['ENOENT']);

export function commandMissing(result: CommandResult): boolean {
  return result.errorCode !== undefined && MISSING_ERROR_CODES.has(result.errorCode);
}

export function requiredConstraint(requirement: SelectedRequirement): VersionConstraint {
  return {
    ...(requirement.minimumVersion ? { minimumVersion: requirement.minimumVersion } : {}),
    ...(requirement.exactVersion ? { exactVersion: requirement.exactVersion } : {}),
    ...(requirement.releaseLine ? { releaseLine: requirement.releaseLine } : {}),
    allowPrerelease: requirement.allowPrerelease ?? false
  };
}

export function unsupportedConstraint(requirement: SelectedRequirement): string | undefined {
  for (const field of ['minimumVersion', 'exactVersion'] as const) {
    if (requirement[field] !== undefined && extractVersion(requirement[field]!) !== requirement[field]) {
      return `The requested ${field} is not a supported version constraint.`;
    }
  }
  if (requirement.definition.exactVersion && requirement.exactVersion !== requirement.definition.exactVersion) {
    return `The registered ${requirement.definition.label} pin is ${requirement.definition.exactVersion}; another requested pin is unsupported.`;
  }
  if (requirement.releaseLine !== undefined && (!/^\d+(?:\.\d+)*$/.test(requirement.releaseLine) ||
      (requirement.definition.releaseLine && requirement.releaseLine !== requirement.definition.releaseLine))) {
    return `The requested release line does not match the registered ${requirement.definition.label} constraint.`;
  }
  return undefined;
}

export function safeDetail(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '<redacted>')
    .replace(/\b(?:authorization|password|secret|token)\s*[:=]\s*\S+/gi, '<redacted>')
    .split(/\r?\n/, 1)[0]!.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 600);
}

export function resultWithCause(
  requirement: SelectedRequirement,
  identity: ExecutableIdentity,
  reasonCode: RequirementReasonCode,
  detail: string,
  fields: Partial<Pick<RequirementProbeResult, 'detectedBy' | 'detectedVersion' | 'remedy' | 'notices'>> = {}
): RequirementProbeResult {
  const states: Record<RequirementReasonCode, RequirementState> = {
    compatible: 'ready',
    'missing-executable': 'missing',
    'observation-unavailable': 'not-observable',
    'probe-failed': 'unhealthy',
    'version-unparseable': 'unhealthy',
    'unsupported-constraint': 'not-observable',
    'below-minimum': 'outdated',
    'release-line-mismatch': 'outdated',
    'exact-version-mismatch': 'outdated',
    'incompatible-channel': 'outdated'
  };
  return {
    requirement,
    state: states[reasonCode],
    reasonCode,
    detail,
    identity,
    required: requiredConstraint(requirement),
    observations: [],
    notices: [],
    ...fields
  };
}

export function missingResult(
  requirement: SelectedRequirement,
  identity: ExecutableIdentity,
  detail = 'command not found'
): RequirementProbeResult {
  return resultWithCause(requirement, identity, 'missing-executable', detail, {
    remedy: requirement.definition.missingRemedy ?? `Install ${requirement.definition.label}.`
  });
}

export function observed(
  classified: RequirementProbeResult,
  command: ExternalCommand,
  result: CommandResult
): RequirementProbeResult {
  classified.observations = [{
    command,
    identity: classified.identity,
    status: result.status,
    timedOut: result.timedOut,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    reasonCode: classified.reasonCode,
    ...(classified.detectedVersion ? { detectedVersion: classified.detectedVersion } : {})
  }];
  return classified;
}

export function classifyVersion(
  requirement: SelectedRequirement,
  command: ExternalCommand,
  result: CommandResult,
  identity: ExecutableIdentity
): RequirementProbeResult {
  if (commandMissing(result) && identity.resolution !== 'resolved') {
    return missingResult(requirement, { ...identity, resolution: 'missing' },
      safeDetail(result.stderr || result.errorMessage || '') || 'command not found');
  }
  if (result.timedOut) {
    return resultWithCause(requirement, identity, 'probe-failed', `${command.executable} version probe timed out.`, {
      remedy: `Repair ${requirement.definition.label} and retry.`
    });
  }
  if (result.status !== 0 || result.outputLimitExceeded || result.aborted || result.errorCode || result.signal) {
    return resultWithCause(requirement, identity, 'probe-failed',
      result.outputLimitExceeded ? `${command.executable} version probe exceeded the output limit.` :
        safeDetail(result.stderr || result.errorMessage || '') || `${command.executable} exited with status ${result.status}.`, {
        remedy: `Repair ${requirement.definition.label} and retry.`
      });
  }
  const output = requirement.id === 'azure-cli' ? result.stdout.trim() : `${result.stdout}\n${result.stderr}`.trim();
  const version = extractVersion(output, requirement.id);
  if (!version) {
    return resultWithCause(requirement, identity, 'version-unparseable',
      `Unable to parse a supported ${requirement.definition.label} version from the successful probe output.`, {
        detectedBy: command.executable,
        remedy: `Verify the ${requirement.definition.label} executable and its version output before selecting a remedy.`
      });
  }
  const detected = { detectedVersion: version, detectedBy: command.executable };
  if (
    version &&
    !requirement.allowPrerelease &&
    isPrereleaseVersion(version)
  ) {
    return resultWithCause(requirement, identity, 'incompatible-channel',
      `Found prerelease ${version}; a stable release is required.`, {
      ...detected,
      remedy: requirement.exactVersion
        ? `Install ${requirement.definition.label} ${requirement.exactVersion}.`
        : `Install a stable ${requirement.definition.label} release${requirement.releaseLine ? ` in the supported ${requirement.releaseLine} line` : ''}.`
    });
  }
  if (
    version &&
    requirement.releaseLine &&
    !matchesReleaseLine(version, requirement.releaseLine)
  ) {
    return resultWithCause(requirement, identity, 'release-line-mismatch',
      `Found ${version}; the supported release line is ${requirement.releaseLine}.`, {
      ...detected,
      remedy: requirement.exactVersion
        ? `Install ${requirement.definition.label} ${requirement.exactVersion}.`
        : `Install ${requirement.definition.label} ${requirement.releaseLine}.x at or above ${requirement.minimumVersion}.`
    });
  }
  if (requirement.exactVersion && compareVersionCores(version, requirement.exactVersion) !== 0) {
    return resultWithCause(requirement, identity, 'exact-version-mismatch',
      `Found ${version}; Liftoff tested this integration with exactly ${requirement.exactVersion}.`, {
      ...detected, remedy: `Install ${requirement.definition.label} ${requirement.exactVersion}.`
    });
  }
  if (requirement.minimumVersion && compareVersionCores(version, requirement.minimumVersion) < 0) {
    return resultWithCause(requirement, identity, 'below-minimum',
      `Found ${version}; version ${requirement.minimumVersion} or newer is required.`, {
      ...detected, remedy: `Upgrade ${requirement.definition.label} to ${requirement.minimumVersion} or newer.`
    });
  }
  return resultWithCause(requirement, identity, 'compatible', `Version ${version}`, {
    ...detected,
    notices: isPrereleaseVersion(version) ? [{
      code: 'preview-channel',
      label: `${requirement.definition.label} release channel`,
      state: 'notice',
      detail: `Compatible preview ${version}; a stable-channel downgrade is not required.`
    }] : []
  });
}

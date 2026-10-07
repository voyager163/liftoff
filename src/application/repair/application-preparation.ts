import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { compareVersionCores } from '../../domain/workstation/versions.js';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { ApplicationInspectionError, applicationPathKey } from './application-files.js';
import { validateApplicationCommands } from './application-commands.js';
import { applicationCandidateFiles } from './application-candidate.js';
import {
  resolveApplicationPreparationInputs, resolveCapturedApplicationPreparationInputs
} from './application-preparation-inputs.js';
import {
  assertApplicationToolsCurrent, resolveApplicationPreparationTools,
  resolveApplicationToolsForLocalChecks
} from './application-toolchain.js';
import type {
  ApplicationInspectionOptions, ApplicationPreparationRequest, ApplicationResolvedCheck,
  ApplicationToolId, ApplicationToolIdentity
} from './application-preparation-types.js';
import type {
  ApplicationDirectoryObservation, ApplicationPatchCandidate, ApplicationTargetArtifact,
  ApplicationVerificationCommand, ApplicationVerificationPolicy
} from './application-types.js';

export function compatibleRange(version: string, value: string): boolean {
  const trimmed = value.trim();
  const caret = trimmed.match(/^\^(\d+)\.(\d+)\.(\d+)$/u);
  if (caret && Number(caret[1]) > 0) {
    return compareVersionCores(version, `${caret[1]}.${caret[2]}.${caret[3]}`) >= 0 &&
      compareVersionCores(version, `${Number(caret[1]) + 1}.0.0`) < 0;
  }
  const clauses = trimmed.replaceAll(',', ' ').trim().split(/\s+/u);
  if (!clauses.length) return false;
  return clauses.every((clause) => {
    const match = clause.match(/^(>=|<=|>|<|=|==)?(\d+(?:\.\d+){0,2})$/u);
    if (!match) throw new ApplicationInspectionError('[unsupported-tool-requirement] Candidate runtime requirements use unsupported range syntax; no tool compatibility is inferred.');
    const comparison = compareVersionCores(version, match[2]!);
    switch (match[1] ?? '=') {
      case '>=': return comparison >= 0;
      case '<=': return comparison <= 0;
      case '>': return comparison > 0;
      case '<': return comparison < 0;
      default: return comparison === 0;
    }
  });
}

export interface CapturedApplicationVerificationPolicyInput {
  readonly projectRoot: string;
  readonly stagingRoot: string;
  readonly snapshots: readonly ProjectFileSnapshot[];
  readonly directories: readonly ApplicationDirectoryObservation[];
  readonly targets: readonly ApplicationTargetArtifact[];
  readonly commands: readonly ApplicationVerificationCommand[];
  readonly preparation: readonly ApplicationPreparationRequest[];
}

export async function resolveCapturedApplicationVerificationPolicy(
  input: CapturedApplicationVerificationPolicyInput,
  options: ApplicationInspectionOptions = {},
  approvedTools?: readonly ApplicationToolIdentity[],
  requireProbeSettlement = false
): Promise<ApplicationVerificationPolicy> {
  validateApplicationCommands(input.commands, input.snapshots, input.directories);
  const preparation = resolveCapturedApplicationPreparationInputs(
    input.snapshots, input.targets, input.preparation
  );
  const checkTools: ApplicationToolId[] = input.commands.map((command) => {
    if (command.executable === 'python3') return 'python';
    if (command.executable === 'node' || command.executable === 'npm' ||
        command.executable === 'python' || command.executable === 'go') {
      return command.executable;
    }
    throw new ApplicationInspectionError('[unsupported-check] Prepared verification requires an exact registered check tool.');
  });
  const toolchain = approvedTools
    ? structuredClone([...approvedTools])
    : preparation.length
      ? await resolveApplicationPreparationTools(
        input.projectRoot, input.stagingRoot, preparation, options, checkTools,
        requireProbeSettlement
      )
      : await resolveApplicationToolsForLocalChecks(
        input.projectRoot, input.stagingRoot, checkTools, options, requireProbeSettlement
      );
  if (approvedTools) {
    await assertApplicationToolsCurrent(input.projectRoot, input.stagingRoot, approvedTools);
  }
  for (const entry of preparation) {
    for (const [id, requirement] of Object.entries(entry.toolRequirements)) {
      const tool = toolchain.find((item) => item.id === id.replace(/-(?:exact|toolchain)$/u, ''));
      if (!tool || !compatibleRange(tool.version, requirement)) {
        throw new ApplicationInspectionError('[incompatible-tool] The installed runtime/interpreter does not satisfy the candidate component requirement. No toolchain replacement or download is authorized.');
      }
    }
    for (const command of entry.commands) {
      command.args = command.args.map((argument) => {
        if (argument !== '$APPROVED_PYTHON') return argument;
        const python = toolchain.find((item) => item.id === 'python');
        if (!python) {
          throw new ApplicationInspectionError('[missing-tool] Locked Python preparation requires its approved interpreter.');
        }
        return python.executablePath;
      });
    }
    const { digest: _digest, ...body } = entry;
    entry.digest = canonicalSha256(body);
  }
  const files = new Map(input.snapshots.filter((item) => item.content !== undefined)
    .map((item) => [applicationPathKey(item.pathParts), item.content!]));
  const executionCommands: ApplicationResolvedCheck[] = input.commands.map((command) => {
    const id = command.executable === 'python3' ? 'python' : command.executable;
    const tool = toolchain.find((item) => item.id === id);
    if (!tool) {
      throw new ApplicationInspectionError('[missing-tool] A declared check lacks an approved installed tool identity.');
    }
    if (tool.id === 'npm') {
      const bytes = files.get(applicationPathKey([...command.cwdPathParts, 'package.json']));
      let project: unknown;
      try { project = bytes === undefined ? null : JSON.parse(bytes.toString('utf8')); }
      catch { project = null; }
      const name = command.args[0] === 'run' ? command.args[1] : command.args[0];
      if (!isRecord(project) || !isRecord(project.scripts) || !name ||
          typeof project.scripts[name] !== 'string') {
        throw new ApplicationInspectionError('[missing-check] The candidate npm component does not declare the requested check. A frontend build is not invented frontend test coverage.');
      }
    }
    const python = tool.id === 'python'
      ? preparation.find((item) => item.provider === 'uv-locked-sync')
      : undefined;
    const pythonEnvironmentPathParts = python
      ? ['project', ...python.cwdPathParts, '.venv',
          ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])]
      : null;
    return {
      executable: pythonEnvironmentPathParts
        ? `$WORKSPACE/${pythonEnvironmentPathParts.join('/')}`
        : tool.executablePath,
      args: [...tool.prefixArgs, ...command.args],
      cwdPathParts: [...command.cwdPathParts],
      tool: tool.id,
      pythonEnvironmentPathParts
    };
  });
  return {
    kind: 'isolated-application-checks',
    commands: input.commands.map((command) => ({
      ...command, args: [...command.args], cwdPathParts: [...command.cwdPathParts]
    })),
    preparation,
    toolchain,
    executionCommands,
    outputRoles: preparation.flatMap((entry) => entry.outputRoles),
    effects: {
      projectCode: true,
      preparation: preparation.length > 0,
      lifecycle: false,
      isolatedCopy: true,
      network: input.commands.some((entry) => entry.network) ||
        preparation.some((entry) => entry.network),
      securitySandbox: false
    }
  };
}

export async function resolveApplicationPreparation(
  candidate: ApplicationPatchCandidate, requests: readonly ApplicationPreparationRequest[],
  options: ApplicationInspectionOptions, approvedTools?: readonly ApplicationToolIdentity[]
): Promise<void> {
  if (!requests.length) return;
  candidate.verificationPolicy.effects.preparation = true;
  candidate.verificationPolicy.effects.network ||= requests.some((entry) => entry.network);
  const declaredPreparation = resolveApplicationPreparationInputs(candidate, requests);
  candidate.verificationPolicy.preparation = declaredPreparation;
  candidate.scope.preparation = declaredPreparation;
  const policy = await resolveCapturedApplicationVerificationPolicy({
    projectRoot: candidate.scope.projectRoot,
    stagingRoot: candidate.scope.staging.root,
    snapshots: applicationCandidateFiles(candidate),
    directories: candidate.scope.directoryInventory,
    targets: candidate.scope.target?.artifacts ?? [],
    commands: candidate.verificationPolicy.commands,
    preparation: requests
  }, options, approvedTools);
  Object.assign(candidate.verificationPolicy, policy);
  candidate.scope.preparation = policy.preparation;
  candidate.scope.toolchain = policy.toolchain;
}

export { applicationPreparationSupport, applicationPreparationBounds } from './application-preparation-policy.js';
export type { ApplicationVerificationOptions, ApplicationPreparationRequest } from './application-preparation-types.js';

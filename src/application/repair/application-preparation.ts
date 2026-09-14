import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { compareVersionCores } from '../../domain/workstation/versions.js';
import { ApplicationInspectionError, applicationPathKey } from './application-files.js';
import { applicationCandidateFiles } from './application-candidate.js';
import { resolveApplicationPreparationInputs } from './application-preparation-inputs.js';
import { assertApplicationToolsCurrent, resolveApplicationPreparationTools } from './application-toolchain.js';
import type {
  ApplicationInspectionOptions, ApplicationPreparationRequest, ApplicationResolvedCheck,
  ApplicationToolId, ApplicationToolIdentity
} from './application-preparation-types.js';
import type { ApplicationPatchCandidate } from './application-types.js';

function compatibleRange(version: string, value: string): boolean {
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

export async function resolveApplicationPreparation(
  candidate: ApplicationPatchCandidate, requests: readonly ApplicationPreparationRequest[],
  options: ApplicationInspectionOptions, approvedTools?: readonly ApplicationToolIdentity[]
): Promise<void> {
  if (!requests.length) return;
  candidate.verificationPolicy.effects.preparation = true;
  candidate.verificationPolicy.effects.network ||= requests.some((entry) => entry.network);
  const preparation = resolveApplicationPreparationInputs(candidate, requests);
  candidate.verificationPolicy.preparation = preparation;
  candidate.scope.preparation = preparation;
  const checkTools: ApplicationToolId[] = candidate.verificationPolicy.commands.map((command) => {
    if (command.executable === 'python3') return 'python';
    if (command.executable === 'node' || command.executable === 'npm' || command.executable === 'python' || command.executable === 'go') return command.executable;
    throw new ApplicationInspectionError('[unsupported-check] Prepared verification requires an exact registered check tool.');
  });
  const toolchain = approvedTools
    ? structuredClone([...approvedTools])
    : await resolveApplicationPreparationTools(candidate.scope.projectRoot, candidate.scope.staging.root, preparation, options, checkTools);
  if (approvedTools) await assertApplicationToolsCurrent(candidate.scope.projectRoot, candidate.scope.staging.root, approvedTools);
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
        if (!python) throw new ApplicationInspectionError('[missing-tool] Locked Python preparation requires its approved interpreter.');
        return python.executablePath;
      });
    }
    const { digest: _digest, ...body } = entry;
    entry.digest = canonicalSha256(body);
  }
  const files = new Map(applicationCandidateFiles(candidate).filter((item) => item.content !== undefined)
    .map((item) => [applicationPathKey(item.pathParts), item.content!]));
  const executionCommands: ApplicationResolvedCheck[] = candidate.verificationPolicy.commands.map((command) => {
    const id = command.executable === 'python3' ? 'python' : command.executable;
    const tool = toolchain.find((item) => item.id === id);
    if (!tool) throw new ApplicationInspectionError('[missing-tool] A declared check lacks an approved installed tool identity.');
    if (tool.id === 'npm') {
      const bytes = files.get(applicationPathKey([...command.cwdPathParts, 'package.json']));
      let project: unknown;
      try { project = bytes === undefined ? null : JSON.parse(bytes.toString('utf8')); }
      catch { project = null; }
      const name = command.args[0] === 'run' ? command.args[1] : command.args[0];
      if (!isRecord(project) || !isRecord(project.scripts) || !name || typeof project.scripts[name] !== 'string') {
        throw new ApplicationInspectionError('[missing-check] The candidate npm component does not declare the requested check. A frontend build is not invented frontend test coverage.');
      }
    }
    const python = tool.id === 'python' ? preparation.find((item) => item.provider === 'uv-locked-sync') : undefined;
    const pythonEnvironmentPathParts = python
      ? ['project', ...python.cwdPathParts, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])]
      : null;
    return {
      executable: pythonEnvironmentPathParts ? `$WORKSPACE/${pythonEnvironmentPathParts.join('/')}` : tool.executablePath,
      args: [...tool.prefixArgs, ...command.args], cwdPathParts: [...command.cwdPathParts],
      tool: tool.id, pythonEnvironmentPathParts
    };
  });
  candidate.verificationPolicy.preparation = preparation;
  candidate.verificationPolicy.toolchain = toolchain;
  candidate.verificationPolicy.executionCommands = executionCommands;
  candidate.verificationPolicy.outputRoles = preparation.flatMap((entry) => entry.outputRoles);
  candidate.verificationPolicy.effects.preparation = true;
  candidate.verificationPolicy.effects.network ||= preparation.some((entry) => entry.network);
  candidate.scope.preparation = preparation;
  candidate.scope.toolchain = toolchain;
}

export { applicationPreparationSupport, applicationPreparationBounds } from './application-preparation-policy.js';
export type { ApplicationVerificationOptions, ApplicationPreparationRequest } from './application-preparation-types.js';

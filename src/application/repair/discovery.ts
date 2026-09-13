import { lstat } from 'node:fs/promises';
import { resolveProjectPath } from '../../adapters/filesystem/project-paths.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { CommandRunner, CommandResult } from '../../process-runner.js';
import type { InfrastructureRepairCandidate } from './infrastructure.js';

export const repairCommandLimits = { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 } as const;
export const repairDiscoveryLimits = { totalTimeoutMs: 120_000, maximumResourceGroups: 24 } as const;
export interface RepairDiscovery {
  status: 'verified-undeployed' | 'stateful' | 'unknown' | 'not-required';
  blockers: string[];
  observations: { kind: 'local-state' | 'azure-resource-group'; identity: string; status: 'absent' | 'present' | 'unknown' }[];
}

export function commandFailure(result: CommandResult): string | undefined {
  if (result.timedOut) return 'timed out';
  if (result.aborted) return 'was cancelled';
  if (result.outputLimitExceeded) return 'exceeded its output limit';
  if (result.errorCode === 'ENOENT') return 'requires an installed executable on PATH';
  if (result.errorCode || result.status !== 0 || result.signal) return 'failed; check existing authentication, permissions and tool readiness';
  return undefined;
}

export async function discoverRepairEligibility(
  projectRoot: string,
  candidate: InfrastructureRepairCandidate,
  options: { live: boolean; subscription?: string; runner: CommandRunner; env?: NodeJS.ProcessEnv }
): Promise<RepairDiscovery> {
  const result: RepairDiscovery = { status: 'unknown', blockers: [], observations: [] };
  if (candidate.layout === 'independent' && !candidate.blockers.length) return { ...result, status: 'not-required' };
  for (const parts of candidate.statePaths) {
    try {
      await lstat(await resolveProjectPath(projectRoot, parts));
      result.observations.push({ kind: 'local-state', identity: parts.join('/'), status: 'present' });
      result.blockers.push(`Existing state or backend metadata at ${parts.join('/')}. The local repair lane cannot establish undeployed scope; protected stateful inspection is required.`);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      result.observations.push({ kind: 'local-state', identity: parts.join('/'), status: 'absent' });
    }
  }
  if (result.blockers.length) return result;
  if (candidate.blockers.length) return result;
  if (!options.live || !options.subscription) {
    result.blockers.push('Deployment status is unknown. Missing local state is not proof of absence; request the explicit live check for the correct subscription.');
    return result;
  }
  if (!candidate.resourceGroups.length) {
    result.blockers.push('No complete authoritative Azure resource scope could be established from the source configuration.');
    return result;
  }
  if (candidate.resourceGroups.length > repairDiscoveryLimits.maximumResourceGroups) {
    result.blockers.push(`The resource scope exceeds the bounded ${repairDiscoveryLimits.maximumResourceGroups}-group local repair recipe.`);
    return result;
  }
  if (new Set(candidate.resourceGroups.map((group) => group.name.toLowerCase())).size !== candidate.resourceGroups.length) {
    result.blockers.push('Resource-group bindings overlap between the proposed independent roots. Separate environment ownership must be established before local repair.');
    return result;
  }
  const signal = AbortSignal.timeout(repairDiscoveryLimits.totalTimeoutMs);
  const run = async (args: string[]): Promise<CommandResult> => options.runner.run(
    { executable: 'az', args: [...args, '--only-show-errors', '--output', 'json'] },
    { cwd: projectRoot, env: options.env, signal, ...repairCommandLimits }
  );
  const account = await run(['account', 'show', '--subscription', options.subscription]);
  const accountFailure = commandFailure(account);
  if (accountFailure) {
    result.blockers.push(`Azure subscription verification ${accountFailure}. No authentication or permission changes were attempted.`);
    return result;
  }
  let identity: unknown;
  try { identity = JSON.parse(account.stdout); }
  catch { result.blockers.push('Azure subscription verification returned invalid JSON.'); return result; }
  if (!isRecord(identity) || typeof identity.id !== 'string' ||
      identity.id.toLowerCase() !== options.subscription.toLowerCase() || identity.state !== 'Enabled' ||
      typeof identity.tenantId !== 'string' || !identity.tenantId) {
    result.blockers.push('Azure account response did not verify the exact enabled subscription and tenant.');
    return result;
  }
  for (const group of candidate.resourceGroups) {
    const observation = await run(['group', 'exists', '--name', group.name, '--subscription', options.subscription]);
    const failure = commandFailure(observation);
    let exists: unknown;
    try { exists = failure ? undefined : JSON.parse(observation.stdout); }
    catch { exists = undefined; }
    const status = exists === false ? 'absent' : exists === true ? 'present' : 'unknown';
    result.observations.push({
      kind: 'azure-resource-group', identity: `${options.subscription}/${group.name}`, status
    });
    if (status === 'unknown') {
      result.blockers.push(`Azure resource-group observation for ${group.environment}/${group.name} ${failure ?? 'returned an invalid result'}. Absence is not established.`);
      break;
    }
    if (status === 'present') {
      result.status = 'stateful';
      result.blockers.push(`Resource group ${group.name} exists. This local repair lane cannot move deployed infrastructure; protected state inspection, complete address mappings and separately approved stateful cutover are required.`);
    }
  }
  if (!result.blockers.length) result.status = 'verified-undeployed';
  return result;
}

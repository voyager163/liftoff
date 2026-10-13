import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EnvironmentId } from '../../domain/project/contracts.js';
import type { CommandRunner } from '../../process-runner.js';
import { commandFailure } from './discovery.js';
import type { InfrastructureRepairCandidate } from './infrastructure.js';
import { packagedSupportedStack } from '../../adapters/packaged-assets/supported-stack.js';
import { compareVersionCores, extractVersion, isPrereleaseVersion } from '../../domain/workstation/versions.js';

export const repairValidationPolicy = {
  kind: 'isolated-backend-disabled',
  tool: { executable: 'tofu',
    minimumVersion: packagedSupportedStack.runtimes.opentofu.minimumVersion ?? packagedSupportedStack.runtimes.opentofu.version,
    releaseLine: packagedSupportedStack.runtimes.opentofu.releaseLine ?? packagedSupportedStack.runtimes.opentofu.version.split('.').slice(0, 2).join('.'),
    channel: 'stable' },
  formatCommand: ['fmt', '-check', '-recursive'],
  commands: [
    ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'],
    ['validate', '-no-color', '-json']
  ],
  timeoutMs: 120_000,
  maxOutputBytes: 64 * 1024,
  effects: 'Private staging and provider downloads only; no live plan, apply, backend initialization or project scripts.'
} as const;

class RepairValidationError extends Error {}

export async function validateRepairCandidate(
  candidate: InfrastructureRepairCandidate,
  environments: readonly EnvironmentId[],
  runner: CommandRunner,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'liftoff-repair-'));
  let cleanupSafe = true;
  let failure: { error: unknown } | undefined;
  try {
    for (const file of candidate.files) {
      const destination = path.join(staging, ...file.pathParts);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { mode: 0o600, flag: 'wx' });
    }
    const home = path.join(staging, 'private-home');
    await mkdir(home, { mode: 0o700 });
    const config = path.join(home, 'tofu.rc');
    await writeFile(config, '', { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...inherited };
    for (const name of Object.keys({ ...process.env, ...inherited })) {
      if (['TF_', 'TOFU_', 'OTF_', 'ARM_', 'AZURE_', 'AWS_', 'GOOGLE_'].some((prefix) => name.startsWith(prefix))) {
        env[name] = undefined;
      }
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home,
      TF_CLI_CONFIG_FILE: config, TF_IN_AUTOMATION: '1', TF_INPUT: '0'
    });
    const run = async (args: readonly string[], cwd: string, timeoutMs: number, maxOutputBytes: number) => {
      cleanupSafe = false;
      const result = await runner.run({ executable: 'tofu', args: [...args] }, {
        cwd, env, timeoutMs, maxOutputBytes, ensureProcessTreeSettled: true
      });
      cleanupSafe = result.processTreeSettled === true &&
        !['PROCESS_TREE_TERMINATION_FAILED', 'DESCENDANT_PROCESSES_ACTIVE', 'UNSUPPORTED_PROCESS_SETTLEMENT']
          .includes(result.errorCode ?? '');
      if (!cleanupSafe) {
        throw new RepairValidationError('Isolated OpenTofu command settlement was not confirmed; private staging is retained and no project transaction is authorized.');
      }
      return result;
    };
    const versionResult = await run(['--version'], staging, 30_000, 16_384);
    const version = extractVersion(versionResult.stdout, 'opentofu');
    if (commandFailure(versionResult) || !version || isPrereleaseVersion(version) ||
        !version.startsWith(`${repairValidationPolicy.tool.releaseLine}.`) ||
        compareVersionCores(version, repairValidationPolicy.tool.minimumVersion) < 0) {
      throw new RepairValidationError(`Repair validation requires stable OpenTofu ${repairValidationPolicy.tool.minimumVersion}+ on the ${repairValidationPolicy.tool.releaseLine}.x release line. Prepare that executable separately; repair does not install tools.`);
    }
    const formatting = await run(repairValidationPolicy.formatCommand,
      path.join(staging, 'infrastructure', 'opentofu', 'azure'), 30_000, 65536);
    if (commandFailure(formatting)) {
      throw new RepairValidationError('The repair candidate does not pass OpenTofu formatting. Project files were preserved. Format the original infrastructure with tofu fmt -recursive, then request a fresh repair check; persistent generated-root formatting failures require a CLI fix.');
    }
    for (const environment of environments) {
      const cwd = path.join(staging, 'infrastructure', 'opentofu', 'azure', 'environments', environment);
      for (const args of repairValidationPolicy.commands) {
        const result = await run(args, cwd, repairValidationPolicy.timeoutMs, repairValidationPolicy.maxOutputBytes);
        const failure = commandFailure(result);
        if (failure) throw new RepairValidationError(`Isolated OpenTofu ${args[0]} for ${environment} ${failure}. Project files were not changed; resolve the tool or configuration problem and request a new repair preview.`);
        if (args[0] === 'validate') {
          let value: unknown;
          try { value = JSON.parse(result.stdout); }
          catch { throw new RepairValidationError(`OpenTofu validation for ${environment} did not return valid JSON; project files were preserved.`); }
          if (typeof value !== 'object' || value === null || !('valid' in value) || value.valid !== true ||
              !('error_count' in value) || value.error_count !== 0) {
            throw new RepairValidationError(`OpenTofu validation for ${environment} did not confirm a valid candidate; project files were preserved. Configuration diagnostics may contain sensitive values and are not echoed.`);
          }
        }
      }
    }
  } catch (error) {
    failure = { error };
  }
  if (!cleanupSafe) {
    throw new Error('Isolated OpenTofu command settlement was not confirmed; private staging cleanup is blocked and no project transaction is authorized.',
      { cause: failure?.error });
  }
  try {
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    if (failure) {
      const primary = failure.error instanceof RepairValidationError ? failure.error.message : 'Isolated OpenTofu validation failed.';
      throw new AggregateError([failure.error, error],
        `${primary} Private staging cleanup also failed; no project transaction is authorized.`,
        { cause: failure.error });
    }
    throw new Error('Private OpenTofu staging cleanup failed; no project transaction is authorized.', { cause: error });
  }
  if (failure) throw failure.error;
}

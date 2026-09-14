import { chmod, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { extractVersion } from '../../domain/workstation/versions.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../../process-runner.js';
import { ApplicationFiles, ApplicationInspectionError, applicationParts, applicationPathKey } from './application-files.js';
import { applicationCandidateDigest, applicationInspectedProjectUnchanged, assertApplicationCandidateCurrent } from './application-patch-inspection.js';
import { applicationVerificationLimitation } from './application-commands.js';
import { createApplicationEnvironment } from './application-environment.js';
import { ApplicationCandidateProtection } from './application-protection.js';
import { applicationCommandFailure, applicationFailureBlocker, applicationRunnerFailure } from './application-diagnostics.js';
import { applicationPreparationFailure } from './application-preparation-diagnostics.js';
import { applicationPackageSources, applicationPreparationBounds } from './application-preparation-policy.js';
import { assertApplicationToolsCurrent } from './application-toolchain.js';
import { loadRepairPreview } from './preview.js';
import { createRepairVerificationWorkspace } from './workspaces.js';
import type { RepairVerificationWorkspace } from './workspaces-types.js';
import type { ApplicationPatchCandidate, ApplicationVerificationCommand, ApplicationVerificationResult } from './application-types.js';
import type { ApplicationResolvedPreparation, ApplicationVerificationOptions } from './application-preparation-types.js';

async function copyCandidate(candidate: ApplicationPatchCandidate, project: string): Promise<void> {
  for (const directory of candidate.scope.directoryInventory) {
    if (directory.exists && directory.pathParts.length) {
      await mkdir(path.join(project, ...applicationParts(directory.pathParts)), { recursive: true, mode: 0o700 });
    }
  }
  const modes = new Map<string, number>();
  for (const snapshot of candidate.snapshots) {
    if (snapshot.content === undefined) continue;
    const target = path.join(project, ...applicationParts(snapshot.pathParts));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, snapshot.content, { flag: 'wx', mode: 0o600 });
    modes.set(applicationPathKey(snapshot.pathParts), snapshot.mode!);
  }
  for (const mutation of candidate.mutations) {
    const target = path.join(project, ...applicationParts(mutation.pathParts));
    if (mutation.type === 'delete') {
      await unlink(target);
      modes.delete(applicationPathKey(mutation.pathParts));
    } else {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, mutation.content, {
        flag: modes.has(applicationPathKey(mutation.pathParts)) ? 'w' : 'wx', mode: 0o600
      });
      modes.set(applicationPathKey(mutation.pathParts), mutation.mode ?? 0o600);
    }
  }
  for (const [name, mode] of modes) await chmod(path.join(project, ...name.split('/')), mode);
  for (const directory of [...candidate.scope.directoryInventory].sort((a, b) => b.pathParts.length - a.pathParts.length)) {
    if (directory.exists && directory.pathParts.length) await chmod(path.join(project, ...directory.pathParts), directory.mode! & 0o777);
  }
}

function knownSettlement(runner: CommandRunner, result: CommandResult): boolean {
  if (result.errorCode === 'PROCESS_TREE_TERMINATION_FAILED' ||
      result.errorCode === 'DESCENDANT_PROCESSES_ACTIVE' ||
      result.errorCode === 'UNSUPPORTED_PROCESS_SETTLEMENT') {
    return false;
  }
  if (typeof result.processTreeSettled === 'boolean') {
    return result.processTreeSettled;
  }
  return false;
}

function preparationEnvironment(
  base: NodeJS.ProcessEnv, workspace: RepairVerificationWorkspace, entry: ApplicationResolvedPreparation
): NodeJS.ProcessEnv {
  const env = { ...base };
  const key = entry.cwdPathParts.join('-');
  env.LIFTOFF_APPLICATION_NETWORK = entry.network ? 'declared-allowed' : 'not-authorized';
  if (entry.provider === 'npm-ci') {
    Object.assign(env, {
      npm_config_prefix: path.join(workspace.roles.project, ...entry.cwdPathParts),
      npm_config_cache: path.join(workspace.roles.cache, 'npm', key),
      npm_config_registry: entry.registry, npm_config_offline: entry.network ? 'false' : 'true',
      npm_config_ignore_scripts: 'true', npm_config_replace_registry_host: 'never',
      ...(applicationPackageSources[entry.packageSource].remoteProxyOptIn ? { npm_config_allow_remote: 'all' } : {})
    });
  } else if (entry.provider === 'uv-locked-sync') {
    Object.assign(env, {
      UV_PROJECT_ENVIRONMENT: path.join(workspace.roles.project, ...entry.cwdPathParts, '.venv'),
      UV_CACHE_DIR: path.join(workspace.roles.cache, 'uv', key), UV_DEFAULT_INDEX: entry.registry,
      UV_OFFLINE: entry.network ? '0' : '1', PIP_NO_INDEX: entry.network ? '0' : '1'
    });
  } else {
    Object.assign(env, {
      GOPATH: path.join(workspace.roles.cache, 'go-path', key),
      GOMODCACHE: path.join(workspace.roles.cache, 'go-mod', key),
      GOCACHE: path.join(workspace.roles.cache, 'go-build', key),
      GOPROXY: entry.network ? entry.registry : 'off', GOSUMDB: entry.network ? 'sum.golang.org' : 'off'
    });
  }
  return env;
}

export async function verifyApplicationPatch(
  root: string, candidate: ApplicationPatchCandidate, runner: CommandRunner, options: ApplicationVerificationOptions
): Promise<ApplicationVerificationResult> {
  const policy = candidate.verificationPolicy;
  const result: ApplicationVerificationResult = {
    schemaVersion: 1, kind: 'liftoff-application-verification', status: 'blocked',
    candidateDigest: applicationCandidateDigest(candidate), inspectionDigest: candidate.scope.inspectionDigest,
    verificationPolicyDigest: canonicalSha256(policy), providerDigest: canonicalSha256(policy.preparation),
    toolchainDigest: canonicalSha256(policy.toolchain), preparedScopeDigest: canonicalSha256([]),
    startedAt: new Date().toISOString(), completedAt: '', commands: [], preparation: [], blockers: [],
    inspectedProjectUnchanged: false, cleanupComplete: true, limitation: applicationVerificationLimitation
  };
  let workspace: RepairVerificationWorkspace | undefined;
  let protection: ApplicationCandidateProtection | undefined;
  let admissionChecked = false;
  let uncertain = false;
  const assertAdmission = async () => {
    if (process.platform === 'win32') {
      const { resolveWindowsPowerShellPath, verifyWindowsJobControllerAsset } = await import('../../adapters/process/windows-job-runner.js');
      const powershellPath = resolveWindowsPowerShellPath();
      const { existsSync } = await import('node:fs');
      if (!existsSync(powershellPath)) {
        throw new ApplicationInspectionError('[unsupported-platform-settlement] Windows PowerShell 5.1 is required for Windows process-tree settlement verification. Project-code and preparation effects were not executed.');
      }
      try {
        await verifyWindowsJobControllerAsset();
      } catch (err) {
        throw new ApplicationInspectionError(`[corrupted-controller-asset] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!options || typeof options.assertCurrent !== 'function' || !options.preview ||
        options.allowProjectCode !== true || typeof options.allowDependencyPreparation !== 'boolean' ||
        typeof options.allowNetwork !== 'boolean') {
      throw new ApplicationInspectionError('[verification-consent] Verification requires the real saved preview, a coordinator input assertion, and explicit project-code/preparation/network permission fields.');
    }
    if (policy.effects.preparation && !options.allowDependencyPreparation) {
      throw new ApplicationInspectionError('[preparation-consent] The displayed dependency preparation requires its own explicit approval before any preparation or check command.');
    }
    if (candidate.networkRequired && !options.allowNetwork) {
      throw new ApplicationInspectionError('[network-consent] Declared network effects need separate approval before any preparation/check command (or explicit --allow-network automation).');
    }
    const preview = await loadRepairPreview(root, options.preview.fingerprint, options.storage?.clock?.() ?? new Date(), options.storage);
    if (canonicalSha256(preview) !== canonicalSha256(options.preview) || preview.applicationPatchPath !== candidate.patchPath ||
        preview.recipe.id !== 'application-layout-patch' || preview.verificationDigest !== result.verificationPolicyDigest) {
      throw new ApplicationInspectionError('[stale-preview] The real saved preview does not match this application candidate, recipe, or verification/preparation policy.');
    }
    try { await options.assertCurrent(); }
    catch { throw new ApplicationInspectionError('[stale-preview] The coordinator could not rebind the same approved raw inputs and immutable plan. Request a fresh review.'); }
    await assertApplicationCandidateCurrent(root, candidate);
    await assertApplicationToolsCurrent(root, candidate.scope.staging.root, policy.toolchain);
    admissionChecked = true;
    result.inspectedProjectUnchanged = true;
  };
  const run = async (
    logical: ApplicationVerificationCommand, actual: ExternalCommand, env: NodeJS.ProcessEnv,
    kind: 'preparation' | 'verification', index: number, metadata = false, preparation?: ApplicationResolvedPreparation
  ) => {
    let captured: { result?: CommandResult; error?: unknown } | undefined;
    try {
      await workspace!.runOwned({
        kind, commandDigest: canonicalSha256({ command: actual, cwdPathParts: logical.cwdPathParts, metadata, policy: result.verificationPolicyDigest }),
        network: logical.network, lifecycle: false
      }, async () => {
        try {
          const actualResult = await runner.run(actual, {
            cwd: metadata ? workspace!.roles.home : path.join(workspace!.roles.project, ...logical.cwdPathParts), env,
            timeoutMs: logical.timeoutMs, maxOutputBytes: logical.maxOutputBytes, stream: false,
            ensureProcessTreeSettled: true
          });
          captured = { result: actualResult };
          const definitivePreExecutionFailure = actualResult.processSpawned === false &&
            actualResult.processTreeSettled === false &&
            actualResult.signal === null &&
            Boolean(actualResult.errorCode && [
              'RESTRICTED_EXECUTION_POLICY', 'CONSTRAINED_LANGUAGE_MODE', 'UNSUPPORTED_PROCESS_SETTLEMENT',
              'CORRUPTED_CONTROLLER_ASSET', 'POWERSHELL_SPAWN_FAILED', 'CONTROLLER_LAUNCH_FAILED',
              'AUTHENTICATION_FAILED', 'SPAWN_REQUEST_FAILED',
              'ENOENT', 'EACCES', 'ENOEXEC'
            ].includes(actualResult.errorCode));
          const settled = knownSettlement(runner, actualResult) || definitivePreExecutionFailure;
          uncertain ||= (!settled && !definitivePreExecutionFailure);
          return { value: captured, allKnownCommandsSettled: settled };
        } catch (error) {
          captured = { error };
          uncertain = true;
          return { value: captured, allKnownCommandsSettled: false };
        }
      });
    } catch (error) {
      if (!captured) throw new ApplicationInspectionError('[workspace-activity] Registered command admission or progress could not be confirmed; no success receipt is permitted.');
      uncertain = true;
    }
    const raw = captured?.result;
    const diagnostic = raw ? preparation ? applicationPreparationFailure(preparation, logical, raw) :
      applicationCommandFailure(logical, raw) : applicationRunnerFailure(logical, captured?.error);
    const signal = raw && ['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
      'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP'].includes(raw.signal ?? '') ? raw.signal : null;
    const commandResult = {
      index, status: raw && Number.isSafeInteger(raw.status) ? raw.status : null, signal,
      timedOut: raw?.timedOut === true || diagnostic?.kind === 'timed-out',
      outputLimitExceeded: raw?.outputLimitExceeded === true || diagnostic?.kind === 'output-limit',
      passed: diagnostic === null && !uncertain && raw?.processSpawned !== false
    };
    if (diagnostic) result.blockers.push(`${kind === 'preparation' ? 'Locked preparation: ' : ''}${applicationFailureBlocker(index, logical, diagnostic)}`);
    return { raw, commandResult };
  };
  try {
    await assertAdmission();
    workspace = await createRepairVerificationWorkspace(root, {
      planFingerprint: options.preview.fingerprint,
      repairIdentity: { cliVersion: options.preview.cliVersion, repairContractVersion: options.preview.repairContractVersion, recipe: options.preview.recipe },
      patchStagingRoot: candidate.scope.staging.root,
      bindings: {
        inputDigest: options.preview.inputDigest, verificationPolicyDigest: result.verificationPolicyDigest,
        providerDigest: result.providerDigest, toolchainDigest: result.toolchainDigest
      },
      approvedScopes: {
        projectCode: true, dependencyPreparation: policy.effects.preparation && options.allowDependencyPreparation,
        network: candidate.networkRequired && options.allowNetwork, lifecycle: false
      }
    }, options.storage);
    result.workspaceId = workspace.workspaceId;
    await workspace.checkpoint('copying');
    await copyCandidate(candidate, workspace.roles.project);
    const base = await createApplicationEnvironment(options.env ?? process.env, root, candidate.scope.staging.root, workspace.directory);
    const node = policy.toolchain.find((item) => item.id === 'node');
    if (node) base.PATH = [path.dirname(node.executablePath), base.PATH ?? ''].filter(Boolean).join(path.delimiter);
    protection = new ApplicationCandidateProtection(candidate, workspace.directory);
    await protection.captureControls();
    await protection.assertCurrent();
    const revalidateTools = async (kind: 'preparation' | 'verification') => {
      await assertApplicationToolsCurrent(root, candidate.scope.staging.root, policy.toolchain);
      for (const tool of policy.toolchain) {
        const logical: ApplicationVerificationCommand = {
          executable: tool.id, args: tool.probe.args, cwdPathParts: [], network: false,
          timeoutMs: applicationPreparationBounds.probeTimeoutMs, maxOutputBytes: applicationPreparationBounds.probeOutputBytes
        };
        const probe = await run(logical, tool.probe, base, kind, 0, true);
        if (!probe.commandResult.passed || !probe.raw ||
            extractVersion(`${probe.raw.stdout}\n${probe.raw.stderr}`, tool.id) !== tool.version) {
          throw new ApplicationInspectionError('[changed-tool] Approved installed tool/interpreter identity or version changed before effects.');
        }
      }
      await assertApplicationToolsCurrent(root, candidate.scope.staging.root, policy.toolchain);
    };
    if (policy.preparation.length) {
      await workspace.checkpoint('preparing');
      await revalidateTools('preparation');
    }
    for (const preparation of policy.preparation) {
      await assertAdmission();
      await protection.assertCurrent();
      await workspace.checkpoint('preparing');
      const prepared = {
        schemaVersion: 1 as const, provider: preparation.provider, version: preparation.version,
        cwdPathParts: preparation.cwdPathParts, policyDigest: preparation.digest,
        status: 'failed' as 'failed' | 'passed', commands: [] as ApplicationVerificationResult['commands']
      };
      result.preparation.push(prepared);
      const env = preparationEnvironment(base, workspace, preparation);
      for (const [index, command] of preparation.commands.entries()) {
        const tool = policy.toolchain.find((item) => item.id === command.tool);
        if (!tool) throw new ApplicationInspectionError('[missing-tool] An approved preparation tool identity is missing.');
        const logical = {
          executable: command.tool, args: command.args, cwdPathParts: command.cwdPathParts,
          timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes, network: preparation.network
        };
        const argumentsForWorkspace = command.args.map((argument) => argument === '$PRIVATE_PYTHON_ENVIRONMENT'
          ? path.join(workspace!.roles.project, ...preparation.cwdPathParts, '.venv') : argument);
        const executed = await run(logical, { executable: tool.executablePath, args: [...tool.prefixArgs, ...argumentsForWorkspace] }, env, 'preparation', index, false, preparation);
        prepared.commands.push(executed.commandResult);
        if (!uncertain) {
          await assertAdmission();
          await protection.assertCurrent();
          await revalidateTools('preparation');
        }
        if (!executed.commandResult.passed) throw new ApplicationInspectionError('[preparation-failed] Locked preparation did not complete; no project check or file transaction can follow.');
      }
      if (preparation.provider === 'uv-locked-sync') {
        const environmentFiles = new ApplicationFiles(workspace.directory);
        const configuration = await environmentFiles.read(['project', ...preparation.cwdPathParts, '.venv', 'pyvenv.cfg']);
        const config = configuration.content?.toString('utf8') ?? '';
        const python = policy.toolchain.find((item) => item.id === 'python')!;
        if (!/^include-system-site-packages\s*=\s*false\s*$/mu.test(config) ||
            !(config.includes(`version_info = ${python.version}`) || config.includes(`version = ${python.version}`))) {
          throw new ApplicationInspectionError('[incompatible-private-environment] The prepared Python environment does not match its approved isolated interpreter scope.');
        }
      }
      await protection.freeze(preparation);
      prepared.status = 'passed';
      result.preparedScopeDigest = protection.preparedScopeDigest;
    }
    await workspace.checkpoint('verifying');
    for (const [index, command] of policy.commands.entries()) {
      await assertAdmission();
      await protection.assertCurrent();
      await revalidateTools('verification');
      const resolved = policy.executionCommands[index];
      const componentPreparation = policy.preparation.find((item) =>
        item.provider === 'uv-locked-sync' && (command.executable === 'python' || command.executable === 'python3') ||
        applicationPathKey(item.cwdPathParts) === applicationPathKey(command.cwdPathParts));
      const env = componentPreparation ? preparationEnvironment(base, workspace, componentPreparation) : { ...base };
      env.LIFTOFF_APPLICATION_NETWORK = command.network ? 'declared-allowed' : 'not-authorized';
      env.PIP_NO_INDEX = '1';
      env.UV_OFFLINE = '1';
      env.npm_config_offline = 'true';
      env.GOPROXY = 'off';
      env.GOSUMDB = 'off';
      const actual = resolved ? {
        executable: resolved.pythonEnvironmentPathParts
          ? path.join(workspace.directory, ...resolved.pythonEnvironmentPathParts) : resolved.executable,
        args: resolved.args
      } : { executable: command.executable, args: command.args };
      if (resolved?.pythonEnvironmentPathParts) {
        const target = await realpath(actual.executable);
        if (!target) throw new ApplicationInspectionError('[missing-private-environment] The approved private Python interpreter is unavailable.');
      }
      const executed = await run(command, actual, env, 'verification', index);
      result.commands.push(executed.commandResult);
      if (!uncertain) {
        await assertAdmission();
        await protection.assertCurrent();
        await revalidateTools('verification');
      }
      if (!executed.commandResult.passed) throw new ApplicationInspectionError('[check-failed] A declared check failed; earlier preparation/verifier effects remain recorded and no file transaction is authorized.');
    }
    result.status = 'passed';
    await workspace.checkpoint('verified');
  } catch (error) {
    result.status = workspace ? 'failed' : 'blocked';
    result.blockers.push(error instanceof ApplicationInspectionError ? error.message :
      '[verification-failed] Registered private preparation/verification could not complete; unsafe diagnostic values are withheld.');
    if (workspace) {
      try { await workspace.checkpoint('failed'); } catch { /* Cleanup remains guarded by the workspace owner. */ }
    }
  } finally {
    if (admissionChecked) {
      try {
        await assertApplicationCandidateCurrent(root, candidate);
        result.inspectedProjectUnchanged = true;
      } catch {
        result.inspectedProjectUnchanged = await applicationInspectedProjectUnchanged(root, candidate);
        if (result.status === 'passed') result.status = 'failed';
        result.blockers.push('[changed-inputs] Inspected application or staged inputs changed; no success receipt is valid.');
      }
    }
    if (workspace) {
      try {
        if (uncertain) throw new ApplicationInspectionError('[owner-uncertain] Verifier/preparation process termination is not proven; automatic cleanup is blocked.');
        await workspace.releaseOwner();
        const cleanup = await workspace.cleanup();
        result.cleanupComplete = cleanup.cleanupComplete;
        if (!cleanup.cleanupComplete) {
          result.status = 'failed'; result.retainedWorkspace = workspace.directory;
          result.blockers.push(...cleanup.issues.map((issue) => `[workspace-${issue.code}] ${issue.message}`));
        }
      } catch {
        result.cleanupComplete = false;
        result.retainedWorkspace = workspace.directory;
        result.status = 'failed';
        result.blockers.push('[workspace-cleanup] Registered workspace cleanup is blocked or incomplete; owner/progress metadata was retained and no success receipt may be issued.');
      }
    }
    result.completedAt = new Date().toISOString();
  }
  return result;
}

import { chmod, lstat, mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeExecutableObserver } from '../../adapters/filesystem/executables.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { compareVersionCores, extractVersion, isPrereleaseVersion } from '../../domain/workstation/versions.js';
import type { EnvironmentId } from '../../domain/project/contracts.js';
import { workstationRequirementCatalog } from '../../workstation-catalog.js';
import type { CommandRunner } from '../../process-runner.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { ApplicationFiles, applicationWithin, assertApplicationNoLinkAncestors } from './application-files.js';
import { applicationSearchEnvironment, createApplicationEnvironment } from './application-environment.js';
import { captureInstalledApplicationToolFile } from './application-toolchain.js';
import type { ApplicationToolFileIdentity } from './application-preparation-types.js';
import { commandFailure } from './discovery.js';
import { repairValidationPolicy } from './validation.js';
import { loadRepairPreview, type RepairPreview } from './preview.js';
import { createRepairVerificationWorkspace, type RepairVerificationWorkspace, type RepairWorkspaceStorageOptions } from './workspaces.js';
import type { AzureBaselineSettingsCandidate } from './baseline-settings.js';

export interface BaselineValidationPolicy {
  kind: 'isolated-azure-baseline-checks-v1';
  tool: { launcher: string; file: ApplicationToolFileIdentity; requirement: typeof repairValidationPolicy.tool };
  commands: typeof repairValidationPolicy.commands;
  timeoutMs: number;
  maxOutputBytes: number;
  formatting: 'none-preserve-reviewed-source-bytes';
  effects: string;
}

export async function baselineValidationPolicy(root: string, inherited: NodeJS.ProcessEnv = process.env): Promise<BaselineValidationPolicy> {
  const platform = process.platform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Baseline validation has no supported process-settlement implementation on this platform.');
  const environment = applicationSearchEnvironment(inherited, root, root, root);
  const observed = await nativeExecutableObserver.resolve(inherited.TOFU_PATH ?? 'tofu', {
    platform: platform as 'darwin' | 'linux' | 'win32', cwd: root, env: environment,
    definition: workstationRequirementCatalog.opentofu
  });
  if (observed.resolution !== 'resolved' || !observed.resolvedPath || !observed.realPath ||
      applicationWithin(root, observed.resolvedPath) || applicationWithin(root, observed.realPath)) {
    throw new Error('Missing prerequisite: an identifiable installed OpenTofu executable outside the project is required; repair never installs it.');
  }
  return {
    kind: 'isolated-azure-baseline-checks-v1',
    tool: { launcher: observed.resolvedPath, file: await captureInstalledApplicationToolFile(observed.resolvedPath, root, root, true), requirement: repairValidationPolicy.tool },
    commands: repairValidationPolicy.commands, timeoutMs: repairValidationPolicy.timeoutMs, maxOutputBytes: repairValidationPolicy.maxOutputBytes,
    formatting: 'none-preserve-reviewed-source-bytes',
    effects: 'Separately approved locked provider downloads and backend-disabled private validation only. No formatter, project script, live state, plan, apply, or deployed-Azure proof.'
  };
}

export async function assertBaselineTool(root: string, policy: BaselineValidationPolicy): Promise<void> {
  const actual = await captureInstalledApplicationToolFile(policy.tool.launcher, root, root, true);
  if (canonicalSha256(actual) !== canonicalSha256(policy.tool.file)) throw new Error('The reviewed OpenTofu executable changed; request a fresh preview.');
}

export function baselineTemporaryEnvironment(env: NodeJS.ProcessEnv, cwd: string, scratch: string): NodeJS.ProcessEnv {
  // Go provider Unix sockets have short pathname limits; this still resolves to the registered private scratch role.
  const temporary = process.platform === 'win32' ? scratch : path.relative(cwd, scratch) || '.';
  return { ...env, TMPDIR: temporary, TEMP: temporary, TMP: temporary };
}

export interface BaselineValidationResult {
  passed: boolean;
  commands: Array<{ operation: string; environment?: EnvironmentId; status: number | null; passed: boolean }>;
  cleanupComplete: boolean;
  workspaceId?: string;
  blockers: string[];
}

export async function validateAzureBaselineCandidate(
  root: string, candidate: AzureBaselineSettingsCandidate, environments: readonly EnvironmentId[],
  policy: BaselineValidationPolicy, preview: RepairPreview, runner: CommandRunner,
  options: {
    storage: RepairWorkspaceStorageOptions;
    env?: NodeJS.ProcessEnv;
    allowValidation: boolean;
    allowDependencyPreparation: boolean;
    allowNetwork: boolean;
    assertCurrent(): Promise<void>;
  }
): Promise<BaselineValidationResult> {
  const result: BaselineValidationResult = { passed: false, commands: [], cleanupComplete: true, blockers: [] };
  let workspace: RepairVerificationWorkspace | undefined;
  let staging: string | undefined;
  let stageGuard: ApplicationFiles | undefined;
  let stageIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  let uncertain = false;
  const assertAuthority = async () => {
    if (!options.allowValidation || !options.allowDependencyPreparation || !options.allowNetwork) {
      throw new Error('Baseline validation, locked provider preparation and network access require separate explicit authorization.');
    }
    const saved = await loadRepairPreview(root, preview.fingerprint, options.storage.clock?.() ?? new Date(), options.storage);
    if (canonicalSha256(saved) !== canonicalSha256(preview) || preview.recipe.id !== 'azure-baseline-settings' ||
        preview.verificationDigest !== canonicalSha256(policy)) throw new Error('Baseline validation does not match the real reviewed plan.');
    await options.assertCurrent();
    await assertBaselineTool(root, policy);
  };
  try {
    await assertAuthority();
    await assertApplicationNoLinkAncestors(path.dirname(root));
    staging = await mkdtemp(path.join(path.dirname(root), '.liftoff-baseline-review-'));
    await chmod(staging, 0o700);
    stageIdentity = await lstat(staging);
    const review = `${JSON.stringify({ fingerprint: preview.fingerprint, inputDigest: preview.inputDigest, effectsDigest: preview.effectsDigest })}\n`;
    await writeFile(path.join(staging, 'review.json'), review, { flag: 'wx', mode: 0o600 });
    stageGuard = new ApplicationFiles(staging);
    await stageGuard.walk();
    workspace = await createRepairVerificationWorkspace(root, {
      planFingerprint: preview.fingerprint,
      repairIdentity: { cliVersion: preview.cliVersion, repairContractVersion: preview.repairContractVersion, recipe: preview.recipe },
      patchStagingRoot: staging,
      bindings: {
        inputDigest: preview.inputDigest, verificationPolicyDigest: preview.verificationDigest,
        providerDigest: canonicalSha256(candidate.files.filter((file) => file.pathParts.at(-1) === '.terraform.lock.hcl')),
        toolchainDigest: canonicalSha256(policy.tool)
      },
      approvedScopes: { projectCode: true, dependencyPreparation: true, network: true, lifecycle: false }
    }, options.storage);
    result.workspaceId = workspace.workspaceId;
    await workspace.checkpoint('copying');
    for (const file of candidate.files) {
      const original = candidate.snapshots.find((entry) => entry.pathParts.join('/') === file.pathParts.join('/'));
      if (original?.mode === undefined || original.content === undefined) throw new Error('A baseline validation input is missing its confined snapshot.');
      const destination = path.join(workspace.roles.project, ...file.pathParts);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { flag: 'wx', mode: 0o600 });
      await chmod(destination, original.mode);
    }
    const env = await createApplicationEnvironment(options.env ?? process.env, root, staging, workspace.directory);
    const configuration = path.join(workspace.roles.home, 'tofu.rc');
    await writeFile(configuration, '', { flag: 'wx', mode: 0o600 });
    await mkdir(path.join(workspace.roles.home, 'opentofu'), { mode: 0o700 });
    Object.assign(env, {
      TF_CLI_CONFIG_FILE: configuration, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1'
    });
    const inputs = new ApplicationFiles(workspace.roles.project), controls = new ApplicationFiles(workspace.roles.home);
    await inputs.walk();
    await controls.walk();
    const unchanged = async () => {
      await assertAuthority();
      for (const [label, guard] of [['Reviewed infrastructure inputs', inputs], ['Private tool configuration', controls], ['External review inputs', stageGuard!]] as const) {
        try { await guard.assertUnchanged(); }
        catch (error) { throw new Error(`${label} changed during baseline validation.`, { cause: error }); }
      }
    };
    const execute = async (args: readonly string[], environment?: EnvironmentId) => {
      await unchanged();
      const preparing = args[0] === 'init';
      await workspace!.checkpoint(preparing ? 'preparing' : 'verifying');
      const cwd = environment
        ? path.join(workspace!.roles.project, 'infrastructure', 'opentofu', 'azure', 'environments', environment)
        : workspace!.roles.home;
      const command = { executable: policy.tool.file.path, args: [...args] };
      const value = await workspace!.runOwned({
        kind: preparing ? 'preparation' : 'verification',
        commandDigest: canonicalSha256({ command, cwd, policy: preview.verificationDigest }),
        network: preparing, lifecycle: false
      }, async () => {
        try {
          const actual = await runner.run(command, {
            cwd, env: baselineTemporaryEnvironment({
              ...env, TF_DATA_DIR: path.join(workspace!.roles.cache, 'opentofu', environment ?? 'metadata'),
              LIFTOFF_APPLICATION_NETWORK: preparing ? 'declared-allowed' : 'not-authorized'
            }, cwd, workspace!.roles.scratch),
            timeoutMs: args[0] === '--version' ? 15_000 : policy.timeoutMs,
            maxOutputBytes: policy.maxOutputBytes, ensureProcessTreeSettled: true, stream: false
          });
          uncertain ||= actual.processTreeSettled !== true;
          return { value: actual, allKnownCommandsSettled: actual.processTreeSettled === true };
        } catch (error) {
          uncertain = true;
          throw error;
        }
      });
      const passed = !commandFailure(value) && value.processTreeSettled === true && value.processSpawned !== false;
      result.commands.push({ operation: args[0]!, ...(environment ? { environment } : {}), status: value.status, passed });
      if (!passed) throw new Error(`Private OpenTofu ${args[0]}${environment ? ` for ${environment}` : ''} failed or its owned process tree did not settle; no file commit is authorized.`);
      await unchanged();
      return value;
    };
    const versionResult = await execute(['--version']);
    const version = extractVersion(versionResult.stdout, 'opentofu'), requirement = policy.tool.requirement;
    if (!version || isPrereleaseVersion(version) || !version.startsWith(`${requirement.releaseLine}.`) ||
        compareVersionCores(version, requirement.minimumVersion) < 0) {
      throw new Error(`Baseline validation requires stable OpenTofu ${requirement.minimumVersion}+ on ${requirement.releaseLine}.x; prepare the required tool separately.`);
    }
    for (const environment of environments) {
      for (const args of policy.commands) {
        const actual = await execute(args, environment);
        if (args[0] === 'validate') {
          let body: unknown;
          try { body = JSON.parse(actual.stdout); }
          catch { throw new Error('OpenTofu validate did not return a valid JSON result.'); }
          if (!isRecord(body) || body.valid !== true || body.error_count !== 0) {
            throw new Error('OpenTofu validate did not prove the reviewed baseline candidate is valid.');
          }
        }
      }
    }
    await unchanged();
    await workspace.checkpoint('verified');
    result.passed = true;
  } catch (error) {
    result.blockers.push(error instanceof Error ? error.message : 'Baseline validation could not complete.');
    if (workspace) {
      try { await workspace.checkpoint('failed'); }
      catch { uncertain = true; result.blockers.push('Private validation progress could not be recorded.'); }
    }
  } finally {
    if (workspace) {
      try {
        await workspace.releaseOwner();
        const cleaned = await workspace.cleanup();
        result.cleanupComplete = cleaned.cleanupComplete;
        result.blockers.push(...cleaned.issues.map((entry) => entry.message));
      } catch {
        result.cleanupComplete = false;
        result.blockers.push('Private workspace cleanup is incomplete; use registered repair recovery.');
      }
    }
    if (staging && !uncertain && result.cleanupComplete && stageIdentity) {
      try {
        await stageGuard?.assertUnchanged();
        const current = await lstat(staging);
        if (current.isSymbolicLink() || current.dev !== stageIdentity.dev || current.ino !== stageIdentity.ino ||
            current.mode !== stageIdentity.mode || (await readdir(staging)).join(',') !== 'review.json') {
          throw new Error('Baseline review input directory changed identity or inventory.');
        }
        await unlink(path.join(staging, 'review.json'));
        await rmdir(staging);
      } catch {
        result.cleanupComplete = false;
        result.blockers.push(`Baseline review input cleanup is incomplete; preserved ${staging}.`);
      }
    } else if (staging) {
      result.cleanupComplete = false;
      result.blockers.push(`Uncertain validation activity; preserved exact review inputs at ${staging}.`);
    }
    result.passed &&= result.cleanupComplete && !uncertain;
  }
  return result;
}

function receiptBinding(preview: RepairPreview) {
  return {
    schemaVersion: 1, kind: 'liftoff-azure-baseline-verification', fingerprint: preview.fingerprint,
    inputDigest: preview.inputDigest, effectsDigest: preview.effectsDigest, verificationDigest: preview.verificationDigest,
    identityDigest: canonicalSha256({ cliVersion: preview.cliVersion, recipe: preview.recipe, repairContractVersion: preview.repairContractVersion }),
    networkAuthorized: true, dependencyPreparationAuthorized: true, result: 'declared-checks-passed', cleanupComplete: true
  };
}

export async function readBaselineVerification(preview: RepairPreview, now: Date, storage: RepairWorkspaceStorageOptions): Promise<boolean> {
  const saved = await createScopedUserLocalRecordStore(preview.projectRoot, 'repair-verification', storage).read(preview.fingerprint);
  if (!saved) return false;
  if (!isRecord(saved.value)) throw new Error('Malformed baseline verification receipt.');
  const { verifiedAt, ...binding } = saved.value;
  if (canonicalSha256(binding) !== canonicalSha256(receiptBinding(preview)) || typeof verifiedAt !== 'string' ||
      !Number.isFinite(Date.parse(verifiedAt)) || Date.parse(verifiedAt) < Date.parse(preview.createdAt) ||
      Date.parse(verifiedAt) > now.getTime() || Date.parse(preview.expiresAt) <= now.getTime()) {
    throw new Error('Baseline verification receipt is stale or does not match this exact plan.');
  }
  return true;
}

export async function saveBaselineVerification(preview: RepairPreview, now: Date, storage: RepairWorkspaceStorageOptions): Promise<void> {
  if (preview.recipe.id !== 'azure-baseline-settings' || now.getTime() < Date.parse(preview.createdAt) ||
      now.getTime() >= Date.parse(preview.expiresAt)) throw new Error('Baseline plan expired during validation; request a fresh preview.');
  await createScopedUserLocalRecordStore(preview.projectRoot, 'repair-verification', storage).write(preview.fingerprint, {
    ...receiptBinding(preview), verifiedAt: now.toISOString()
  });
}

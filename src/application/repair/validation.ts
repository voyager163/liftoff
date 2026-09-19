import { chmod, lstat, mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentId } from '../../domain/project/contracts.js';
import type { CommandRunner, RunCommandOptions } from '../../process-runner.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import { commandFailure } from './discovery.js';
import type { InfrastructureRepairCandidate } from './infrastructure.js';
import { packagedSupportedStack } from '../../adapters/packaged-assets/supported-stack.js';
import { compareVersionCores, extractVersion, isPrereleaseVersion } from '../../domain/workstation/versions.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { ApplicationFiles, applicationParts, assertApplicationNoLinkAncestors } from './application-files.js';
import type { RepairPreview } from './preview.js';
import { captureInstalledApplicationToolFile } from './application-toolchain.js';
import type { ApplicationToolFileIdentity } from './application-preparation-types.js';
import {
  createRepairVerificationWorkspace, type RepairVerificationWorkspace, type RepairWorkspaceStorageOptions
} from './workspaces.js';

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

export async function validateRepairCandidate(
  candidate: Pick<InfrastructureRepairCandidate, 'files'>,
  environments: readonly EnvironmentId[],
  runner: CommandRunner,
  inherited: NodeJS.ProcessEnv | undefined,
  options: {
    projectRoot: string;
    preview: RepairPreview;
    tool: { launcher: string; file: ApplicationToolFileIdentity };
    storage: RepairWorkspaceStorageOptions;
    assertCurrent(): Promise<void>;
  }
): Promise<void> {
  if (!options || typeof options.assertCurrent !== 'function' || !options.tool || options.preview.recipe.id !== 'azure-local-layout') {
    throw new Error('Infrastructure validation requires its real exact reviewed repair and current input assertion.');
  }
  await options.assertCurrent();
  const receipt = await createScopedUserLocalRecordStore(options.projectRoot, 'repair-preview', options.storage).read(options.preview.fingerprint);
  if (!receipt || canonicalSha256(receipt.value) !== canonicalSha256(options.preview) ||
      options.preview.verificationDigest !== canonicalSha256(repairValidationPolicy)) {
    throw new Error('Infrastructure validation does not match the real saved preview and validation policy.');
  }
  let workspace: RepairVerificationWorkspace | undefined;
  let reviewRoot: string | undefined;
  let reviewIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  let reviewFiles: ApplicationFiles | undefined;
  let uncertain = false;
  try {
    await assertApplicationNoLinkAncestors(path.dirname(options.projectRoot));
    reviewRoot = await mkdtemp(path.join(path.dirname(options.projectRoot), '.liftoff-infrastructure-review-'));
    await chmod(reviewRoot, 0o700);
    reviewIdentity = await lstat(reviewRoot);
    await writeFile(path.join(reviewRoot, 'review.json'), canonicalJson({
      fingerprint: options.preview.fingerprint, inputDigest: options.preview.inputDigest, effectsDigest: options.preview.effectsDigest
    }), { flag: 'wx', mode: 0o600 });
    reviewFiles = new ApplicationFiles(reviewRoot);
    await reviewFiles.walk();
    workspace = await createRepairVerificationWorkspace(options.projectRoot, {
      planFingerprint: options.preview.fingerprint,
      repairIdentity: {
        cliVersion: options.preview.cliVersion, repairContractVersion: options.preview.repairContractVersion,
        recipe: options.preview.recipe
      },
      patchStagingRoot: reviewRoot,
      bindings: {
        inputDigest: options.preview.inputDigest, verificationPolicyDigest: options.preview.verificationDigest,
        providerDigest: canonicalSha256(candidate.files.filter((file) => file.pathParts.at(-1) === '.terraform.lock.hcl')),
        toolchainDigest: canonicalSha256(options.tool.file)
      },
      approvedScopes: { projectCode: true, dependencyPreparation: true, network: true, lifecycle: false }
    }, options.storage);
    const staging = workspace.roles.project;
    await workspace.checkpoint('copying');
    for (const file of candidate.files) {
      const destination = path.join(staging, ...applicationParts(file.pathParts));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { mode: 0o600, flag: 'wx' });
    }
    const home = workspace.roles.home;
    const config = path.join(home, 'tofu.rc');
    await writeFile(config, '', { mode: 0o600 });
    await mkdir(path.join(home, 'opentofu'), { mode: 0o700 });
    const candidateFiles = new ApplicationFiles(staging), controls = new ApplicationFiles(home);
    await candidateFiles.walk();
    await controls.walk();
    const assertPrivateInputs = async () => {
      await candidateFiles.assertUnchanged();
      await controls.assertUnchanged();
      await reviewFiles!.assertUnchanged();
    };
    const env: NodeJS.ProcessEnv = { ...inherited ?? process.env };
    for (const name of Object.keys({ ...process.env, ...inherited })) {
      if (['TF_', 'TOFU_', 'OTF_', 'ARM_', 'AZURE_', 'AWS_', 'GOOGLE_'].some((prefix) => name.startsWith(prefix))) {
        env[name] = undefined;
      }
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home,
      TF_CLI_CONFIG_FILE: config, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1',
      TMPDIR: workspace.roles.scratch, TMP: workspace.roles.scratch, TEMP: workspace.roles.scratch
    });
    const run = async (command: ExternalCommand, runOptions: RunCommandOptions) => {
      await options.assertCurrent();
      await assertPrivateInputs();
      const currentTool = await captureInstalledApplicationToolFile(options.tool.launcher, options.projectRoot, reviewRoot!, true);
      if (canonicalSha256(currentTool) !== canonicalSha256(options.tool.file)) {
        throw new Error('The reviewed OpenTofu executable changed before validation; request a fresh preview.');
      }
      const boundCommand = { ...command, executable: options.tool.file.path };
      const preparation = command.args[0] === 'init';
      await workspace!.checkpoint(preparation ? 'preparing' : 'verifying');
      const result = await workspace!.runOwned({
        kind: preparation ? 'preparation' : 'verification',
        commandDigest: canonicalSha256({ command: boundCommand, cwd: runOptions.cwd, policy: options.preview.verificationDigest }),
        network: preparation, lifecycle: false
      }, async () => {
        uncertain = true;
        const cwd = runOptions.cwd ?? staging;
        const scratch = process.platform === 'win32' ? workspace!.roles.scratch :
          path.relative(cwd, workspace!.roles.scratch) || '.';
        const actual = await runner.run(boundCommand, {
          ...runOptions, ensureProcessTreeSettled: true, stream: false,
          env: {
            ...runOptions.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch,
            TF_DATA_DIR: path.join(workspace!.roles.cache, 'opentofu', path.basename(cwd))
          }
        });
        uncertain = actual.processTreeSettled !== true;
        return { value: actual, allKnownCommandsSettled: !uncertain };
      });
      await options.assertCurrent();
      await assertPrivateInputs();
      return result;
    };
    const versionResult = await run({ executable: 'tofu', args: ['--version'] }, {
      cwd: staging, env, timeoutMs: 30_000, maxOutputBytes: 16_384
    });
    const version = extractVersion(versionResult.stdout, 'opentofu');
    if (commandFailure(versionResult) || !version || isPrereleaseVersion(version) ||
        !version.startsWith(`${repairValidationPolicy.tool.releaseLine}.`) ||
        compareVersionCores(version, repairValidationPolicy.tool.minimumVersion) < 0) {
      throw new Error(`Repair validation requires stable OpenTofu ${repairValidationPolicy.tool.minimumVersion}+ on the ${repairValidationPolicy.tool.releaseLine}.x release line. Prepare that executable separately; repair does not install tools.`);
    }
    const formatting = await run({ executable: 'tofu', args: [...repairValidationPolicy.formatCommand] }, {
      cwd: path.join(staging, 'infrastructure', 'opentofu', 'azure'), env, timeoutMs: 30_000, maxOutputBytes: 65536
    });
    if (commandFailure(formatting)) {
      throw new Error('The repair candidate does not pass OpenTofu formatting. Project files were preserved. Format the original infrastructure with tofu fmt -recursive, then request a fresh repair check; persistent generated-root formatting failures require a CLI fix.');
    }
    for (const environment of environments) {
      const cwd = path.join(staging, 'infrastructure', 'opentofu', 'azure', 'environments', environment);
      for (const args of repairValidationPolicy.commands) {
        const result = await run({ executable: 'tofu', args: [...args] }, {
          cwd, env, timeoutMs: repairValidationPolicy.timeoutMs, maxOutputBytes: repairValidationPolicy.maxOutputBytes
        });
        const failure = commandFailure(result);
        if (failure) throw new Error(`Isolated OpenTofu ${args[0]} for ${environment} ${failure}. Project files were not changed; resolve the tool or configuration problem and request a new repair preview.`);
        if (args[0] === 'validate') {
          let value: unknown;
          try { value = JSON.parse(result.stdout); }
          catch { throw new Error(`OpenTofu validation for ${environment} did not return valid JSON; project files were preserved.`); }
          if (typeof value !== 'object' || value === null || !('valid' in value) || value.valid !== true ||
              !('error_count' in value) || value.error_count !== 0) {
            throw new Error(`OpenTofu validation for ${environment} did not confirm a valid candidate; project files were preserved. Configuration diagnostics may contain sensitive values and are not echoed.`);
          }
        }
      }
    }
  } catch (error) {
    if (uncertain && workspace) {
      throw new Error(`Private OpenTofu process settlement is uncertain. Registered workspace ${workspace.workspaceId} and exact review inputs ${reviewRoot} were retained; no successful validation or cleanup is claimed.`, { cause: error });
    }
    throw error;
  } finally {
    if (workspace && !uncertain) {
      await workspace.releaseOwner();
      const cleanup = await workspace.cleanup();
      if (!cleanup.cleanupComplete) {
        throw new Error('Registered private infrastructure validation cleanup is incomplete; use exact repair workspace recovery.');
      }
    }
    if (reviewRoot && reviewFiles && reviewIdentity && !uncertain) {
      await reviewFiles.assertUnchanged();
      const current = await lstat(reviewRoot);
      if (!current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== reviewIdentity.dev || current.ino !== reviewIdentity.ino ||
          current.mode !== reviewIdentity.mode) {
        throw new Error('Private infrastructure review directory changed; it was preserved.');
      }
      await unlink(path.join(reviewRoot, 'review.json'));
      await rmdir(reviewRoot);
    }
  }
}

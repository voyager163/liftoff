import {
  chmod, lstat, mkdir, mkdtemp, realpath, rmdir, writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {
  createScopedUserLocalRecordStore
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { extractVersion } from '../../domain/workstation/versions.js';
import {
  NodeCommandRunner, type CommandResult, type CommandRunner
} from '../../process-runner.js';
import {
  applicationCommandFailure, applicationFailureBlocker,
  applicationRunnerFailure
} from '../repair/application-diagnostics.js';
import {
  applicationPreparationEnvironment, createApplicationEnvironment,
  withoutApplicationDependencyNetwork
} from '../repair/application-environment.js';
import {
  ApplicationFiles, ApplicationInspectionError,
  applicationPathKey, applicationParts
} from '../repair/application-files.js';
import {
  applicationPreparationFailure
} from '../repair/application-preparation-diagnostics.js';
import {
  applicationPreparationBounds
} from '../repair/application-preparation-policy.js';
import type {
  ApplicationInspectionOptions, ApplicationResolvedPreparation
} from '../repair/application-preparation-types.js';
import { CapturedApplicationProtection } from '../repair/application-protection.js';
import { assertApplicationToolsCurrent } from '../repair/application-toolchain.js';
import type {
  ApplicationDirectoryObservation, ApplicationVerificationCommand
} from '../repair/application-types.js';
import {
  createAdoptionVerificationWorkspace,
  type RepairVerificationWorkspace,
  type RepairWorkspaceStorageOptions
} from '../repair/workspaces.js';
import {
  loadAdoptionCompatibilityPlan
} from './compatibility-plan.js';
import {
  adoptionVerificationSnapshotDigest, adoptionVerificationStagingBoundary,
  type AdoptionVerificationPlan
} from './verification-plan.js';
import { inspectAdoptionCandidate } from './candidate.js';
import { liftoffVersion } from '../../version.js';
import {
  adoptionVerificationResultSchemaVersion, adoptionVerificationTime,
  loadAdoptionVerificationAuthority, persistAdoptionVerificationReceipt,
  readBoundAdoptionVerificationResult,
  type AdoptionVerificationCommandResult,
  type AdoptionVerificationExecutionResult,
  type AdoptionVerificationPreparationResult
} from './verification-result.js';

export {
  readAdoptionVerificationResult,
  type AdoptionVerificationReceipt
} from './verification-result.js';

export interface AdoptionVerificationExecutionOptions {
  readonly storage?: RepairWorkspaceStorageOptions;
  readonly inspection?: ApplicationInspectionOptions;
  readonly runner?: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}

async function copySnapshots(
  project: string,
  snapshots: AdoptionVerificationPlan['snapshots'],
  directories: readonly ApplicationDirectoryObservation[]
): Promise<void> {
  for (const directory of directories
    .filter(entry => entry.exists && entry.pathParts.length)
    .sort((left, right) => left.pathParts.length - right.pathParts.length)) {
    await mkdir(path.join(project, ...applicationParts(directory.pathParts)), {
      recursive: true, mode: 0o700
    });
  }
  for (const snapshot of snapshots) {
    if (snapshot.content === undefined) continue;
    const target = path.join(project, ...applicationParts(snapshot.pathParts));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, snapshot.content, { flag: 'wx', mode: 0o600 });
  }
  for (const snapshot of snapshots) {
    if (snapshot.content !== undefined && snapshot.mode !== undefined) {
      await chmod(
        path.join(project, ...applicationParts(snapshot.pathParts)),
        snapshot.mode
      );
    }
  }
  for (const directory of [...directories]
    .filter(entry => entry.exists && entry.pathParts.length && entry.mode !== null)
    .sort((left, right) => right.pathParts.length - left.pathParts.length)) {
    await chmod(
      path.join(project, ...applicationParts(directory.pathParts)),
      directory.mode! & 0o777
    );
  }
}

function knownSettlement(result: CommandResult): boolean {
  if (result.errorCode === 'PROCESS_TREE_TERMINATION_FAILED' ||
      result.errorCode === 'DESCENDANT_PROCESSES_ACTIVE' ||
      result.errorCode === 'UNSUPPORTED_PROCESS_SETTLEMENT') {
    return false;
  }
  return result.processTreeSettled === true;
}

function definitivePreExecutionFailure(result: CommandResult): boolean {
  return result.processSpawned === false &&
    result.processTreeSettled === false &&
    result.signal === null &&
    Boolean(result.errorCode && [
      'RESTRICTED_EXECUTION_POLICY', 'CONSTRAINED_LANGUAGE_MODE',
      'UNSUPPORTED_PROCESS_SETTLEMENT', 'CORRUPTED_CONTROLLER_ASSET',
      'POWERSHELL_SPAWN_FAILED', 'CONTROLLER_LAUNCH_FAILED',
      'AUTHENTICATION_FAILED', 'SPAWN_REQUEST_FAILED',
      'ENOENT', 'EACCES', 'ENOEXEC'
    ].includes(result.errorCode));
}

function safeSignal(result: CommandResult | undefined): string | null {
  return result?.signal && /^SIG[A-Z0-9]+$/u.test(result.signal)
    ? result.signal : null;
}

export async function executeAdoptionVerification(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  verificationPlanFingerprint: string,
  source: unknown,
  options: AdoptionVerificationExecutionOptions = {}
): Promise<AdoptionVerificationExecutionResult> {
  const identity = {
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, verificationPlanFingerprint
  };
  const { plan, consent } = await loadAdoptionVerificationAuthority(
    identity, source, options.storage, options.inspection
  );
  const prior = await readBoundAdoptionVerificationResult(
    identity, plan, consent, options.storage
  );
  if (prior) return prior;

  const policy = plan.verificationPolicy;
  const candidate = await inspectAdoptionCandidate(plan.report.projectRoot, source);
  if (candidate.report.inventory.inspectionDigest !== plan.report.inventoryDigest ||
      candidate.report.inventory.target.digest !== plan.report.targetLayoutDigest ||
      adoptionVerificationSnapshotDigest(candidate.snapshots) !==
        plan.report.snapshotDigest) {
    throw new Error(
      'Adoption verification inputs changed before isolated execution.'
    );
  }
  const boundary = await realpath(await mkdtemp(
    `${await adoptionVerificationStagingBoundary(plan.report.projectRoot)}-`
  ));
  const boundaryDetails = await lstat(boundary, { bigint: true });
  if (!boundaryDetails.isDirectory() || boundaryDetails.isSymbolicLink()) {
    throw new Error('Adoption verification staging boundary is unsafe.');
  }
  const boundaryIdentity = {
    device: boundaryDetails.dev,
    inode: boundaryDetails.ino,
    birthtimeNs: boundaryDetails.birthtimeNs
  };
  const runner = options.runner ?? new NodeCommandRunner();
  let workspace: RepairVerificationWorkspace | undefined;
  let protection: CapturedApplicationProtection | undefined;
  let uncertain = false;
  const commands: AdoptionVerificationCommandResult[] = [];
  const preparation: AdoptionVerificationPreparationResult[] = [];
  const blockers: string[] = [];
  const startedAt = adoptionVerificationTime(options.storage).toISOString();
  let status: AdoptionVerificationExecutionResult['status'] = 'failed';
  let inputsUnchanged = false;
  let cleanupComplete = false;
  let retainedWorkspace: string | undefined;

  const assertCurrent = async () => {
    const now = adoptionVerificationTime(options.storage);
    if (now.getTime() >= Date.parse(consent.expiresAt)) {
      throw new ApplicationInspectionError(
        '[expired-consent] Adoption verification consent expired before a new effect.'
      );
    }
    const [storedPlan, storedConsent, compatibility] = await Promise.all([
      createScopedUserLocalRecordStore(
        plan.report.projectRoot, 'adoption-verification-plan', options.storage
      ).read(verificationPlanFingerprint),
      createScopedUserLocalRecordStore(
        plan.report.projectRoot, 'adoption-verification-consent', options.storage
      ).read(verificationPlanFingerprint),
      loadAdoptionCompatibilityPlan(
        plan.report.projectRoot, reviewFingerprint,
        destinationPlanFingerprint, compatibilityPlanFingerprint,
        source, now, options.storage
      )
    ]);
    if (!storedPlan || canonicalSha256(storedPlan.value) !== canonicalSha256(plan.report) ||
        !storedConsent ||
        canonicalSha256(storedConsent.value) !== canonicalSha256(consent) ||
        compatibility.report.inventoryDigest !== plan.report.inventoryDigest ||
        compatibility.report.targetLayoutDigest !== plan.report.targetLayoutDigest ||
        adoptionVerificationSnapshotDigest(compatibility.snapshots) !==
          plan.report.snapshotDigest) {
      throw new ApplicationInspectionError(
        '[changed-inputs] Adoption plan, consent, source or destination inputs changed.'
      );
    }
    await assertApplicationToolsCurrent(
      plan.report.projectRoot, boundary, policy.toolchain
    );
    inputsUnchanged = true;
  };

  const run = async (
    logical: ApplicationVerificationCommand,
    actual: { executable: string; args: string[] },
    env: NodeJS.ProcessEnv,
    kind: 'preparation' | 'verification',
    index: number,
    metadata = false,
    prepared?: ApplicationResolvedPreparation
  ): Promise<{ raw?: CommandResult; result: AdoptionVerificationCommandResult }> => {
    await assertCurrent();
    await protection!.assertCurrent();
    let captured: { result?: CommandResult; error?: unknown } | undefined;
    try {
      await workspace!.runOwned({
        kind,
        commandDigest: canonicalSha256({
          command: actual, cwdPathParts: logical.cwdPathParts,
          metadata, policy: plan.report.verificationPolicyDigest
        }),
        network: logical.network,
        lifecycle: false
      }, async () => {
        try {
          const raw = await runner.run(actual, {
            cwd: metadata
              ? workspace!.roles.home
              : path.join(workspace!.roles.project, ...logical.cwdPathParts),
            env, timeoutMs: logical.timeoutMs,
            maxOutputBytes: logical.maxOutputBytes,
            stream: false, ensureProcessTreeSettled: true
          });
          captured = { result: raw };
          const settled = knownSettlement(raw) ||
            definitivePreExecutionFailure(raw);
          uncertain ||= !settled;
          return { value: undefined, allKnownCommandsSettled: settled };
        } catch (error) {
          captured = { error };
          uncertain = true;
          return { value: undefined, allKnownCommandsSettled: false };
        }
      });
    } catch {
      if (!captured) {
        throw new ApplicationInspectionError(
          '[workspace-activity] Registered adoption verification activity could not be admitted.'
        );
      }
      uncertain = true;
    }
    const raw = captured?.result;
    const diagnostic = raw
      ? prepared
        ? applicationPreparationFailure(prepared, logical, raw)
        : applicationCommandFailure(logical, raw)
      : applicationRunnerFailure(logical, captured?.error);
    const observed = {
      index,
      status: raw && Number.isSafeInteger(raw.status) ? raw.status : null,
      signal: safeSignal(raw),
      timedOut: raw?.timedOut === true || diagnostic?.kind === 'timed-out',
      outputLimitExceeded: raw?.outputLimitExceeded === true ||
        diagnostic?.kind === 'output-limit',
      passed: diagnostic === null && !uncertain && raw?.processSpawned !== false
    };
    if (diagnostic) {
      blockers.push(
        `${kind === 'preparation' ? 'Locked preparation: ' : ''}` +
        applicationFailureBlocker(index, logical, diagnostic)
      );
    }
    if (!uncertain) {
      await protection!.assertCurrent();
      await assertCurrent();
    }
    return { raw, result: observed };
  };

  const probeTools = async (
    kind: 'preparation' | 'verification', base: NodeJS.ProcessEnv
  ) => {
    for (const tool of policy.toolchain) {
      const logical: ApplicationVerificationCommand = {
        executable: tool.id, args: tool.probe.args,
        cwdPathParts: [], network: false,
        timeoutMs: applicationPreparationBounds.probeTimeoutMs,
        maxOutputBytes: applicationPreparationBounds.probeOutputBytes
      };
      const observed = await run(
        logical, tool.probe, base, kind, -1, true
      );
      if (!observed.result.passed || !observed.raw ||
          extractVersion(
            `${observed.raw.stdout}\n${observed.raw.stderr}`, tool.id
          ) !== tool.version) {
        throw new ApplicationInspectionError(
          '[changed-tool] Approved installed tool identity or version changed before effects.'
        );
      }
    }
  };

  try {
    await assertCurrent();
    workspace = await createAdoptionVerificationWorkspace(
      plan.report.projectRoot,
      {
        planFingerprint: verificationPlanFingerprint,
        adoptionIdentity: {
          schemaVersion: 1,
          kind: 'liftoff-adoption-verification-execution',
          cliVersion: liftoffVersion,
          adoptionVerificationContractVersion: 1
        },
        patchStagingRoot: boundary,
        bindings: {
          inputDigest: plan.report.snapshotDigest,
          verificationPolicyDigest: plan.report.verificationPolicyDigest,
          providerDigest: plan.report.providerDigest,
          toolchainDigest: plan.report.toolchainDigest
        },
        approvedScopes: {
          projectCode: consent.permissions.projectCode,
          dependencyPreparation: consent.permissions.dependencyPreparation,
          network: consent.permissions.declaredNetwork,
          lifecycle: false
        }
      },
      options.storage
    );
    await workspace.checkpoint('copying');
    await copySnapshots(
      workspace.roles.project, candidate.snapshots,
      candidate.report.inventory.directoryInventory
    );
    const base = await createApplicationEnvironment(
      options.env ?? process.env, plan.report.projectRoot,
      boundary, workspace.directory
    );
    const node = policy.toolchain.find(tool => tool.id === 'node');
    if (node) {
      base.PATH = [path.dirname(node.executablePath), base.PATH ?? '']
        .filter(Boolean).join(path.delimiter);
    }
    protection = new CapturedApplicationProtection({
      files: candidate.snapshots.map(snapshot => ({
        pathParts: [...snapshot.pathParts],
        ...(snapshot.content === undefined
          ? {}
          : { content: Buffer.from(snapshot.content) }),
        ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
      })),
      directories: candidate.report.inventory.directoryInventory
        .filter(directory => directory.exists),
      outputRoles: policy.outputRoles,
      toolchain: policy.toolchain
    }, workspace.directory);
    await protection.captureControls();
    await protection.assertCurrent();

    if (policy.preparation.length) {
      await workspace.checkpoint('preparing');
      await probeTools('preparation', base);
    }
    for (const step of policy.preparation) {
      const observed: {
        schemaVersion: 1;
        provider: string;
        version: 1;
        cwdPathParts: string[];
        policyDigest: string;
        status: 'passed' | 'failed';
        commands: AdoptionVerificationCommandResult[];
      } = {
        schemaVersion: 1, provider: step.provider, version: 1,
        cwdPathParts: [...step.cwdPathParts], policyDigest: step.digest,
        status: 'failed', commands: []
      };
      preparation.push(observed);
      const env = applicationPreparationEnvironment(
        base, workspace.roles, step
      );
      for (const [index, command] of step.commands.entries()) {
        const tool = policy.toolchain.find(entry => entry.id === command.tool);
        if (!tool) {
          throw new ApplicationInspectionError(
            '[missing-tool] Approved preparation tool identity is unavailable.'
          );
        }
        const logical: ApplicationVerificationCommand = {
          executable: command.tool, args: command.args,
          cwdPathParts: command.cwdPathParts,
          timeoutMs: command.timeoutMs,
          maxOutputBytes: command.maxOutputBytes,
          network: step.network
        };
        const args = command.args.map(argument =>
          argument === '$PRIVATE_PYTHON_ENVIRONMENT'
            ? path.join(
                workspace!.roles.project, ...step.cwdPathParts, '.venv'
              )
            : argument
        );
        const executed = await run(
          logical,
          {
            executable: tool.executablePath,
            args: [...tool.prefixArgs, ...args]
          },
          env, 'preparation', index, false, step
        );
        observed.commands.push(executed.result);
        if (!executed.result.passed) {
          throw new ApplicationInspectionError(
            '[preparation-failed] Locked preparation failed; no adoption check or success receipt can follow.'
          );
        }
        await probeTools('preparation', base);
      }
      if (step.provider === 'uv-locked-sync') {
        const reader = new ApplicationFiles(workspace.directory);
        const configuration = await reader.read([
          'project', ...step.cwdPathParts, '.venv', 'pyvenv.cfg'
        ]);
        const text = configuration.content?.toString('utf8') ?? '';
        const python = policy.toolchain.find(tool => tool.id === 'python');
        if (!python ||
            !/^include-system-site-packages\s*=\s*false\s*$/mu.test(text) ||
            !(text.includes(`version_info = ${python.version}`) ||
              text.includes(`version = ${python.version}`))) {
          throw new ApplicationInspectionError(
            '[incompatible-private-environment] Prepared Python environment does not match its approved interpreter.'
          );
        }
      }
      await protection.freeze(step);
      observed.status = 'passed';
    }

    await workspace.checkpoint('verifying');
    for (const [index, command] of policy.commands.entries()) {
      await probeTools('verification', base);
      const resolved = policy.executionCommands[index];
      const componentPreparation = policy.preparation.find(entry =>
        entry.provider === 'uv-locked-sync' &&
          (command.executable === 'python' ||
            command.executable === 'python3') ||
        applicationPathKey(entry.cwdPathParts) ===
          applicationPathKey(command.cwdPathParts)
      );
      const env = withoutApplicationDependencyNetwork(
        componentPreparation
          ? applicationPreparationEnvironment(
              base, workspace.roles, componentPreparation
            )
          : base
      );
      env.LIFTOFF_APPLICATION_NETWORK = command.network
        ? 'declared-allowed' : 'not-authorized';
      const actual = resolved
        ? {
            executable: resolved.pythonEnvironmentPathParts
              ? path.join(
                  workspace.directory,
                  ...resolved.pythonEnvironmentPathParts
                )
              : resolved.executable,
            args: resolved.args
          }
        : { executable: command.executable, args: command.args };
      if (resolved?.pythonEnvironmentPathParts) {
        await realpath(actual.executable);
      }
      const executed = await run(
        command, actual, env, 'verification', index
      );
      commands.push(executed.result);
      if (!executed.result.passed) {
        throw new ApplicationInspectionError(
          '[check-failed] A declared adoption check failed; no verification receipt or file approval is authorized.'
        );
      }
    }
    await protection.assertCurrent();
    await assertCurrent();
    await workspace.checkpoint('verified');
    status = 'passed';
  } catch (error) {
    status = uncertain ? 'uncertain' : 'failed';
    blockers.push(
      error instanceof ApplicationInspectionError
        ? error.message
        : '[verification-failed] Isolated adoption verification could not complete; unsafe diagnostics were withheld.'
    );
    if (workspace && !uncertain) {
      try {
        await workspace.checkpoint('failed');
      } catch {
        blockers.push(
          '[workspace-progress] Failed adoption verification progress could not be authenticated.'
        );
      }
    }
  } finally {
    if (workspace) {
      if (!uncertain) {
        try {
          await assertCurrent();
        } catch {
          inputsUnchanged = false;
          status = 'failed';
          blockers.push(
            '[changed-inputs] Adoption inputs changed after execution; no success receipt is valid.'
          );
          try {
            await workspace.checkpoint('failed');
          } catch {
            // Cleanup below still requires the same authenticated owner.
          }
        }
      }
      try {
        if (uncertain) {
          throw new ApplicationInspectionError(
            '[owner-uncertain] Process settlement is not proven; automatic cleanup is blocked.'
          );
        }
        await workspace.releaseOwner();
        const cleaned = await workspace.cleanup();
        cleanupComplete = cleaned.cleanupComplete;
        if (!cleaned.cleanupComplete) {
          status = 'failed';
          retainedWorkspace = workspace.directory;
          blockers.push(...cleaned.issues.map(issue =>
            `[workspace-${issue.code}] ${issue.message}`
          ));
        }
      } catch (error) {
        cleanupComplete = false;
        retainedWorkspace = workspace.directory;
        status = uncertain ? 'uncertain' : 'failed';
        blockers.push(
          `[workspace-cleanup] ${error instanceof Error
            ? error.message
            : 'Adoption verification workspace cleanup is blocked or incomplete; no success receipt is valid.'}`
        );
      }
    }
    try {
      const identity = await lstat(boundary, { bigint: true });
      if (!identity.isDirectory() || identity.isSymbolicLink() ||
          identity.dev !== boundaryIdentity.device ||
          identity.ino !== boundaryIdentity.inode ||
          identity.birthtimeNs !== boundaryIdentity.birthtimeNs) {
        throw new Error('Adoption verification staging identity changed.');
      }
      await rmdir(boundary);
    } catch {
      cleanupComplete = false;
      status = uncertain ? 'uncertain' : 'failed';
      blockers.push(
        '[staging-cleanup] Owned empty adoption verification staging cleanup was not proven.'
      );
    }
  }

  const completedAt = adoptionVerificationTime(options.storage).toISOString();
  const baseResult: AdoptionVerificationExecutionResult = {
    schemaVersion: adoptionVerificationResultSchemaVersion,
    kind: 'liftoff-adoption-verification-result',
    projectRoot: plan.report.projectRoot,
    reviewFingerprint,
    destinationPlanFingerprint,
    compatibilityPlanFingerprint,
    verificationPlanFingerprint,
    consentFingerprint: consent.fingerprint,
    snapshotDigest: plan.report.snapshotDigest,
    verificationPolicyDigest: plan.report.verificationPolicyDigest,
    providerDigest: plan.report.providerDigest,
    toolchainDigest: plan.report.toolchainDigest,
    workspaceId: workspace?.workspaceId ?? canonicalSha256('unallocated'),
    status,
    startedAt, completedAt,
    commands, preparation, blockers,
    inputsUnchanged, cleanupComplete,
    ...(retainedWorkspace ? { retainedWorkspace } : {}),
    compatibility: status === 'passed' && inputsUnchanged && cleanupComplete
      ? 'verified-by-declared-checks' : 'not-verified',
    approval: 'not-requested',
    transaction: 'not-authorized',
    publication: 'not-authorized',
    limitations: [
      'Success covers only the exact declared checks against a disposable copy of the bounded observed application.',
      'The private workspace and credential-free environment are not an operating-system or network sandbox.',
      'Verification success is not file approval, transaction, recovery, active-binding publication or deployment authority.'
    ],
    receiptFingerprint: null
  };
  if (baseResult.status !== 'passed' ||
      !baseResult.inputsUnchanged ||
      !baseResult.cleanupComplete ||
      !workspace) {
    return Object.freeze(structuredClone(baseResult));
  }
  if (adoptionVerificationTime(options.storage).getTime() >=
      Date.parse(consent.expiresAt)) {
    const expired: AdoptionVerificationExecutionResult = {
      ...baseResult,
      status: 'failed',
      compatibility: 'not-verified',
      blockers: [...baseResult.blockers,
        '[expired-consent] Consent expired before result authentication.']
    };
    return Object.freeze(structuredClone(expired));
  }
  return persistAdoptionVerificationReceipt(baseResult, options.storage);
}

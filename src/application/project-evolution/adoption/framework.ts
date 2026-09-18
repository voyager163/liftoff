import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedArtifact } from '../../../domain/project/contracts.js';
import type { AdoptionFrameworkBinding, AdoptionFrameworkSelection, AdoptionPlan } from '../../../domain/project-evolution/adoption/contracts.js';
import { adoptionExecutionIdentity } from '../../../domain/project-evolution/adoption/identity.js';
import { canonicalSha256, isRecord } from '../../../domain/governance/activation/canonical-json.js';
import { nativeExecutableObserver } from '../../../adapters/filesystem/executables.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../../../adapters/filesystem/update-previews.js';
import { getCodingAgent, getFrameworkDefinition, getSpecWorkflow } from '../../project/catalog.js';
import { frameworkAdapters, initializeFramework, type FrameworkInitializationPlan } from '../../../framework-adapters.js';
import { frameworkOutputPaths } from '../../../framework-validation.js';
import { type StagingArea, validateStagedTree } from '../../../init-filesystem.js';
import { OPEN_SPEC_DELIVERY, OPEN_SPEC_PROFILE, OPEN_SPEC_WORKFLOW_IDS } from '../../../openspec-profile.js';
import { workstationRequirementCatalog } from '../../../workstation-catalog.js';
import { extractVersion } from '../../../domain/workstation/versions.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../../../process-runner.js';
import { NodeCommandRunner } from '../../../process-runner.js';
import { ApplicationFiles, ApplicationInspectionError, applicationDigest, applicationParts, applicationWithin } from '../../repair/application-files.js';
import { applicationBounds } from '../../repair/application-types.js';
import { applicationSearchEnvironment, createApplicationEnvironment } from '../../repair/application-environment.js';
import { assertApplicationToolsCurrent, captureInstalledApplicationToolFile, resolveApplicationPreparationTools } from '../../repair/application-toolchain.js';
import type { ApplicationInspectionOptions, ApplicationToolFileIdentity, ApplicationToolIdentity } from '../../repair/application-preparation-types.js';
import { createAdoptionVerificationWorkspace, type RepairVerificationWorkspace } from '../../repair/workspaces.js';

export interface FrameworkPreparation {
  binding: AdoptionFrameworkBinding;
  tool: ApplicationToolFileIdentity;
  runtimes: ApplicationToolIdentity[];
  initialization: FrameworkInitializationPlan;
}

export interface PreparedFramework {
  recordId: string;
  sourceFingerprint: string;
  artifacts: Array<GeneratedArtifact & { mode: number }>;
  commandsExecuted: number;
}

export async function inspectAdoptionFramework(
  selection: AdoptionFrameworkSelection, projectRoot: string, stagingRoot: string,
  options: ApplicationInspectionOptions = {}
): Promise<FrameworkPreparation | null> {
  if (!selection.initialize) return null;
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') throw new ApplicationInspectionError('Official staged framework preparation is unsupported on this host.');
  const specWorkflow = getSpecWorkflow(selection.workflow)!;
  const framework = getFrameworkDefinition(selection.workflow);
  const agents = selection.agents.map((id) => {
    const agent = getCodingAgent(id);
    if (!agent) throw new ApplicationInspectionError('Framework preparation has an unregistered selected agent.');
    return agent;
  });
  const initialization: FrameworkInitializationPlan = {
    specWorkflow, framework, agents, copilotCloud: selection.copilotCloud,
    ...(selection.defaultAgent ? { defaultAgent: agents.find((agent) => agent.id === selection.defaultAgent) } : {})
  };
  const env = applicationSearchEnvironment(options.env ?? process.env, projectRoot, stagingRoot, stagingRoot);
  const observed = await nativeExecutableObserver.resolve(framework.executable, {
    platform, cwd: stagingRoot, env, definition: workstationRequirementCatalog[selection.workflow]
  });
  if (observed.resolution !== 'resolved' || !observed.realPath || !observed.resolvedPath ||
    applicationWithin(projectRoot, observed.realPath) || applicationWithin(stagingRoot, observed.realPath)) {
    throw new ApplicationInspectionError(`Official ${framework.id} ${framework.version} must already be installed outside the project/staging boundary; adoption cannot install tools.`);
  }
  const tool = await captureInstalledApplicationToolFile(observed.realPath, projectRoot, stagingRoot, false);
  const runtimes = await resolveApplicationPreparationTools(projectRoot, stagingRoot, [], options,
    selection.workflow === 'openspec' ? ['node'] : ['python']);
  const binding: AdoptionFrameworkBinding = {
    definitionId: selection.workflow, contractVersion: framework.version, launcherPath: observed.resolvedPath,
    executablePath: observed.realPath, toolDigest: canonicalSha256(tool), runtimeDigest: canonicalSha256(runtimes),
    commands: frameworkAdapters[selection.workflow].buildCommands(initialization),
    expectedPaths: frameworkOutputPaths({ workflow: selection.workflow, agents: selection.agents, ...(selection.defaultAgent ? { defaultAgent: selection.defaultAgent } : {}) })
  };
  return { binding, tool, runtimes, initialization };
}

export async function readPreparedAdoptionFramework(
  projectRoot: string, recordId: string, binding: AdoptionFrameworkBinding, createdAt: string,
  now: Date, storage?: UpdatePreviewOptions
): Promise<PreparedFramework | null> {
  const store = createScopedUserLocalRecordStore(projectRoot, 'adoption-framework', storage);
  const saved = await store.read(recordId);
  if (!saved) return null;
  const record = saved.value;
  const fields = ['schemaVersion', 'kind', 'projectRoot', 'recordId', 'sourceFingerprint', 'bindingDigest', 'createdAt', 'expiresAt', 'commandsExecuted', 'files'];
  const expiresAt = isRecord(record) && typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN;
  const currentTime = now.getTime();
  if (!isRecord(record) || Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)) ||
    record.schemaVersion !== 1 || record.kind !== 'liftoff-adoption-framework' || record.projectRoot !== projectRoot ||
    record.recordId !== recordId || record.bindingDigest !== canonicalSha256(binding) || record.createdAt !== createdAt ||
    !Number.isFinite(expiresAt) || !Number.isFinite(currentTime) || expiresAt <= currentTime ||
    typeof record.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sourceFingerprint) ||
    typeof record.commandsExecuted !== 'number' || record.commandsExecuted !== binding.commands.length ||
    !Array.isArray(record.files) || record.files.length === 0 || record.files.length > applicationBounds.files) {
    throw new ApplicationInspectionError('Prepared framework receipt is invalid, stale, or bound to another tool/source/plan; no integration authority was inferred.');
  }
  const artifacts: Array<GeneratedArtifact & { mode: number }> = [];
  for (const raw of record.files) {
    if (!isRecord(raw) || Object.keys(raw).length !== 5 || typeof raw.logicalName !== 'string' ||
      typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.digest) || typeof raw.key !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(raw.key) || typeof raw.mode !== 'number' || !Number.isInteger(raw.mode) || raw.mode < 0 || raw.mode > 0o777 ||
      !Array.isArray(raw.pathParts)) throw new ApplicationInspectionError('Prepared framework inventory is malformed.');
    const pathParts = applicationParts(raw.pathParts);
    if (raw.logicalName !== `framework-${canonicalSha256(pathParts).slice(0, 32)}`) throw new ApplicationInspectionError('Prepared framework logical identity changed.');
    const chunk = await store.read(raw.key);
    if (!chunk || !isRecord(chunk.value) || Object.keys(chunk.value).length !== 5 || chunk.value.schemaVersion !== 1 ||
      chunk.value.kind !== 'liftoff-adoption-framework-file' ||
      chunk.value.recordId !== recordId || chunk.value.digest !== raw.digest || typeof chunk.value.bytes !== 'string') {
      throw new ApplicationInspectionError('Prepared framework bytes are missing or have an invalid independent identity.');
    }
    const bytes = Buffer.from(chunk.value.bytes, 'base64');
    if (bytes.toString('base64') !== chunk.value.bytes || applicationDigest(bytes) !== raw.digest || bytes.length > 32 * 1024) {
      throw new ApplicationInspectionError('Prepared framework bytes changed or exceed the registered file bound.');
    }
    artifacts.push({
      logicalName: raw.logicalName, lifecycle: 'framework', category: 'framework', pathParts,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), mode: raw.mode
    });
  }
  return { recordId, sourceFingerprint: record.sourceFingerprint, artifacts, commandsExecuted: record.commandsExecuted };
}

export interface FrameworkPreparationResult {
  status: 'prepared' | 'blocked';
  commandsExecuted: number;
  networkAuthorized: boolean;
  cleanupComplete: boolean;
  blockers: string[];
  retainedWorkspace?: string;
}

export async function prepareAdoptionFramework(
  plan: AdoptionPlan, preparation: FrameworkPreparation,
  options: {
    runner?: CommandRunner;
    env?: NodeJS.ProcessEnv;
    storage?: UpdatePreviewOptions;
    allowCode: boolean;
    allowNetwork: boolean;
    assertCurrent(): Promise<void>;
  }
): Promise<FrameworkPreparationResult> {
  const result: FrameworkPreparationResult = { status: 'blocked', commandsExecuted: 0, networkAuthorized: false, cleanupComplete: true, blockers: [] };
  let workspace: RepairVerificationWorkspace | undefined;
  let unsettled = false;
  let artifacts: Awaited<ReturnType<typeof validateStagedTree>> = [];
  const stagingRoot = plan.proposal ? path.dirname(plan.proposal.path) : '';
  const runner = options.runner ?? new NodeCommandRunner();
  const assertCurrent = async () => {
    await options.assertCurrent();
    const current = await captureInstalledApplicationToolFile(preparation.binding.launcherPath, plan.projectRoot, stagingRoot, false);
    if (canonicalSha256(current) !== preparation.binding.toolDigest) throw new ApplicationInspectionError('The approved framework launcher or installed file identity changed.');
    await assertApplicationToolsCurrent(plan.projectRoot, stagingRoot, preparation.runtimes);
  };
  try {
    if (!plan.framework.initialize || !plan.proposal || !options.allowCode || !options.allowNetwork ||
      canonicalSha256(plan.frameworkPreparation.binding) !== canonicalSha256(preparation.binding)) {
      throw new ApplicationInspectionError('Official framework preparation needs its exact plan, declared source, separate code approval and declared network authority.');
    }
    await assertCurrent();
    workspace = await createAdoptionVerificationWorkspace(plan.projectRoot, {
      planFingerprint: plan.fingerprint, adoptionIdentity: adoptionExecutionIdentity(plan.cliVersion), patchStagingRoot: stagingRoot,
      bindings: {
        inputDigest: plan.inspectionDigest, verificationPolicyDigest: canonicalSha256(preparation.binding),
        providerDigest: canonicalSha256([]), toolchainDigest: preparation.binding.runtimeDigest
      },
      approvedScopes: { projectCode: true, dependencyPreparation: false, network: true, lifecycle: false }
    }, options.storage);
    const env = await createApplicationEnvironment(options.env ?? process.env, plan.projectRoot, stagingRoot, workspace.directory);
    env.PATH = [...preparation.runtimes.map((tool) => path.dirname(tool.executablePath)), env.PATH ?? ''].join(path.delimiter);
    Object.assign(env, {
      OPENSPEC_TELEMETRY: '0', OPENSPEC_NO_UPDATE_CHECK: '1', XDG_STATE_HOME: workspace.roles.home,
      CODEX_HOME: path.join(workspace.roles.home, '.codex'), CLAUDE_CONFIG_DIR: path.join(workspace.roles.home, '.claude')
    });
    if (plan.framework.workflow === 'openspec') {
      const config = path.join(workspace.roles.home, 'openspec');
      await mkdir(config, { mode: 0o700 });
      await writeFile(path.join(config, 'config.json'), `${JSON.stringify({
        profile: OPEN_SPEC_PROFILE, delivery: OPEN_SPEC_DELIVERY, workflows: OPEN_SPEC_WORKFLOW_IDS
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    const execute = async (args: string[], network: boolean, runOptions?: RunCommandOptions): Promise<CommandResult> => {
      await assertCurrent();
      const command = { executable: preparation.binding.launcherPath, args };
      return workspace!.runOwned({ kind: 'verification', commandDigest: canonicalSha256({ command, binding: preparation.binding }), network, lifecycle: false }, async () => {
        const outcome = await runner.run(command, {
          ...runOptions, cwd: workspace!.roles.project, env, stream: false,
          timeoutMs: 120_000, maxOutputBytes: 64 * 1024, ensureProcessTreeSettled: true
        });
        const settled = outcome.processTreeSettled === true;
        unsettled ||= !settled;
        return { value: outcome, allKnownCommandsSettled: settled };
      });
    };
    const version = await execute(['--version'], false);
    if (version.status !== 0 || version.signal !== null || version.timedOut || version.outputLimitExceeded ||
      extractVersion(`${version.stdout}\n${version.stderr}`, preparation.binding.definitionId) !== preparation.binding.contractVersion) {
      throw new ApplicationInspectionError('The actual installed framework does not match the exact pinned framework contract; no integration files were committed.');
    }
    result.networkAuthorized = true;
    const supervised: CommandRunner = {
      run: async (command, runOptions) => {
        if (command.executable !== preparation.initialization.framework.executable ||
          !preparation.binding.commands.some((registered) => canonicalSha256(registered) === canonicalSha256(command))) {
          throw new ApplicationInspectionError('Framework initialization attempted an unregistered operation.');
        }
        result.commandsExecuted++;
        return execute(command.args, true, runOptions);
      }
    };
    const area: StagingArea = { root: workspace.roles.project, origins: new Map(), frameworkAllowedRoots: new Set() };
    await workspace.checkpoint('preparing');
    await initializeFramework(area, preparation.initialization, supervised, { preparedEnvironment: env });
    const bounded = new ApplicationFiles(workspace.roles.project);
    await bounded.walk();
    await bounded.assertUnchanged();
    artifacts = await validateStagedTree(area);
    if (!artifacts.length || artifacts.some((artifact) => artifact.origin !== 'framework' || artifact.content.length > 32 * 1024)) {
      throw new ApplicationInspectionError('Official framework output exceeds the exact supported bounded file/ownership contract.');
    }
    await assertCurrent();
    await workspace.checkpoint('verified');
    result.status = 'prepared';
  } catch (error) {
    result.blockers.push(error instanceof ApplicationInspectionError ? error.message :
      'Official staged framework initialization failed its registered contract. Unsafe child output was withheld and no real project file was written.');
    if (workspace) {
      try { await workspace.checkpoint('failed'); } catch { unsettled = true; }
    }
  } finally {
    if (workspace) {
      try {
        if (unsettled) throw new Error('uncertain owner');
        await workspace.releaseOwner();
        const cleanup = await workspace.cleanup();
        result.cleanupComplete = cleanup.cleanupComplete;
        if (!cleanup.cleanupComplete) throw new Error('cleanup incomplete');
      } catch {
        result.status = 'blocked'; result.cleanupComplete = false; result.retainedWorkspace = workspace.directory;
        result.blockers.push('Framework process settlement or exact registered workspace cleanup is uncertain; retained scope requires attributable recovery.');
      }
    }
  }
  if (result.status !== 'prepared') return result;
  try {
    const store = createScopedUserLocalRecordStore(plan.projectRoot, 'adoption-framework', options.storage);
    const files = [];
    for (const artifact of artifacts) {
      const digest = applicationDigest(artifact.content);
      const key = canonicalSha256({ kind: 'adoption-framework-file', recordId: plan.recordId, pathParts: artifact.pathParts, digest });
      await store.write(key, { schemaVersion: 1, kind: 'liftoff-adoption-framework-file', recordId: plan.recordId, digest, bytes: artifact.content.toString('base64') });
      files.push({
        logicalName: `framework-${canonicalSha256(artifact.pathParts).slice(0, 32)}`, pathParts: artifact.pathParts,
        digest, mode: artifact.mode, key
      });
    }
    await store.write(plan.recordId, {
      schemaVersion: 1, kind: 'liftoff-adoption-framework', projectRoot: plan.projectRoot, recordId: plan.recordId,
      sourceFingerprint: plan.fingerprint, bindingDigest: canonicalSha256(preparation.binding),
      createdAt: plan.createdAt, expiresAt: plan.expiresAt, commandsExecuted: result.commandsExecuted, files
    });
  } catch {
    result.status = 'blocked';
    result.blockers.push('Framework code ran, but its exact prepared-byte receipt could not be persisted. No project transaction is authorized.');
  }
  return result;
}

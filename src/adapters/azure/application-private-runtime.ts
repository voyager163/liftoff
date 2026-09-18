import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { DarwinStateSystemBridge, StateBackendAdapter, StateExecutionContext } from '../../domain/repair/stateful.js';
import { stateBindingDigest, stateDigest } from '../../domain/repair/stateful-invariants.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import { createDarwinStateStorageProfile, PythonDarwinStateSystemBridge } from '../state/darwin-capabilities.js';
import { assertPrivateStatePath } from '../state/protected-workspace.js';
import { inspectNativeLocalStateTools } from '../state/native-system.js';
import { readPrivateNativeFile } from '../state/native-files.js';
import { stopOwnedStateProcessesIn } from '../state/owned-process.js';
import { createAzureCliArmTransport } from './activation-rest.js';
import { createAzureCliPrivateStatePath, type PrivateStateEffectRecorder } from './private-state-path.js';
import { parseApplicationImageReference } from './application-provisioning.js';
import { readApplicationRegistryManifest } from './application-registry.js';
import { ApplicationPrivateAzureWriter } from './application-private-credentials.js';
import { ApplicationPrivateResourceReader } from './application-private-readback.js';
import { SpawnApplicationPrivateCommandRunner, applicationPrivateNativeFiles } from './application-private-opentofu.js';
import {
  applicationPrivateAssert as must, type ApplicationPrivateAuthority, type ApplicationPrivateDirectory,
  type ApplicationPrivateIntent, type ApplicationPrivateRuntime, type ApplicationPrivateSource, type ApplicationPrivateStorage
} from '../../application/azure-activation/application-private-contracts.js';
import { applicationPrivateNativeRoot, verifyApplicationPrivateProjection } from '../../application/azure-activation/application-private-source.js';
import { applicationPrivateReadResourceIds } from '../../application/azure-activation/application-private-inputs.js';
import { applicationFunctionReadRequests } from './application-function-readback.js';
import { readApplicationPrivateArtifactRoles } from '../../application/azure-activation/application-private-artifacts.js';

export interface ApplicationPrivateAdapters {
  /** Fixture/host-adapter seams; they are not public configuration or qualification flags. */
  storage?: ApplicationPrivateStorage;
  bridge?: DarwinStateSystemBridge;
  backend?: (recorder: PrivateStateEffectRecorder) => StateBackendAdapter;
  fetch?: typeof globalThis.fetch;
}

async function directoryIdentity(directory: string): Promise<ApplicationPrivateDirectory['identity']> {
  const info = await lstat(directory);
  must(info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory &&
    (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'private-directory');
  return { device: String(info.dev), inode: String(info.ino), birthtime: String(info.birthtimeMs), uid: info.uid, mode: info.mode & 0o777 };
}

export async function createApplicationPrivateRuntime(
  input: PhaseAdapterExecutionInput, intent: ApplicationPrivateIntent, source: ApplicationPrivateSource,
  context: StateExecutionContext, authority: ApplicationPrivateAuthority, adapters: ApplicationPrivateAdapters = {}
): Promise<ApplicationPrivateRuntime> {
  await authority.assertCurrent();
  const relative = path.relative(context.projectRoot, intent.custody.workspaceRoot);
  must(path.isAbsolute(intent.custody.workspaceRoot) && path.normalize(intent.custody.workspaceRoot) === intent.custody.workspaceRoot &&
    relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'workspace-outside-project-required');
  await directoryIdentity(intent.custody.workspaceRoot);
  const tools = await inspectNativeLocalStateTools({
    pythonPath: intent.custody.tools.python.path, tofuPath: intent.custody.tools.tofu.path,
    workingDirectory: intent.custody.workspaceRoot
  });
  must(canonicalSha256(tools) === canonicalSha256(intent.custody.tools), 'qualified-tool-identity');
  let storage = adapters.storage;
  if (!storage) {
    const profile = await createDarwinStateStorageProfile({
      tools, workspaceRoot: intent.custody.workspaceRoot, workspaceId: intent.custody.workspaceId,
      keyReference: intent.custody.keyReference, projectId: context.projectId
    });
    storage = {
      workspace: profile.workspace,
      assertDirectory: (directory, selected) => assertPrivateStatePath(directory, selected, profile.volume, true)
    };
  }
  const privateStorage = storage;
  must(privateStorage.workspace.workspaceRef === `state-workspace:${intent.custody.workspaceId}`, 'workspace-binding');
  await privateStorage.workspace.assertAvailable(context);
  await privateStorage.assertDirectory(intent.custody.workspaceRoot, context);
  await directoryIdentity(intent.custody.workspaceRoot);
  let active: ApplicationPrivateDirectory | null = null;
  const assertDirectory = async (directory: ApplicationPrivateDirectory) => {
    const relative = path.relative(intent.custody.workspaceRoot, directory.path);
    must(/^application-[a-f0-9-]{36}$/u.test(relative) && path.resolve(intent.custody.workspaceRoot, relative) === directory.path,
      'private-directory-scope');
    await privateStorage.assertDirectory(directory.path, context);
    must(canonicalSha256(await directoryIdentity(directory.path)) === canonicalSha256(directory.identity), 'private-directory-replaced');
    active = structuredClone(directory);
  };
  const clock = () => (input.clock?.() ?? input.now).getTime();
  const readResources = new Set(applicationPrivateReadResourceIds(intent).map((resourceId) => resourceId.toLowerCase()));
  const privatePosts = new Set(intent.targets.filter((target) => target.type === 'azurerm_linux_function_app')
    .flatMap((target) => applicationFunctionReadRequests(target.resourceId).filter((request) => request.method === 'POST')
      .map((request) => request.resourceId.toLowerCase())));
  const arm = {
    request: async (...args: Parameters<ReturnType<typeof createAzureCliArmTransport>['request']>) => {
      must((args[0].method === 'GET' || args[0].method === 'POST' && privatePosts.has(args[0].resourceId.toLowerCase()) &&
        args[0].apiVersion === '2024-11-01' && args[0].body === undefined) &&
        readResources.has(args[0].resourceId.toLowerCase()), 'application-unapproved-arm-access');
      await authority.assertCurrent();
      return (azurePorts(input).transport ?? createAzureCliArmTransport(input.runner, input.inspection.projectRoot, { now: clock }))
        .request(...args);
    }
  };
  const reader = new ApplicationPrivateResourceReader({
    intent, transport: arm, authorize: () => authority.assertCurrent(), now: clock, fetch: adapters.fetch
  });
  const writer = new ApplicationPrivateAzureWriter({
    reference: intent.writer,
    bridge: adapters.bridge ?? {
      request: (operation, value, signal) => {
        must(active, 'credential-private-directory-required');
        return new PythonDarwinStateSystemBridge(tools.python, active.path).request(operation, value, signal);
      }
    },
    authorize: () => authority.assertCurrent(), now: clock, fetch: adapters.fetch
  });
  const runner = new SpawnApplicationPrivateCommandRunner({
    intent, authorize: () => authority.assertCurrent(),
    privateEnvironment: (signal) => writer.resolve(context, intent.targets, signal),
    async quiescePrivateHelpers() {
      if (active) await stopOwnedStateProcessesIn(active.path);
    },
    async verify(cwd) {
      must(active && cwd === applicationPrivateNativeRoot(active.path, source), 'native-directory-binding');
      await assertDirectory(active);
      await privateStorage.assertDirectory(cwd, context);
      await verifyApplicationPrivateProjection(source, active.path);
      const backend = await readPrivateNativeFile(path.join(cwd, applicationPrivateNativeFiles.backend), 16_384);
      const cli = await readPrivateNativeFile(path.join(cwd, applicationPrivateNativeFiles.cli), 16_384);
      try {
        must(stateDigest(backend) === stateDigest(JSON.stringify({
          terraform: { backend: { local: { path: path.join(active.path, applicationPrivateNativeFiles.state) } } }
        })) && stateDigest(cli) === stateDigest(
          `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror {\n path = ${JSON.stringify(intent.source.provider.mirrorDirectory)}\n include = ["registry.opentofu.org/hashicorp/azurerm"]\n }\n}\n`
        ), 'private-local-backend-or-provider-config');
      } finally { backend.fill(0); cli.fill(0); }
    }
  });
  let recorder: PrivateStateEffectRecorder | null = null;
  const effects: PrivateStateEffectRecorder = {
    async before(effect) {
      must(recorder, 'backend-pre-effect-custody-required');
      return recorder.before(effect);
    },
    async returned(key, response) {
      must(recorder, 'backend-pre-effect-custody-required');
      await recorder.returned(key, response);
    },
    async uncertain(key) {
      must(recorder, 'backend-pre-effect-custody-required');
      await recorder.uncertain(key);
    }
  };
  const backend = adapters.backend?.(effects) ?? createAzureCliPrivateStatePath(input.runner, input.inspection.projectRoot,
    intent.backend, { arm, effects, now: clock }).backend;
  must(stateBindingDigest(backend.binding) === stateBindingDigest(intent.backend.backend), 'backend-runtime-binding');
  return {
    storage: privateStorage, context, backend, runner,
    async createDirectory() {
      await authority.assertCurrent();
      await privateStorage.assertDirectory(intent.custody.workspaceRoot, context);
      const directory = path.join(intent.custody.workspaceRoot, `application-${randomUUID()}`);
      await mkdir(directory, { mode: 0o700 });
      const result = { path: directory, identity: await directoryIdentity(directory) };
      await assertDirectory(result);
      return result;
    },
    assertDirectory,
    observe: (target, verify, signal, expectedState) => reader.observe(target, verify, signal, expectedState),
    assertProviders: () => reader.assertProviders(),
    async assertArtifact(signal) {
      const artifacts = intent.artifactSet ? await readApplicationPrivateArtifactRoles(input, intent) :
        intent.artifact ? [intent.artifact] : [];
      for (const artifact of artifacts) {
        const locations = [{ imageRef: artifact.imageRef, registryResourceId: artifact.registryResourceId }];
        if ('producerRegistryResourceId' in artifact && artifact.producerRegistryResourceId !== artifact.registryResourceId) {
          locations.unshift({ imageRef: artifact.producerImageRef, registryResourceId: artifact.producerRegistryResourceId });
        }
        for (const location of locations) {
          must(!signal?.aborted, 'readback-cancelled');
          const expected = parseApplicationImageReference(location.imageRef);
          const registry = location.registryResourceId.split('/');
          const observed = await reader.client.getAcr(registry[4]!, registry.at(-1)!);
          must(observed.id.toLowerCase() === location.registryResourceId.toLowerCase() &&
            observed.loginServer === expected.loginServer && !observed.adminUserEnabled &&
            observed.provisioningState === 'Succeeded', 'artifact-registry-readback');
          const manifest = await readApplicationRegistryManifest({
            runner: input.runner, projectRoot: input.inspection.projectRoot, binding: intent.binding,
            loginServer: expected.loginServer, repository: expected.repository, digest: expected.digest,
            beforeAccess: async () => { must(!signal?.aborted, 'readback-cancelled'); await authority.assertCurrent(); }, now: clock
          });
          must(manifest.digest === expected.digest, 'artifact-registry-digest');
        }
      }
    },
    setBackendEffects(value) { recorder = value; }
  };
}

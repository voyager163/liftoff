import path from 'node:path';
import type {
  DarwinAzureReaderReference, NativeStateHost, ProtectedStateWorkspace, StateExecutionContext
} from '../../domain/repair/stateful.js';
import { stateAssert } from '../../domain/repair/stateful-invariants.js';
import { createDarwinStateStorageProfile, PythonDarwinStateSystemBridge } from '../state/darwin-capabilities.js';
import { assertEnvironmentOnlyProviders, DarwinKeychainAzureReader } from '../state/darwin-native-host.js';
import { assertPrivateStatePath } from '../state/protected-workspace.js';
import { SpawnPrivateStateCommandRunner } from '../state/native-command.js';
import { inspectNativeLocalStateTools } from '../state/native-system.js';
import { readPrivateNativeFile } from '../state/native-files.js';
import { stopOwnedStateProcessesIn } from '../state/owned-process.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { PrivateCustodyConfiguration } from '../../application/azure-activation/private-custody.js';
import {
  FilesystemPrivateImportConfiguration, PrivateBootstrapImportDriver,
  type BootstrapImportMapping, type PrivateImportConfiguration
} from './private-import-opentofu.js';

export async function createPrivateImportRuntime(options: {
  custody: PrivateCustodyConfiguration;
  context: StateExecutionContext;
  reader: DarwinAzureReaderReference;
  configuration: PrivateImportConfiguration;
  mappings: readonly BootstrapImportMapping[];
  ownedResourceIds: readonly string[];
  authorize: () => Promise<void>;
  now?: () => number;
}): Promise<{ workspace: ProtectedStateWorkspace; driver: PrivateBootstrapImportDriver }> {
  await options.authorize();
  const actualTools = await inspectNativeLocalStateTools({
    pythonPath: options.custody.tools.python.path, tofuPath: options.custody.tools.tofu.path,
    workingDirectory: options.custody.workspaceRoot
  });
  stateAssert(canonicalSha256(actualTools) === canonicalSha256(options.custody.tools), 'tool-unavailable');
  const storage = await createDarwinStateStorageProfile({
    tools: actualTools, workspaceRoot: options.custody.workspaceRoot, workspaceId: options.custody.workspaceId,
    keyReference: options.custody.keyReference, projectId: options.context.projectId
  });
  const context = { ...options.context, principalId: options.reader.principalId };
  const bridge = new PythonDarwinStateSystemBridge(actualTools.python, options.custody.workspaceRoot);
  const reader = new DarwinKeychainAzureReader({ reference: options.reader, bridge });
  const environments = new Map<string, { value: Readonly<Record<string, string>>; expires: number }>();
  const within = (name: string) => {
    const relative = path.relative(options.custody.workspaceRoot, name);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const host: NativeStateHost = {
    async verify(directory) {
      await options.authorize();
      stateAssert(within(directory) && options.ownedResourceIds.length > 0 && options.ownedResourceIds.length <= 128, 'unsafe-path');
      await assertPrivateStatePath(directory, context, storage.volume, true);
      await assertEnvironmentOnlyProviders(directory);
      const bytes = await readPrivateNativeFile(path.join(directory, 'liftoff-state-backend.tf.json'), 16_384);
      try {
        const backend = JSON.parse(Buffer.from(bytes).toString('utf8'));
        stateAssert(typeof backend.terraform?.backend?.local?.path === 'string' && within(backend.terraform.backend.local.path), 'unsafe-path');
      } finally { bytes.fill(0); }
      const environment = await reader.resolve(context, options.ownedResourceIds);
      environments.set(directory, { value: environment, expires: Date.now() + 30_000 });
      return { directory, encryptedVolume: true, isolated: true, providerIdentityReadOnly: true, providerRegistrationDisabled: true };
    },
    async privateEnvironment(directory) {
      const value = environments.get(directory);
      stateAssert(value && value.expires > Date.now(), 'access-denied');
      environments.delete(directory);
      return value.value;
    },
    async quiesce() {
      await stopOwnedStateProcessesIn(options.custody.workspaceRoot);
      environments.clear();
    }
  };
  const runner = new SpawnPrivateStateCommandRunner({
    executable: actualTools.tofu.path, executableDigest: actualTools.tofu.sha256, host
  });
  return {
    workspace: storage.workspace,
    driver: new PrivateBootstrapImportDriver({
      workspace: storage.workspace, runner, configuration: options.configuration,
      configurations: new FilesystemPrivateImportConfiguration(options.context.projectRoot, options.configuration),
      mappings: options.mappings, context, authorize: options.authorize, now: options.now
    })
  };
}

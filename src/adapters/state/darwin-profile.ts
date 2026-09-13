import {
  type DarwinLocalStateExecutionProfile, type DarwinLocalStateExecutionProfileOptions,
  type StateRecipeQualification
} from '../../domain/repair/stateful.js';
import { freezeStateValue, stateAssert } from '../../domain/repair/stateful-invariants.js';
import { createStateMigrationService } from '../../application/state-migration/service.js';
import { createDarwinStateStorageProfile, PythonDarwinStateSystemBridge } from './darwin-capabilities.js';
import { DarwinKeychainAzureReader, DarwinObservedStateHost } from './darwin-native-host.js';
import { isActualNativeLocalQualification } from './local-qualification.js';
import { LocalStateBackend } from './local.js';
import { SpawnPrivateStateCommandRunner } from './native-command.js';
import { OpenTofuStateDriver } from './opentofu.js';
import { nativeStateHostId, verifyStateExecutable } from './native-system.js';

/**
 * Real macOS/APFS implementation, with account/key setup and independent live
 * qualification left as explicit prerequisites, not fabricated readiness.
 */
export async function createDarwinLocalStateExecutionProfile(
  options: DarwinLocalStateExecutionProfileOptions
): Promise<DarwinLocalStateExecutionProfile> {
  stateAssert(isActualNativeLocalQualification(options.nativeQualification, options.tools), 'unqualified-combination');
  stateAssert(options.context.hostId === nativeStateHostId() && options.context.projectId === options.projectId, 'ownership-mismatch');
  await verifyStateExecutable(options.tools.tofu);
  await verifyStateExecutable(options.tools.python);
  const storage = await createDarwinStateStorageProfile(options);
  const context = freezeStateValue(structuredClone(options.context));
  const bridge = new PythonDarwinStateSystemBridge(options.tools.python, options.workspaceRoot);
  const reader = new DarwinKeychainAzureReader({ reference: options.readerReference, bridge });
  const host = new DarwinObservedStateHost({
    root: options.workspaceRoot, context, volume: storage.volume, reader
  });
  const runner = new SpawnPrivateStateCommandRunner({
    executable: options.tools.tofu.path, executableDigest: options.tools.tofu.sha256, host
  });
  const qualification: StateRecipeQualification = {
    async assertQualified(request) {
      stateAssert(request.recipe === 'address-refactor' && request.source === 'local'
        && request.destinations.length === 1 && request.destinations[0] === 'local', 'unsupported-local-state-operation');
      stateAssert(request.hostId === options.tools.hostId && request.executableDigest === options.tools.tofu.sha256
        && isActualNativeLocalQualification(options.nativeQualification, options.tools), 'unqualified-combination');
      await verifyStateExecutable(options.tools.tofu);
      await verifyStateExecutable(options.tools.python);
      stateAssert(options.liveQualification, 'unqualified-combination');
      await options.liveQualification.assertQualified(request);
    }
  };
  const native = new OpenTofuStateDriver({
    workspace: storage.workspace, runner, configurations: options.configurations, qualification
  });
  const service = createStateMigrationService({
    workspace: storage.workspace, native, writers: options.writers,
    backend(binding) {
      stateAssert(binding.kind === 'local', 'unsupported-local-state-operation');
      return new LocalStateBackend(binding, { volume: storage.volume, locks: storage.locks });
    }
  });
  return {
    ...storage, service, qualification, nativeQualification: options.nativeQualification,
    liveQualification: options.liveQualification ? 'supplied' : 'required'
  };
}

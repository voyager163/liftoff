import type { MacMigrationBrew, MacMigrationHost, MacNpmOwner } from '../../domain/distribution/mac-migration.js';
import type { NativeBundleInventory, NativeCandidate, NativeChannelObservation, NativeReleasePolicy } from '../../domain/distribution/native-upgrade.js';
import type { NativeStableMaterial } from './native-metadata.js';
import type { CaskOwnershipObservation } from './native.js';
import type { CaskMigrationTargetStage } from './mac-migration-cask-stage.js';

/** No production implementation is registered until actual channel and host qualification. */
export interface MacMigrationCaskPort {
  policy: NativeReleasePolicy;
  admitHost(host: MacMigrationHost, signal: AbortSignal): Promise<void>;
  target(brew: MacMigrationBrew, signal: AbortSignal): Promise<NativeStableMaterial>;
  channel(brew: MacMigrationBrew, candidate: NativeCandidate, signal: AbortSignal): Promise<NativeChannelObservation>;
  destination(brew: MacMigrationBrew, candidate: NativeCandidate, signal: AbortSignal): Promise<string>;
  preflight(brew: MacMigrationBrew, candidate: NativeCandidate, oldOwner: MacNpmOwner, signal: AbortSignal):
    Promise<{ identity: string; permissions: 'verified'; collisions: 'clear' }>;
  installExact(brew: MacMigrationBrew, candidate: NativeCandidate, channelIdentity: string,
    operationId: string, context: { signal: AbortSignal; environment: NodeJS.ProcessEnv; timeoutMs: number;
      targetStage: CaskMigrationTargetStage }):
    Promise<{ settled: boolean; installed: boolean }>;
  absent(brew: MacMigrationBrew, candidate: NativeCandidate, signal: AbortSignal): Promise<boolean>;
  installed(brew: MacMigrationBrew, candidate: NativeCandidate, signal: AbortSignal):
    Promise<{ inventory: NativeBundleInventory; ownership: CaskOwnershipObservation }>;
}

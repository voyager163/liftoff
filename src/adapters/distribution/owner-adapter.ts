import type { ExternalCommand } from '../../domain/project/contracts.js';
import type { NativeChannelRegistration } from '../../domain/distribution/native-trust.js';
import type { AdmittedNativeArtifact, AdmittedNativeCandidate } from './native-admission.js';

export interface NativeManagerInstallation {
  owner: 'homebrew-cask' | 'winget';
  packageId: string;
  version: string;
  prefix: string;
  payloadRoot: string;
  launcherPath: string;
  sourceId: string;
  evidenceDigest: string;
}

export interface NativeManagerSelection {
  owner: 'homebrew-cask' | 'winget';
  packageId: string;
  version: string;
  destinationDirectory: string;
  launcherPath: string;
  sourceId: string;
  sourceDigest: string;
  bindingDigest: string;
  command: ExternalCommand;
}

export interface NativeOwnerAdapter {
  readonly owner: 'homebrew-cask' | 'winget';
  observeInstallation(candidate: AdmittedNativeCandidate): Promise<NativeManagerInstallation | undefined>;
  select(candidate: AdmittedNativeArtifact, mode: 'install' | 'upgrade'): Promise<NativeManagerSelection>;
  recheck(selection: NativeManagerSelection): Promise<void>;
  execute(selection: NativeManagerSelection): Promise<void>;
  verify(candidate: AdmittedNativeCandidate, selection: NativeManagerSelection): Promise<NativeManagerInstallation>;
}

export interface NativeManagerToolContext {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  channel: NativeChannelRegistration;
}

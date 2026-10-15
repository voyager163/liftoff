import type { NativeReleaseCatalog } from '../distribution/native/native-release-catalog.mjs';

export interface NativeReleasePolicy {
  readonly schemaVersion: number;
  readonly repository: string;
  readonly approvedSigningKeySha256: string | null;
  readonly homebrew: {
    readonly cask: string | null;
    readonly sourceRepository: string | null;
    readonly developerTeamId: string | null;
  };
  readonly winget: {
    readonly packageIdentifier: string | null;
    readonly publisher: string | null;
    readonly certificateSha256: string | null;
    readonly installerAppId: string | null;
  };
  readonly linux: { readonly archiveSigningKeySha256: string | null };
}

export interface NativeReleaseSetOptions {
  readonly root?: string;
  readonly approvedPolicy?: NativeReleasePolicy;
}

export interface NativeReleaseSet {
  readonly directory: string;
  readonly catalogSha256: string;
  readonly catalog: NativeReleaseCatalog;
  readonly published: false;
}

export function assembleNativeReleaseSet(
  directory: string,
  expectedInputDigest: string,
  env?: Readonly<Record<string, string | undefined>>,
  options?: NativeReleaseSetOptions
): Promise<NativeReleaseSet>;

export function verifyNativeReleaseSet(
  directory: string,
  expectedDigest: string,
  env?: Readonly<Record<string, string | undefined>>,
  options?: NativeReleaseSetOptions
): Promise<NativeReleaseCatalog>;

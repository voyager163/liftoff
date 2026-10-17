import type { Buffer } from 'node:buffer';

declare const originalAssembly: unique symbol;

export interface NativeProgramBuildOptions {
  output: string;
  runtimeArchive: string;
  windowsLauncher?: string;
  npmCli?: string;
}

export interface OriginalNativeProgramAssembly {
  readonly kind: 'liftoff-original-native-program-assembly';
  readonly [originalAssembly]: true;
}

export interface NativeProgramFile {
  bytes: number;
  sha256: string;
  mode: number;
}

export interface NativeProgramSourceFile {
  path: string;
  sha256: string;
  [key: string]: unknown;
}

export interface NativeProgramInputSet {
  digest: string;
  files: NativeProgramSourceFile[];
  [key: string]: unknown;
}

export interface NativeProgramObservation {
  readonly kind: 'liftoff-original-native-program-content';
  readonly installedApplicationRoot: string;
  readonly installedCliEntrypoint: string;
  readonly manifest: {
    schemaVersion: 1;
    kind: 'liftoff-native-development-bundle';
    releaseReady: false;
    package: {
      name: string;
      version: string;
      archive: NativeProgramFile;
      lockSha256: string;
      sourceFiles: NativeProgramSourceFile[];
    };
    source: {
      repository: string;
      commit: string;
      dirty: boolean;
      sourceDigest: string;
      configurationDigest: string;
      builderInputs: NativeProgramSourceFile[];
    };
    launcher: string;
    inventory: {
      entries: Array<{ path: string; kind: string; [key: string]: unknown }>;
      totalBytes: number;
      sha256: string;
    };
    [key: string]: unknown;
  };
  readonly sourceInputs: {
    source: NativeProgramInputSet;
    tests: NativeProgramInputSet;
    configuration: NativeProgramInputSet;
    revision: Record<string, unknown>;
  };
  readonly packageArchive: Readonly<NativeProgramFile & { content: Buffer }>;
  readonly releaseAuthority: 'not-issued';
  readonly nativeQualification: 'not-issued';
  readonly workflowAuthority: 'not-issued';
}

export function buildNativeProgram(options: NativeProgramBuildOptions): Promise<OriginalNativeProgramAssembly>;
export function readNativeProgramAssembly(reference: unknown): Promise<NativeProgramObservation>;

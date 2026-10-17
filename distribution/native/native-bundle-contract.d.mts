import type { Buffer } from 'node:buffer';

export interface NativeBundleLimits {
  entries: number;
  depth: number;
  fileBytes: number;
  totalBytes: number;
}

export interface NativeBundleFileIdentity {
  bytes: number;
  sha256: string;
  mode: number;
}

export type NativeBundleEntry =
  | { path: string; kind: 'directory'; mode: number }
  | { path: string; kind: 'symlink'; target: string }
  | ({ path: string; kind: 'file' } & NativeBundleFileIdentity);

export interface NativeBundleInventory {
  entries: NativeBundleEntry[];
  totalBytes: number;
  sha256: string;
}

export type NativeBundleHost =
  | { platform: 'darwin'; architecture: 'arm64' }
  | { platform: 'linux'; architecture: 'arm64' | 'x64' }
  | { platform: 'win32'; architecture: 'x64' };

export const nativeBundleLimits: Readonly<NativeBundleLimits>;
export const nativeBundleCases: readonly string[];
export function assertNativeBundleReport(report: unknown): { cases: number; passed: number };
export function nativeBundleHost(platform?: string, architecture?: string): NativeBundleHost;
export function nativeRuntimeInput<
  Inputs extends {
    runtime: { platform: string; architecture: string };
    additionalRuntimes: readonly { platform: string; architecture: string }[];
  }
>(inputs: Inputs, host: { platform: string; architecture: string }):
  Inputs['runtime'] | Inputs['additionalRuntimes'][number];
export function nativeArchiveTool(platform?: string, windowsRoot?: string): string;
export function nativeArchiveMembers(output: unknown): string[];
export function bundlePath(value: unknown): string;
export function bundleFile(file: string, maximum?: number): Promise<NativeBundleFileIdentity>;
export function readBundleFile(file: string, maximum?: number): Promise<{
  identity: NativeBundleFileIdentity;
  content: Buffer;
}>;
export function bundleInventory(directory: string, limits?: NativeBundleLimits): Promise<NativeBundleInventory>;
export function assertSystemRuntimeLibraries(output: unknown): string[];
export function assertLinuxRuntimeLibraries(
  linked: string, versions: string, floor: { minimumGlibc: string; minimumGlibcxx: string }
): { linked: string[]; requiredVersions: { GLIBC: string[]; GLIBCXX: string[] } };
export function assertDependencyClosure(installed: unknown, lock: unknown): {
  path: string;
  version: string;
  integrity: string;
}[];

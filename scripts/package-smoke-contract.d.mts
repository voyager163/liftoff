export { compiledPackageFiles } from '../src/plugins/builtin/assets.js';

export const maximumUnpackedPackageBytes: number;
export const requiredAncillaryAssets: readonly string[];
export const requiredPackagedAssets: readonly string[];

export interface InstalledPlanCase {
  readonly id: string;
  readonly directory: string;
  readonly args: readonly string[];
  readonly decisions: Readonly<Record<string, string>>;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly excludedPathPrefixes: readonly string[];
}

export const installedPlanCases: readonly InstalledPlanCase[];

export interface AssetIssue {
  readonly code:
    | 'invalid-asset-entry'
    | 'duplicate-asset-entry'
    | 'directory-asset-entry'
    | 'declared-asset-not-packed'
    | 'unexpected-declared-asset'
    | 'duplicate-packaged-asset'
    | 'undeclared-packaged-asset'
    | 'required-asset-not-packed'
    | 'missing-installed-asset'
    | 'installed-asset-bytes-differ'
    | 'retained-asset-installed';
  readonly path: string;
  readonly detail: string;
}

export interface PlanIssue {
  readonly code:
    | 'plan-output-malformed'
    | 'plan-decision-mismatch'
    | 'plan-artifact-missing'
    | 'plan-artifact-path-mismatch'
    | 'plan-excluded-artifact-present';
  readonly subject: string;
  readonly detail: string;
}

export function assertCompiledPackageFiles(packedPaths: unknown): void;
export function assertUnpackedPackageSize(bytes: unknown): void;
export function packagedAssetIssues(input: {
  readonly packedPaths: unknown;
  readonly declaredFiles: unknown;
}): readonly AssetIssue[];
export function installedAssetByteIssues(input: {
  readonly installedRoot: string;
  readonly sourceRoot: string;
}): Promise<readonly AssetIssue[]>;
export function installedRetainedAssetIssues(input: {
  readonly installedRoot: string;
}): Promise<readonly AssetIssue[]>;
export function planContractIssues(stdout: unknown, planCase: unknown): readonly PlanIssue[];
export function formatSmokeIssues(title: string, issues: readonly (AssetIssue | PlanIssue)[]): string;

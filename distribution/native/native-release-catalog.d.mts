export const nativeReleaseCatalogFilename: 'liftoff-native-release.json';
export const nativeReleaseTargets: readonly ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'];
export type NativeReleaseTarget = typeof nativeReleaseTargets[number];
export const nativeEvidenceKinds: readonly [
  'minimumHost', 'installerOwnership', 'signing', 'packageNamespace', 'hclSourceCorrespondence'
];
export type NativeEvidenceKind = typeof nativeEvidenceKinds[number] | 'notarization';

export interface NativeReleaseSubject {
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeReleaseCatalogTarget {
  readonly target: NativeReleaseTarget;
  readonly manifest: NativeReleaseSubject;
  readonly qualification: NativeReleaseSubject;
  readonly signature: NativeReleaseSubject;
  readonly publicKey: NativeReleaseSubject;
  readonly files: readonly (NativeReleaseSubject & { readonly sourceFilename: string })[];
  readonly evidence: readonly (NativeReleaseSubject & { readonly kind: NativeEvidenceKind })[];
  readonly archiveSignature: NativeReleaseSubject | null;
  readonly archivePublicKey: NativeReleaseSubject | null;
  readonly installer: NativeReleaseSubject | null;
  readonly definitions: readonly (NativeReleaseSubject & { readonly sourceFilename: string })[];
}

export interface NativeReleaseCatalog {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-native-release-catalog';
  readonly repository: 'voyager163/liftoff';
  readonly name: '@msn-control/liftoff';
  readonly version: string;
  readonly commit: string;
  readonly runId: string;
  readonly tag: string;
  readonly distTag: 'next' | 'latest';
  readonly npm: NativeReleaseSubject;
  readonly npmRecord: NativeReleaseSubject;
  readonly targets: readonly NativeReleaseCatalogTarget[];
}

export function nativeReleaseAssetStem(version: string, target: NativeReleaseTarget): string;
export function nativeCatalogSubjects(catalog: NativeReleaseCatalog): NativeReleaseSubject[];
export function assertNativeReleaseCatalog(catalog: unknown): NativeReleaseCatalog;

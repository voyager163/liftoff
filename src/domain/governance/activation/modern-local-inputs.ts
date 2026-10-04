import { types } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalSha256 } from './canonical-json.js';
import type { ReadableModernActivationIdentity } from './modern-record-contracts.js';
import { validateManifestPathParts } from '../../project/manifest/layout.js';
import type { ExternalCommand } from '../../project/contracts.js';
import { exactRecord } from '../../project/manifest/fields.js';

export const modernLocalBounds = Object.freeze({
  files: 512, directories: 256, directoryEntries: 256, depth: 12, pathBytes: 1024,
  fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024,
  controlFiles: 1024, controlFileBytes: 8 * 1024 * 1024, controlBytes: 32 * 1024 * 1024,
  references: 2048, tokens: 500_000, dataNodes: 200_000, dataDepth: 24
});

export const modernLocalRequiredInputClosurePolicy = Object.freeze({
  kind: 'liftoff-local-required-input-closure', revision: 3,
  typeScriptConfigs: 'captured-local-extends-and-project-reference-graph',
  typeScriptTargets: 'all-reached-basenames-with-shared-input-rules-cycle-rejection-and-global-bounds',
  pythonPackageSearchPaths: 'pytest-literal-immediate-component-parent-namespace-without-additional-source-roots',
  composeLabelFiles: 'unsupported-service-declaration-scalar-and-list-without-source-read',
  composeCredentialSpecs: 'unsupported-service-declaration-without-file-or-registry-read',
  composeLiteralData: 'label-and-environment-or-extension-keys-are-not-service-source-declarations',
  hclTemplateFiles: 'unsupported-nested-template-closure',
  recursiveOpenTofu: 'no-exclusion-gaps-without-established-command-ignore-semantics'
});

export class ModernLocalInputError extends Error {}

export const rawLocalDigest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function localInputFailure(message: string): never {
  throw new ModernLocalInputError(message);
}

/** Copies bounded own data before any async work; neither getters nor proxies are read. */
export function copyModernLocalData<T>(value: T): T {
  let nodes = 0, textBytes = 0;
  function stringBound(entry: string): void {
    const size = Buffer.byteLength(entry);
    textBytes += size;
    if (size > 12 * 1024 * 1024 || textBytes > 64 * 1024 * 1024) localInputFailure('Local input data exceeds the string bound.');
  }
  function check(entry: unknown, depth: number): void {
    if (++nodes > modernLocalBounds.dataNodes || depth > modernLocalBounds.dataDepth) {
      localInputFailure('Local input data exceeds the structural bound.');
    }
    if (typeof entry === 'string') {
      stringBound(entry);
      return;
    }
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || types.isProxy(entry) ||
        ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(entry))) {
      localInputFailure('Local inputs require plain own data, not buffers, proxies or callable objects.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry), array = Array.isArray(entry);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > modernLocalBounds.dataNodes || array &&
        (Object.getPrototypeOf(entry) !== Array.prototype || keys.length !== entry.length + 1)) {
      localInputFailure('Local input arrays must be bounded and dense.');
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key as string];
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
          ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key) ||
          array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= entry.length)) {
        localInputFailure('Local inputs must not contain accessors, sparse entries or special properties.');
      }
      stringBound(key);
      check(descriptor.value, depth + 1);
    }
  }
  check(value, 0);
  return structuredClone(value);
}

export function localPath(value: unknown, root = false): string[] {
  value = copyModernLocalData(value);
  if (root && Array.isArray(value) && value.length === 0) return [];
  const parts = [...validateManifestPathParts(value, 'Local input path')];
  if (parts.length > modernLocalBounds.depth || Buffer.byteLength(parts.join('/')) > modernLocalBounds.pathBytes) {
    localInputFailure('Local input path exceeds the depth or byte bound.');
  }
  return parts;
}

export interface ModernLocalFile {
  readonly pathParts: readonly string[];
  readonly scope: 'application' | 'control';
  readonly content: string | null;
  readonly mode: number | null;
  readonly bytes: number;
  readonly digest: string | null;
}
export interface ModernLocalDirectory {
  readonly pathParts: readonly string[];
  readonly exists: boolean;
  readonly mode: number | null;
  readonly entries: readonly { readonly name: string; readonly kind: 'file' | 'directory' | 'symlink' | 'other' }[];
}
export interface ModernLocalPhysical {
  readonly path: string;
  readonly identity: string | null;
}
export interface ModernLocalSnapshot {
  readonly kind: 'liftoff-modern-local-inputs';
  readonly schemaVersion: 3;
  readonly root: string;
  readonly files: readonly ModernLocalFile[];
  readonly directories: readonly ModernLocalDirectory[];
  readonly exclusions: readonly { readonly pathParts: readonly string[]; readonly kind: string; readonly reason: string }[];
  readonly physical: readonly ModernLocalPhysical[];
}
export type ModernLocalInspection =
  | { readonly status: 'modern-observed'; readonly snapshot: ModernLocalSnapshot }
  | { readonly status: 'released-source'; readonly root: string; readonly manifestVersion: number; readonly sourceDigest: string }
  | { readonly status: 'blocked'; readonly blockers: readonly string[] };

export type ModernLocalContext =
  | { readonly kind: 'governed'; readonly identity: ReadableModernActivationIdentity }
  | { readonly kind: 'governance-none'; readonly selectionDigest: string; readonly pluginResolutionDigest: string; readonly activeLayoutDigest: string };
export interface ModernLocalCheck {
  readonly id: string;
  readonly status: 'planned' | 'blocked' | 'inapplicable';
  readonly inputPaths: readonly string[];
  readonly reasons: readonly string[];
  readonly command: ExternalCommand | null;
  readonly cwdPathParts: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly prerequisites: readonly string[];
  readonly effects: readonly string[];
}
export interface ModernLocalVerificationPlan {
  readonly kind: 'liftoff-modern-local-verification-plan';
  readonly schemaVersion: 1;
  readonly status: 'planned' | 'blocked';
  readonly inspection: ModernLocalInspection;
  readonly context: ModernLocalContext | null;
  readonly observationDigest: string;
  readonly physicalDigest: string;
  readonly baselineDigest: string;
  readonly recipeSet: { readonly id: 'liftoff-local-verification'; readonly version: 1; readonly digest: string };
  readonly checks: readonly ModernLocalCheck[];
  readonly blockers: readonly string[];
  readonly execution: 'not-authorized';
}

export function capturedFileBytes(file: ModernLocalFile): Buffer | undefined {
  file = copyModernLocalData(file);
  exactRecord(file, ['pathParts', 'scope', 'content', 'mode', 'bytes', 'digest'], 'Captured local file');
  if (file.content === null) {
    if (file.mode !== null || file.bytes !== 0 || file.digest !== null) localInputFailure('Absent local input has fabricated content metadata.');
    return undefined;
  }
  if (typeof file.content !== 'string' || !Number.isInteger(file.mode) || file.mode === null || file.mode < 0 ||
      file.mode > 0o777 || !Number.isSafeInteger(file.bytes) || file.bytes < 0) localInputFailure('Invalid local input file metadata.');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64') !== file.content || bytes.length !== file.bytes || rawLocalDigest(bytes) !== file.digest) {
    localInputFailure('Local input bytes do not match their declared raw digest or length.');
  }
  return bytes;
}

export function validateModernLocalSnapshot(value: ModernLocalSnapshot): void {
  value = copyModernLocalData(value);
  exactRecord(value, ['kind', 'schemaVersion', 'root', 'files', 'directories', 'exclusions', 'physical'], 'Local snapshot');
  if (value.kind !== 'liftoff-modern-local-inputs' || value.schemaVersion !== 3 || typeof value.root !== 'string' ||
      !path.isAbsolute(value.root) || path.normalize(value.root) !== value.root || /[\u0000-\u001f]/u.test(value.root)) localInputFailure('Invalid local input snapshot identity.');
  const counts = { application: 0, control: 0 }, totals = { application: 0, control: 0 };
  const seen = new Set<string>();
  if (!Array.isArray(value.files) || !Array.isArray(value.directories) || !Array.isArray(value.physical) ||
      !Array.isArray(value.exclusions)) localInputFailure('Local input snapshot collections are required.');
  for (const file of value.files) {
    exactRecord(file, ['pathParts', 'scope', 'content', 'mode', 'bytes', 'digest'], 'Local file');
    const parts = file.scope === 'control' ? validateManifestPathParts(file.pathParts, 'Control input path') : localPath(file.pathParts);
    if (file.scope !== 'application' && file.scope !== 'control') localInputFailure('Unknown local input scope.');
    const key = parts.join('/');
    if (seen.has(key)) localInputFailure('Duplicate local input file.');
    seen.add(key);
    const bytes = capturedFileBytes(file);
    if (file.scope === 'application') {
      counts.application += 1;
      totals.application += bytes?.length ?? 0;
    } else {
      counts.control += 1;
      totals.control += bytes?.length ?? 0;
    }
    if (file.bytes > (file.scope === 'control' ? modernLocalBounds.controlFileBytes : modernLocalBounds.fileBytes)) {
      localInputFailure('Local input file exceeds its byte bound.');
    }
  }
  if (counts.application > modernLocalBounds.files || counts.control > modernLocalBounds.controlFiles ||
      totals.application > modernLocalBounds.totalBytes || totals.control > modernLocalBounds.controlBytes ||
      value.directories.length > modernLocalBounds.directories) localInputFailure('Local input inventory exceeds its aggregate bound.');
  const directoryNames = new Set<string>();
  for (const directory of value.directories) {
    exactRecord(directory, ['pathParts', 'exists', 'mode', 'entries'], 'Local directory');
    const key = localPath(directory.pathParts, true).join('/');
    if (directoryNames.has(key) || typeof directory.exists !== 'boolean' || !Array.isArray(directory.entries) ||
        directory.entries.length > modernLocalBounds.directoryEntries ||
        !directory.exists && (directory.mode !== null || directory.entries.length !== 0) ||
        directory.exists && (!Number.isInteger(directory.mode) || directory.mode === null || directory.mode < 0 || directory.mode > 0o777)) localInputFailure('Invalid or duplicate local directory observation.');
    directoryNames.add(key);
    const names = new Set<string>();
    for (const entry of directory.entries) {
      exactRecord(entry, ['name', 'kind'], 'Local directory entry');
      localPath([entry.name]);
      const alias = entry.name.toUpperCase().toLowerCase();
      if (names.has(alias) || !['file', 'directory', 'symlink', 'other'].includes(entry.kind)) localInputFailure('Local directory contains aliases or invalid entry kinds.');
      names.add(alias);
    }
  }
  const physicalNames = new Set<string>();
  for (const entry of value.physical) {
    exactRecord(entry, ['path', 'identity'], 'Local physical input');
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || path.normalize(entry.path) !== entry.path || physicalNames.has(entry.path) ||
        entry.identity !== null && (typeof entry.identity !== 'string' || !/^\d+(?::\d+){7}$/u.test(entry.identity))) {
      localInputFailure('Invalid or duplicate local physical observation.');
    }
    const relative = path.relative(value.root, entry.path);
    const ancestor = value.root === entry.path || value.root.startsWith(entry.path.endsWith(path.sep) ? entry.path : entry.path + path.sep);
    if (!ancestor && (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))) {
      localInputFailure('Physical binding contains a path unrelated to the selected root.');
    }
    physicalNames.add(entry.path);
  }
  if (!value.physical.some(entry => entry.path === value.root && entry.identity !== null)) localInputFailure('Local root physical identity was not captured.');
  for (const entry of [...value.files, ...value.directories]) {
    for (let index = 0; index <= entry.pathParts.length; index += 1) {
      if (!physicalNames.has(path.join(value.root, ...entry.pathParts.slice(0, index)))) localInputFailure('Local file or parent physical identity is missing.');
    }
    const identity = value.physical.find(physical => physical.path === path.join(value.root, ...entry.pathParts))!.identity;
    const exists = 'content' in entry ? entry.content !== null : entry.exists;
    if (exists !== (identity !== null) || exists && (Number(identity!.split(':')[2]) & 0o7777) !== entry.mode) {
      localInputFailure('File/directory presence or mode contradicts its physical observation.');
    }
  }
  for (const file of value.files.filter(file => file.scope === 'application')) {
    const parent: ModernLocalDirectory | undefined = value.directories.find(directory => directory.pathParts.join('/') === file.pathParts.slice(0, -1).join('/'));
    const member = parent?.entries.find(entry => entry.name === file.pathParts.at(-1));
    if (file.content !== null ? !parent?.exists || member?.kind !== 'file' : member !== undefined) {
      localInputFailure('Local file presence contradicts captured directory membership.');
    }
  }
  for (const entry of value.exclusions) {
    exactRecord(entry, ['pathParts', 'kind', 'reason'], 'Local exclusion');
    localPath(entry.pathParts);
    if (typeof entry.kind !== 'string' || typeof entry.reason !== 'string' || !entry.reason) localInputFailure('Invalid local input exclusion.');
  }
}

export function localObservationDigest(snapshot: ModernLocalSnapshot): string {
  snapshot = copyModernLocalData(snapshot);
  validateModernLocalSnapshot(snapshot);
  return canonicalSha256({ kind: 'liftoff-local-raw-observation', schemaVersion: 1, root: snapshot.root,
    files: snapshot.files.map(({ content: _content, ...file }) => file), directories: snapshot.directories, exclusions: snapshot.exclusions });
}

export function assembleModernLocalPlan(
  inspection: ModernLocalInspection, context: ModernLocalContext | null,
  checks: readonly ModernLocalCheck[], expectedIds: readonly string[], baseline: unknown,
  computationPolicy: Readonly<Record<string, unknown>>
): ModernLocalVerificationPlan {
  ({ inspection, context, checks, expectedIds, baseline, computationPolicy } = copyModernLocalData({ inspection, context, checks, expectedIds, baseline, computationPolicy }));
  if (new Set(expectedIds).size !== expectedIds.length || checks.length !== expectedIds.length ||
      checks.some((check, index) => check.id !== expectedIds[index])) localInputFailure('Local recipe set has missing, duplicate or invented checks.');
  const blockers = inspection.status === 'blocked' ? [...inspection.blockers] :
    inspection.status === 'released-source' ? ['Released input requires the gated reviewed successor path.'] :
      checks.filter(check => check.status === 'blocked').flatMap(check => check.reasons);
  const recipeSet = {
    id: 'liftoff-local-verification' as const, version: 1 as const,
    digest: canonicalSha256({ kind: 'liftoff-local-recipe-values', schemaVersion: 1,
      inputBounds: modernLocalBounds,
      computationPolicy,
      requiredInputClosurePolicy: modernLocalRequiredInputClosurePolicy,
      policy: { installedToolIdentity: 'not-observed', projectCode: 'requires-separate-authorization',
        preparation: 'never-implicit', network: 'not-isolated-by-offline-flags', stateAndHistoryExecutionPreflight: 'requires-mr2' },
      checks })
  };
  return {
    kind: 'liftoff-modern-local-verification-plan', schemaVersion: 1,
    status: blockers.length ? 'blocked' : 'planned', inspection, context,
    observationDigest: inspection.status === 'modern-observed' ? localObservationDigest(inspection.snapshot) : canonicalSha256(inspection),
    physicalDigest: canonicalSha256(inspection.status === 'modern-observed' ? inspection.snapshot.physical : null),
    baselineDigest: canonicalSha256({ kind: 'liftoff-local-baseline', schemaVersion: 3, context, baseline }),
    recipeSet, checks, blockers, execution: 'not-authorized'
  };
}

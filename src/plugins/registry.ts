import { createHash } from 'node:crypto';
import type { ArtifactLifecycle, GeneratedArtifact, ProjectProvisioningGroup } from '../domain/project/contracts.js';
import { canonicalJson, canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { validateArtifactPathParts } from '../domain/project/paths.js';
import { supportedHostPlatforms, type SupportedHostPlatform } from '../domain/project/supported-stack.js';
import {
  frontendSelections,
  pluginApiVersion,
  pluginCategories,
  pluginEffectClasses,
  pluginRegistryLimits,
  PluginRegistryError,
  supportedPluginApiVersions,
  type ArtifactDeclaration,
  type AssetDigest,
  type ContributionOwner,
  type FrontendSelection,
  type OperationDefinition,
  type PluginAssetTexts,
  type PluginCategory,
  type PluginCondition,
  type PluginEffectClass,
  type PluginHost,
  type PluginInventoryEntry,
  type PluginIssue,
  type PluginIssueCode,
  type PluginRegistry,
  type PluginRegistryInput,
  type PluginRegistryLimits,
  type PluginRegistryStage,
  type PluginResolution,
  type PluginSelection,
  type PluginSupportCondition,
  type ResolvedArtifact,
  type ResolvedCheck,
  type ResolvedPlugin,
  type ResolvedRecipe,
  type Sha256Digest
} from './contracts.js';

/*
 * Pure, static validation and composition of release-owned bundled plugins. The registry never
 * reads files, environment, clocks or host state, never loads code, and never authorizes effects.
 */

type Dimension =
  | 'workload'
  | 'variant'
  | 'stack'
  | 'cloud'
  | 'workflow'
  | 'frontend'
  | 'governanceProfile'
  | 'agent'
  | 'environment';
type ScalarDimension = Exclude<Dimension, 'agent' | 'environment'>;
type Values = Partial<Record<Dimension, readonly string[]>>;
type RawRecord = Record<string, unknown>;

const scalarDimensions: readonly ScalarDimension[] = [
  'workload',
  'variant',
  'stack',
  'cloud',
  'workflow',
  'frontend',
  'governanceProfile'
];
const allDimensions: readonly Dimension[] = [...scalarDimensions, 'agent', 'environment'];
const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const kebabPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const portablePartPattern = /^[A-Za-z0-9._-]+$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const artifactLifecycles: ReadonlySet<string> = new Set<ArtifactLifecycle>([
  'managed-core',
  'project',
  'desired-state',
  'framework',
  'seed',
  'manifest'
]);
const coreOnlyLifecycles: ReadonlySet<string> = new Set<ArtifactLifecycle>(['manifest', 'desired-state']);
const categorySet: ReadonlySet<string> = new Set(pluginCategories);
const effectSet: ReadonlySet<string> = new Set(pluginEffectClasses);
const frontendSet: ReadonlySet<string> = new Set(frontendSelections);
const hostSet: ReadonlySet<string> = new Set(supportedHostPlatforms);
const sortedHosts: readonly SupportedHostPlatform[] = [...supportedHostPlatforms].sort(compareText);
const limitNames = Object.keys(pluginRegistryLimits) as (keyof PluginRegistryLimits)[];
const descriptorFields = [
  'apiVersion',
  'artifacts',
  'assets',
  'category',
  'checks',
  'contentVersion',
  'hostPlatforms',
  'id',
  'recipes',
  'sharedAssets',
  'supports'
];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

// Byte-view metadata is read from internal slots through intrinsic accessors captured at load, so
// own or inherited byteLength, buffer or Symbol.toStringTag overrides are never consulted or run.
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = intrinsicGetter(typedArrayPrototype, Symbol.toStringTag);
const typedArrayByteLength = intrinsicGetter(typedArrayPrototype, 'byteLength');
const typedArrayBuffer = intrinsicGetter(typedArrayPrototype, 'buffer');
const arrayBufferByteLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength');
const typedArraySet = (Object.getOwnPropertyDescriptor(typedArrayPrototype, 'set') as PropertyDescriptor)
  .value as (this: Uint8Array, source: ArrayBufferView) => void;
const OwnedBytes = Uint8Array;

function intrinsicGetter(target: object, key: PropertyKey): (this: unknown) => unknown {
  return (Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor).get as (this: unknown) => unknown;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keys are validated strings or numbers; values are never coerced. */
function compareKeys(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    const order = typeof a === 'number' && typeof b === 'number' ? a - b : compareText(a as string, b as string);
    if (order !== 0) return order;
  }
  return 0;
}

function sortBy<T>(values: readonly T[], key: (value: T) => readonly (string | number)[]): T[] {
  return [...values].sort((left, right) => compareKeys(key(left), key(right)));
}

function aliasKey(parts: readonly string[]): string {
  return parts.map((part) => part.normalize('NFC').toLowerCase()).join('/');
}

function display(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : typeof value;
}

/** Diagnostic text for an unvalidated value; objects and arrays are never coerced to strings. */
function label(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  if (value === null) return 'null';
  return Array.isArray(value) ? '<array>' : `<${typeof value}>`;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function digestOf(record: unknown): Sha256Digest {
  return `sha256:${canonicalSha256(record)}`;
}

function bytesDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isIdentifier(value: unknown, limits: PluginRegistryLimits): value is string {
  return typeof value === 'string' && value.length <= limits.maxIdLength && slugPattern.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

class Issues {
  private readonly entries = new Map<string, PluginIssue>();

  add(code: PluginIssueCode, subject: string, detail: string): void {
    this.entries.set(`${code}\u0000${subject}\u0000${detail}`, { code, subject, detail });
  }

  failure(stage: PluginRegistryStage): PluginRegistryError {
    const all = [...this.entries.values()];
    const limits = all.filter((issue) => issue.code === 'validation-limit-exceeded');
    return new PluginRegistryError(stage, sortBy(limits.length > 0 ? limits : all, (issue) => [
      issue.code,
      issue.subject,
      issue.detail
    ]));
  }

  hasAny(): boolean {
    return this.entries.size > 0;
  }

  throwIfAny(stage: PluginRegistryStage): void {
    if (this.hasAny()) throw this.failure(stage);
  }
}

class LimitExceeded extends Error {
  readonly issue: PluginIssue;

  constructor(limit: keyof PluginRegistryLimits, limits: PluginRegistryLimits) {
    super(`${limit} (${limits[limit]}) exceeded`);
    this.issue = {
      code: 'validation-limit-exceeded',
      subject: `limit:${limit}`,
      detail: `input exceeds the ${limit} bound of ${limits[limit]}; validation stopped without a partial result`
    };
  }
}

function limitIssue(issues: Issues, limit: keyof PluginRegistryLimits, limits: PluginRegistryLimits): void {
  const { issue } = new LimitExceeded(limit, limits);
  issues.add(issue.code, issue.subject, issue.detail);
}

function runStage<T>(stage: PluginRegistryStage, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof LimitExceeded) throw new PluginRegistryError(stage, [error.issue]);
    throw error;
  }
}

class Budget {
  private used = 0;

  constructor(private readonly limits: PluginRegistryLimits) {}

  charge(units: number): void {
    this.used += units;
    if (this.used > this.limits.maxSatisfiabilityWork) {
      throw new LimitExceeded('maxSatisfiabilityWork', this.limits);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Bounded plain-data intake. Values are read from own data-property descriptors, so accessors are
// rejected without being invoked. Every bound fails fast: the first exceeded bound stops the walk
// before any further copy is allocated. Proxy traps still run while inspecting a Proxy; hostile
// proxies are outside the release-owned-data trust boundary.
// ---------------------------------------------------------------------------------------------

const invalid: unique symbol = Symbol('invalid-plain-data');

interface IntakeOptions {
  readonly limits: PluginRegistryLimits;
  readonly issues: Issues;
  readonly code: (path: string) => PluginIssueCode;
  readonly bytesAt?: (path: string) => boolean;
  readonly unboundedStringAt?: (path: string) => boolean;
}

interface IntakeState extends IntakeOptions {
  nodes: number;
  bytes: number;
}

function intake(value: unknown, options: IntakeOptions): unknown {
  return walkValue(value, '', 0, new Set(), { ...options, nodes: 0, bytes: 0 });
}

function reserveNodes(state: IntakeState, count: number): void {
  if (state.nodes + count > state.limits.maxNodes) throw new LimitExceeded('maxNodes', state.limits);
}

function walkValue(value: unknown, path: string, depth: number, ancestors: Set<object>, state: IntakeState): unknown {
  reserveNodes(state, 1);
  state.nodes += 1;
  const reject = (detail: string): typeof invalid => {
    state.issues.add(state.code(path), path === '' ? 'input' : path, detail);
    return invalid;
  };
  if (typeof value === 'string') {
    if (value.length > state.limits.maxStringLength && state.unboundedStringAt?.(path) !== true) {
      throw new LimitExceeded('maxStringLength', state.limits);
    }
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : reject('numbers must be finite');
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'object') return reject(`${typeof value} values are not accepted`);
  if (ancestors.has(value)) return reject('cyclic references are not accepted');
  if (depth >= state.limits.maxDepth) throw new LimitExceeded('maxDepth', state.limits);
  if (ArrayBuffer.isView(value)) {
    return state.bytesAt?.(path) === true
      ? copyAssetBytes(value, state, reject)
      : reject('binary data is accepted only as packaged asset bytes');
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? walkList(value, path, depth, ancestors, state, reject)
      : walkRecord(value, path, depth, ancestors, state, reject);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Copies one packaged byte view into registry-owned memory. The per-asset and cumulative bounds
 * are checked against the view's actual internal length before the copy is allocated.
 */
function copyAssetBytes(
  value: ArrayBufferView,
  state: IntakeState,
  reject: (detail: string) => typeof invalid
): Uint8Array | typeof invalid {
  if (typedArrayName.call(value) !== 'Uint8Array') return reject('packaged asset bytes must be a Uint8Array');
  try {
    arrayBufferByteLength.call(typedArrayBuffer.call(value));
  } catch {
    return reject('packaged asset bytes must not use shared memory');
  }
  const length = typedArrayByteLength.call(value) as number;
  if (length > state.limits.maxAssetBytes) throw new LimitExceeded('maxAssetBytes', state.limits);
  if (state.bytes + length > state.limits.maxTotalAssetBytes) throw new LimitExceeded('maxTotalAssetBytes', state.limits);
  const copy = new OwnedBytes(length);
  try {
    typedArraySet.call(copy, value);
  } catch {
    return reject('packaged asset bytes must be an attached, in-bounds Uint8Array');
  }
  state.bytes += length;
  return copy;
}

function walkList(
  value: unknown[],
  path: string,
  depth: number,
  ancestors: Set<object>,
  state: IntakeState,
  reject: (detail: string) => typeof invalid
): unknown {
  if (Object.getPrototypeOf(value) !== Array.prototype) return reject('arrays must be plain arrays');
  const length = value.length;
  reserveNodes(state, length);
  if (Reflect.ownKeys(value).length !== length + 1) return reject('arrays cannot contain holes or extra properties');
  const result: unknown[] = [];
  let valid = true;
  for (let index = 0; index < length; index += 1) {
    const childPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      state.issues.add(state.code(childPath), childPath, 'array entries must be enumerable data properties');
      valid = false;
      continue;
    }
    const entry = walkValue(descriptor.value, childPath, depth + 1, ancestors, state);
    if (entry === invalid) valid = false;
    else result.push(entry);
  }
  return valid ? result : invalid;
}

function walkRecord(
  value: object,
  path: string,
  depth: number,
  ancestors: Set<object>,
  state: IntakeState,
  reject: (detail: string) => typeof invalid
): unknown {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return reject('values must be plain objects');
  const ownKeys = Reflect.ownKeys(value);
  reserveNodes(state, ownKeys.length);
  const result = Object.create(null) as RawRecord;
  let valid = true;
  const keys: string[] = [];
  for (const key of ownKeys) {
    if (typeof key === 'string') {
      keys.push(key);
    } else {
      reject('symbol-keyed properties are not accepted');
      valid = false;
    }
  }
  for (const key of keys.sort(compareText)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
    if (!('value' in descriptor) || descriptor.enumerable !== true) {
      state.issues.add(state.code(childPath), childPath, 'object fields must be enumerable data properties');
      valid = false;
      continue;
    }
    const entry = walkValue(descriptor.value, childPath, depth + 1, ancestors, state);
    if (entry === invalid) valid = false;
    else result[key] = entry;
  }
  return valid ? result : invalid;
}

// ---------------------------------------------------------------------------------------------
// Internal models and structural readers.
// ---------------------------------------------------------------------------------------------

interface ConditionModel {
  readonly values: Values;
  readonly sets: ReadonlyMap<Dimension, ReadonlySet<string>>;
  readonly key: string;
}

function conditionModel(values: Values): ConditionModel {
  const normalized: Record<string, readonly string[]> = {};
  const sets = new Map<Dimension, ReadonlySet<string>>();
  for (const dimension of allDimensions) {
    const list = values[dimension];
    if (list === undefined) continue;
    const sorted = [...list].sort(compareText);
    normalized[dimension] = sorted;
    sets.set(dimension, new Set(sorted));
  }
  return { values: normalized, sets, key: canonicalJson(normalized) };
}

const emptyCondition = conditionModel({});

interface Owner {
  readonly key: string;
  readonly rank: number;
  readonly id: string;
  readonly category?: PluginCategory;
  readonly output: ContributionOwner;
}

const coreOwner: Owner = { key: 'core', rank: 0, id: '', output: { kind: 'core' } };

function pluginOwner(category: PluginCategory, id: string): Owner {
  return {
    key: `plugin:${category}:${id}`,
    rank: pluginCategories.indexOf(category) + 1,
    id,
    category,
    output: { kind: 'plugin', category, id }
  };
}

interface Declared {
  readonly owner: Owner;
  readonly subject: string;
  readonly when: ConditionModel;
}

interface ArtifactModel extends Declared {
  readonly logicalName: string;
  readonly category: string;
  readonly pathParts: readonly string[];
  readonly key: string;
  readonly lifecycle: ArtifactLifecycle;
  readonly provisioningGroup?: ProjectProvisioningGroup;
}

interface AssetModel {
  readonly owner: Owner;
  readonly subject: string;
  readonly id: string;
  readonly pathParts: readonly string[];
  readonly key: string;
}

interface CheckModel extends Declared {
  readonly id: string;
  readonly version: number;
  readonly operation: string;
  readonly effects: readonly PluginEffectClass[];
}

interface RecipeModel extends Declared {
  readonly operation: string;
  readonly id: string;
  readonly version: number;
}

interface DescriptorModel {
  readonly owner: Owner;
  readonly category: PluginCategory;
  readonly id: string;
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly hostPlatforms: readonly string[];
  readonly supports: readonly ConditionModel[];
  readonly artifacts: readonly ArtifactModel[];
  readonly assets: readonly AssetModel[];
  readonly sharedAssets: readonly string[];
  readonly checks: readonly CheckModel[];
  readonly recipes: readonly RecipeModel[];
}

interface SpaceModel {
  readonly workloads: ReadonlyMap<string, readonly string[]>;
  readonly variantWorkload: ReadonlyMap<string, string>;
  readonly environments: readonly string[];
  readonly environmentSet: ReadonlySet<string>;
  readonly profiles: readonly string[];
  readonly profileSet: ReadonlySet<string>;
  readonly output: {
    readonly workloads: readonly { readonly id: string; readonly variants: readonly string[] }[];
    readonly environments: readonly string[];
    readonly governanceProfiles: readonly string[];
  };
}

interface OperationModel {
  readonly id: string;
  readonly effects: ReadonlySet<string>;
  readonly recipes: ReadonlySet<string>;
  readonly output: OperationDefinition;
}

interface ReleaseAssetModel {
  readonly id: string;
  readonly pathParts: readonly string[];
  readonly sha256: string;
}

interface PluginReleaseModel {
  readonly category: string;
  readonly id: string;
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly contentDigest: string;
  readonly assets: ReadonlyMap<string, ReleaseAssetModel>;
}

interface ReleaseModel {
  readonly sharedAssets: ReadonlyMap<string, ReleaseAssetModel>;
  readonly plugins: ReadonlyMap<string, PluginReleaseModel>;
}

interface BytesModel {
  readonly pathParts: readonly string[];
  readonly exact: string;
  readonly bytes: Uint8Array;
}

interface CoreModel {
  readonly artifacts: readonly ArtifactModel[];
  readonly sharedAssets: readonly AssetModel[];
  readonly managedCore: ReadonlyMap<string, readonly string[]>;
  readonly retired: ReadonlySet<string>;
}

interface Shape {
  readonly descriptors: readonly DescriptorModel[];
  readonly core: CoreModel;
  readonly space: SpaceModel;
  readonly operations: ReadonlyMap<string, OperationModel>;
  readonly release: ReleaseModel;
  readonly bytes: readonly BytesModel[];
}

interface Parser {
  readonly issues: Issues;
  readonly limits: PluginRegistryLimits;
}

function readRecord(
  parser: Parser,
  value: unknown,
  subject: string,
  code: PluginIssueCode,
  required: readonly string[],
  optional: readonly string[] = []
): RawRecord | undefined {
  if (!isRecord(value)) {
    parser.issues.add(code, subject, 'must be an object');
    return undefined;
  }
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(compareText);
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0) parser.issues.add(code, subject, `unknown field(s): ${unknown.join(', ')}`);
  if (missing.length > 0) parser.issues.add(code, subject, `missing field(s): ${missing.join(', ')}`);
  return unknown.length === 0 && missing.length === 0 ? value : undefined;
}

function readList(
  parser: Parser,
  value: unknown,
  subject: string,
  code: PluginIssueCode,
  field: string,
  limit?: keyof PluginRegistryLimits
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    parser.issues.add(code, subject, `${field} must be an array`);
    return undefined;
  }
  if (limit !== undefined && value.length > parser.limits[limit]) {
    limitIssue(parser.issues, limit, parser.limits);
    return undefined;
  }
  return value;
}

function readIdentifiers(
  parser: Parser,
  value: unknown,
  subject: string,
  code: PluginIssueCode,
  field: string,
  nonEmpty: boolean
): string[] | undefined {
  const list = readList(parser, value, subject, code, field, 'maxConditionValues');
  if (list === undefined) return undefined;
  const invalidEntry = list.find((entry) => !isIdentifier(entry, parser.limits));
  if ((nonEmpty && list.length === 0) || invalidEntry !== undefined || new Set(list).size !== list.length) {
    parser.issues.add(code, subject, `${field} must be ${nonEmpty ? 'a non-empty' : 'an'} array of distinct identifiers`);
    return undefined;
  }
  return [...(list as string[])].sort(compareText);
}

function readPath(
  parser: Parser,
  value: unknown,
  subject: string,
  code: PluginIssueCode,
  packaged: boolean
): string[] | undefined {
  if (!isStringList(value)) {
    parser.issues.add(code, subject, 'pathParts must be an array of strings');
    return undefined;
  }
  if (value.length > parser.limits.maxPathParts) {
    limitIssue(parser.issues, 'maxPathParts', parser.limits);
    return undefined;
  }
  let parts: string[];
  try {
    parts = validateArtifactPathParts(value, 'Path');
  } catch (error) {
    parser.issues.add(code, subject, (error as Error).message);
    return undefined;
  }
  const nonPortable = parts.find((part) => !portablePartPattern.test(part));
  if (nonPortable !== undefined) {
    parser.issues.add(code, subject, `path part ${JSON.stringify(nonPortable)} uses characters outside [A-Za-z0-9._-]`);
    return undefined;
  }
  if (packaged && (parts.length < 2 || parts[0] !== 'assets')) {
    parser.issues.add(code, subject, 'packaged asset paths must name a file below the assets directory');
    return undefined;
  }
  return parts;
}

function readEffects(
  parser: Parser,
  value: unknown,
  subject: string,
  code: PluginIssueCode,
  field: string
): PluginEffectClass[] | undefined {
  if (!isStringList(value) || value.some((effect) => !effectSet.has(effect)) || new Set(value).size !== value.length) {
    parser.issues.add(code, subject, `${field} must list distinct effect classes from ${pluginEffectClasses.join(', ')}`);
    return undefined;
  }
  return [...value].sort(compareText) as PluginEffectClass[];
}

function readCondition(parser: Parser, value: unknown, subject: string, allowSets: boolean): ConditionModel | undefined {
  if (value === undefined) return emptyCondition;
  const dimensions = allowSets ? allDimensions : scalarDimensions;
  const record = readRecord(parser, value, subject, 'invalid-condition', [], dimensions);
  if (record === undefined) return undefined;
  const values: Record<string, readonly string[]> = {};
  let valid = true;
  for (const dimension of dimensions) {
    if (!(dimension in record)) continue;
    const list = record[dimension];
    if (!isStringList(list) || list.length === 0 || new Set(list).size !== list.length) {
      parser.issues.add('invalid-condition', subject, `${dimension} must be a non-empty array of distinct strings`);
      valid = false;
    } else if (list.length > parser.limits.maxConditionValues) {
      limitIssue(parser.issues, 'maxConditionValues', parser.limits);
      valid = false;
    } else {
      values[dimension] = list;
    }
  }
  return valid ? conditionModel(values) : undefined;
}

function readSpace(parser: Parser, value: unknown): SpaceModel | undefined {
  const code: PluginIssueCode = 'invalid-registry-input';
  const subject = 'selection-space';
  const record = readRecord(parser, value, subject, code, ['environments', 'governanceProfiles', 'workloads']);
  if (record === undefined) return undefined;
  const workloads = readList(parser, record.workloads, subject, code, 'workloads', 'maxConditionValues');
  const environments = readIdentifiers(parser, record.environments, subject, code, 'environments', true);
  const profiles = readIdentifiers(parser, record.governanceProfiles, subject, code, 'governanceProfiles', true);
  if (workloads === undefined || environments === undefined || profiles === undefined) return undefined;
  const workloadMap = new Map<string, readonly string[]>();
  const variantWorkload = new Map<string, string>();
  let valid = workloads.length > 0;
  if (!valid) parser.issues.add(code, subject, 'workloads must not be empty');
  for (const entry of workloads) {
    const workload = readRecord(parser, entry, subject, code, ['id', 'variants']);
    const variants = workload && readIdentifiers(parser, workload.variants, subject, code, 'variants', false);
    if (workload === undefined || variants === undefined) {
      valid = false;
      continue;
    }
    if (!isIdentifier(workload.id, parser.limits) || workloadMap.has(workload.id)) {
      parser.issues.add(code, subject, `workload ${display(workload.id)} must be a distinct identifier`);
      valid = false;
      continue;
    }
    workloadMap.set(workload.id, variants);
    for (const variant of variants) {
      if (variantWorkload.has(variant)) {
        parser.issues.add(code, subject, `variant ${variant} is listed by more than one workload`);
        valid = false;
      }
      variantWorkload.set(variant, workload.id);
    }
  }
  if (!valid) return undefined;
  const ids = [...workloadMap.keys()].sort(compareText);
  return {
    workloads: workloadMap,
    variantWorkload,
    environments,
    environmentSet: new Set(environments),
    profiles,
    profileSet: new Set(profiles),
    output: {
      workloads: ids.map((id) => ({ id, variants: [...(workloadMap.get(id) as readonly string[])] })),
      environments: [...environments],
      governanceProfiles: [...profiles]
    }
  };
}

function readOperations(parser: Parser, value: unknown): Map<string, OperationModel> | undefined {
  const code: PluginIssueCode = 'invalid-registry-input';
  const list = readList(parser, value, 'operations', code, 'operations', 'maxConditionValues');
  if (list === undefined) return undefined;
  const operations = new Map<string, OperationModel>();
  let valid = true;
  for (const entry of list) {
    const record = readRecord(parser, entry, 'operation', code, ['id', 'permittedCheckEffects', 'recipes']);
    if (record === undefined) {
      valid = false;
      continue;
    }
    const subject = `operation:${typeof record.id === 'string' ? record.id : '?'}`;
    const effects = readEffects(parser, record.permittedCheckEffects, subject, code, 'permittedCheckEffects');
    const recipes = readList(parser, record.recipes, subject, code, 'recipes', 'maxRecipesPerPlugin');
    if (!isIdentifier(record.id, parser.limits) || operations.has(record.id)) {
      parser.issues.add(code, subject, 'operations require distinct identifiers');
      valid = false;
      continue;
    }
    if (effects === undefined || recipes === undefined) {
      valid = false;
      continue;
    }
    const keys = new Set<string>();
    const offered: { id: string; version: number }[] = [];
    for (const recipeEntry of recipes) {
      const recipe = readRecord(parser, recipeEntry, subject, code, ['id', 'version']);
      if (recipe === undefined) {
        valid = false;
        continue;
      }
      const key = `${label(recipe.id)}@${label(recipe.version)}`;
      if (!isIdentifier(recipe.id, parser.limits) || !isPositiveInteger(recipe.version) || keys.has(key)) {
        parser.issues.add(code, subject, `recipe ${key} requires a distinct identifier and positive integer version`);
        valid = false;
        continue;
      }
      keys.add(key);
      offered.push({ id: recipe.id, version: recipe.version });
    }
    operations.set(record.id, {
      id: record.id,
      effects: new Set(effects),
      recipes: keys,
      output: {
        id: record.id,
        permittedCheckEffects: effects,
        recipes: sortBy(offered, (recipe) => [recipe.id, recipe.version])
      }
    });
  }
  return valid ? operations : undefined;
}

function validProvisioningGroup(
  group: unknown,
  when: ConditionModel | undefined,
  space: SpaceModel,
  fail: (detail: string) => void
): boolean {
  if (group === 'base' || group === 'frontend') return true;
  const environment = typeof group === 'string' && group.startsWith('environment:')
    ? group.slice('environment:'.length)
    : undefined;
  if (environment === undefined || !space.environmentSet.has(environment)) {
    fail(`project artifacts require a base, frontend or declared environment provisioning group, not ${display(group)}`);
    return false;
  }
  if (when === undefined) return false;
  const listed = when.values.environment;
  if (listed === undefined || listed.length !== 1 || listed[0] !== environment) {
    fail(`provisioning group environment:${environment} requires an environment condition of exactly [${environment}]`);
    return false;
  }
  return true;
}

function readArtifact(parser: Parser, value: unknown, owner: Owner, space: SpaceModel): ArtifactModel | undefined {
  const base = `artifact:${owner.key}`;
  const record = readRecord(
    parser,
    value,
    base,
    'invalid-artifact',
    ['category', 'lifecycle', 'logicalName', 'pathParts'],
    ['provisioningGroup', 'when']
  );
  if (record === undefined) return undefined;
  const { category, lifecycle, logicalName, provisioningGroup } = record;
  const subject = typeof logicalName === 'string' ? `${base}:${logicalName}` : base;
  const fail = (detail: string): void => parser.issues.add('invalid-artifact', subject, detail);
  let valid = true;
  if (typeof logicalName !== 'string' || !kebabPattern.test(logicalName)) {
    fail(`logical name ${display(logicalName)} must be lowercase kebab case`);
    valid = false;
  }
  if (typeof category !== 'string' || !kebabPattern.test(category)) {
    fail(`artifact category ${display(category)} must be lowercase kebab case`);
    valid = false;
  }
  const pathParts = readPath(parser, record.pathParts, subject, 'invalid-artifact', false);
  const when = readCondition(parser, record.when, subject, true);
  if (pathParts === undefined || when === undefined) valid = false;
  if (typeof lifecycle !== 'string' || !artifactLifecycles.has(lifecycle)) {
    fail(`lifecycle ${display(lifecycle)} is not a supported artifact lifecycle`);
    valid = false;
  } else if (owner.category !== undefined && coreOnlyLifecycles.has(lifecycle)) {
    fail(`${lifecycle} artifacts are reserved for core declarations`);
    valid = false;
  }
  if (lifecycle === 'project') {
    if (!validProvisioningGroup(provisioningGroup, when, space, fail)) valid = false;
  } else if (provisioningGroup !== undefined) {
    fail('only project artifacts declare a provisioning group');
    valid = false;
  }
  if (!valid) return undefined;
  const parts = pathParts as string[];
  return {
    owner,
    subject,
    logicalName: logicalName as string,
    category: category as string,
    pathParts: parts,
    key: aliasKey(parts),
    lifecycle: lifecycle as ArtifactLifecycle,
    ...(provisioningGroup === undefined ? {} : { provisioningGroup: provisioningGroup as ProjectProvisioningGroup }),
    when: when as ConditionModel
  };
}

function readAsset(parser: Parser, value: unknown, owner: Owner): AssetModel | undefined {
  const base = `asset:${owner.key}`;
  const record = readRecord(parser, value, base, 'invalid-asset', ['id', 'pathParts']);
  if (record === undefined) return undefined;
  const subject = typeof record.id === 'string' ? `${base}:${record.id}` : base;
  const validId = isIdentifier(record.id, parser.limits);
  if (!validId) parser.issues.add('invalid-asset', subject, `asset id ${display(record.id)} is not a valid identifier`);
  const pathParts = readPath(parser, record.pathParts, subject, 'invalid-asset', true);
  if (!validId || pathParts === undefined) return undefined;
  return { owner, subject, id: record.id as string, pathParts, key: aliasKey(pathParts) };
}

function readCheck(parser: Parser, value: unknown, owner: Owner): CheckModel | undefined {
  const base = `check:${owner.key}`;
  const record = readRecord(parser, value, base, 'invalid-check', ['effects', 'id', 'operation', 'version'], ['when']);
  if (record === undefined) return undefined;
  const subject = typeof record.id === 'string' ? `${base}:${record.id}` : base;
  const validIdentity = isIdentifier(record.id, parser.limits) &&
    isIdentifier(record.operation, parser.limits) &&
    isPositiveInteger(record.version);
  if (!validIdentity) {
    parser.issues.add('invalid-check', subject, 'checks require identifier id and operation values and a positive integer version');
  }
  const effects = readEffects(parser, record.effects, subject, 'invalid-check', 'effects');
  const when = readCondition(parser, record.when, subject, true);
  if (!validIdentity || effects === undefined || when === undefined) return undefined;
  return {
    owner,
    subject,
    id: record.id as string,
    version: record.version as number,
    operation: record.operation as string,
    effects,
    when
  };
}

function readRecipe(parser: Parser, value: unknown, owner: Owner): RecipeModel | undefined {
  const base = `recipe:${owner.key}`;
  const record = readRecord(parser, value, base, 'invalid-recipe', ['id', 'operation', 'version'], ['when']);
  if (record === undefined) return undefined;
  const subject = `${base}:${label(record.operation)}:${label(record.id)}@${label(record.version)}`;
  const validIdentity = isIdentifier(record.id, parser.limits) &&
    isIdentifier(record.operation, parser.limits) &&
    isPositiveInteger(record.version);
  if (!validIdentity) {
    parser.issues.add('invalid-recipe', subject, 'recipe references require identifier operation and id values and a positive integer version');
  }
  const when = readCondition(parser, record.when, subject, true);
  if (!validIdentity || when === undefined) return undefined;
  return {
    owner,
    subject,
    operation: record.operation as string,
    id: record.id as string,
    version: record.version as number,
    when
  };
}

function readEach<T>(
  parser: Parser,
  value: unknown,
  subject: string,
  code: PluginIssueCode,
  field: string,
  limit: keyof PluginRegistryLimits,
  read: (entry: unknown) => T | undefined
): T[] | undefined {
  const list = readList(parser, value, subject, code, field, limit);
  if (list === undefined) return undefined;
  const results = list.map(read);
  return results.every((entry) => entry !== undefined) ? (results as T[]) : undefined;
}

function readDescriptor(parser: Parser, value: unknown, space: SpaceModel): DescriptorModel | undefined {
  const raw: RawRecord = isRecord(value) ? value : {};
  const subject = `plugin:${typeof raw.category === 'string' ? raw.category : '?'}:${typeof raw.id === 'string' ? raw.id : '?'}`;
  const record = readRecord(parser, value, subject, 'invalid-descriptor', descriptorFields);
  if (record === undefined) return undefined;
  const { category, id } = record;
  if (typeof category !== 'string' || !categorySet.has(category)) {
    parser.issues.add('unknown-category', subject, `category ${display(category)} must be one of ${pluginCategories.join(', ')}`);
    return undefined;
  }
  if (!isIdentifier(id, parser.limits)) {
    parser.issues.add('invalid-plugin-id', subject, `plugin id ${display(id)} must be a lowercase identifier of at most ${parser.limits.maxIdLength} characters`);
    return undefined;
  }
  const owner = pluginOwner(category as PluginCategory, id);
  const fail = (detail: string): void => parser.issues.add('invalid-descriptor', subject, detail);
  let valid = true;
  if (typeof record.apiVersion !== 'number' || typeof record.contentVersion !== 'number') {
    fail('apiVersion and contentVersion must be numbers');
    valid = false;
  }
  const hosts = record.hostPlatforms;
  if (!isStringList(hosts) || hosts.length === 0 || new Set(hosts).size !== hosts.length) {
    fail('hostPlatforms must be a non-empty array of distinct strings');
    valid = false;
  }
  const shared = record.sharedAssets;
  if (!isStringList(shared)) {
    fail('sharedAssets must be an array of strings');
    valid = false;
  }
  const code: PluginIssueCode = 'invalid-descriptor';
  const supports = readEach(parser, record.supports, subject, code, 'supports', 'maxSupportAlternatives', (entry) =>
    readCondition(parser, entry, subject, false));
  if (supports?.length === 0) {
    fail('supports must list at least one alternative');
    valid = false;
  }
  const artifacts = readEach(parser, record.artifacts, subject, code, 'artifacts', 'maxArtifactsPerOwner', (entry) =>
    readArtifact(parser, entry, owner, space));
  const assets = readEach(parser, record.assets, subject, code, 'assets', 'maxAssetsPerOwner', (entry) =>
    readAsset(parser, entry, owner));
  const checks = readEach(parser, record.checks, subject, code, 'checks', 'maxChecksPerPlugin', (entry) =>
    readCheck(parser, entry, owner));
  const recipes = readEach(parser, record.recipes, subject, code, 'recipes', 'maxRecipesPerPlugin', (entry) =>
    readRecipe(parser, entry, owner));
  if (!valid || !supports || !artifacts || !assets || !checks || !recipes) return undefined;
  return {
    owner,
    category: category as PluginCategory,
    id,
    apiVersion: record.apiVersion as number,
    contentVersion: record.contentVersion as number,
    hostPlatforms: [...(hosts as string[])].sort(compareText),
    supports,
    artifacts,
    assets,
    sharedAssets: [...(shared as string[])],
    checks,
    recipes
  };
}

function readManaged(parser: Parser, value: unknown): { logicalName: string; pathParts: string[] } | undefined {
  const code: PluginIssueCode = 'invalid-registry-input';
  const record = readRecord(parser, value, 'core.managedCore', code, ['logicalName', 'pathParts']);
  if (record === undefined) return undefined;
  const validName = typeof record.logicalName === 'string' && kebabPattern.test(record.logicalName);
  if (!validName) {
    parser.issues.add(code, 'core.managedCore', `managed-core logical name ${display(record.logicalName)} must be kebab case`);
  }
  const pathParts = readPath(parser, record.pathParts, 'core.managedCore', code, false);
  return validName && pathParts !== undefined ? { logicalName: record.logicalName as string, pathParts } : undefined;
}

function readCore(parser: Parser, value: unknown, space: SpaceModel): CoreModel | undefined {
  const code: PluginIssueCode = 'invalid-registry-input';
  const record = readRecord(parser, value, 'core', code, ['artifacts', 'managedCore', 'retiredLogicalNames', 'sharedAssets']);
  if (record === undefined) return undefined;
  const artifacts = readEach(parser, record.artifacts, 'core', code, 'artifacts', 'maxArtifactsPerOwner', (entry) =>
    readArtifact(parser, entry, coreOwner, space));
  const sharedAssets = readEach(parser, record.sharedAssets, 'core', code, 'sharedAssets', 'maxAssetsPerOwner', (entry) =>
    readAsset(parser, entry, coreOwner));
  const managed = readEach(parser, record.managedCore, 'core', code, 'managedCore', 'maxArtifacts', (entry) =>
    readManaged(parser, entry));
  const retiredNames = readList(parser, record.retiredLogicalNames, 'core', code, 'retiredLogicalNames', 'maxArtifacts');
  let valid = artifacts !== undefined && sharedAssets !== undefined && managed !== undefined && retiredNames !== undefined;
  const managedCore = new Map<string, readonly string[]>();
  for (const entry of managed ?? []) {
    if (managedCore.has(entry.logicalName)) {
      parser.issues.add(code, 'core', `managed-core identity ${entry.logicalName} is listed more than once`);
      valid = false;
    }
    managedCore.set(entry.logicalName, entry.pathParts);
  }
  const retired = new Set<string>();
  for (const name of retiredNames ?? []) {
    if (typeof name !== 'string' || !kebabPattern.test(name) || retired.has(name)) {
      parser.issues.add(code, 'core', `retired logical name ${display(name)} must be a distinct kebab-case name`);
      valid = false;
      continue;
    }
    retired.add(name);
  }
  if (!valid) return undefined;
  return { artifacts: artifacts as ArtifactModel[], sharedAssets: sharedAssets as AssetModel[], managedCore, retired };
}

function readReleaseAssets(parser: Parser, value: unknown, subject: string): Map<string, ReleaseAssetModel> | undefined {
  const code: PluginIssueCode = 'invalid-registry-input';
  const list = readList(parser, value, subject, code, 'assets', 'maxAssetsPerOwner');
  if (list === undefined) return undefined;
  const assets = new Map<string, ReleaseAssetModel>();
  let valid = true;
  for (const entry of list) {
    const record = readRecord(parser, entry, subject, code, ['id', 'pathParts', 'sha256']);
    const pathParts = record && readPath(parser, record.pathParts, subject, code, true);
    if (record === undefined || pathParts === undefined) {
      valid = false;
      continue;
    }
    if (!isIdentifier(record.id, parser.limits) || typeof record.sha256 !== 'string' ||
        !digestPattern.test(record.sha256) || assets.has(record.id)) {
      parser.issues.add(code, subject, `release asset ${display(record.id)} requires a distinct identifier and a sha256 digest`);
      valid = false;
      continue;
    }
    assets.set(record.id, { id: record.id, pathParts, sha256: record.sha256 });
  }
  return valid ? assets : undefined;
}

function readRelease(parser: Parser, value: unknown): ReleaseModel | undefined {
  const code: PluginIssueCode = 'invalid-registry-input';
  const record = readRecord(parser, value, 'release', code, ['plugins', 'schemaVersion', 'sharedAssets']);
  if (record === undefined) return undefined;
  let valid = record.schemaVersion === 1;
  if (!valid) parser.issues.add(code, 'release', `release inventory schemaVersion ${display(record.schemaVersion)} is not 1`);
  const sharedAssets = readReleaseAssets(parser, record.sharedAssets, 'release:core');
  const entries = readList(parser, record.plugins, 'release', code, 'plugins', 'maxDescriptors');
  const plugins = new Map<string, PluginReleaseModel>();
  for (const entry of entries ?? []) {
    const plugin = readRecord(parser, entry, 'release', code, [
      'apiVersion',
      'assets',
      'category',
      'contentDigest',
      'contentVersion',
      'id'
    ]);
    if (plugin === undefined) {
      valid = false;
      continue;
    }
    const subject = `release:plugin:${label(plugin.category)}:${label(plugin.id)}`;
    const assets = readReleaseAssets(parser, plugin.assets, subject);
    if (typeof plugin.id !== 'string' || typeof plugin.category !== 'string' ||
        typeof plugin.apiVersion !== 'number' || typeof plugin.contentVersion !== 'number' ||
        typeof plugin.contentDigest !== 'string' || !digestPattern.test(plugin.contentDigest) ||
        assets === undefined || plugins.has(plugin.id)) {
      parser.issues.add(code, subject, 'plugin release records require a distinct identity, numeric versions, a sha256 content digest and asset records');
      valid = false;
      continue;
    }
    plugins.set(plugin.id, {
      category: plugin.category,
      id: plugin.id,
      apiVersion: plugin.apiVersion,
      contentVersion: plugin.contentVersion,
      contentDigest: plugin.contentDigest,
      assets
    });
  }
  return valid && sharedAssets !== undefined && entries !== undefined ? { sharedAssets, plugins } : undefined;
}

function readBytes(parser: Parser, value: unknown): BytesModel[] | undefined {
  const code: PluginIssueCode = 'invalid-registry-input';
  const list = readList(parser, value, 'assets', code, 'assets');
  if (list === undefined) return undefined;
  const entries: BytesModel[] = [];
  const keys = new Set<string>();
  let valid = true;
  for (const entry of list) {
    const record = readRecord(parser, entry, 'assets', code, ['bytes', 'pathParts']);
    const pathParts = record && readPath(parser, record.pathParts, 'assets', code, true);
    if (record === undefined || pathParts === undefined) {
      valid = false;
      continue;
    }
    const key = aliasKey(pathParts);
    if (!(record.bytes instanceof Uint8Array) || keys.has(key)) {
      parser.issues.add(code, `asset-path:${key}`, 'asset bytes require exactly one Uint8Array per distinct location');
      valid = false;
      continue;
    }
    keys.add(key);
    entries.push({ pathParts, exact: pathParts.join('/'), bytes: record.bytes });
  }
  return valid ? entries : undefined;
}

function readShape(parser: Parser, input: unknown): Shape {
  const code: PluginIssueCode = 'invalid-registry-input';
  const record = readRecord(parser, input, 'input', code, [
    'assets',
    'core',
    'descriptors',
    'operations',
    'release',
    'selectionSpace'
  ], ['limits']);
  if (record === undefined) throw parser.issues.failure('registry');
  const space = readSpace(parser, record.selectionSpace);
  const operations = readOperations(parser, record.operations);
  if (space === undefined || operations === undefined) throw parser.issues.failure('registry');
  const descriptorList = readList(parser, record.descriptors, 'input', code, 'descriptors', 'maxDescriptors');
  const descriptors = (descriptorList ?? []).map((entry) => readDescriptor(parser, entry, space));
  const core = readCore(parser, record.core, space);
  const release = readRelease(parser, record.release);
  const bytes = readBytes(parser, record.assets);
  const artifactCount = descriptors.reduce((total, descriptor) => total + (descriptor?.artifacts.length ?? 0), 0) +
    (core?.artifacts.length ?? 0);
  if (artifactCount > parser.limits.maxArtifacts) limitIssue(parser.issues, 'maxArtifacts', parser.limits);
  parser.issues.throwIfAny('registry');
  return {
    descriptors: descriptors as DescriptorModel[],
    core: core as CoreModel,
    space,
    operations,
    release: release as ReleaseModel,
    bytes: bytes as BytesModel[]
  };
}

function resolveLimits(input: unknown): PluginRegistryLimits {
  const issues = new Issues();
  const parser: Parser = { issues, limits: pluginRegistryLimits };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    issues.add('invalid-registry-input', 'input', 'registry input must be a plain object');
    throw issues.failure('registry');
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, 'limits');
  if (descriptor === undefined) return pluginRegistryLimits;
  const value = 'value' in descriptor
    ? intake(descriptor.value, { limits: pluginRegistryLimits, issues, code: () => 'invalid-registry-input' })
    : undefined;
  issues.throwIfAny('registry');
  const record = readRecord(parser, value, 'limits', 'invalid-registry-input', [], limitNames);
  if (record === undefined) throw issues.failure('registry');
  const limits: Record<string, number> = { ...pluginRegistryLimits };
  for (const name of limitNames) {
    if (!(name in record)) continue;
    const bound = record[name];
    if (!isPositiveInteger(bound) || bound > pluginRegistryLimits[name]) {
      issues.add('invalid-registry-input', `limits.${name}`, `limits may only lower the default bound of ${pluginRegistryLimits[name]}`);
      continue;
    }
    limits[name] = bound;
  }
  issues.throwIfAny('registry');
  return Object.freeze(limits) as unknown as PluginRegistryLimits;
}

// ---------------------------------------------------------------------------------------------
// Semantic validation: identities, conditions, lifecycles, assets, release records, operations.
// ---------------------------------------------------------------------------------------------

interface Registered {
  readonly plugins: readonly DescriptorModel[];
  readonly byId: ReadonlyMap<string, DescriptorModel>;
  readonly idsByCategory: ReadonlyMap<PluginCategory, ReadonlySet<string>>;
  readonly ambiguous: ReadonlySet<string>;
  readonly knownIds: ReadonlySet<string>;
}

interface Semantics {
  readonly issues: Issues;
  readonly limits: PluginRegistryLimits;
  readonly space: SpaceModel;
  readonly registered: Registered;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(key(value));
    if (group === undefined) groups.set(key(value), [value]);
    else group.push(value);
  }
  return groups;
}

function registerPlugins(descriptors: readonly DescriptorModel[], issues: Issues): Registered {
  const byId = new Map<string, DescriptorModel>();
  const ambiguous = new Set<string>();
  for (const [id, group] of groupBy(descriptors, (descriptor) => descriptor.id)) {
    if (group.length === 1) {
      byId.set(id, group[0]);
      continue;
    }
    ambiguous.add(id);
    const categories = group.map((descriptor) => descriptor.category).sort(compareText).join(', ');
    issues.add('duplicate-plugin-id', `plugin-id:${id}`, `declared by ${group.length} descriptors (${categories}); plugin ids are unique across categories`);
  }
  const plugins = sortBy([...byId.values()], (plugin) => [plugin.owner.rank, plugin.id]);
  const idsByCategory = new Map<PluginCategory, Set<string>>(pluginCategories.map((category) => [category, new Set<string>()]));
  for (const plugin of plugins) (idsByCategory.get(plugin.category) as Set<string>).add(plugin.id);
  for (const [category, ids] of idsByCategory) {
    if (ids.size === 0) issues.add('missing-category', `category:${category}`, `no registered ${category} plugin; every selection requires one`);
  }
  for (const plugin of plugins) {
    const subject = plugin.owner.key;
    if (!supportedPluginApiVersions.includes(plugin.apiVersion)) {
      issues.add('incompatible-api-version', subject, `plugin API version ${plugin.apiVersion} is not supported; this release accepts ${supportedPluginApiVersions.join(', ')}`);
    }
    if (!isPositiveInteger(plugin.contentVersion)) {
      issues.add('invalid-content-version', subject, `contentVersion ${plugin.contentVersion} must be a positive safe integer`);
    }
    const unqualified = plugin.hostPlatforms.filter((host) => !hostSet.has(host));
    if (unqualified.length > 0) {
      issues.add('unsupported-host-platform', subject, `host platforms ${unqualified.join(', ')} are not qualified; supported: ${sortedHosts.join(', ')}`);
    }
  }
  return {
    plugins,
    byId,
    idsByCategory,
    ambiguous,
    knownIds: new Set(descriptors.map((descriptor) => descriptor.id))
  };
}

function conditionValueKnown(dimension: Dimension, value: string, semantics: Semantics): boolean {
  switch (dimension) {
    case 'workload':
      return semantics.space.workloads.has(value);
    case 'variant':
      return semantics.space.variantWorkload.has(value);
    case 'frontend':
      return frontendSet.has(value);
    case 'governanceProfile':
      return semantics.space.profileSet.has(value);
    case 'environment':
      return semantics.space.environmentSet.has(value);
    default:
      return semantics.registered.ambiguous.has(value) ||
        (semantics.registered.idsByCategory.get(dimension) as ReadonlySet<string>).has(value);
  }
}

function checkCondition(condition: ConditionModel, subject: string, semantics: Semantics): void {
  for (const [dimension, values] of condition.sets) {
    for (const value of values) {
      if (!conditionValueKnown(dimension, value, semantics)) {
        semantics.issues.add('invalid-condition', subject, `${dimension} value ${JSON.stringify(value)} is not a registered choice`);
      }
    }
  }
  const workloads = condition.sets.get('workload');
  for (const variant of condition.values.variant ?? []) {
    const workload = semantics.space.variantWorkload.get(variant);
    if (workloads !== undefined && workload !== undefined && !workloads.has(workload)) {
      semantics.issues.add('invalid-condition', subject, `variant ${variant} does not belong to the listed workloads`);
    }
  }
}

function checkConditions(core: CoreModel, semantics: Semantics): void {
  for (const artifact of core.artifacts) checkCondition(artifact.when, artifact.subject, semantics);
  for (const plugin of semantics.registered.plugins) {
    for (const alternative of plugin.supports) checkCondition(alternative, plugin.owner.key, semantics);
    if (new Set(plugin.supports.map((alternative) => alternative.key)).size !== plugin.supports.length) {
      semantics.issues.add('invalid-condition', plugin.owner.key, 'support alternatives must be distinct');
    }
    for (const declaration of [...plugin.artifacts, ...plugin.checks, ...plugin.recipes]) {
      checkCondition(declaration.when, declaration.subject, semantics);
    }
  }
}

function checkLifecycles(artifacts: readonly ArtifactModel[], core: CoreModel, issues: Issues): void {
  const declared = new Set<string>();
  for (const artifact of artifacts) {
    const subject = `artifact:${artifact.logicalName}`;
    const expected = core.managedCore.get(artifact.logicalName);
    if (artifact.lifecycle === 'managed-core') {
      declared.add(artifact.logicalName);
      if (expected === undefined || !samePath(expected, artifact.pathParts)) {
        issues.add('unregistered-managed-core', subject, `${artifact.owner.key} declares managed-core ${artifact.pathParts.join('/')} outside the exact core managed-core inventory`);
      }
    } else if (expected !== undefined) {
      issues.add('unregistered-managed-core', subject, `${artifact.owner.key} declares managed-core identity ${artifact.logicalName} with lifecycle ${artifact.lifecycle}`);
    }
    if (core.retired.has(artifact.logicalName)) {
      issues.add('retired-logical-name', subject, `${artifact.owner.key} reuses a retired logical name`);
    }
  }
  for (const logicalName of core.managedCore.keys()) {
    if (!declared.has(logicalName)) {
      issues.add('unregistered-managed-core', `artifact:${logicalName}`, 'the core managed-core inventory identity is not declared by any contribution');
    }
    if (core.retired.has(logicalName)) {
      issues.add('retired-logical-name', `managed-core:${logicalName}`, 'the core managed-core inventory lists a retired logical name');
    }
  }
}

function decodeExact(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return undefined;
  }
  const encoded = encoder.encode(text);
  return encoded.length === bytes.length && encoded.every((byte, index) => byte === bytes[index]) ? text : undefined;
}

function assetKey(owner: Owner, id: string): string {
  return `${owner.key}\u0000${id}`;
}

interface VerifiedAssets {
  readonly texts: ReadonlyMap<string, string>;
  readonly digests: ReadonlyMap<string, Sha256Digest>;
}

function checkAssets(
  core: CoreModel,
  plugins: readonly DescriptorModel[],
  allDescriptors: readonly DescriptorModel[],
  bytes: readonly BytesModel[],
  issues: Issues
): VerifiedAssets {
  const assets = [...core.sharedAssets, ...plugins.flatMap((plugin) => plugin.assets)];
  for (const [, group] of groupBy(assets, (asset) => assetKey(asset.owner, asset.id))) {
    if (group.length > 1) issues.add('duplicate-asset-id', group[0].subject, 'the asset id is declared more than once by its owner');
  }
  const byKey = groupBy(assets, (asset) => asset.key);
  const identity = (asset: AssetModel): string => `${asset.owner.key}:${asset.id}`;
  for (const [key, group] of byKey) {
    if (group.length > 1) {
      issues.add('asset-location-conflict', `asset-path:${key}`, `claimed by ${group.map(identity).sort(compareText).join(', ')}`);
    }
  }
  for (const asset of assets) {
    for (let length = 1; length < asset.pathParts.length; length += 1) {
      const prefix = aliasKey(asset.pathParts.slice(0, length));
      for (const file of byKey.get(prefix) ?? []) {
        issues.add('asset-location-conflict', `asset-path:${prefix}`, `${identity(file)} is a file where ${identity(asset)} requires a directory`);
      }
    }
  }
  const sharedIds = new Set(core.sharedAssets.map((asset) => asset.id));
  for (const plugin of plugins) {
    const seen = new Set<string>();
    for (const reference of plugin.sharedAssets) {
      if (!sharedIds.has(reference)) {
        issues.add('unknown-shared-asset', plugin.owner.key, `shared asset ${JSON.stringify(reference)} is not a core shared asset`);
      } else if (seen.has(reference)) {
        issues.add('unknown-shared-asset', plugin.owner.key, `shared asset ${reference} is referenced more than once`);
      }
      seen.add(reference);
    }
  }
  const declaredPaths = new Set([
    ...assets,
    ...allDescriptors.flatMap((descriptor) => descriptor.assets)
  ].map((asset) => asset.pathParts.join('/')));
  const bytesByPath = new Map(bytes.map((entry) => [entry.exact, entry]));
  for (const entry of bytes) {
    if (!declaredPaths.has(entry.exact)) {
      issues.add('undeclared-asset', `asset-path:${entry.exact}`, 'bytes were supplied for a location that no asset identity declares');
    }
  }
  const texts = new Map<string, string>();
  const digests = new Map<string, Sha256Digest>();
  for (const asset of assets) {
    const entry = bytesByPath.get(asset.pathParts.join('/'));
    if (entry === undefined) {
      issues.add('missing-asset', asset.subject, `no bytes were supplied for ${asset.pathParts.join('/')}`);
      continue;
    }
    const text = decodeExact(entry.bytes);
    if (text === undefined) {
      issues.add('invalid-asset-encoding', asset.subject, 'asset bytes are not exactly round-trippable UTF-8');
      continue;
    }
    texts.set(assetKey(asset.owner, asset.id), text);
    digests.set(assetKey(asset.owner, asset.id), bytesDigest(entry.bytes));
  }
  return { texts, digests };
}

function checkReleaseAsset(
  asset: AssetModel,
  record: ReleaseAssetModel | undefined,
  digests: ReadonlyMap<string, Sha256Digest>,
  issues: Issues
): void {
  const subject = `release-asset:${asset.owner.key}:${asset.id}`;
  if (record === undefined) {
    issues.add('missing-release-record', subject, 'no release asset record exists for this asset identity');
    return;
  }
  if (!samePath(record.pathParts, asset.pathParts)) {
    issues.add('release-record-mismatch', subject, `release location ${record.pathParts.join('/')} differs from declared ${asset.pathParts.join('/')}`);
  }
  const actual = digests.get(assetKey(asset.owner, asset.id));
  if (actual !== undefined && actual !== record.sha256) {
    issues.add('digest-mismatch', subject, `release sha256 ${record.sha256} does not match the packaged bytes ${actual}`);
  }
}

function checkRelease(
  core: CoreModel,
  registered: Registered,
  release: ReleaseModel,
  digests: ReadonlyMap<string, Sha256Digest>,
  issues: Issues
): void {
  const sharedIds = new Set(core.sharedAssets.map((asset) => asset.id));
  for (const asset of core.sharedAssets) checkReleaseAsset(asset, release.sharedAssets.get(asset.id), digests, issues);
  for (const id of release.sharedAssets.keys()) {
    if (!sharedIds.has(id)) issues.add('unexpected-release-record', `release-asset:core:${id}`, 'the release inventory lists a shared asset that no core declaration owns');
  }
  for (const plugin of registered.plugins) {
    const subject = `release:${plugin.owner.key}`;
    const record = release.plugins.get(plugin.id);
    if (record === undefined) {
      issues.add('missing-release-record', subject, 'no release inventory record exists for this plugin');
      continue;
    }
    const fields = [
      record.category === plugin.category ? '' : 'category',
      record.apiVersion === plugin.apiVersion ? '' : 'apiVersion',
      record.contentVersion === plugin.contentVersion ? '' : 'contentVersion'
    ].filter((field) => field !== '');
    if (fields.length > 0) issues.add('release-record-mismatch', subject, `the release record differs in ${fields.join(', ')}`);
    const declared = new Set(plugin.assets.map((asset) => asset.id));
    const missing = [...declared].filter((id) => !record.assets.has(id)).sort(compareText);
    const unexpected = [...record.assets.keys()].filter((id) => !declared.has(id)).sort(compareText);
    if (missing.length > 0 || unexpected.length > 0) {
      issues.add('release-record-mismatch', subject, `release asset identities differ (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`);
    }
    for (const asset of plugin.assets) {
      const assetRecord = record.assets.get(asset.id);
      if (assetRecord !== undefined) checkReleaseAsset(asset, assetRecord, digests, issues);
    }
  }
  for (const [id, record] of release.plugins) {
    if (!registered.knownIds.has(id)) {
      issues.add('unexpected-release-record', `release:plugin:${record.category}:${id}`, 'the release inventory lists a plugin that no descriptor declares');
    }
  }
}

function checkOperations(
  plugins: readonly DescriptorModel[],
  operations: ReadonlyMap<string, OperationModel>,
  issues: Issues
): void {
  for (const plugin of plugins) {
    const checkIds = new Set<string>();
    for (const check of plugin.checks) {
      if (checkIds.has(check.id)) issues.add('invalid-check', check.subject, 'the check id is declared more than once by this plugin');
      checkIds.add(check.id);
      const operation = operations.get(check.operation);
      if (operation === undefined) {
        issues.add('unknown-operation', check.subject, `operation ${check.operation} is not a core operation`);
        continue;
      }
      const unpermitted = check.effects.filter((effect) => !operation.effects.has(effect));
      if (unpermitted.length > 0) {
        issues.add('unpermitted-effect', check.subject, `operation ${operation.id} does not permit ${unpermitted.join(', ')}`);
      }
    }
    const recipeKeys = new Set<string>();
    for (const recipe of plugin.recipes) {
      const identity = `${recipe.id}@${recipe.version}`;
      if (recipeKeys.has(`${recipe.operation}:${identity}`)) {
        issues.add('invalid-recipe', recipe.subject, 'the recipe reference is declared more than once by this plugin');
      }
      recipeKeys.add(`${recipe.operation}:${identity}`);
      const operation = operations.get(recipe.operation);
      if (operation === undefined) {
        issues.add('unknown-operation', recipe.subject, `operation ${recipe.operation} is not a core operation`);
      } else if (!operation.recipes.has(identity)) {
        issues.add('unknown-recipe', recipe.subject, `operation ${operation.id} offers no recipe ${identity}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Canonical outputs and digests. Only packaged asset locations are excluded from content identity.
// ---------------------------------------------------------------------------------------------

/** An inventory entry may be passed directly: its recorded contentDigest is ignored and recomputed. */
export type PluginContentInput = Omit<PluginInventoryEntry, 'contentDigest'> & { readonly contentDigest?: Sha256Digest };

function normalizeCondition(condition: PluginCondition): PluginCondition {
  const output: Record<string, string[]> = {};
  for (const dimension of allDimensions) {
    const values = (condition as Values)[dimension];
    if (values !== undefined) output[dimension] = [...values].sort(compareText);
  }
  return output as PluginCondition;
}

function whenField(when: PluginCondition | undefined): { readonly when?: PluginCondition } {
  const normalized = normalizeCondition(when ?? {});
  return Object.keys(normalized).length === 0 ? {} : { when: normalized };
}

function conditionKey(when: PluginCondition | undefined): string {
  return canonicalJson(normalizeCondition(when ?? {}));
}

function normalizeArtifact(artifact: ArtifactDeclaration): ArtifactDeclaration {
  return {
    logicalName: artifact.logicalName,
    category: artifact.category,
    pathParts: [...artifact.pathParts],
    lifecycle: artifact.lifecycle,
    ...(artifact.provisioningGroup === undefined ? {} : { provisioningGroup: artifact.provisioningGroup }),
    ...whenField(artifact.when)
  };
}

function sortArtifacts(artifacts: readonly ArtifactDeclaration[]): ArtifactDeclaration[] {
  return sortBy(artifacts.map(normalizeArtifact), (artifact) => [
    artifact.logicalName,
    aliasKey(artifact.pathParts),
    conditionKey(artifact.when)
  ]);
}

function canonicalContent(entry: PluginContentInput): PluginContentInput {
  return {
    category: entry.category,
    id: entry.id,
    apiVersion: entry.apiVersion,
    contentVersion: entry.contentVersion,
    hostPlatforms: [...entry.hostPlatforms].sort(compareText),
    supports: sortBy(entry.supports.map((alternative) => normalizeCondition(alternative)), (alternative) => [
      canonicalJson(alternative)
    ]),
    artifacts: sortArtifacts(entry.artifacts),
    assets: sortBy(entry.assets.map(({ id, sha256 }) => ({ id, sha256 })), (asset) => [asset.id]),
    sharedAssets: sortBy(entry.sharedAssets.map(({ id, sha256 }) => ({ id, sha256 })), (asset) => [asset.id]),
    checks: sortBy(entry.checks.map((check) => ({
      id: check.id,
      version: check.version,
      operation: check.operation,
      effects: [...check.effects].sort(compareText),
      ...whenField(check.when)
    })), (check) => [check.id, check.version]),
    recipes: sortBy(entry.recipes.map((recipe) => ({
      operation: recipe.operation,
      id: recipe.id,
      version: recipe.version,
      ...whenField(recipe.when)
    })), (recipe) => [recipe.operation, recipe.id, recipe.version, conditionKey(recipe.when)])
  };
}

/** Digest of canonical content; internal callers pass registry-validated models only. */
function contentDigestOf(entry: PluginContentInput): Sha256Digest {
  return digestOf({ kind: 'liftoff-plugin-content', schemaVersion: 1, ...canonicalContent(entry) });
}

const contentFields = [
  'apiVersion',
  'artifacts',
  'assets',
  'category',
  'checks',
  'contentVersion',
  'hostPlatforms',
  'id',
  'recipes',
  'sharedAssets',
  'supports'
];

function hasFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is RawRecord {
  return isRecord(value) &&
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function isListOf(value: unknown, entry: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(entry);
}

function isConditionShape(value: unknown, dimensions: readonly string[]): boolean {
  return isRecord(value) && Object.keys(value).every((key) => dimensions.includes(key) && isStringList(value[key]));
}

function hasConditionShape(value: RawRecord): boolean {
  return !('when' in value) || isConditionShape(value.when, allDimensions);
}

function isAssetDigestShape(value: unknown): boolean {
  return hasFields(value, ['id', 'sha256']) && typeof value.id === 'string' && typeof value.sha256 === 'string';
}

const contentShape: Readonly<Record<string, (value: unknown) => boolean>> = {
  apiVersion: (value) => typeof value === 'number',
  artifacts: (value) => isListOf(value, (item) =>
    hasFields(item, ['category', 'lifecycle', 'logicalName', 'pathParts'], ['provisioningGroup', 'when']) &&
    typeof item.category === 'string' &&
    typeof item.lifecycle === 'string' &&
    typeof item.logicalName === 'string' &&
    isStringList(item.pathParts) &&
    (!('provisioningGroup' in item) || typeof item.provisioningGroup === 'string') &&
    hasConditionShape(item)),
  assets: (value) => isListOf(value, isAssetDigestShape),
  category: (value) => typeof value === 'string',
  checks: (value) => isListOf(value, (item) =>
    hasFields(item, ['effects', 'id', 'operation', 'version'], ['when']) &&
    typeof item.id === 'string' &&
    typeof item.operation === 'string' &&
    typeof item.version === 'number' &&
    isStringList(item.effects) &&
    hasConditionShape(item)),
  contentVersion: (value) => typeof value === 'number',
  hostPlatforms: isStringList,
  id: (value) => typeof value === 'string',
  recipes: (value) => isListOf(value, (item) =>
    hasFields(item, ['id', 'operation', 'version'], ['when']) &&
    typeof item.id === 'string' &&
    typeof item.operation === 'string' &&
    typeof item.version === 'number' &&
    hasConditionShape(item)),
  sharedAssets: (value) => isListOf(value, isAssetDigestShape),
  supports: (value) => isListOf(value, (item) => isConditionShape(item, scalarDimensions))
};

/**
 * Structural intake for public digest computation: the same bounded plain-data walk as the registry,
 * then exact field shapes. Semantic validity is established only by createPluginRegistry.
 */
function readContentInput(value: unknown): PluginContentInput {
  const issues = new Issues();
  const parser: Parser = { issues, limits: pluginRegistryLimits };
  const plain = intake(value, { limits: pluginRegistryLimits, issues, code: () => 'invalid-descriptor' });
  issues.throwIfAny('registry');
  const record = readRecord(parser, plain, 'content', 'invalid-descriptor', contentFields, ['contentDigest']);
  if (record === undefined) throw issues.failure('registry');
  const subject = `content:${label(record.category)}:${label(record.id)}`;
  for (const field of contentFields) {
    if (!contentShape[field](record[field])) issues.add('invalid-descriptor', subject, `${field} is not well-formed plugin content`);
  }
  if ('contentDigest' in record && typeof record.contentDigest !== 'string') {
    issues.add('invalid-descriptor', subject, 'contentDigest must be a string when present');
  }
  issues.throwIfAny('registry');
  return record as unknown as PluginContentInput;
}

/**
 * Location-independent identity over every behavior-bearing descriptor field and asset content.
 * Input is validated structurally first; a recorded contentDigest field is ignored and recomputed.
 */
export function pluginContentDigest(entry: PluginContentInput): Sha256Digest {
  return runStage('registry', () => contentDigestOf(readContentInput(entry)));
}

function declarationOf(artifact: ArtifactModel): ArtifactDeclaration {
  return {
    logicalName: artifact.logicalName,
    category: artifact.category,
    pathParts: [...artifact.pathParts],
    lifecycle: artifact.lifecycle,
    ...(artifact.provisioningGroup === undefined ? {} : { provisioningGroup: artifact.provisioningGroup }),
    when: artifact.when.values as PluginCondition
  };
}

function contentInputOf(
  plugin: DescriptorModel,
  digests: ReadonlyMap<string, Sha256Digest>
): PluginContentInput | undefined {
  const assets = plugin.assets.map((asset) => ({ id: asset.id, sha256: digests.get(assetKey(asset.owner, asset.id)) }));
  const sharedAssets = plugin.sharedAssets.map((id) => ({ id, sha256: digests.get(assetKey(coreOwner, id)) }));
  if ([...assets, ...sharedAssets].some((asset) => asset.sha256 === undefined)) return undefined;
  return {
    category: plugin.category,
    id: plugin.id,
    apiVersion: plugin.apiVersion,
    contentVersion: plugin.contentVersion,
    hostPlatforms: plugin.hostPlatforms as SupportedHostPlatform[],
    supports: plugin.supports.map((alternative) => alternative.values as PluginSupportCondition),
    artifacts: plugin.artifacts.map(declarationOf),
    assets: assets as AssetDigest[],
    sharedAssets: sharedAssets as AssetDigest[],
    checks: plugin.checks.map((check) => ({
      id: check.id,
      version: check.version,
      operation: check.operation,
      effects: [...check.effects],
      when: check.when.values as PluginCondition
    })),
    recipes: plugin.recipes.map((recipe) => ({
      operation: recipe.operation,
      id: recipe.id,
      version: recipe.version,
      when: recipe.when.values as PluginCondition
    }))
  };
}

function checkContentDigests(
  registered: Registered,
  release: ReleaseModel,
  digests: ReadonlyMap<string, Sha256Digest>,
  issues: Issues
): void {
  for (const plugin of registered.plugins) {
    const input = contentInputOf(plugin, digests);
    const record = release.plugins.get(plugin.id);
    if (input === undefined || record === undefined) continue;
    const digest = contentDigestOf(input);
    if (record.contentDigest !== digest) {
      issues.add('digest-mismatch', `release:${plugin.owner.key}`, `release contentDigest ${record.contentDigest} does not match the computed ${digest}`);
    }
  }
}

function sharedAssetDigests(core: CoreModel, digests: ReadonlyMap<string, Sha256Digest>): AssetDigest[] {
  return sortBy(core.sharedAssets.map((asset) => ({
    id: asset.id,
    sha256: digests.get(assetKey(coreOwner, asset.id)) as Sha256Digest
  })), (asset) => [asset.id]);
}

function coreContributionRecord(core: CoreModel, sharedAssets: readonly AssetDigest[]): unknown {
  return {
    kind: 'liftoff-core-contribution',
    schemaVersion: 1,
    artifacts: sortArtifacts(core.artifacts.map(declarationOf)),
    sharedAssets,
    managedCore: sortBy([...core.managedCore].map(([logicalName, pathParts]) => ({
      logicalName,
      pathParts: [...pathParts]
    })), (entry) => [entry.logicalName]),
    retiredLogicalNames: [...core.retired].sort(compareText)
  };
}

// ---------------------------------------------------------------------------------------------
// Exact satisfiability over host-expanded selection contexts.
//
// A context fixes every scalar dimension and one qualified host platform. It is admitted only
// when the selected stack, cloud and workflow each list that host and have a support alternative
// matching the scalar values, and at least one agent does the same. Set conditions use positive
// membership and selections have no upper bound on selected agents or environments, so a query is
// satisfiable exactly when some admitted context meets its scalar intersections and every agent
// hitting set intersects that context's admitted agents. The union of one member per hitting set
// is then a concrete witness selection. Enumeration and work are bounded and fail closed.
// ---------------------------------------------------------------------------------------------

interface SelectionContext {
  readonly scalar: Readonly<Record<ScalarDimension, string | undefined>>;
  readonly host: SupportedHostPlatform;
  readonly admitted: ReadonlySet<string>;
  readonly admittedSorted: readonly string[];
}

interface Query {
  readonly scalar: ReadonlyMap<string, ReadonlySet<string>>;
  readonly agentSets: readonly ReadonlySet<string>[];
  readonly environmentSets: readonly ReadonlySet<string>[];
  readonly empty: boolean;
}

interface Witness {
  readonly context: SelectionContext;
  readonly agents: readonly string[];
  readonly environments: readonly string[];
}

function matchesScalar(
  sets: ReadonlyMap<string, ReadonlySet<string>>,
  valueOf: (dimension: ScalarDimension) => string | undefined
): boolean {
  for (const dimension of scalarDimensions) {
    const allowed = sets.get(dimension);
    if (allowed === undefined) continue;
    const value = valueOf(dimension);
    if (value === undefined || !allowed.has(value)) return false;
  }
  return true;
}

function supportsAt(
  plugin: DescriptorModel,
  host: string,
  valueOf: (dimension: ScalarDimension) => string | undefined,
  budget: Budget
): boolean {
  if (!plugin.hostPlatforms.includes(host)) return false;
  return plugin.supports.some((alternative) => {
    budget.charge(1);
    return matchesScalar(alternative.sets, valueOf);
  });
}

function buildContexts(registered: Registered, space: SpaceModel, limits: PluginRegistryLimits, budget: Budget): SelectionContext[] {
  const of = (category: PluginCategory): DescriptorModel[] =>
    registered.plugins.filter((plugin) => plugin.category === category);
  const [stacks, clouds, workflows, agents] = pluginCategories.map(of);
  const pairs = [...space.workloads.keys()].sort(compareText).flatMap((workload) => {
    const variants = space.workloads.get(workload) as readonly string[];
    return variants.length === 0
      ? [{ workload, variant: undefined }]
      : variants.map((variant): { workload: string; variant: string | undefined } => ({ workload, variant }));
  });
  const candidates = pairs.length * stacks.length * clouds.length * workflows.length *
    frontendSelections.length * space.profiles.length * sortedHosts.length;
  if (candidates > limits.maxSelectionContexts) throw new LimitExceeded('maxSelectionContexts', limits);
  const contexts: SelectionContext[] = [];
  for (const pair of pairs) for (const stack of stacks) for (const cloud of clouds) for (const workflow of workflows) {
    for (const frontend of frontendSelections) for (const governanceProfile of space.profiles) for (const host of sortedHosts) {
      budget.charge(1);
      const scalar = {
        workload: pair.workload,
        variant: pair.variant,
        stack: stack.id,
        cloud: cloud.id,
        workflow: workflow.id,
        frontend,
        governanceProfile
      };
      const valueOf = (dimension: ScalarDimension): string | undefined => scalar[dimension];
      if (![stack, cloud, workflow].every((plugin) => supportsAt(plugin, host, valueOf, budget))) continue;
      const admittedSorted = agents.filter((agent) => supportsAt(agent, host, valueOf, budget)).map((agent) => agent.id);
      if (admittedSorted.length > 0) contexts.push({ scalar, host, admitted: new Set(admittedSorted), admittedSorted });
    }
  }
  return contexts;
}

function buildQuery(parts: readonly Pick<Declared, 'owner' | 'when'>[]): Query {
  const scalar = new Map<string, ReadonlySet<string>>();
  const agentSets: ReadonlySet<string>[] = [];
  const environmentSets: ReadonlySet<string>[] = [];
  let empty = false;
  const restrict = (dimension: ScalarDimension, allowed: ReadonlySet<string>): void => {
    const current = scalar.get(dimension);
    const next = current === undefined ? allowed : new Set([...current].filter((value) => allowed.has(value)));
    if (next.size === 0) empty = true;
    scalar.set(dimension, next);
  };
  for (const { owner, when } of parts) {
    if (owner.category === 'agent') agentSets.push(new Set([owner.id]));
    else if (owner.category !== undefined) restrict(owner.category, new Set([owner.id]));
    for (const dimension of scalarDimensions) {
      const allowed = when.sets.get(dimension);
      if (allowed !== undefined) restrict(dimension, allowed);
    }
    const agents = when.sets.get('agent');
    if (agents !== undefined) agentSets.push(agents);
    const environments = when.sets.get('environment');
    if (environments !== undefined) environmentSets.push(environments);
  }
  return { scalar, agentSets, environmentSets, empty };
}

function findWitness(query: Query, contexts: readonly SelectionContext[], space: SpaceModel, budget: Budget): Witness | undefined {
  if (query.empty) return undefined;
  for (const context of contexts) {
    budget.charge(1);
    if (!matchesScalar(query.scalar, (dimension) => context.scalar[dimension])) continue;
    const agents = query.agentSets.map((set) => [...set].sort(compareText).find((agent) => context.admitted.has(agent)));
    if (agents.some((agent) => agent === undefined)) continue;
    const environments = query.environmentSets.map((set) => [...set].sort(compareText)[0]);
    return {
      context,
      agents: [...new Set(agents.length === 0 ? [context.admittedSorted[0]] : (agents as string[]))].sort(compareText),
      environments: [...new Set(environments.length === 0 ? [space.environments[0]] : environments)].sort(compareText)
    };
  }
  return undefined;
}

function describeWitness(witness: Witness): string {
  const { scalar, host } = witness.context;
  return [
    `workload=${label(scalar.workload)}`,
    ...(scalar.variant === undefined ? [] : [`variant=${scalar.variant}`]),
    `stack=${label(scalar.stack)}`,
    `cloud=${label(scalar.cloud)}`,
    `workflow=${label(scalar.workflow)}`,
    `frontend=${label(scalar.frontend)}`,
    `governanceProfile=${label(scalar.governanceProfile)}`,
    `agents=${witness.agents.join(',')}`,
    `environments=${witness.environments.join(',')}`,
    `host=${host}`
  ].join(' ');
}

function describeArtifact(artifact: ArtifactModel): string {
  return `${artifact.logicalName} (${artifact.owner.key}, ${artifact.pathParts.join('/')})`;
}

function choose2(count: number): number {
  return (count * (count - 1)) / 2;
}

function eachPair<T>(values: readonly T[], visit: (first: T, second: T) => void): void {
  for (let first = 0; first < values.length; first += 1) {
    for (let second = first + 1; second < values.length; second += 1) visit(values[first], values[second]);
  }
}

function checkConflicts(
  artifacts: readonly ArtifactModel[],
  contexts: readonly SelectionContext[],
  semantics: Semantics,
  budget: Budget
): void {
  const byName = groupBy(artifacts, (artifact) => artifact.logicalName);
  const byKey = groupBy(artifacts, (artifact) => artifact.key);
  const prefixes = (artifact: ArtifactModel): string[] =>
    artifact.pathParts.slice(1).map((_, index) => aliasKey(artifact.pathParts.slice(0, index + 1)));
  let pairs = 0;
  for (const group of byName.values()) pairs += choose2(group.length);
  for (const group of byKey.values()) {
    pairs += choose2(group.length);
    for (const same of groupBy(group, (artifact) => artifact.logicalName).values()) pairs -= choose2(same.length);
  }
  for (const artifact of artifacts) {
    for (const prefix of prefixes(artifact)) pairs += byKey.get(prefix)?.length ?? 0;
  }
  if (pairs > semantics.limits.maxConflictPairs) throw new LimitExceeded('maxConflictPairs', semantics.limits);
  const report = (code: PluginIssueCode, subject: string, first: ArtifactModel, second: ArtifactModel, relation: string): void => {
    const witness = findWitness(buildQuery([first, second]), contexts, semantics.space, budget);
    if (witness !== undefined) {
      semantics.issues.add(code, subject, `${describeArtifact(first)} and ${describeArtifact(second)} ${relation} for ${describeWitness(witness)}`);
    }
  };
  for (const [logicalName, group] of byName) {
    eachPair(group, (first, second) => report('duplicate-logical-name', `artifact:${logicalName}`, first, second, 'can apply together'));
  }
  for (const [key, group] of byKey) {
    eachPair(group, (first, second) => {
      if (first.logicalName !== second.logicalName) {
        report('path-alias-collision', `path:${key}`, first, second, 'resolve to the same portable path');
      }
    });
  }
  for (const artifact of artifacts) {
    for (const prefix of prefixes(artifact)) {
      for (const file of byKey.get(prefix) ?? []) {
        report('path-prefix-collision', `path:${prefix}`, file, artifact, 'use one path as both a file and a directory');
      }
    }
  }
}

function checkSatisfiability(core: CoreModel, semantics: Semantics): void {
  const budget = new Budget(semantics.limits);
  const { registered, space, issues } = semantics;
  const contexts = buildContexts(registered, space, semantics.limits, budget);
  if (contexts.length === 0) {
    issues.add('no-supported-selection', 'registry', 'no stack, cloud, workflow and agent combination shares a supported host platform and matching support alternatives');
    return;
  }
  const live = new Set<string>();
  for (const plugin of registered.plugins) {
    if (findWitness(buildQuery([{ owner: plugin.owner, when: emptyCondition }]), contexts, space, budget) === undefined) {
      issues.add('unsatisfiable-condition', plugin.owner.key, 'the plugin cannot be selected in any supported combination on a common host platform');
    } else {
      live.add(plugin.owner.key);
    }
  }
  const isLive = (declaration: Declared): boolean =>
    declaration.owner.category === undefined || live.has(declaration.owner.key);
  const plugins = registered.plugins;
  const artifacts = sortBy([...core.artifacts, ...plugins.flatMap((plugin) => plugin.artifacts)].filter(isLive), (artifact) => [
    artifact.owner.rank,
    artifact.owner.id,
    artifact.logicalName,
    artifact.key,
    artifact.when.key
  ]);
  const applicable: ArtifactModel[] = [];
  for (const artifact of artifacts) {
    if (findWitness(buildQuery([artifact]), contexts, space, budget) === undefined) {
      issues.add('unsatisfiable-condition', artifact.subject, 'the artifact condition can never apply to a supported selection');
    } else {
      applicable.push(artifact);
    }
  }
  for (const declaration of plugins.flatMap((plugin) => [...plugin.checks, ...plugin.recipes]).filter(isLive)) {
    if (findWitness(buildQuery([declaration]), contexts, space, budget) === undefined) {
      issues.add('unsatisfiable-condition', declaration.subject, 'the declaration condition can never apply to a supported selection');
    }
  }
  checkConflicts(applicable, contexts, semantics, budget);
}

// ---------------------------------------------------------------------------------------------
// Resolution, composition verification and registry assembly.
// ---------------------------------------------------------------------------------------------

interface RegistryState {
  readonly limits: PluginRegistryLimits;
  readonly space: SpaceModel;
  readonly registered: Registered;
  readonly core: CoreModel;
  readonly operations: ReadonlyMap<string, OperationModel>;
  readonly entries: ReadonlyMap<string, PluginInventoryEntry>;
  readonly sharedAssets: readonly AssetDigest[];
  readonly texts: ReadonlyMap<string, PluginAssetTexts>;
}

interface ConcreteSelection {
  readonly scalar: Readonly<Record<ScalarDimension, string | undefined>>;
  readonly agents: readonly string[];
  readonly environments: readonly string[];
}

const selectionFields = ['agents', 'cloud', 'environments', 'frontend', 'governanceProfile', 'stack', 'workflow', 'workload'];
const resolutionFields = ['artifacts', 'checks', 'digest', 'operations', 'plugins', 'recipes', 'sharedAssets'];
const renderedFields = ['category', 'content', 'lifecycle', 'logicalName', 'pathParts'];

function appliesTo(condition: ConditionModel, selection: ConcreteSelection): boolean {
  const agents = condition.sets.get('agent');
  const environments = condition.sets.get('environment');
  return matchesScalar(condition.sets, (dimension) => selection.scalar[dimension]) &&
    (agents === undefined || selection.agents.some((agent) => agents.has(agent))) &&
    (environments === undefined || selection.environments.some((environment) => environments.has(environment)));
}

function describeSelection(scalar: Readonly<Record<ScalarDimension, string | undefined>>): string {
  return scalarDimensions
    .filter((dimension) => scalar[dimension] !== undefined)
    .map((dimension) => `${dimension}=${label(scalar[dimension])}`)
    .join(' ');
}

function pluginRefOf(owner: Owner): { category: PluginCategory; id: string } {
  return { category: owner.category as PluginCategory, id: owner.id };
}

function resolveInternal(
  state: RegistryState,
  selectionValue: unknown,
  hostValue: unknown,
  issues: Issues
): PluginResolution | undefined {
  const parser: Parser = { issues, limits: state.limits };
  const options: IntakeOptions = { limits: state.limits, issues, code: () => 'invalid-selection' };
  const plainSelection = intake(selectionValue, options);
  const plainHost = intake(hostValue, options);
  if (issues.hasAny()) return undefined;
  const selection = readRecord(parser, plainSelection, 'selection', 'invalid-selection', selectionFields, ['variant']);
  const host = readRecord(parser, plainHost, 'host', 'invalid-selection', ['platform']);
  if (selection === undefined || host === undefined) return undefined;
  const invalidSelection = (detail: string): void => issues.add('invalid-selection', 'selection', detail);
  const { workload, variant, frontend, governanceProfile, agents, environments } = selection;
  const variants = typeof workload === 'string' ? state.space.workloads.get(workload) : undefined;
  if (variants === undefined) {
    invalidSelection(`workload ${display(workload)} is not a registered workload`);
  } else if (variants.length === 0 ? variant !== undefined : typeof variant !== 'string' || !variants.includes(variant)) {
    invalidSelection(`workload ${label(workload)} requires ${variants.length === 0 ? 'no variant' : `one of its variants (${variants.join(', ')})`}`);
  }
  if (typeof frontend !== 'string' || !frontendSet.has(frontend)) invalidSelection(`frontend must be one of ${frontendSelections.join(', ')}`);
  if (typeof governanceProfile !== 'string' || !state.space.profileSet.has(governanceProfile)) {
    invalidSelection(`governance profile ${display(governanceProfile)} is not registered`);
  }
  if (!isStringList(environments) || environments.length === 0 || new Set(environments).size !== environments.length ||
      environments.some((environment) => !state.space.environmentSet.has(environment))) {
    invalidSelection('environments must be a non-empty array of distinct registered environments');
  }
  if (!isStringList(agents) || new Set(agents).size !== agents.length) {
    invalidSelection('agents must be an array of distinct agent plugin ids');
  }
  const picked: DescriptorModel[] = [];
  const pick = (value: unknown, category: PluginCategory): void => {
    if (typeof value !== 'string') {
      invalidSelection(`${category} must be a plugin id`);
      return;
    }
    const plugin = state.registered.byId.get(value);
    if (plugin === undefined) {
      issues.add('unknown-plugin', `plugin-id:${value}`, `no bundled ${category} plugin is registered with this id; plugins are never loaded from paths, packages or environment settings`);
    } else if (plugin.category !== category) {
      issues.add('wrong-category', plugin.owner.key, `${value} is a ${plugin.category} plugin, not a ${category} plugin`);
    } else {
      picked.push(plugin);
    }
  };
  pick(selection.stack, 'stack');
  pick(selection.cloud, 'cloud');
  pick(selection.workflow, 'workflow');
  for (const agent of isStringList(agents) ? agents : []) pick(agent, 'agent');
  const platform = host.platform;
  if (typeof platform !== 'string' || !hostSet.has(platform)) {
    issues.add('unsupported-host-platform', `host:${label(platform)}`, `the host platform is not qualified; supported: ${sortedHosts.join(', ')}`);
  }
  if (issues.hasAny()) return undefined;
  const scalar: Record<ScalarDimension, string | undefined> = {
    workload: workload as string,
    variant: variant as string | undefined,
    stack: selection.stack as string,
    cloud: selection.cloud as string,
    workflow: selection.workflow as string,
    frontend: frontend as string,
    governanceProfile: governanceProfile as string
  };
  for (const plugin of picked) {
    if (!plugin.hostPlatforms.includes(platform as string)) {
      issues.add('unsupported-host-platform', plugin.owner.key, `the plugin does not support host platform ${label(platform)}`);
    }
    if (!plugin.supports.some((alternative) => matchesScalar(alternative.sets, (dimension) => scalar[dimension]))) {
      issues.add('unsupported-combination', plugin.owner.key, `no support alternative matches ${describeSelection(scalar)}`);
    }
  }
  if (issues.hasAny()) return undefined;
  // Construction analyzed only contexts that admit an agent. Selecting no agent activates a subset of
  // what selecting one admitted agent would, so an agent-free selection must stay inside those contexts.
  if ((agents as string[]).length === 0 && !state.registered.plugins.some((plugin) =>
    plugin.category === 'agent' &&
    plugin.hostPlatforms.includes(platform as string) &&
    plugin.supports.some((alternative) => matchesScalar(alternative.sets, (dimension) => scalar[dimension])))) {
    issues.add('unsupported-combination', 'selection', `no bundled agent plugin supports ${describeSelection(scalar)} on host ${label(platform)}, so an agent-free selection is outside the validated combinations`);
    return undefined;
  }
  const concrete: ConcreteSelection = {
    scalar,
    agents: [...(agents as string[])].sort(compareText),
    environments: [...(environments as string[])].sort(compareText)
  };
  const selectedKeys = new Set(picked.map((plugin) => plugin.owner.key));
  const applies = (declaration: Declared): boolean =>
    (declaration.owner.category === undefined || selectedKeys.has(declaration.owner.key)) &&
    appliesTo(declaration.when, concrete);
  const plugins = sortBy(picked, (plugin) => [plugin.owner.rank, plugin.id]);
  const artifacts = [...state.core.artifacts, ...plugins.flatMap((plugin) => plugin.artifacts)].filter(applies);
  const checks = plugins.flatMap((plugin) => plugin.checks).filter(applies);
  const recipes = plugins.flatMap((plugin) => plugin.recipes).filter(applies);
  const operationIds = [...new Set([...checks, ...recipes].map((declaration) => declaration.operation))].sort(compareText);
  const semantic = {
    selection: {
      workload: scalar.workload as string,
      ...(scalar.variant === undefined ? {} : { variant: scalar.variant }),
      stack: scalar.stack as string,
      cloud: scalar.cloud as string,
      workflow: scalar.workflow as string,
      agents: [...concrete.agents],
      frontend: scalar.frontend as FrontendSelection,
      governanceProfile: scalar.governanceProfile as string,
      environments: [...concrete.environments]
    },
    plugins: plugins.map((plugin): ResolvedPlugin => {
      const entry = state.entries.get(plugin.id) as PluginInventoryEntry;
      return {
        category: entry.category,
        id: entry.id,
        apiVersion: entry.apiVersion,
        contentVersion: entry.contentVersion,
        contentDigest: entry.contentDigest
      };
    }),
    artifacts: sortBy(artifacts.map((artifact): ResolvedArtifact => ({
      owner: { ...artifact.owner.output },
      logicalName: artifact.logicalName,
      category: artifact.category,
      pathParts: [...artifact.pathParts],
      lifecycle: artifact.lifecycle,
      ...(artifact.provisioningGroup === undefined ? {} : { provisioningGroup: artifact.provisioningGroup })
    })), (artifact) => [aliasKey(artifact.pathParts)]),
    checks: sortBy(checks.map((check): ResolvedCheck => ({
      owner: pluginRefOf(check.owner),
      id: check.id,
      version: check.version,
      operation: check.operation,
      effects: [...check.effects]
    })), (check) => [pluginCategories.indexOf(check.owner.category), check.owner.id, check.id, check.version]),
    recipes: sortBy(recipes.map((recipe): ResolvedRecipe => ({
      owner: pluginRefOf(recipe.owner),
      operation: recipe.operation,
      id: recipe.id,
      version: recipe.version
    })), (recipe) => [recipe.operation, recipe.id, recipe.version, pluginCategories.indexOf(recipe.owner.category), recipe.owner.id]),
    sharedAssets: state.sharedAssets.map((asset) => ({ ...asset })),
    operations: operationIds.map((id): OperationDefinition => {
      const { output } = state.operations.get(id) as OperationModel;
      return {
        id: output.id,
        permittedCheckEffects: [...output.permittedCheckEffects],
        recipes: output.recipes.map((recipe) => ({ ...recipe }))
      };
    })
  };
  const digest = pluginResolutionDigest(semantic);
  return deepFreeze({ ...semantic, hostPlatform: platform as SupportedHostPlatform, digest });
}

/** Canonical identity only; callers must independently validate the complete resolution semantics. */
export function pluginResolutionDigest(semantic: Omit<PluginResolution, 'hostPlatform' | 'digest'>): Sha256Digest {
  return digestOf({ kind: 'liftoff-plugin-resolution', schemaVersion: 1, pluginApiVersion, ...semantic });
}

function verifyComposition(state: RegistryState, resolutionValue: unknown, artifactsValue: unknown): void {
  const issues = new Issues();
  const parser: Parser = { issues, limits: state.limits };
  const supplied = intake(resolutionValue, { limits: state.limits, issues, code: () => 'resolution-mismatch' });
  issues.throwIfAny('composition');
  const record = readRecord(parser, supplied, 'resolution', 'resolution-mismatch', ['hostPlatform', 'selection'], resolutionFields);
  if (record === undefined) throw issues.failure('composition');
  const selectionIssues = new Issues();
  const current = resolveInternal(state, record.selection, { platform: record.hostPlatform }, selectionIssues);
  if (current === undefined) {
    const codes = [...new Set(selectionIssues.failure('selection').issues.map((issue) => issue.code))].join(', ');
    issues.add('resolution-mismatch', 'resolution', `the supplied selection does not resolve in this registry (${codes})`);
    throw issues.failure('composition');
  }
  const recomputed = current as unknown as RawRecord;
  const differing = [...new Set([...Object.keys(record), ...Object.keys(recomputed)])].sort(compareText).filter((key) =>
    !(key in record) || canonicalJson(record[key]) !== canonicalJson(recomputed[key]));
  if (differing.length > 0) {
    issues.add('resolution-mismatch', 'resolution', `the supplied resolution differs from this registry's recomputed resolution in: ${differing.join(', ')}`);
    throw issues.failure('composition');
  }
  const rendered = intake(artifactsValue, {
    limits: state.limits,
    issues,
    code: () => 'artifact-identity-mismatch',
    unboundedStringAt: (path) => /^\[\d+\]\.content$/.test(path)
  });
  issues.throwIfAny('composition');
  const list = readList(parser, rendered, 'rendered', 'artifact-identity-mismatch', 'artifacts', 'maxArtifacts');
  if (list === undefined) throw issues.failure('composition');
  const declared = new Map(current.artifacts.map((artifact) => [artifact.logicalName, artifact]));
  const counts = new Map<string, number>();
  const namesByKey = new Map<string, Set<string>>();
  for (const [index, entry] of list.entries()) {
    const subject = `rendered[${index}]`;
    const artifact = readRecord(parser, entry, subject, 'artifact-identity-mismatch', renderedFields, ['provisioningGroup']);
    const countRendered = (logicalName: string, pathParts: readonly string[]): void => {
      counts.set(logicalName, (counts.get(logicalName) ?? 0) + 1);
      const key = aliasKey(pathParts);
      namesByKey.set(key, (namesByKey.get(key) ?? new Set<string>()).add(logicalName));
    };
    if (artifact === undefined) {
      // The wrong field set is already reported; a record with a usable identity still counts as rendered.
      if (isRecord(entry) && typeof entry.logicalName === 'string' && isStringList(entry.pathParts)) {
        countRendered(entry.logicalName, entry.pathParts);
      }
      continue;
    }
    const { logicalName, category, lifecycle, provisioningGroup, pathParts } = artifact;
    if (typeof logicalName !== 'string' || !isStringList(pathParts)) {
      issues.add('artifact-identity-mismatch', subject, 'rendered artifacts require a string logical name and string path parts');
      continue;
    }
    countRendered(logicalName, pathParts);
    if (typeof artifact.content !== 'string') {
      issues.add('artifact-identity-mismatch', `artifact:${logicalName}`, 'rendered artifact content must be a string');
    }
    const expected = declared.get(logicalName);
    if (expected === undefined) {
      issues.add('undeclared-artifact', `artifact:${logicalName}`, `${pathParts.join('/')} is not declared for this resolution`);
      continue;
    }
    const differences = [
      category === expected.category ? '' : 'category',
      samePath(pathParts, expected.pathParts) ? '' : 'pathParts',
      lifecycle === expected.lifecycle ? '' : 'lifecycle',
      provisioningGroup === expected.provisioningGroup ? '' : 'provisioningGroup'
    ].filter((field) => field !== '');
    if (differences.length > 0) {
      issues.add('artifact-identity-mismatch', `artifact:${logicalName}`, `the rendered artifact differs from its declaration in ${differences.join(', ')}`);
    }
  }
  for (const [logicalName, count] of counts) {
    if (count > 1) issues.add('duplicate-artifact', `artifact:${logicalName}`, `rendered ${count} times`);
  }
  for (const [key, names] of namesByKey) {
    if (names.size > 1) issues.add('path-alias-collision', `path:${key}`, `rendered by ${[...names].sort(compareText).join(', ')}`);
  }
  for (const artifact of current.artifacts) {
    if (!counts.has(artifact.logicalName)) {
      issues.add('missing-artifact', `artifact:${artifact.logicalName}`, `declared ${artifact.pathParts.join('/')} was not rendered`);
    }
  }
  issues.throwIfAny('composition');
}

function assetsFor(state: RegistryState, ownerValue: unknown): PluginAssetTexts {
  const issues = new Issues();
  const parser: Parser = { issues, limits: state.limits };
  const plainOwner = intake(ownerValue, { limits: state.limits, issues, code: () => 'invalid-selection' });
  issues.throwIfAny('selection');
  const owner = readRecord(
    parser,
    plainOwner,
    'owner',
    'invalid-selection',
    ['kind'],
    ['category', 'id']
  );
  if (owner === undefined) throw issues.failure('selection');
  if (owner.kind === 'core' && !('category' in owner) && !('id' in owner)) return state.texts.get('core') as PluginAssetTexts;
  if (owner.kind !== 'plugin' || typeof owner.category !== 'string' || typeof owner.id !== 'string') {
    issues.add('invalid-selection', 'owner', 'owners must be {kind: core} or {kind: plugin, category, id}');
    throw issues.failure('selection');
  }
  const plugin = state.registered.byId.get(owner.id);
  if (plugin === undefined) {
    issues.add('unknown-plugin', `plugin-id:${owner.id}`, 'no bundled plugin is registered with this id');
  } else if (plugin.category !== owner.category) {
    issues.add('wrong-category', plugin.owner.key, `${owner.id} is a ${plugin.category} plugin, not a ${owner.category} plugin`);
  }
  issues.throwIfAny('selection');
  return state.texts.get((plugin as DescriptorModel).owner.key) as PluginAssetTexts;
}

function assemble(
  shape: Shape,
  registered: Registered,
  verified: VerifiedAssets,
  limits: PluginRegistryLimits
): PluginRegistry {
  const entries = new Map<string, PluginInventoryEntry>();
  for (const plugin of registered.plugins) {
    const input = contentInputOf(plugin, verified.digests) as PluginContentInput;
    entries.set(plugin.id, deepFreeze({ ...canonicalContent(input), contentDigest: contentDigestOf(input) }));
  }
  const inventory = deepFreeze(registered.plugins.map((plugin) => entries.get(plugin.id) as PluginInventoryEntry));
  const sharedAssets = deepFreeze(sharedAssetDigests(shape.core, verified.digests));
  const pluginSetDigest = digestOf({
    kind: 'liftoff-plugin-set',
    schemaVersion: 1,
    pluginApiVersion,
    plugins: inventory.map(({ category, id, apiVersion, contentVersion, contentDigest }) => ({
      category,
      id,
      apiVersion,
      contentVersion,
      contentDigest
    }))
  });
  const coreContributionDigest = digestOf(coreContributionRecord(shape.core, sharedAssets));
  const registryDigest = digestOf({
    kind: 'liftoff-plugin-registry',
    schemaVersion: 1,
    pluginSetDigest,
    coreContributionDigest,
    selectionSpace: shape.space.output,
    operations: sortBy([...shape.operations.values()].map((operation) => operation.output), (operation) => [operation.id])
  });
  const textOf = (owner: Owner, id: string): string => verified.texts.get(assetKey(owner, id)) as string;
  const texts = new Map<string, PluginAssetTexts>([['core', deepFreeze({
    own: Object.fromEntries(sortBy(shape.core.sharedAssets, (asset) => [asset.id]).map((asset) => [asset.id, textOf(coreOwner, asset.id)])),
    shared: {}
  })]]);
  for (const plugin of registered.plugins) {
    texts.set(plugin.owner.key, deepFreeze({
      own: Object.fromEntries(sortBy(plugin.assets, (asset) => [asset.id]).map((asset) => [asset.id, textOf(plugin.owner, asset.id)])),
      shared: Object.fromEntries([...plugin.sharedAssets].sort(compareText).map((id) => [id, textOf(coreOwner, id)]))
    }));
  }
  const state: RegistryState = {
    limits,
    space: shape.space,
    registered,
    core: shape.core,
    operations: shape.operations,
    entries,
    sharedAssets,
    texts
  };
  return Object.freeze({
    apiVersion: pluginApiVersion,
    inventory,
    pluginSetDigest,
    coreContributionDigest,
    registryDigest,
    resolveSelection: (selection: PluginSelection, host: PluginHost): PluginResolution =>
      runStage('selection', () => {
        const issues = new Issues();
        const resolution = resolveInternal(state, selection, host, issues);
        if (resolution === undefined) throw issues.failure('selection');
        return resolution;
      }),
    assetsFor: (owner: ContributionOwner): PluginAssetTexts =>
      runStage('selection', () => assetsFor(state, owner)),
    verifyComposedArtifacts: (resolution: PluginResolution, artifacts: readonly GeneratedArtifact[]): void =>
      runStage('composition', () => verifyComposition(state, resolution, artifacts))
  });
}

function buildRegistry(input: unknown): PluginRegistry {
  const limits = resolveLimits(input);
  const issues = new Issues();
  const plain = intake(input, {
    limits,
    issues,
    code: (path) => (path.startsWith('descriptors') ? 'invalid-descriptor' : 'invalid-registry-input'),
    bytesAt: (path) => /^assets\[\d+\]\.bytes$/.test(path)
  });
  issues.throwIfAny('registry');
  const shape = readShape({ issues, limits }, plain);
  const registered = registerPlugins(shape.descriptors, issues);
  const semantics: Semantics = { issues, limits, space: shape.space, registered };
  checkConditions(shape.core, semantics);
  checkLifecycles([...shape.core.artifacts, ...registered.plugins.flatMap((plugin) => plugin.artifacts)], shape.core, issues);
  const verified = checkAssets(shape.core, registered.plugins, shape.descriptors, shape.bytes, issues);
  checkRelease(shape.core, registered, shape.release, verified.digests, issues);
  checkContentDigests(registered, shape.release, verified.digests, issues);
  checkOperations(registered.plugins, shape.operations, issues);
  issues.throwIfAny('registry');
  checkSatisfiability(shape.core, semantics);
  issues.throwIfAny('registry');
  return assemble(shape, registered, verified, limits);
}

/**
 * Validates a complete, release-owned set of bundled plugin descriptors together with core
 * declarations, packaged asset bytes and the expected release inventory. Every problem is reported
 * before any rendering; the returned registry is immutable and grants no authority.
 */
export function createPluginRegistry(input: PluginRegistryInput): PluginRegistry {
  return runStage('registry', () => buildRegistry(input));
}

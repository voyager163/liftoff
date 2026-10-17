import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import {
  readNativeProgramAssembly, type NativeProgramObservation
} from '../../distribution/native/native-program-assembly.mjs';
import { readBoundProjectFileSnapshot } from '../adapters/filesystem/bound-project-files.js';
import { readDeclaredAssetBytes } from '../adapters/packaged-assets/plugin-assets.js';
import { createModernSourceRegistry } from '../application/project/modern-plugins.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { workflowFailure } from './workflow-control-values.js';
import { assertSource5WorkflowContext, type Source5WorkflowContext } from './workflow-source5-context.js';
import { assertWorkflowObservationRuntime, type WorkflowRuntime } from './workflow-runtime.js';

const archiveBytes = 12 * 1024 * 1024;
const entrypoint = 'dist/workflow-context-validator.js';
const refuse = (message: string): never => workflowFailure('workflow-program-content', message);
const diagnostics = { pathLabel: 'original current5 program', invalid: refuse };
type Request = { readonly context: Source5WorkflowContext; readonly runtime: WorkflowRuntime };

export interface Source5WorkflowInstalledProgramContent {
  readonly kind: 'source5-original-program-content';
  readonly contentDigest: string;
  readonly assemblyDigest: string;
}
const observations = new WeakMap<Source5WorkflowInstalledProgramContent, Request & {
  readonly assembly: unknown; readonly root: string;
}>();

function request<T extends Request>(value: T, fields: readonly string[]): Readonly<T> {
  if (typeof value !== 'object' || value === null || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some(field => typeof field !== 'string' || !fields.includes(field)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(field =>
        !field.enumerable || !Object.hasOwn(field, 'value'))) {
    return workflowFailure('workflow-program-request',
      'Program consumption accepts only original context/runtime/assembly or content references, not paths, receipts, callbacks or authority overrides.');
  }
  const captured = Object.freeze({ ...value });
  guard(captured);
  return captured;
}
function guard(value: Request): void {
  assertSource5WorkflowContext(value.context);
  assertWorkflowObservationRuntime(value.runtime);
}
async function packageIdentity(value: Request, root: string, original: NativeProgramObservation) {
  async function metadata(name: string) {
    guard(value);
    const file = await readBoundProjectFileSnapshot(root, [name],
      { maximumBytes: 4 * 1024 * 1024, linkPolicy: 'single-link', diagnostics });
    guard(value);
    if (!file.content?.length) return refuse('The original installed program has missing or empty package metadata.');
    const text = file.content.toString('utf8');
    if (!Buffer.from(text).equals(file.content)) return refuse('Original package metadata must be complete UTF-8 JSON.');
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return refuse('Original installed package metadata is not valid JSON.');
    }
    if (!isRecord(parsed)) return refuse('Original installed package metadata is not an ordinary record.');
    return { parsed, digest: createHash('sha256').update(file.content).digest('hex') };
  }
  const pkg = await metadata('package.json'), lock = await metadata('package-lock.json');
  const locked = isRecord(lock.parsed.packages) ? lock.parsed.packages[''] : undefined;
  const version = value.context.records.identity.liftoffVersion;
  for (const item of [pkg.parsed, lock.parsed, locked, original.manifest.package]) {
    if (!isRecord(item) || item.name !== '@msn-control/liftoff' || item.version !== version) {
      return workflowFailure('workflow-program-version',
        'Original archive, installed package and lock must match the actual current5 name/version; an older package cannot be relabelled.');
    }
  }
  if (lock.digest !== original.manifest.package.lockSha256) refuse('The installed lock differs from its original assembly.');
  return { name: '@msn-control/liftoff', version, packageDigest: pkg.digest, lockDigest: lock.digest };
}
function assemblyDigest(original: NativeProgramObservation): string {
  const { content, ...archive } = original.packageArchive;
  if (!Buffer.isBuffer(content) || content.length === 0 || content.length > archiveBytes ||
      archive.bytes !== content.length || createHash('sha256').update(content).digest('hex') !== archive.sha256 ||
      canonicalSha256(archive) !== canonicalSha256(original.manifest.package.archive) ||
      original.kind !== 'liftoff-original-native-program-content' ||
      original.releaseAuthority !== 'not-issued' || original.nativeQualification !== 'not-issued' ||
      original.workflowAuthority !== 'not-issued') {
    return refuse('Original program archive bytes or assembly boundaries differ from their independently read identity.');
  }
  return canonicalSha256({ manifest: original.manifest, sourceInputs: original.sourceInputs, archive,
    installedApplicationRoot: original.installedApplicationRoot, installedCliEntrypoint: original.installedCliEntrypoint });
}
function assertOriginalSourceFamily(value: Request, root: string): void {
  guard(value);
  createModernSourceRegistry((declarations, bounds) =>
    readDeclaredAssetBytes(declarations, bounds, { packageRoot: root }));
  guard(value);
}
async function observe(value: Request, assembly: unknown) {
  guard(value);
  const original = await readNativeProgramAssembly(assembly);
  guard(value);
  const originalDigest = assemblyDigest(original), root = original.installedApplicationRoot;
  const runtimeMember = process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node';
  if (!path.isAbsolute(root) || await realpath(root) !== root ||
      path.basename(root) !== 'application' || original.installedCliEntrypoint !== path.join(root, 'dist', 'cli.js') ||
      !isRecord(original.manifest.runtime) || original.manifest.runtime.executable !== runtimeMember ||
      !original.manifest.inventory.entries.some(entry => entry.path === runtimeMember && entry.kind === 'file')) {
    return refuse('Only the original producer-owned canonical application, CLI and bundled runtime references may be consumed.');
  }
  const identity = await packageIdentity(value, root, original);
  assertOriginalSourceFamily(value, root);
  for (const executable of [entrypoint, 'dist/cli.js']) {
    const member = original.manifest.inventory.entries.find(entry => entry.path === `application/${executable}` && entry.kind === 'file');
    if (!member || typeof member.bytes !== 'number' || member.bytes <= 0 ||
        !original.manifest.package.sourceFiles.some(file => file.path === executable && file.sha256 === member.sha256)) {
      refuse('An exact original installed CLI/validator entrypoint is absent or differs from its packed source.');
    }
  }
  const after = await readNativeProgramAssembly(assembly);
  guard(value);
  if (assemblyDigest(after) !== originalDigest) refuse('The original archive/source/output relationship changed during program consumption.');
  return { original: after, originalDigest, root, identity, contentDigest: canonicalSha256(after.manifest.inventory),
    runtimeEntrypoint: path.join(path.dirname(root), runtimeMember) };
}

/** Original candidate content, not release, workflow execution or phase authority. */
export async function constructSource5WorkflowProgramContent(input: Request & { readonly assembly: unknown }) {
  const value = request(input, ['context', 'runtime', 'assembly']);
  const observed = await observe(value, value.assembly);
  const content = Object.freeze({ kind: 'source5-original-program-content' as const,
    contentDigest: observed.contentDigest, assemblyDigest: observed.originalDigest });
  observations.set(content, { context: value.context, runtime: value.runtime, assembly: value.assembly, root: observed.root });
  return freezeModernValue({
    status: 'observed' as const, package: { name: observed.identity.name, version: observed.identity.version }, content,
    files: observed.original.manifest.inventory.entries.filter(entry => entry.kind === 'file').length,
    directories: observed.original.manifest.inventory.entries.filter(entry => entry.kind === 'directory').length,
    bytes: observed.original.manifest.inventory.totalBytes, inventoryScope: 'complete-original-bundle' as const,
    archive: { bytes: observed.original.packageArchive.bytes, sha256: observed.original.packageArchive.sha256,
      mode: observed.original.packageArchive.mode },
    originalAssembly: { sourceCommit: observed.original.manifest.source.commit, sourceDirty: observed.original.manifest.source.dirty,
      sourceDigest: observed.original.manifest.source.sourceDigest, configurationDigest: observed.original.manifest.source.configurationDigest },
    scope: 'original-current5-candidate-content' as const, publication: 'not-observed' as const,
    sourceFamily: 'compiled-current5-family-matched' as const,
    dependencyClosure: 'original-packed-and-installed-readset' as const,
    effects: [] as const, releaseAuthority: 'not-issued' as const, nativeQualification: 'not-issued' as const,
    workflowAuthority: 'not-issued' as const, requiredContextSemantics: 'not-validated' as const,
    prerequisiteSession: null, phaseProof: 'not-issued' as const
  });
}
async function current(input: Request & { readonly content: Source5WorkflowInstalledProgramContent }) {
  const value = request(input, ['context', 'runtime', 'content']), original = observations.get(value.content);
  if (!original || original.context !== value.context || original.runtime !== value.runtime) {
    return workflowFailure('workflow-program-observation',
      'Only this invocation/context/runtime original program token may be consumed; copying or serialization creates no authority.');
  }
  const actual = await observe(value, original.assembly);
  if (actual.root !== original.root || actual.originalDigest !== value.content.assemblyDigest ||
      actual.contentDigest !== value.content.contentDigest) {
    return refuse('Original program archive, source, installed bytes, modes, membership or physical references changed before consumption.');
  }
  return actual;
}
export async function assertCurrentSource5WorkflowProgramContent(
  input: Request & { readonly content: Source5WorkflowInstalledProgramContent }
): Promise<void> {
  await current(input);
}
export async function readSource5WorkflowProgramContent(
  input: Request & { readonly content: Source5WorkflowInstalledProgramContent }
) {
  const actual = await current(input);
  return Object.freeze({
    kind: 'source5-original-program-readback' as const,
    installedApplicationRoot: actual.root, installedCliEntrypoint: actual.original.installedCliEntrypoint,
    installedValidatorEntrypoint: path.join(actual.root, entrypoint),
    installedRuntimeEntrypoint: actual.runtimeEntrypoint,
    packageArchive: Object.freeze({ bytes: actual.original.packageArchive.bytes, sha256: actual.original.packageArchive.sha256,
      mode: actual.original.packageArchive.mode, content: Buffer.from(actual.original.packageArchive.content) }),
    originalAssembly: Object.freeze({
      sourceCommit: actual.original.manifest.source.commit, sourceDirty: actual.original.manifest.source.dirty,
      sourceDigest: actual.original.manifest.source.sourceDigest,
      configurationDigest: actual.original.manifest.source.configurationDigest
    }),
    contentDigest: actual.contentDigest, assemblyDigest: actual.originalDigest,
    releaseAuthority: 'not-issued' as const, nativeQualification: 'not-issued' as const, workflowAuthority: 'not-issued' as const
  });
}

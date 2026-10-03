import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  assertBoundProjectPath, readBoundProjectFileSnapshot
} from '../../adapters/filesystem/bound-project-files.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { manifestHistoryMaximumSourceBytes } from '../../domain/project/manifest/history.js';
import {
  standaloneManifestHistoryPathsForSource,
  type CapturedFile, type CapturedPresentFile, type StandaloneManifestHistoryInput
} from './manifest-history.js';

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
}

type CapturedDirectory =
  | { readonly kind: 'absent'; readonly pathParts: readonly string[] }
  | { readonly kind: 'directory'; readonly pathParts: readonly string[]; readonly identity: DirectoryIdentity };

function invalid(detail: string): never {
  throw new FileSystemError(`Manifest history capture: ${detail}`);
}

const diagnostics = { pathLabel: 'Manifest history capture path', invalid };

function selectedRoot(value: string): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) ||
    !path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value ||
    value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) {
    invalid('the selected root must be an absolute canonical native path.');
  }
  return value;
}

function directoryIdentity(details: BigIntStats, label: string): DirectoryIdentity {
  if (!details.isDirectory() || details.isSymbolicLink()) invalid(`${label} must be a real directory, not a link or special file.`);
  if (typeof details.dev !== 'bigint' || details.dev < 0n ||
    typeof details.ino !== 'bigint' || details.ino <= 0n ||
    typeof details.mode !== 'bigint' || details.mode < 0n) {
    invalid(`${label} has no comparable exact filesystem identity.`);
  }
  return { dev: details.dev, ino: details.ino, mode: details.mode };
}

function assertDirectoryIdentity(expected: DirectoryIdentity, actual: DirectoryIdentity, label: string): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.mode !== actual.mode) {
    invalid(`${label} changed during collection; no alternate root or history was selected.`);
  }
}

async function captureRoot(root: string): Promise<DirectoryIdentity> {
  const before = directoryIdentity(await lstat(root, { bigint: true }), 'the selected root');
  if (await realpath(root) !== root) invalid('the selected root is not its exact physical canonical path.');
  const after = directoryIdentity(await lstat(root, { bigint: true }), 'the selected root');
  assertDirectoryIdentity(before, after, 'the selected root');
  return after;
}

function assertSameFile(expected: CapturedFile, actual: CapturedFile): void {
  if (expected.pathParts.join('\0') !== actual.pathParts.join('\0') ||
    expected.mode !== actual.mode || (expected.content === undefined
      ? actual.content !== undefined : actual.content === undefined || !expected.content.equals(actual.content))) {
    invalid(`${expected.pathParts.join('/')} changed during collection; obtain fresh observations.`);
  }
}

function assertSameDirectories(expected: readonly CapturedDirectory[], actual: readonly CapturedDirectory[]): void {
  if (expected.length !== actual.length) invalid('the namespace observation inventory changed.');
  for (const [index, before] of expected.entries()) {
    const after = actual[index];
    const label = before.pathParts.join('/');
    if (!after || before.pathParts.join('\0') !== after.pathParts.join('\0') || before.kind !== after.kind) {
      invalid(`${label} changed during collection; obtain fresh observations.`);
    }
    if (before.kind === 'directory' && after.kind === 'directory') {
      assertDirectoryIdentity(before.identity, after.identity, label);
    }
  }
}

// Fixed observations are not activation classification, write permission, or
// atomic confinement against noncooperating ancestor replacement.
export async function collectStandaloneManifestHistoryInput(
  canonicalProjectRoot: string
): Promise<StandaloneManifestHistoryInput> {
  const root = selectedRoot(canonicalProjectRoot);
  const rootIdentity = await captureRoot(root);
  async function assertRoot(): Promise<void> {
    assertDirectoryIdentity(rootIdentity, await captureRoot(root), 'the selected root');
  }
  async function captureFile(parts: readonly string[]): Promise<CapturedFile> {
    await assertRoot();
    const captured = await readBoundProjectFileSnapshot(root, parts, {
      maximumBytes: manifestHistoryMaximumSourceBytes, linkPolicy: 'single-link', diagnostics
    });
    await assertRoot();
    if (captured.content === undefined) {
      if (captured.mode !== undefined) invalid(`${parts.join('/')} has an inconsistent absent-file observation.`);
      return { pathParts: [...captured.pathParts] };
    }
    if (typeof captured.mode !== 'number' || !Number.isSafeInteger(captured.mode) ||
      captured.mode < 0 || captured.mode > 0o7777) {
      invalid(`${parts.join('/')} has no valid observed mode.`);
    }
    return { pathParts: [...captured.pathParts], content: captured.content, mode: captured.mode };
  }
  async function captureDirectory(parts: readonly string[]): Promise<CapturedDirectory> {
    await assertRoot();
    await assertBoundProjectPath(root, parts, diagnostics);
    let details: BigIntStats | undefined;
    try {
      details = await lstat(path.join(root, ...parts), { bigint: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const identity = details === undefined ? undefined : directoryIdentity(details, parts.join('/'));
    await assertBoundProjectPath(root, parts, diagnostics);
    await assertRoot();
    return identity === undefined ? { kind: 'absent', pathParts: [...parts] }
      : { kind: 'directory', pathParts: [...parts], identity };
  }

  const source = await captureFile(['liftoff.manifest.json']);
  if (source.content === undefined) invalid('the required original liftoff.manifest.json is absent.');
  const sourceManifest: CapturedPresentFile = {
    pathParts: [...source.pathParts], content: source.content, mode: source.mode
  };
  const paths = standaloneManifestHistoryPathsForSource(sourceManifest);
  const directoryParts = paths.indexPathParts.slice(0, -1);
  async function captureNamespace(): Promise<readonly [CapturedDirectory, CapturedDirectory, CapturedDirectory]> {
    return [
      await captureDirectory(directoryParts.slice(0, 1)),
      await captureDirectory(directoryParts.slice(0, 2)),
      await captureDirectory(directoryParts)
    ];
  }
  const directories = await captureNamespace();
  const index = await captureFile(paths.indexPathParts);
  const copy = await captureFile(paths.manifestPathParts);

  assertSameFile(sourceManifest, await captureFile(['liftoff.manifest.json']));
  assertSameDirectories(directories, await captureNamespace());
  assertSameFile(index, await captureFile(paths.indexPathParts));
  assertSameFile(copy, await captureFile(paths.manifestPathParts));
  assertSameDirectories(directories, await captureNamespace());
  await assertRoot();
  return {
    sourceManifest,
    destinations: {
      directory: { kind: directories[2].kind, pathParts: [...directoryParts] },
      index,
      copy
    }
  };
}

import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { installedPackageRoot, resolvePackageFile } from '../src/adapters/packaged-assets/package-root.js';
import {
  PackagedAssetReadError,
  readDeclaredAssetBytes,
  type BoundedReadFs,
  type PackagedAssetReadBounds
} from '../src/adapters/packaged-assets/plugin-assets.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import { pluginRegistryLimits } from '../src/plugins/contracts.js';
import {
  capabilityLabel,
  createDirectoryLink,
  createOwnedRoot,
  describeNativeCapabilities,
  nativeCapabilities,
  removeAllOwnedRoots,
  windowsOnlyLabel
} from './fixtures/native-path-capabilities.js';

// Packaged lookup trusts the release tree: containment is lexical, links and hard links are allowed,
// and the registry alone verifies bytes. These rows pin that on owned copies of the declared assets.

afterEach(() => {
  removeAllOwnedRoots();
});

afterAll(() => {
  console.info(describeNativeCapabilities());
});

// The composition root's own bound derivation (createBuiltinPluginRegistry).
const bounds: PackagedAssetReadBounds = {
  maxAssetBytes: pluginRegistryLimits.maxAssetBytes,
  maxTotalAssetBytes: pluginRegistryLimits.maxTotalAssetBytes,
  maxPathParts: pluginRegistryLimits.maxPathParts,
  maxPartLength: pluginRegistryLimits.maxStringLength
};

// Read-only reads of the checkout's declared template assets; only owned copies are ever written.
const checkoutBytes = new Map(builtinAssets.map((asset) => [asset.id, readFileSync(path.join(installedPackageRoot, ...asset.pathParts))]));

function copyPackage(root: string, place: (target: string, bytes: Buffer, id: string) => void = (target, bytes) => {
  writeFileSync(target, bytes, { flag: 'wx' });
}): void {
  for (const asset of builtinAssets) {
    const target = path.join(root, ...asset.pathParts);
    mkdirSync(path.dirname(target), { recursive: true });
    place(target, checkoutBytes.get(asset.id)!, asset.id);
  }
}

function expectEveryDeclaredAsset(entries: readonly { readonly pathParts: readonly string[]; readonly bytes: Uint8Array }[], root: string): void {
  expect(entries.map((entry) => entry.pathParts)).toEqual(builtinAssets.map((asset) => [...asset.pathParts]));
  entries.forEach((entry, index) => {
    const asset = builtinAssets[index];
    expect(Buffer.from(entry.bytes).equals(readFileSync(path.join(root, ...asset.pathParts))), asset.id).toBe(true);
    expect(Buffer.from(entry.bytes).equals(checkoutBytes.get(asset.id)!), asset.id).toBe(true);
  });
}

function readFailure(action: () => unknown): PackagedAssetReadError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PackagedAssetReadError);
    return error as PackagedAssetReadError;
  }
  throw new Error('Expected a packaged asset read failure.');
}

describe('packaged plugin asset lookup on the native filesystem', () => {
  it('refuses Windows alias and escape forms before any file operation (host-neutral)', () => {
    const root = createOwnedRoot('p1');
    copyPackage(root);
    const [valid] = builtinAssets;
    // a\b, CON and a trailing dot are already covered by the lazy-asset reader table.
    const forms: readonly (readonly string[])[] = [
      ['ASSETS', ...valid.pathParts.slice(1)],
      ['Assets', ...valid.pathParts.slice(1)],
      ['assets', 'C:x'],
      ['assets', 'x:zone'],
      ['assets', 'x '],
      ['assets', 'nul.txt'],
      ['assets', 'PROGRA~1'],
      ['assets', '\\\\srv\\share'],
      ['assets', '\\\\?\\C:']
    ];
    for (const pathParts of forms) {
      const calls: string[] = [];
      const refuse = (operation: string) => (): never => {
        calls.push(operation);
        throw new Error(`unexpected ${operation}`);
      };
      const fs: BoundedReadFs = { openSync: refuse('open'), fstatSync: refuse('fstat'), readSync: refuse('read'), closeSync: refuse('close') };
      const failure = readFailure(() => readDeclaredAssetBytes(
        [valid, { owner: valid.owner, id: 'windows-form', pathParts }], bounds, { packageRoot: root, fs }));
      expect({ reason: failure.reason, owner: failure.owner, id: failure.id, portablePath: failure.portablePath }, JSON.stringify(pathParts))
        .toEqual({ reason: 'invalid-path', owner: valid.owner, id: 'windows-form', portablePath: pathParts.join('/') });
      expect(calls, JSON.stringify(pathParts)).toEqual([]);
    }
  });

  it.skipIf(!nativeCapabilities.directoryLinks.available)(
    `reads every declared asset through a linked package root, because containment is lexical ${capabilityLabel('directory links', nativeCapabilities.directoryLinks)}`,
    () => {
      const root = createOwnedRoot('p2');
      const copy = path.join(root, 'package');
      copyPackage(copy);
      const linked = path.join(root, 'linked-package');
      createDirectoryLink(copy, linked);
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expectEveryDeclaredAsset(readDeclaredAssetBytes(builtinAssets, bounds, { packageRoot: linked }), copy);
    }
  );

  it.skipIf(!nativeCapabilities.hardLinks.available)(
    `reads hard-linked assets from a package-manager-style store ${capabilityLabel('hard links', nativeCapabilities.hardLinks)}`,
    () => {
      const root = createOwnedRoot('p3');
      const store = path.join(root, 'store');
      mkdirSync(store);
      const copy = path.join(root, 'package');
      copyPackage(copy, (target, bytes, id) => {
        const stored = path.join(store, id);
        writeFileSync(stored, bytes, { flag: 'wx' });
        linkSync(stored, target);
      });
      for (const asset of builtinAssets) {
        expect(lstatSync(path.join(copy, ...asset.pathParts)).nlink, asset.id).toBeGreaterThanOrEqual(2);
      }
      expectEveryDeclaredAsset(readDeclaredAssetBytes(builtinAssets, bounds, { packageRoot: copy }), copy);
    }
  );

  it('reads a package root whose path has spaces and non-ASCII characters, and reports a deleted asset as missing', () => {
    const root = createOwnedRoot('p4');
    const copy = path.join(root, 'Liftoff Pkg \u03a9 \u00e9');
    copyPackage(copy);
    expectEveryDeclaredAsset(readDeclaredAssetBytes(builtinAssets, bounds, { packageRoot: copy }), copy);

    const removed = builtinAssets[builtinAssets.length - 1];
    unlinkSync(path.join(copy, ...removed.pathParts));
    const failure = readFailure(() => readDeclaredAssetBytes(builtinAssets, bounds, { packageRoot: copy }));
    expect({ reason: failure.reason, owner: failure.owner, id: failure.id, portablePath: failure.portablePath })
      .toEqual({ reason: 'missing', owner: removed.owner, id: removed.id, portablePath: removed.pathParts.join('/') });
    expect(failure.message).not.toContain(root);
  });

  it.runIf(process.platform === 'win32')(`reads a case-variant spelling of the package root ${windowsOnlyLabel()}`, () => {
    const root = createOwnedRoot('p5');
    const copy = path.join(root, 'Package Root');
    copyPackage(copy);
    const flipped = path.join(path.dirname(copy), 'pACKAGE rOOT');
    const variant = /^[a-z]:/i.test(flipped)
      ? `${flipped[0] === flipped[0].toUpperCase() ? flipped[0].toLowerCase() : flipped[0].toUpperCase()}${flipped.slice(1)}`
      : flipped;
    expect(variant).not.toBe(copy);
    expectEveryDeclaredAsset(readDeclaredAssetBytes(builtinAssets, bounds, { packageRoot: variant }), copy);
  });

  it('rejects separator, UNC, drive and traversal forms in resolvePackageFile parts (host-neutral)', () => {
    for (const part of ['a\\b', '\\\\srv\\share', 'C:\\x', '\\\\?\\C:\\x', '/x', '..', '.', '']) {
      expect(() => resolvePackageFile('assets', part), JSON.stringify(part))
        .toThrow(`Invalid packaged file path part: ${JSON.stringify(part)}.`);
    }
  });
});

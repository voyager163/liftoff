import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectPackedNpmLock, packedTemplateSbom, resolvePackedGoComponents, verifiedPackedGoComponents } from '../scripts/repository-security/packed-template-inventory.ts';

describe('packed npm template component metadata, not installed runtime proof', () => {
  it('rejects a serialized or claimed completed Go inventory as live native evidence', () => {
    expect(() => verifiedPackedGoComponents(JSON.parse('{"complete":true,"cleanup":"completed"}'))).toThrow('unissued-go-inventory');
  });
  it('preserves documented omitted registry URLs and legacy SHA-1 metadata without rewriting or upgrading it', () => {
    const integrity = `sha1-${createHash('sha1').update('Nonfunctional package fixture.').digest('base64')}`;
    const source = JSON.stringify({
      lockfileVersion: 3, packages: { '': {}, 'node_modules/fixture': { version: '1.0.0', integrity } }
    });
    const result = inspectPackedNpmLock(source, 'node-backend');
    expect(result.components[0]).toMatchObject({
      name: 'fixture', version: '1.0.0', integrity, integrityAlgorithm: 'sha1', legacyIntegrity: true,
      resolution: 'registry-selected-at-operation'
    });
    expect(result).toMatchObject({ legacyIntegrityCount: 1, installedRuntimeClaim: false, vulnerabilitiesAssessed: false });
  });
  it.each([
    { integrity: 'sha1-invalid' }, { integrity: undefined },
    { resolved: 'https://unapproved.invalid/package.tgz' },
    { resolved: 'https://secret:credential@registry.npmjs.org/fixture.tgz' },
    { resolved: 'file:../../private' }, { link: true }, { version: undefined }
  ])('rejects malformed or unsupported metadata without treating absence of resolved as absence of a component %#', change => {
    const source = JSON.stringify({ lockfileVersion: 3, packages: {
      '': {}, 'node_modules/fixture': {
        version: '1.0.0', integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, ...change
      }
    } });
    expect(() => inspectPackedNpmLock(source, 'node-backend')).toThrow();
  });
  it('retains bundled children without inventing a child integrity or silently dropping them', () => {
    const parentIntegrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    const packages: Record<string, Record<string, unknown>> = {
      '': {}, 'node_modules/parent': { version: '1.0.0', integrity: parentIntegrity },
      'node_modules/parent/node_modules/child': { version: '2.0.0', inBundle: true }
    };
    const parse = () => inspectPackedNpmLock(JSON.stringify({ lockfileVersion: 3, packages }), 'standard-frontend');
    const result = parse();
    expect(result.components).toHaveLength(2);
    expect(result.components[1]).toMatchObject({
      name: 'child', integrity: null, bundleParent: { integrity: parentIntegrity },
      independentBundledBytesVerified: false
    });
    delete packages['node_modules/parent']!.integrity;
    expect(parse).toThrow('npm-package-integrity');
    packages['node_modules/parent']!.integrity = parentIntegrity;
    packages['node_modules/unbound'] = { version: '1.0.0', inBundle: true };
    expect(parse).toThrow('unbound-bundled-component');
  });
  it('keeps every declared Node/frontend lock entry and exact source bytes', async () => {
    for (const [id, directory] of [['node-backend', 'node-backend'], ['standard-frontend', 'frontend']]) {
      const source = await readFile(path.join(process.cwd(), 'assets', 'locks', directory!, 'package-lock.json'), 'utf8');
      const result = inspectPackedNpmLock(source, id!);
      expect(result.components).toHaveLength(Object.keys(JSON.parse(source).packages).length - 1);
      expect(result.inputDigest).toBe(`sha256:${createHash('sha256').update(source).digest('hex')}`);
    }
  });
});

it.runIf(process.env.LIFTOFF_REAL_PACKED_GO_ROOT !== undefined)(
  'reconciles real exact packed Go/tool components into the separate template SBOM without vulnerability claims',
  async () => {
    const root = process.env.LIFTOFF_REAL_PACKED_GO_ROOT!, parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!path.isAbsolute(root) || !parent || !path.isAbsolute(parent)) throw new Error('Explicit retained artifact and private parent required.');
    const candidate = JSON.parse(await readFile(path.join(root, 'candidate.json'), 'utf8'));
    const tarball = await readFile(path.join(root, candidate.artifact.filename));
    const go = await resolvePackedGoComponents({
      repository: process.cwd(), workspaceParent: parent, go: '/opt/homebrew/bin/go', candidate, tarball
    });
    const sbom = packedTemplateSbom(candidate, tarball, go);
    expect(sbom.components).toHaveLength(826);
    expect(new Set(sbom.components.map(component => component['bom-ref'])).size).toBe(826);
    expect(go.extraction.map(scope => [scope.selected, scope.extracted])).toEqual([[77, 77], [205, 205], [263, 263], [205, 205]]);
    expect(sbom.metadata.component.hashes[0]!.content).toBe(candidate.artifact.sha256.slice(7));
    expect(sbom.metadata.properties).toContainEqual({ name: 'liftoff:vulnerability-verdict', value: 'not-produced' });
    expect(() => verifiedPackedGoComponents(structuredClone(go))).toThrow('unissued-go-inventory');
    const component = go.inventories[0]!.components[0]!;
    component.version += '-changed';
    expect(() => packedTemplateSbom(candidate, tarball, go)).toThrow('unissued-go-inventory');
  }, 300_000
);

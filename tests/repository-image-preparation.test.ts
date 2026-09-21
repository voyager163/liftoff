import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { imageUvRelease, pythonPreparationArguments, verifyImageUvVersion } from '../scripts/repository-security/image-preparation.ts';

describe('isolated Python image preparation', () => {
  it('binds the real version metadata to the exact release commit and target triple', () => {
    const version = 'uv 0.12.7 (61291a8ca 2026-08-27 aarch64-apple-darwin)\n';
    expect(verifyImageUvVersion(version, 'darwin-arm64')).toEqual({
      version: '0.12.7', commit: '61291a8ca', target: 'aarch64-apple-darwin'
    });
    expect(verifyImageUvVersion(version.replace('\n', '\r\n'), 'darwin-arm64').version).toBe('0.12.7');
    for (const invalid of [version.replace('0.12.7', '0.12.8'), version.replace('61291a8ca', 'a'.repeat(9)), 'uv 0.12.7\n']) {
      expect(() => verifyImageUvVersion(invalid, 'darwin-arm64')).toThrow('uv-version');
    }
    expect(() => verifyImageUvVersion(version, 'linux-arm64')).toThrow('uv-version');
  });

  it('retains supported-stack ownership and exact public uv pins', async () => {
    const baseline = JSON.parse(await readFile(path.join(process.cwd(), 'assets', 'supported-stack.json'), 'utf8'));
    expect(imageUvRelease.version).toBe(baseline.packageManagers.uv.version);
    expect(imageUvRelease.pythonVersion).toBe(baseline.runtimes.python.version);
    expect(Object.keys(imageUvRelease.assets)).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);
    for (const [name, digest] of Object.values(imageUvRelease.assets)) {
      expect(name).toMatch(/^uv-/);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('uses the explicit interpreter, frozen lock and canonical index without interpreter downloads', () => {
    const python = path.resolve('private runtime', 'python');
    const plain = pythonPreparationArguments(python, false), worker = pythonPreparationArguments(python, true);
    expect(plain).toEqual([
      'sync', '--frozen', '--python', python, '--no-managed-python', '--no-python-downloads', '--no-config',
      '--keyring-provider', 'disabled', '--default-index', 'https://pypi.org/simple', '--project', 'backend', '--extra', 'test'
    ]);
    expect(worker).toEqual([...plain, '--extra', 'functions']);
    expect(() => pythonPreparationArguments('relative-python', false)).toThrow('python-path');
  });
});

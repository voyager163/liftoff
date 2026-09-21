import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecurityWorkspace, resolveSecurityPath } from '../scripts/repository-security/workspace.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function parent() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-security-test '));
  roots.push(root);
  return root;
}

describe('registered security workspace', () => {
  it('writes exact registered files and cleans only its own private workspace', async () => {
    const base = await parent(), workspace = await createSecurityWorkspace(base);
    await writeFile(path.join(base, 'neighbor'), 'keep');
    await workspace.write(['backend', 'src', 'main.ts'], 'export const value = 1;\n');
    await workspace.verify(['backend', 'src', 'main.ts'], 'export const value = 1;\n');
    await workspace.cleanup();
    expect(await readdir(base)).toEqual(['neighbor']);
    await expect(workspace.cleanup()).rejects.toThrow('workspace-closed');
  });

  it('rejects traversal, aliases, duplicate paths and owner-marker replacement', async () => {
    const workspace = await createSecurityWorkspace(await parent());
    await expect(workspace.write(['..', 'escape'], '')).rejects.toThrow('unsafe-location');
    await workspace.write(['Backend', 'input'], 'first');
    await expect(workspace.write(['backend', 'second'], '')).rejects.toThrow('workspace-case-alias');
    await expect(workspace.write(['Backend', 'INPUT'], '')).rejects.toThrow('workspace-entry-conflict');
    await expect(workspace.write(['.security-owner'], '')).rejects.toThrow('workspace-entry-conflict');
    await workspace.cleanup();
  });

  it('fails closed rather than deleting unregistered build output', async () => {
    const workspace = await createSecurityWorkspace(await parent());
    await workspace.write(['known'], 'known');
    await writeFile(path.join(workspace.root, 'unknown'), 'keep');
    await expect(workspace.cleanup()).rejects.toThrow('workspace-unregistered-entry');
    expect(await readFile(path.join(workspace.root, 'known'), 'utf8')).toBe('known');
    expect(await readFile(path.join(workspace.root, 'unknown'), 'utf8')).toBe('keep');
  });

  it('detects changed input and rejects symlink or junction cleanup targets', async () => {
    const base = await parent(), workspace = await createSecurityWorkspace(base);
    await workspace.write(['input'], 'original');
    await writeFile(path.join(workspace.root, 'input'), 'changed');
    await expect(workspace.verify(['input'], 'original')).rejects.toThrow('workspace-input-changed');
    const external = path.join(base, 'outside');
    await mkdir(external);
    await writeFile(path.join(external, 'keep'), 'keep');
    await symlink(external, path.join(workspace.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(workspace.cleanup()).rejects.toThrow('workspace-unregistered-entry');
    expect(await readFile(path.join(external, 'keep'), 'utf8')).toBe('keep');
  });

  it('resolves Windows and POSIX identities with platform-native separators', () => {
    expect(resolveSecurityPath('C:\\repo with spaces', ['backend', 'uv.lock'], path.win32))
      .toBe(path.win32.join('C:\\repo with spaces', 'backend', 'uv.lock'));
    expect(resolveSecurityPath('/repo with spaces', ['backend', 'uv.lock'], path.posix))
      .toBe(path.posix.join('/repo with spaces', 'backend', 'uv.lock'));
  });
});

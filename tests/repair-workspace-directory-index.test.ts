import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { indexWorkspaceDirectoryAncestors } from '../src/adapters/filesystem/repair-workspace-directory-index.js';
import { workspaceWithin } from '../src/adapters/filesystem/repair-workspaces.js';
import type { RepairWorkspaceFileIdentity } from '../src/application/repair/workspaces-types.js';

const root = path.parse(process.cwd()).root;
const absolute = (...parts: string[]) => path.join(root, ...parts);
const identity = (index: number): RepairWorkspaceFileIdentity => ({
  device: '1', inode: String(index + 1), birthtime: String(index + 100)
});
const expected = (directories: ReadonlyMap<string, RepairWorkspaceFileIdentity>, target: string) =>
  new Map([...directories].filter(([directory]) => directory !== target && workspaceWithin(directory, target)));

describe('one-cleanup captured-directory ancestor index', () => {
  it('selects exactly the former guarded set and order, including folded aliases and root boundaries', () => {
    const directories = new Map([
      absolute('Workspace', 'cache', 'nested'),
      absolute('Workspace', 'cache-extra'),
      absolute('Workspace'),
      absolute('workspace', 'cache'),
      root,
      absolute('Workspace', 'cache'),
      absolute('Workspace', 'Caf\u00e9'),
      absolute('Workspace', 'Cafe\u0301'),
      absolute('Workspace', '\u0130'),
      absolute('Unrelated')
    ].map((directory, index) => [directory, identity(index)]));
    const select = indexWorkspaceDirectoryAncestors(directories);
    for (const target of [
      root, absolute('Workspace'), absolute('Workspace', 'cache'), absolute('WORKSPACE', 'cache'),
      absolute('Workspace', 'cache', 'nested', 'file'), absolute('Workspace', 'cache-extra', 'file'),
      absolute('workspace', 'CAF\u00c9', 'file'), absolute('Workspace', 'Cafe\u0301', 'file'),
      absolute('Workspace', 'i\u0307', 'file'), absolute('Unrelated', 'file'), absolute('Other')
    ]) {
      expect([...select(target)], target).toEqual([...expected(directories, target)]);
      for (const [directory, observed] of select(target)) expect(observed).toBe(directories.get(directory));
    }
  });

  it('honors successfully deleted directories without changing other pinned identities or ordering', () => {
    const directories = new Map([
      root, absolute('Owned'), absolute('Owned', 'cache'), absolute('Owned', 'cache', 'dependency')
    ].map((directory, index) => [directory, identity(index)]));
    const select = indexWorkspaceDirectoryAncestors(directories);
    const target = absolute('Owned', 'cache', 'dependency', 'file');
    for (const directory of [absolute('Owned', 'cache', 'dependency'), absolute('Owned', 'cache')]) {
      expect([...select(target)]).toEqual([...expected(directories, target)]);
      directories.delete(directory);
      expect([...select(target)]).toEqual([...expected(directories, target)]);
    }
    expect([...select(absolute('Owned'))]).toEqual([...expected(directories, absolute('Owned'))]);
  });

  it('never enumerates the entire captured directory set again for individual effect guards', () => {
    const directories = new Map([[root, identity(0)], [absolute('Owned'), identity(1)]]);
    for (let index = 0; index < 1600; index++) {
      directories.set(absolute('Owned', `dependency-${index}`), identity(index + 2));
    }
    const reference = new Map(directories);
    const enumerations = [
      vi.spyOn(directories, 'keys'), vi.spyOn(directories, 'entries'), vi.spyOn(directories, 'values'),
      vi.spyOn(directories, 'forEach'), vi.spyOn(directories, Symbol.iterator)
    ];
    const select = indexWorkspaceDirectoryAncestors(directories);
    const enumerationCount = () => enumerations.reduce((total, mock) => total + mock.mock.calls.length, 0);
    expect(enumerationCount()).toBe(1);
    for (let index = 0; index < 200; index++) {
      const target = absolute('Owned', `dependency-${index}`, 'file');
      expect([...select(target)]).toEqual([...expected(reference, target)]);
    }
    expect(enumerationCount()).toBe(1);
    for (const mock of enumerations) mock.mockRestore();
  });
});

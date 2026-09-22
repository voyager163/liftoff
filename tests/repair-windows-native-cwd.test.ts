import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationVerificationCwdParts, verifyApplicationPatch } from '../src/application/repair/application-verification.js';
import { inspectApplicationPatch } from '../src/application/repair/application-patch.js';
import * as locations from '../src/adapters/filesystem/repair-workspaces.js';
import * as workspaces from '../src/application/repair/workspaces.js';
import * as controller from '../src/adapters/process/windows-job-runner.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import {
  createApplicationRepairFixture, stageApplicationRepairFixture, applicationVerificationFixtureContext
} from './fixtures/repair-application.js';
import { createOwnedFixtureRoot } from './fixtures/owned-root.js';

const owned: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('complete pre-allocation Windows command-cwd admission', () => {
  it('includes declared checks, resolved checks, each preparation root and every preparation command', () => {
    expect(applicationVerificationCwdParts({
      commands: [{ cwdPathParts: [] }, { cwdPathParts: ['check'] }],
      executionCommands: [{ cwdPathParts: ['resolved'] }],
      preparation: [{ cwdPathParts: ['backend'], commands: [{ cwdPathParts: ['backend', 'nested'] }, { cwdPathParts: [] }] }]
    })).toEqual([[], ['check'], ['resolved'], ['backend'], ['backend', 'nested'], []]);
    expect(() => applicationVerificationCwdParts({
      commands: [], executionCommands: [], preparation: [{ cwdPathParts: ['backend'], commands: [{ cwdPathParts: ['..'] }] }]
    })).toThrow('portable');
  });
  it('reports a causal cwd blocker with no new registry/workspace allocation or requested command', async () => {
    const root = (await createOwnedFixtureRoot(os.tmpdir(), 'lf-cwd-')).name; owned.push(root);
    const fixture = await createApplicationRepairFixture(root);
    const patch = await stageApplicationRepairFixture(fixture.root, fixture.stage, fixture.manifest);
    const candidate = await inspectApplicationPatch(fixture.root, fixture.manifest, patch.patchPath);
    expect(candidate.blockers).toEqual([]);
    const context = await applicationVerificationFixtureContext(fixture.root, candidate, {
      projectCode: true, dependencyPreparation: false, network: false
    });
    const runner = new NodeCommandRunner(), run = vi.spyOn(runner, 'run');
    const allocation = vi.spyOn(workspaces, 'createRepairVerificationWorkspace');
    vi.spyOn(controller, 'resolveWindowsPowerShellPath').mockReturnValue(process.execPath);
    const rootPath = path.win32.join('C:\\', 'a'.repeat(170), 'b'.repeat(64));
    vi.spyOn(locations, 'repairWorkspaceLocation').mockResolvedValue({
      root: rootPath, projectRoot: 'C:\\project', projectKey: 'b'.repeat(64),
      projectIdentity: { device: '1', inode: '1', birthtime: '1' },
      registryDirectory: 'C:\\registry', privateRoot: 'C:\\private'
    });
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const result = await verifyApplicationPatch(fixture.root, candidate, runner, context);
      expect(result.status).toBe('blocked');
      expect(result.blockers.join(' ')).toContain('[unsupported-native-cwd]');
      expect(result.blockers.join(' ')).not.toContain(rootPath);
      expect(result.workspaceId).toBeUndefined();
      expect(result.commands).toEqual([]);
      expect(result.preparation).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      expect(allocation).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  });
});

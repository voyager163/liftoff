import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindGovernanceTransitionContext } from '../src/governance-activation/transition-context.js';
import { getUpdatePreviewDirectory, nodeUpdatePreviewFileSystem } from '../src/adapters/filesystem/update-previews.js';
import { approveGovernancePreview, saveGovernancePreview } from '../src/governance-activation/public-plans.js';
import { assertGovernanceApprovalIssued } from '../src/governance-activation/authority-records.js';
import { activationProducerFixture } from './helpers/activation-producer-fixture.js';
import { WorkflowGitHubFixture, workflowFixtureNow, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';

const fixtures: Awaited<ReturnType<typeof activationProducerFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

describe('one private governance execution context', () => {
  it('preserves transports and captures the same private namespace for both providers', () => {
    const env = { XDG_STATE_HOME: '/private/state/original', UNRELATED_SETTING: 'not retained' };
    const transport = new WorkflowGitHubFixture();
    const context = bindGovernanceTransitionContext({
      storage: { platform: 'linux', homedir: '/private/home', env },
      adapters: { githubActivation: { transport } }
    });
    env.XDG_STATE_HOME = '/private/state/changed';
    expect(getUpdatePreviewDirectory(context.storage)).toContain('/private/state/original/');
    expect(context.storage.env).not.toHaveProperty('UNRELATED_SETTING');
    expect(Object.isFrozen(context.storage.env)).toBe(true);
    expect(context.adapters.githubActivation?.transport).toBe(transport);
    expect(context.adapters.githubActivation?.storage).toBe(context.storage);
    expect(context.adapters.azureActivation?.storage).toBe(context.storage);
  });

  it('retains compatible provider-specific storage inputs without requiring shared object identity', () => {
    const storage = { platform: 'linux' as const, homedir: '/private/home', env: {} };
    const context = bindGovernanceTransitionContext({
      adapters: { githubActivation: { storage }, azureActivation: { storage: { ...storage, env: {} } } }
    });
    expect(context.storage.homedir).toBe('/private/home');
    expect(context.adapters.azureActivation?.storage).toBe(context.adapters.githubActivation?.storage);
  });

  it.each(['directory', 'platform', 'repository', 'filesystem'] as const)('refuses a conflicting %s boundary instead of splitting approval and recovery', (kind) => {
    const storage = { platform: 'linux' as const, homedir: '/private/home', repositoryRoot: '/project', env: {} };
    const conflicting = kind === 'directory' ? { ...storage, homedir: '/other/home' } :
      kind === 'platform' ? { ...storage, platform: 'darwin' as const } :
      kind === 'repository' ? { ...storage, repositoryRoot: '/other/project' } :
      { ...storage, fileSystem: { ...nodeUpdatePreviewFileSystem } };
    expect(() => bindGovernanceTransitionContext({
      storage, adapters: { githubActivation: { storage: conflicting } }
    })).toThrow(/same explicitly selected private storage boundary/);
  });

  it('uses the selected transport and private store through actual preview, replan and approval issuance', async () => {
    const protocol = new WorkflowGitHubFixture(`${workflowFixtureSource}\n# Previously published source\n`);
    const run = vi.fn(async () => { throw new Error('The selected transport must not fall back to an ambient provider command.'); });
    const f = await activationProducerFixture('repository-workflow-source-ready', {
      sourceSha: protocol.baseSha, paths: [workflowFixturePath],
      publication: {
        featureBranch: 'automation/reviewed-context', repositoryId: 42, actorId: 7,
        commitTime: workflowFixtureNow, commitMessage: 'Publish exact reviewed source'
      }
    }, { run });
    fixtures.push(f);
    f.inspection.scope = 'repository';
    const workflow = path.join(f.projectRoot, workflowFixturePath);
    await mkdir(path.dirname(workflow), { recursive: true });
    await writeFile(workflow, workflowFixtureSource);
    await f.refreshInputs();
    const adapters = { githubActivation: { transport: protocol } };
    const saved = await saveGovernancePreview(f.inspection, { runner: f.runner, now: f.now, storage: f.storage, adapters });
    expect(saved?.preview.plan.phaseId).toBe('repository-workflow-source-ready');
    const approved = await approveGovernancePreview({
      projectRoot: f.projectRoot, fingerprint: saved!.preview.fingerprint,
      inspect: async () => f.inspection, runner: f.runner, now: f.now, storage: f.storage, adapters
    });
    await assertGovernanceApprovalIssued(f.projectRoot, approved.envelope, f.storage);
    expect(run).not.toHaveBeenCalled();
    expect(protocol.requests.length).toBeGreaterThan(0);
    expect(protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    const otherHome = path.join(f.root, 'other-private-home');
    await mkdir(otherHome, { mode: 0o700 });
    await expect(assertGovernanceApprovalIssued(f.projectRoot, approved.envelope, {
      ...f.storage, homedir: otherHome
    })).rejects.toThrow(/no project-bound authority/);
  });
});

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { controlledNodeTestFixture, deriveRequiredNodeTestChecks, matchesProtectedRefFamily } from '../src/adapters/github/workflow-check-recipes.js';
import { GitHubActivationClient } from '../src/adapters/github/activation-rest.js';
import { assertPublicationWorkflowEffects, readbackWorkflowContent } from '../src/adapters/github/production-workflows.js';
import { WorkflowGitHubFixture, dispatchFixtureSource, workflowFixturePath, workflowFixtureSource } from './helpers/workflow-publication-fixture.js';

describe('real controlled source-validation fixture behavior', () => {
  it('keeps single-level and recursive release/hotfix proof scopes distinct', () => {
    for (const prefix of ['release', 'hotfix'] as const) {
      expect(matchesProtectedRefFamily(`${prefix}/1.2.3`, `${prefix}/*`)).toBe(true);
      expect(matchesProtectedRefFamily(`${prefix}/1.2.3`, `${prefix}/**`)).toBe(true);
      expect(matchesProtectedRefFamily(`${prefix}/maintenance/1.2.3`, `${prefix}/*`)).toBe(false);
      expect(matchesProtectedRefFamily(`${prefix}/maintenance/1.2.3`, `${prefix}/**`)).toBe(true);
      expect(matchesProtectedRefFamily(`${prefix}/security/fixes/1.2.3`, `${prefix}/**`)).toBe(true);
      expect(matchesProtectedRefFamily(`${prefix}-other/1.2.3`, `${prefix}/**`)).toBe(false);
      expect(matchesProtectedRefFamily(`feature/${prefix}/1.2.3`, `${prefix}/**`)).toBe(false);
      expect(() => matchesProtectedRefFamily(`${prefix}/../main`, `${prefix}/**`)).toThrow(/safe branch/);
    }
  });

  it('derives recursive policy families for an unfiltered immutable pull-request workflow', async () => {
    const content = workflowFixtureSource.replace('  pull_request:\n    branches: [develop]', '  pull_request: {}');
    const protocol = new WorkflowGitHubFixture(content);
    const source = await readbackWorkflowContent(new GitHubActivationClient(protocol), 'owner/repo', workflowFixturePath, protocol.baseSha);
    expect(deriveRequiredNodeTestChecks(source, 4)[0]!.refFamilies).toEqual(['develop', 'main', 'release/**', 'hotfix/**']);
    expect(protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not let workflow publication implicitly authorize cloud credentials or private runners', () => {
    expect(() => assertPublicationWorkflowEffects(workflowFixtureSource)).not.toThrow();
    expect(() => assertPublicationWorkflowEffects(dispatchFixtureSource)).not.toThrow();
    expect(() => assertPublicationWorkflowEffects(workflowFixtureSource.replace('contents: read', 'id-token: write'))).toThrow(/not credential or cloud execution authority/);
    expect(() => assertPublicationWorkflowEffects(workflowFixtureSource.replace('pull_request:', 'pull_request_target:'))).toThrow(/privileged PR-target/);
    expect(() => assertPublicationWorkflowEffects(workflowFixtureSource.replace('ubuntu-24.04', 'self-hosted'))).toThrow(/private\/self-hosted/);
    expect(() => assertPublicationWorkflowEffects(workflowFixtureSource.replace('run: node --test', 'run: echo ${{ secrets.AZURE_CREDENTIALS }}'))).toThrow(/not credential or cloud execution authority/);
  });

  it('passes the real Node test validator positively and fails that same validator deliberately without changing application code', async () => {
    const root = path.resolve(`tests/.source-check-recipe-${randomUUID()}`);
    let settled = true;
    await mkdir(path.join(root, 'test'), { recursive: true });
    await mkdir(path.join(root, 'home'));
    try {
      for (const polarity of ['positive', 'negative'] as const) {
        const fixture = controlledNodeTestFixture(polarity);
        await writeFile(path.join(root, fixture.path), fixture.content);
        const result = spawnSync(process.execPath, ['--test', fixture.path], {
          cwd: root, env: { ...process.env, HOME: path.join(root, 'home') }, timeout: 10_000, encoding: 'utf8'
        });
        if (result.error || result.signal) { settled = false; throw new Error(`Controlled test process did not settle normally; fixture retained at ${root}.`); }
        expect(result.status).toBe(polarity === 'positive' ? 0 : 1);
        expect(result.stdout).toContain('reviewed Liftoff source-validation control');
        if (polarity === 'negative') expect(result.stdout).toContain('controlled-invalid');
      }
    } finally {
      if (settled) await rm(root, { recursive: true, force: true });
    }
  });
});

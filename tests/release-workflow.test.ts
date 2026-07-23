import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release workflow', () => {
  it('gates publishing on release identity and then runs strict canonical verification', async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    const workflow = await readFile(path.join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
    const identityIndex = workflow.indexOf('- name: Verify release identity');
    const publishIndex = workflow.indexOf('- name: Publish to npm');
    const verificationIndex = workflow.indexOf('- name: Verify published package from canonical npm');

    expect(packageJson.scripts['verify:release-identity']).toContain('scripts/verify-release-identity.mjs');
    expect(packageJson.scripts['verify:published']).toContain('scripts/verify-published-package.mjs');
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeLessThan(publishIndex);
    expect(verificationIndex).toBeGreaterThan(publishIndex);
    const identityStep = workflow.slice(identityIndex, publishIndex);
    expect(identityStep).toContain("github.ref_type == 'tag'");
    expect(identityStep).toContain('github.ref_name');
    expect(identityStep).toContain('npm run verify:release-identity -- "$RELEASE_TAG"');
    expect(identityStep).toContain('npm run verify:release-identity');
    expect(identityStep).not.toContain('continue-on-error');
    const verificationStep = workflow.slice(verificationIndex);
    expect(verificationStep).toContain('npm run verify:published -- "${{ steps.dist-tag.outputs.tag }}"');
    expect(verificationStep).not.toContain('--allow-legacy-version-command');
    expect(verificationStep).not.toContain('continue-on-error');
  });

  it('keeps package and smoke verification on Linux, macOS, and Windows CI', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(workflow).toContain('run: npm run check');
    expect(workflow).toContain('run: npm run smoke:package');
  });
});
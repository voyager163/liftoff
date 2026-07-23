import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release workflow', () => {
  it('runs strict canonical verification after publishing without suppressing failure', async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    const workflow = await readFile(path.join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf8');
    const publishIndex = workflow.indexOf('- name: Publish to npm');
    const verificationIndex = workflow.indexOf('- name: Verify published package from canonical npm');

    expect(packageJson.scripts['verify:published']).toContain('scripts/verify-published-package.mjs');
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(verificationIndex).toBeGreaterThan(publishIndex);
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
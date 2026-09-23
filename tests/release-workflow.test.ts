import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
    expect(verificationStep).toContain('npm run verify:published -- "$DIST_TAG"');
    expect(verificationStep).not.toContain('--allow-legacy-version-command');
    expect(verificationStep).not.toContain('continue-on-error');
    const definition = parse(workflow);
    expect(definition.permissions).toEqual({ contents: 'read' });
    expect(definition.on.workflow_dispatch).toBeNull();
    expect(definition.jobs.publish.needs).toBe('qualify');
    expect(definition.jobs.publish.environment).toBe('npm-release');
    expect(definition.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const qualify = definition.jobs.qualify.steps;
    const publish = definition.jobs.publish.steps;
    expect(qualify.some((step: { run?: string }) => step.run === 'node scripts/release-artifact.mjs check-ref')).toBe(true);
    expect(qualify.findIndex((step: { id?: string }) => step.id === 'bundle')).toBeGreaterThan(
      qualify.findIndex((step: { name?: string }) => step.name === 'Verify release identity')
    );
    const exactSmokeIndex = qualify.findIndex((step: { name?: string }) => step.name === 'Smoke-test the exact release tarball');
    expect(qualify[exactSmokeIndex].run).toContain('npm run smoke:package -- --tarball');
    expect(exactSmokeIndex).toBeGreaterThan(qualify.findIndex((step: { id?: string }) => step.id === 'bundle'));
    expect(exactSmokeIndex).toBeLessThan(qualify.findIndex((step: { id?: string }) => step.id === 'upload'));
    const download = publish.find((step: { uses?: string }) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download.with['artifact-ids']).toBe('${{ needs.qualify.outputs.artifact_id }}');
    const revalidate = publish.find((step: { id?: string }) => step.id === 'artifact');
    expect(revalidate.env.EXPECTED_SHA256).toBe('${{ needs.qualify.outputs.sha256 }}');
    expect(publish.find((step: { name?: string }) => step.name === 'Publish to npm').run)
      .toContain('npm publish "$RUNNER_TEMP/liftoff-release/$RELEASE_FILENAME" --ignore-scripts');
    expect(publish.findIndex((step: { id?: string }) => step.id === 'artifact')).toBeLessThan(
      publish.findIndex((step: { name?: string }) => step.name === 'Publish to npm')
    );
  });

  it('keeps package and smoke verification on Linux, macOS, and Windows CI', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow.match(/os: \[ubuntu-latest, macos-latest, windows-latest]/g)).toHaveLength(1);
    expect(workflow).toMatch(/^  workflow_dispatch:$/m);
    expect(workflow).not.toContain('npm publish');
    expect(workflow).toContain('run: npm run check');
    expect(workflow).toContain('run: npm run smoke:package');
    expect(workflow).toContain('tests/interactive.test.ts');
    expect(workflow).toContain('tests/project-dependencies.test.ts');
    expect(workflow).toContain('tests/project-discovery.test.ts');
    expect(workflow).toContain('tests/project-lock.test.ts');
    expect(workflow).toContain('tests/filesystem-recovery.test.ts');
    expect(workflow).toContain('tests/import-boundaries.test.ts');
    expect(workflow).toContain('tests/contract.test.ts');
    expect(workflow).toContain('tests/infrastructure-layout.test.ts');
    expect(workflow).toContain('tests/governance-assessment.test.ts');
    expect(workflow).toContain('LIFTOFF_FRAMEWORK_SMOKE: "1"');
    expect(workflow).toContain('@fission-ai/openspec@1.11.0');
    expect(workflow).toContain('specify-cli==1.0.1');
    expect(workflow).not.toContain('tests/power-apps-assets.test.ts');
    expect(workflow).toContain('node-version: "24.20.0"');
    expect(workflow).not.toContain('verify:power-apps-starter');
  });
});
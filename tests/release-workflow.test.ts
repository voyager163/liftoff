import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

describe('release workflow', () => {
  it('keeps one explicit operation with no tag-trigger recursion or dry-run publisher authority', async () => {
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    const source = await readFile(path.join(packageRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    const workflow = parse(source);
    expect(packageJson.scripts['verify:release-identity']).toContain('scripts/verify-release-identity.mjs');
    expect(packageJson.scripts['verify:published']).toContain('scripts/verify-published-package.mjs');
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({ group: 'release-liftoff', 'cancel-in-progress': false });
    expect(workflow.env.LIFTOFF_TELEMETRY).toBe('0');
    for (const name of ['validate', 'qualification', 'canonical-verify']) {
      expect(workflow.jobs[name].permissions).toEqual({ contents: 'read' });
      expect(workflow.jobs[name].environment).toBeUndefined();
    }
    for (const name of ['assemble', 'publish', 'finalize']) {
      expect(workflow.jobs[name].if).toContain("github.ref == 'refs/heads/main'");
      expect(workflow.jobs[name].if).toContain("github.event_name == 'workflow_dispatch'");
      expect(workflow.jobs[name].if).toContain('inputs.dry_run == false');
      expect(workflow.jobs[name].if).toContain("needs.qualification.outputs.publication-authorized == 'true'");
      expect(workflow.jobs[name].environment).toBe('npm-publisher');
    }
    expect(workflow.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow.jobs.assemble.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.finalize.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.publish.needs).toContain('assemble');
    expect(workflow.jobs['canonical-verify'].needs).toContain('publish');
    expect(workflow.jobs.finalize.needs).toContain('canonical-verify');
    expect(source).not.toContain('continue-on-error');
    expect(source).not.toContain('--allow-legacy-version-command');
    expect(source).not.toContain('secrets.');
  });

  it('packs exactly once via the helper, retaining existing functional and canonical contracts', async () => {
    const workflow = parse(await readFile(path.join(packageRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
    const runs = workflow.jobs.validate.steps.map((step: { run?: string }) => step.run ?? '').join('\n');
    expect(runs).toContain('npm run check');
    expect(runs).toContain('npm run audit:template-dependencies');
    expect(runs).toContain('npm run verify:standard-node-templates');
    expect(runs).toContain('node scripts/verify-release-identity.mjs');
    expect(runs.match(/scripts\/qualify-npm-candidate.mjs/g)).toHaveLength(1);
    expect(runs).toContain('qualify-npm-candidate.mjs --runtime-assessment');
    expect(runs).not.toContain('--template-assessment');
    expect(runs).not.toContain('npm exec --offline -- node scripts/qualify-npm-candidate.mjs');
    expect(runs).not.toMatch(/npm pack|smoke:package|npm publish/);
    for (const name of ['assemble', 'publish', 'finalize']) {
      const privileged = workflow.jobs[name].steps.map((step: { run?: string }) => step.run ?? '').join('\n');
      expect(privileged).not.toMatch(/npm (ci|install|exec|run|publish)|dist\/cli|package-smoke|verify-published/);
      expect(privileged).toContain('node scripts/release-coordinator.mjs');
    }
    const verifier = workflow.jobs['canonical-verify'];
    expect(verifier.steps.some((step: { run?: string }) => step.run?.includes('release-coordinator.mjs canonical'))).toBe(true);
    expect(verifier.steps.some((step: { run?: string }) => step.run?.includes('npm exec --offline'))).toBe(false);
    const coordinator = await readFile(path.join(packageRoot, 'scripts', 'release-coordinator.mjs'), 'utf8');
    expect(coordinator).toContain('verifyPublishedPackage');
    expect(coordinator).toContain('expectedIntegrity: candidate.artifact.integrity');
    expect(coordinator).toContain('publication-authorized=false');
    expect(coordinator).not.toContain('publication-authorized=true');
  });

  it('uses verified full-SHA action descriptors and exact current-run artifact IDs, not PR artifacts or caches', async () => {
    const workflow = parse(await readFile(path.join(packageRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
    const allowed = new Set([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
      'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
      'opentofu/setup-opentofu@a1320f892987e89d278cc92dc5adc984fb93aca4',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'
    ]);
    for (const job of Object.values(workflow.jobs) as Array<{
      'timeout-minutes': number;
      steps: Array<{ uses?: string; with: Record<string, unknown> }>;
    }>) {
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
      for (const step of job.steps) {
        if (!step.uses) continue;
        expect(allowed.has(step.uses)).toBe(true);
        if (step.uses.startsWith('actions/checkout@')) {
          expect(step.with.ref).toBe('${{ github.sha }}');
          expect(step.with['persist-credentials']).toBe(false);
        }
        if (step.uses.startsWith('actions/download-artifact@')) {
          expect(step.with['artifact-ids']).toMatch(/^\$\{\{ needs\.(validate|canonical-verify)\.outputs\.artifact-id }}$/);
          expect(step.with['run-id']).toBeUndefined();
          expect(step.with.pattern).toBeUndefined();
          expect(step.with['github-token']).toBeUndefined();
        }
        if (step.uses.startsWith('actions/upload-artifact@')) {
          expect(step.with.name).toContain('${{ github.run_id }}-${{ github.run_attempt }}');
          expect(step.with.overwrite).toBe(false);
          expect(step.with['if-no-files-found']).toBe('error');
        }
        if (step.uses.startsWith('actions/setup-node@')) expect(step.with['package-manager-cache']).toBe(false);
      }
    }
  });

  it('keeps package and smoke verification on Linux, macOS, and Windows CI', async () => {
    const workflow = await readFile(path.join(packageRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

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
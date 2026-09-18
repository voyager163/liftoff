import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseManifest, loadManifest } from '../src/application/project/manifest.js';
import { inspectAdoption } from '../src/application/project-evolution/adoption/planning.js';
import { adoptProject, type AdoptRequest, type AdoptionReport } from '../src/application/project-evolution/adoption/use-case.js';
import { adoptionRequestIssue } from '../src/application/project-evolution/adoption/request.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { buildArtifacts, buildManifest } from '../src/templates.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream, ReadyInitRunner, scriptedTtyInput, ttyCaptureStream } from './helpers.js';
import type { ExecutionContext } from '../src/application/context.js';
import type { CommandRunner } from '../src/process-runner.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import type { AdoptionProposal } from '../src/application/project-evolution/adoption/proposal.js';
import { nativeExecutableObserver } from '../src/adapters/filesystem/executables.js';
import { createScopedUserLocalRecordStore, nodeUpdatePreviewFileSystem } from '../src/adapters/filesystem/update-previews.js';
import { adoptCommand } from '../src/cli/commands/adopt.js';
import { inspectAssessmentProject } from '../src/governance-assessment/project.js';
import { AssessmentFiles } from '../src/governance-assessment/readers.js';
import * as assessmentService from '../src/application/standards-assessment/runner.js';
import type { AssessmentResult } from '../src/domain/standards-assessment/types.js';
import * as packagedResources from '../src/adapters/packaged-assets/resource-catalog.js';
import { computeProfileCatalogDigest, computeProfileDigest } from '../src/domain/standards/profile-schema.js';

const roots: string[] = [];
const clock = new Date('2026-09-14T16:00:00Z');
afterEach(async () => {
  packagedResources.setPackageRootOverride(undefined);
  packagedResources.resetResourceCatalogCache();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture() {
  const parent = path.resolve('tests', `.manifest8-adoption-${randomUUID()}`);
  roots.push(parent);
  const root = path.join(parent, 'project'), staging = path.join(parent, 'staging'), home = path.join(parent, 'home');
  for (const directory of [root, staging, home]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'custom-vue', private: true, type: 'module', dependencies: { vue: '^3.5.0' } }, null, 2)}\n`);
  await writeFile(path.join(root, 'App.vue'), '<template><main>Preserved business dashboard</main></template>\n');
  return { parent, root, staging, home };
}

async function isolatePackagedResources(source: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const root = path.join(source.parent, 'installed-package');
  await mkdir(root);
  await cp(path.resolve('assets'), path.join(root, 'assets'), { recursive: true });
  await cp(path.resolve('package.json'), path.join(root, 'package.json'));
  packagedResources.setPackageRootOverride(root);
  packagedResources.resetResourceCatalogCache();
  return root;
}

async function invoke(
  fixture: Awaited<ReturnType<typeof fixture>>, request: Omit<AdoptRequest, 'project'>,
  extra: Partial<ExecutionContext> = {}
) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const result = await adoptProject({ project: fixture.root, json: true, ...request }, {
    cwd: fixture.parent, stdout, stderr, presentation: new PresentationSession({ stdout, stderr }),
    updateNow: () => clock,
    updatePreview: { homedir: fixture.home, env: {}, repositoryRoot: fixture.root }, ...extra
  });
  return { code: result, report: JSON.parse(stdout.text()) as AdoptionReport, stderr: stderr.text() };
}

async function metadataProposal(source: Awaited<ReturnType<typeof fixture>>): Promise<AdoptionProposal> {
  const current = await inspectAdoption({ project: source.root, profile: 'vue-component', now: clock });
  return {
    schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: source.root,
    inspectionDigest: current.inventory.inspectionDigest, projectName: 'custom-vue', profile: 'vue-component',
    componentRootPathParts: [], framework: { workflow: 'openspec', agents: [], initialize: false, copilotCloud: false },
    governanceProfile: 'none', dynamicReferencesReviewed: true, patch: null, additions: [],
    verification: { commands: [], preparation: [] }
  };
}

function untrustedAssessmentSuccess(report: AssessmentResult): AssessmentResult {
  return {
    ...report, outcome: 'success', exitCode: 0,
    profile: { ...report.profile, status: 'supported' }, diagnostics: [],
    inventory: { ...report.inventory, unobserved: [], limits: { ...report.inventory.limits, exceeded: false } },
    coverage: {
      ...report.coverage, assessedRules: report.coverage.declaredRules, alignedRules: report.coverage.declaredRules,
      differingRules: 0, missingRules: 0, unsupportedRules: 0, unknownRules: 0
    }
  };
}

describe('strict manifest 8 adoption and immutable provenance', () => {
  it('exports a strict bound command handler without requiring central CLI changes', async () => {
    const source = await fixture();
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const context: ExecutionContext = {
      cwd: source.parent, stdout, stderr, updateNow: () => clock,
      updatePreview: { homedir: source.home, env: {}, repositoryRoot: source.root },
      presentation: new PresentationSession({ stdout, stderr, json: true })
    };
    const code = await adoptCommand({
      command: 'adopt', positional: [], flags: { project: source.root, profile: 'vue-component', check: true, json: true }
    }, context);
    const report = JSON.parse(stdout.text()) as AdoptionReport;
    expect(code).toBe(2);
    expect(report.command).toBe('adopt');
    expect(report.inventory?.projectRoot).toBe(source.root);
    expect(report.plan?.component.profile.id).toBe('vue-component');
    expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    await expect(adoptCommand({ command: 'adopt', positional: [], flags: { project: source.root, force: true } }, context)).rejects.toThrow(/force/);
  });

  describe('adoption precondition failure boundaries', () => {
    const fingerprint = 'a'.repeat(64);

    it.each([
      { check: true, approvePlan: fingerprint },
      { check: true, verifyPlan: fingerprint },
      { check: true, recover: true },
      { approvePlan: fingerprint, verifyPlan: fingerprint },
      { allowNetwork: true },
      { allowDependencyPreparation: true },
      { recover: true, profile: 'vue-component' },
      { recover: true, component: 'frontend' },
      { recover: true, proposal: 'proposal.json' },
      { approvePlan: 'abbreviated' },
      { verifyPlan: `sha256:${fingerprint}` }
    ] satisfies Array<Omit<AdoptRequest, 'project'>>)('rejects conflicting or incomplete permission request %j before commands or metadata', async (request) => {
      const source = await fixture();
      const run = vi.fn(async () => { throw new Error('Unapproved process must not run.'); });
      const result = await invoke(source, request, { runner: { run } });
      expect(result.code).toBe(1);
      expect(result.report.committed).toBe(false);
      expect(result.report.effects).toEqual({ preparationCommands: 0, projectCommands: 0, networkAuthorized: false, frameworkCommands: 0 });
      expect(run).not.toHaveBeenCalled();
      expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
      expect(await readdir(source.home)).toEqual([]);
    });

    it.each(['approvePlan', 'verifyPlan'] as const)('uses the shared exact request guard for noncanonical %s values', async (permission) => {
      const source = await fixture();
      const assessment = vi.spyOn(assessmentService, 'assessProject').mockImplementation(async () => {
        throw new Error('Invalid permissions must fail before assessment.');
      });
      expect(adoptionRequestIssue({ project: source.root, [permission]: fingerprint })).toBeNull();
      for (const value of [
        `${fingerprint}\n`, `${fingerprint}\r\n`, `${fingerprint}\u2028`, `${fingerprint}\u2029`,
        ` ${fingerprint}`, `${fingerprint} `, fingerprint.toUpperCase(), `sha256:${fingerprint}`
      ]) {
        const issue = adoptionRequestIssue({ project: source.root, [permission]: value });
        expect(issue, JSON.stringify(value)).not.toBeNull();
        const result = await invoke(source, { [permission]: value });
        expect(result.code).toBe(1);
        expect(result.report.blockers).toContain(issue);
        expect(result.report.committed).toBe(false);
        expect(result.report.effects).toEqual({ preparationCommands: 0, projectCommands: 0, networkAuthorized: false, frameworkCommands: 0 });
      }
      const stdout = new CaptureStream(), stderr = new CaptureStream();
      const value = `${fingerprint}\n`;
      expect(await adoptCommand({
        command: 'adopt', positional: [],
        flags: { project: source.root, [permission === 'approvePlan' ? 'approve-plan' : 'verify-plan']: value, json: true }
      }, {
        cwd: source.parent, stdout, stderr, presentation: new PresentationSession({ stdout, stderr }),
        updateNow: () => clock, updatePreview: { homedir: source.home, env: {}, repositoryRoot: source.root }
      })).toBe(1);
      const report = JSON.parse(stdout.text()) as AdoptionReport;
      expect(report.blockers).toContain(adoptionRequestIssue({ project: source.root, [permission]: value }));
      expect(assessment).not.toHaveBeenCalled();
      expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
      expect(await readdir(source.home)).toEqual([]);
    });

    describe('adoption distrusts assessment classification as authority', () => {
      it('blocks actual Express source even when assessment claims the selected Fastify profile is fully supported', async () => {
        const source = await fixture();
        await writeFile(path.join(source.root, 'package.json'), '{"type":"module","dependencies":{"express":"^5.0.0"}}\n');
        await writeFile(path.join(source.root, 'server.js'), "import express from 'express';\nexport const app = express();\n");
        const original = assessmentService.assessProject;
        const assessment = vi.spyOn(assessmentService, 'assessProject').mockImplementation(async (options) =>
          untrustedAssessmentSuccess(await original(options)));
        const result = await invoke(source, { check: true, profile: 'node-fastify' });
        expect(assessment).toHaveBeenCalled();
        expect(result.report.assessment?.outcome).toBe('success');
        expect(result.code).toBe(2);
        expect(result.report.committed).toBe(false);
        expect(result.report.blockers.join(' ')).toMatch(/Express|do not establish/);
        expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
      });

      describe('adoption preserves resource admission failures', () => {
        it.each(['loadPackagedProfilesCatalog', 'loadPackagedTemplateCatalog'] as const)(
          'does not replace a failed %s read with fallback hashes or target facts',
          async (reader) => {
            const source = await fixture();
            const failure = Object.assign(new Error('Installed catalog cannot be read safely.'), { code: 'EACCES' });
            vi.spyOn(packagedResources, reader).mockImplementation(() => { throw failure; });
            const run = vi.fn(async () => { throw new Error('Invalid resource admission must not execute tools.'); });
            const result = await invoke(source, { check: true, profile: 'vue-component' }, { runner: { run } });
            expect(result.code).toBe(1);
            expect(result.report.complete).toBe(false);
            expect(result.report.committed).toBe(false);
            expect(result.report.blockers.join(' ')).toMatch(/catalog cannot be read safely/);
            expect(run).not.toHaveBeenCalled();
            expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
            expect(await readdir(source.home)).toEqual([]);
          }
        );

        it.each(['loadPackagedProfilesCatalog', 'loadPackagedTemplateCatalog'] as const)(
          'refuses an old approved plan when %s integrity is no longer available',
          async (reader) => {
            const source = await fixture();
            const preview = await invoke(source, { check: true, profile: 'vue-component' });
            expect(preview.code).toBe(2);
            const before = await readFile(path.join(source.root, 'App.vue'));
            vi.spyOn(packagedResources, reader).mockImplementation(() => { throw new Error('Installed resource/catalog digest mismatch.'); });
            const result = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
            expect(result.code).toBe(1);
            expect(result.report.committed).toBe(false);
            expect(result.report.blockers.join(' ')).toMatch(/digest mismatch/);
            expect(await readFile(path.join(source.root, 'App.vue'))).toEqual(before);
            expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
            expect(await readdir(source.root)).not.toContain('liftoff.config.json');
          }
        );

        it('fails the generated manifest writer when the installed standards context is malformed', () => {
          const plan = buildProjectPlan({
            projectName: 'catalog-failure', projectType: 'standard', apiStack: 'node-fastify',
            cloud: 'azure', region: 'eastus', includeFrontend: false, environments: ['dev'],
            specWorkflow: 'openspec', agents: ['github-copilot'], governanceProfile: 'none'
          }, { requireProjectName: true });
          const artifacts = buildArtifacts(plan);
          vi.spyOn(packagedResources, 'currentStandardsManifestContext').mockImplementation(() => {
            throw new Error('Malformed installed build/resource identity.');
          });
          expect(() => buildManifest(plan, artifacts)).toThrow('Malformed installed build/resource identity.');
        });

        it.each([
          'profile component boundaries', 'profile required artifacts', 'profile evaluation coverage',
          'resource path', 'artifact lifecycle', 'component dependencies'
        ] as const)('binds actual %s after a real preview instead of trusting the cached catalog', async (change) => {
          const source = await fixture();
          const installed = await isolatePackagedResources(source);
          const preview = await invoke(source, { check: true, profile: 'vue-component' });
          expect(preview.code).toBe(2);
          const original = await readFile(path.join(source.root, 'App.vue'));
          if (change.startsWith('profile')) {
            const catalog = structuredClone(packagedResources.loadPackagedProfilesCatalog());
            const profile = catalog.profiles['vue-component'];
            if (change === 'profile component boundaries') profile.componentBoundaries.push('unobserved-client');
            else if (change === 'profile required artifacts') profile.requiredArtifacts = ['unobserved-test-suite'];
            else profile.evaluationCoverage[0]!.description += ' Changed requirements.';
            await writeFile(path.join(installed, 'assets', 'profiles', 'catalog.json'), JSON.stringify(catalog));
          } else {
            const catalog = structuredClone(packagedResources.loadPackagedTemplateCatalog());
            if (change === 'resource path') catalog.resources['templates.frontend.styles']!.path = 'assets/templates/frontend/other-styles.css';
            else if (change === 'artifact lifecycle') catalog.components['frontend-vue']!.artifactLifecycles['frontend-app'] = 'managed-core';
            else catalog.components['frontend-vue']!.dependencies = [];
            await writeFile(path.join(installed, 'assets', 'templates', 'catalog.json'), JSON.stringify(catalog));
          }
          const run = vi.fn(async () => { throw new Error('Changed installed authority must not execute a tool.'); });
          const result = await invoke(source, { approvePlan: preview.report.plan!.fingerprint }, { runner: { run } });
          expect(result.code).toBe(1);
          expect(result.report.committed).toBe(false);
          expect(result.report.blockers.join(' ')).toMatch(/digest mismatch/i);
          expect(result.report.effects).toEqual({ preparationCommands: 0, projectCommands: 0, networkAuthorized: false, frameworkCommands: 0 });
          expect(run).not.toHaveBeenCalled();
          expect(await readFile(path.join(source.root, 'App.vue'))).toEqual(original);
          expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
        });

        it('requires a new plan when a coherent installed profile catalog changes after preview', async () => {
          const source = await fixture();
          const installed = await isolatePackagedResources(source);
          const preview = await invoke(source, { check: true, profile: 'vue-component' });
          expect(preview.code).toBe(2);
          const catalog = structuredClone(packagedResources.loadPackagedProfilesCatalog());
          const profile = catalog.profiles['vue-component'];
          profile.label += ' (revised catalog fixture)';
          profile.digest = computeProfileDigest(profile);
          catalog.digest = computeProfileCatalogDigest(catalog);
          await writeFile(path.join(installed, 'assets', 'profiles', 'catalog.json'), JSON.stringify(catalog));
          expect(packagedResources.loadPackagedProfilesCatalog().digest).toBe(catalog.digest);
          const result = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
          expect(result.code).toBe(1);
          expect(result.report.committed).toBe(false);
          expect(result.report.blockers.join(' ')).toMatch(/changed|match|stale/i);
          expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
          const next = await invoke(source, { check: true, profile: 'vue-component' });
          expect(next.code).toBe(2);
          expect(next.report.plan!.standards.catalogDigest).toBe(catalog.digest);
          expect(next.report.plan!.fingerprint).not.toBe(preview.report.plan!.fingerprint);
        });
      });

      it('checks the actual selected component instead of accepting root-level framework facts', async () => {
        const source = await fixture();
        await writeFile(path.join(source.root, 'package.json'), '{"type":"module","dependencies":{"fastify":"^5.0.0"}}\n');
        await writeFile(path.join(source.root, 'server.js'), "import Fastify from 'fastify';\nexport const app = Fastify();\n");
        await mkdir(path.join(source.root, 'frontend'));
        await writeFile(path.join(source.root, 'frontend', 'package.json'), '{"dependencies":{"vue":"^3.5.0"}}\n');
        await writeFile(path.join(source.root, 'frontend', 'App.vue'), '<template>Actual Vue component</template>\n');
        const original = assessmentService.assessProject;
        const assessment = vi.spyOn(assessmentService, 'assessProject').mockImplementation(async (options) =>
          untrustedAssessmentSuccess(await original({ ...options, componentPath: undefined })));
        const result = await invoke(source, { check: true, profile: 'node-fastify', component: 'frontend' });
        expect(assessment).toHaveBeenCalled();
        expect(result.code).toBe(2);
        expect(result.report.blockers.join(' ')).toMatch(/do not establish node-fastify/);
        expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
        expect(await readdir(path.join(source.root, 'frontend'))).not.toContain('liftoff.manifest.json');
      });

      it('rejects source changes during a stale successful assessment instead of combining incompatible snapshots', async () => {
        const source = await fixture();
        const original = assessmentService.assessProject;
        const assessment = vi.spyOn(assessmentService, 'assessProject').mockImplementation(async (options) => {
          const result = untrustedAssessmentSuccess(await original(options));
          await writeFile(path.join(source.root, 'package.json'), '{"dependencies":{"express":"^5.0.0"}}\n');
          return result;
        });
        const result = await invoke(source, { check: true, profile: 'vue-component' });
        expect(assessment).toHaveBeenCalled();
        expect(result.code).toBe(1);
        expect(result.report.blockers.join(' ')).toMatch(/changed/);
        expect(await readFile(path.join(source.root, 'package.json'), 'utf8')).toContain('express');
        expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
      });

      it('does not treat comments or template-string import examples as actual framework support', async () => {
        const source = await fixture();
        await writeFile(path.join(source.root, 'package.json'), '{"type":"module","dependencies":{"fastify":"^5.0.0"}}\n');
        await writeFile(path.join(source.root, 'server.js'),
          "/* import Fastify from 'fastify'; */\nconst help = `\nimport Fastify from 'fastify';\n`;\nexport { help };\n");
        const original = assessmentService.assessProject;
        const assessment = vi.spyOn(assessmentService, 'assessProject').mockImplementation(async (options) =>
          untrustedAssessmentSuccess(await original(options)));
        const result = await invoke(source, { check: true, profile: 'node-fastify' });
        expect(assessment).toHaveBeenCalled();
        expect(result.code).toBe(2);
        expect(result.report.blockers.join(' ')).toMatch(/do not establish node-fastify/);
        expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
      });

      it('refuses an aliased component before calling a weaker assessment reader', async () => {
        const source = await fixture();
        const other = path.join(source.parent, 'outside-component');
        await mkdir(other);
        await symlink(other, path.join(source.root, 'frontend'), 'junction');
        const assessment = vi.spyOn(assessmentService, 'assessProject').mockImplementation(async () => {
          throw new Error('Unsafe boundary must not reach assessment.');
        });
        const result = await invoke(source, { check: true, profile: 'vue-component', component: 'frontend' });
        expect(result.code).toBe(1);
        expect(assessment).not.toHaveBeenCalled();
        expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
      });

      it('refuses linked application declarations before delegating any diagnostic assessment', async () => {
        const source = await fixture();
        const outside = path.join(source.parent, 'outside.json');
        await writeFile(outside, '{"private":"must not be followed through a project declaration"}\n');
        await rm(path.join(source.root, 'package.json'));
        await link(outside, path.join(source.root, 'package.json'));
        const assessment = vi.spyOn(assessmentService, 'assessProject').mockImplementation(async () => {
          throw new Error('Unsafe declaration must not reach assessment.');
        });
        const result = await invoke(source, { check: true, profile: 'vue-component' });
        expect(result.code).toBe(1);
        expect(assessment).not.toHaveBeenCalled();
        expect(await readFile(outside, 'utf8')).toContain('must not be followed');
        expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
      });
    });

    it.each(['approvePlan', 'verifyPlan'] as const)('rejects an expired %s without executing or creating metadata', async (permission) => {
      const source = await fixture();
      const preview = await invoke(source, { profile: 'vue-component', check: true });
      const run = vi.fn(async () => { throw new Error('Expired scope must not run.'); });
      const result = await invoke(source, { [permission]: preview.report.plan!.fingerprint }, {
        updateNow: () => new Date(preview.report.plan!.expiresAt), runner: { run }
      });
      expect(result.code).toBe(1);
      expect(result.report.blockers.join(' ')).toMatch(/expired/);
      expect(result.report.committed).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
    });

    it('does not accept the same approved fingerprint for another project boundary', async () => {
      const source = await fixture(), other = await fixture();
      const preview = await invoke(source, { profile: 'vue-component', check: true });
      const result = await invoke(other, { approvePlan: preview.report.plan!.fingerprint }, {
        updatePreview: { homedir: source.home, env: {}, repositoryRoot: other.root }
      });
      expect(result.code).toBe(1);
      expect(result.report.blockers.join(' ')).toMatch(/matching external adoption preview/);
      expect(result.report.committed).toBe(false);
      expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
      expect(await readdir(other.root)).toEqual(['App.vue', 'package.json']);
    });

    it('preserves newly occupied desired-state bytes rather than using prior file approval', async () => {
      const source = await fixture();
      const preview = await invoke(source, { profile: 'vue-component', check: true });
      const custom = '{"owner":"developer","decision":"preserve"}\n';
      await writeFile(path.join(source.root, 'liftoff.config.json'), custom);
      const result = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
      expect(result.code).toBe(1);
      expect(result.report.committed).toBe(false);
      expect(await readFile(path.join(source.root, 'liftoff.config.json'), 'utf8')).toBe(custom);
      expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    });

    it.each(['reviewed-repair-transaction.json', 'reviewed-skills-transaction.json'])('preserves unfinished foreign transaction %s before adoption', async (name) => {
      const source = await fixture();
      const journal = path.join(source.root, '.liftoff', name);
      const original = '{"schemaVersion":99,"untrusted":"preserve for original recovery"}\n';
      await mkdir(path.dirname(journal));
      await writeFile(journal, original);
      const run = vi.fn(async () => { throw new Error('A conflicting writer must block process effects.'); });
      const result = await invoke(source, { check: true, profile: 'vue-component' }, { runner: { run } });
      expect(result.code).toBe(1);
      expect(result.report.blockers.join(' ')).toMatch(/recorded transaction blocks new adoption/);
      expect(await readFile(journal, 'utf8')).toBe(original);
      expect(run).not.toHaveBeenCalled();
      expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    });

    it('refuses recovery of an untrusted local adoption journal without external authority', async () => {
      const source = await fixture();
      const journal = path.join(source.root, '.liftoff', 'reviewed-adoption-transaction.json');
      const original = '{"schemaVersion":1,"kind":"approval-claimed-by-project"}\n';
      await mkdir(path.dirname(journal));
      await writeFile(journal, original);
      const result = await invoke(source, { recover: true });
      expect(result.code).toBe(2);
      expect(result.report.complete).toBe(false);
      expect(result.report.committed).toBe(false);
      expect(result.report.blockers.length).toBeGreaterThan(0);
      expect(await readFile(journal, 'utf8')).toBe(original);
      expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    });

    it('rejects project-local proposals before they can supply any metadata authority', async () => {
      const source = await fixture();
      const proposal = await metadataProposal(source);
      const proposedPath = path.join(source.root, 'proposal.json');
      const bytes = `${JSON.stringify(proposal, null, 2)}\n`;
      await writeFile(proposedPath, bytes);
      const result = await invoke(source, { check: true, proposal: proposedPath });
      expect(result.code).toBe(1);
      expect(result.report.blockers.join(' ')).toMatch(/disjoint external directories/);
      expect(await readFile(proposedPath, 'utf8')).toBe(bytes);
      expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    });

    it('invalidates a proposal mode change even when its JSON bytes are identical', async () => {
      const source = await fixture();
      const proposalPath = path.join(source.staging, 'proposal.json');
      await writeFile(proposalPath, `${JSON.stringify(await metadataProposal(source), null, 2)}\n`, { mode: 0o600 });
      const preview = await invoke(source, { check: true, proposal: proposalPath });
      expect(preview.code).toBe(2);
      const bytes = await readFile(proposalPath);
      await chmod(proposalPath, process.platform === 'win32' ? 0o444 : 0o644);
      const result = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
      expect(result.code).toBe(1);
      expect(result.report.committed).toBe(false);
      expect(await readFile(proposalPath)).toEqual(bytes);
      expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    });

    it('reports later metadata changes without replaying an already committed adoption', async () => {
      const source = await fixture();
      const preview = await invoke(source, { profile: 'vue-component', check: true });
      expect((await invoke(source, { approvePlan: preview.report.plan!.fingerprint })).code).toBe(0);
      const manifest = await readFile(path.join(source.root, 'liftoff.manifest.json'));
      const custom = '{"later":"developer-owned desired-state edit"}\n';
      await writeFile(path.join(source.root, 'liftoff.config.json'), custom);
      const repeated = await invoke(source, { check: true });
      expect(repeated.code).toBe(2);
      expect(repeated.report.status).toBe('incomplete');
      expect(repeated.report.committed).toBe(true);
      expect(repeated.report.blockers).toContain('liftoff.config.json');
      expect(await readFile(path.join(source.root, 'liftoff.config.json'), 'utf8')).toBe(custom);
      expect(await readFile(path.join(source.root, 'liftoff.manifest.json'))).toEqual(manifest);
    });

    it('does not accept a modified external completion checkpoint as a matching adoption', async () => {
      const source = await fixture();
      const preview = await invoke(source, { profile: 'vue-component', check: true });
      expect((await invoke(source, { approvePlan: preview.report.plan!.fingerprint })).code).toBe(0);
      const store = createScopedUserLocalRecordStore(source.root, 'adoption-checkpoint', {
        homedir: source.home, env: {}, repositoryRoot: source.root
      });
      const saved = await store.read(canonicalSha256({ kind: 'adoption-committed', recordId: preview.report.plan!.recordId }));
      if (!saved) throw new Error('Expected the actual externally issued completion checkpoint.');
      await writeFile(saved.path, '{"schemaVersion":1,"kind":"liftoff-adoption-committed","recordId":"changed"}\n');
      const manifest = await readFile(path.join(source.root, 'liftoff.manifest.json'));
      const repeated = await invoke(source, { check: true });
      expect(repeated.code).toBe(1);
      expect(repeated.report.complete).toBe(false);
      expect(repeated.report.blockers.join(' ')).toMatch(/matching external committed checkpoint/);
      expect(await readFile(path.join(source.root, 'liftoff.manifest.json'))).toEqual(manifest);
    });
  });

  it('plans a real Vue component without creating Git or early metadata', async () => {
    const source = await fixture();
    const before = await readdir(source.root);
    const inspected = await inspectAdoption({ project: source.root, profile: 'vue-component', now: clock });
    expect(inspected.blockers).toEqual([]);
    const manifest = parseManifest(inspected.manifest);
    expect(manifest.artifactVersion).toBe(8);
    expect(manifest.project.workload).toEqual({ kind: 'components' });
    expect(manifest.framework).toEqual({ state: 'uninitialized', adapter: 'openspec' });
    expect(manifest.projectArtifacts).toHaveLength(2);
    for (const entry of manifest.projectArtifacts) {
      expect(entry).not.toHaveProperty('generationHash');
      expect(entry).not.toHaveProperty('generatedBy');
      expect(entry.adoption?.observedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(await readdir(source.root)).toEqual(before);
    expect(JSON.stringify(inspected)).not.toContain('Preserved business dashboard');
  });

  it('rejects invented component workload fields and profile facts', async () => {
    const source = await fixture();
    const { manifest } = await inspectAdoption({ project: source.root, profile: 'vue-component', now: clock });
    for (const field of ['apiStack', 'cloud', 'region', 'frontend', 'environments', 'pattern']) {
      const raw = structuredClone(manifest);
      Object.assign(raw.project.workload, { [field]: field === 'environments' ? [] : 'invented' });
      expect(() => parseManifest(raw)).toThrow(/unknown|inapplicable/i);
    }
    const wrong = structuredClone(manifest);
    wrong.standards.components[0]!.profile.digest = `sha256:${'a'.repeat(64)}`;
    expect(() => parseManifest(wrong)).toThrow(/profile identity/);
    const generated = structuredClone(manifest);
    Object.assign(generated.projectArtifacts[0]!, { generatedBy: '0.13.0', generationHash: `sha256:${'a'.repeat(64)}` });
    expect(() => parseManifest(generated)).toThrow(/unknown|inapplicable/);
  });

  it('requires preview and exact approval before metadata-only adoption, then repeats without writes', async () => {
    const source = await fixture();
    const preview = await invoke(source, { profile: 'vue-component', check: true });
    expect(preview.code).toBe(2);
    expect(preview.report.status).toBe('planned');
    expect(await readdir(source.root)).toEqual(['App.vue', 'package.json']);
    const applied = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
    expect(applied.report.blockers).toEqual([]);
    expect(applied.code).toBe(0);
    expect(applied.report.committed).toBe(true);
    const manifestBytes = await readFile(path.join(source.root, 'liftoff.manifest.json'));
    const manifest = await loadManifest(source.root);
    expect(manifest.project.workload).toEqual({ kind: 'components' });
    expect(await readFile(path.join(source.root, 'App.vue'), 'utf8')).toContain('Preserved business dashboard');
    expect(await readdir(source.root)).not.toContain('.git');
    const repeated = await invoke(source, { profile: 'vue-component', check: true });
    expect(repeated.code).toBe(0);
    expect(repeated.report.status).toBe('current');
    expect(await readFile(path.join(source.root, 'liftoff.manifest.json'))).toEqual(manifestBytes);
    const update = await inspectProjectUpdate(source.root);
    expect(update.plan.workload).toBe('components');
    expect(update.render.filter((artifact) => artifact.lifecycle === 'project')).toEqual([]);
    expect(update.hasDrift).toBe(false);
    const governance = await inspectAssessmentProject(new AssessmentFiles(source.root));
    expect(governance.project?.workload).toEqual({ kind: 'components' });
    expect(governance.identity.recordedActivationIdentity).toBeNull();
    expect(governance.renderedCore).toEqual([]);
  });

  it('invalidates exact approval after a source byte, mode, or directory change', async () => {
    for (const change of ['byte', 'mode', 'directory'] as const) {
      const source = await fixture();
      const preview = await invoke(source, { profile: 'vue-component', check: true });
      if (change === 'byte') await writeFile(path.join(source.root, 'App.vue'), '<template>New business behavior</template>\n');
      else if (change === 'mode') await chmod(path.join(source.root, 'App.vue'), 0o600);
      else await mkdir(path.join(source.root, 'new-scope'));
      const applied = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
      expect(applied.code).toBe(1);
      expect(applied.report.committed).toBe(false);
      expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    }
  });

  it('keeps JSON and redirected invocations noninteractive and refuses metadata collisions', async () => {
    const source = await fixture();
    const prompt = vi.fn(async () => true);
    const result = await invoke(source, { profile: 'vue-component' }, {
      stdin: scriptedTtyInput('yes\n'), stderr: ttyCaptureStream(), approveAdoptionPlan: prompt
    });
    expect(result.code).toBe(2);
    expect(prompt).not.toHaveBeenCalled();
    await writeFile(path.join(source.root, 'liftoff.config.json'), '{"owner":"developer"}\n');
    const collision = await invoke(source, { profile: 'vue-component', check: true });
    expect(collision.code).toBe(1);
    expect(await readFile(path.join(source.root, 'liftoff.config.json'), 'utf8')).toBe('{"owner":"developer"}\n');
  });

  it('refuses an explicit supported target when actual source is unsupported', async () => {
    const source = await fixture();
    await writeFile(path.join(source.root, 'package.json'), '{"dependencies":{"express":"^5.0.0"}}\n');
    const result = await invoke(source, { profile: 'node-fastify', check: true });
    expect(result.code).toBe(2);
    expect(result.report.status).toBe('blocked');
    expect(result.report.blockers.join(' ')).toMatch(/do not establish|conversion/);
    expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
  });

  it('writes deterministic generated v8 catalog provenance without adoption claims', () => {
    const plan = buildProjectPlan({
      projectName: 'generated-fixture', projectType: 'standard', apiStack: 'node-fastify',
      cloud: 'azure', region: 'eastus', includeFrontend: false, environments: ['dev'],
      specWorkflow: 'openspec', agents: ['github-copilot'], governanceProfile: 'none'
    }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);
    const manifest = parseManifest(buildManifest(plan, artifacts));
    expect(manifest.artifactVersion).toBe(8);
    expect(manifest.provenance?.kind).toBe('generated');
    expect(canonicalSha256(buildManifest(plan, artifacts))).toBe(canonicalSha256(buildManifest(plan, artifacts)));
    for (const entry of manifest.managedArtifacts) {
      const actual = artifacts.find((artifact) => artifact.logicalName === entry.logicalName)!;
      expect(entry.contentHash).toBe(`sha256:${createHash('sha256').update(actual.content).digest('hex')}`);
    }
  });

  it('verifies a declared addition in the released private candidate before separately committing', async () => {
    const source = await fixture();
    await writeFile(path.join(source.root, 'check.mjs'),
      "import { readFileSync } from 'node:fs';\nif (!readFileSync('feature.ts', 'utf8').includes('preservedValue')) throw new Error('missing addition');\n");
    const inventory = await inspectAdoption({ project: source.root, profile: 'vue-component', now: clock });
    const proposal: AdoptionProposal = {
      schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: source.root,
      inspectionDigest: inventory.inventory.inspectionDigest, projectName: 'custom-vue', profile: 'vue-component',
      componentRootPathParts: [], framework: { workflow: 'openspec', agents: [], initialize: false, copilotCloud: false },
      governanceProfile: 'none', dynamicReferencesReviewed: true, patch: null,
      additions: [{
        logicalName: 'custom-feature', componentId: 'application', targetPathParts: ['feature.ts'],
        stagedPathParts: ['feature.ts'], targetMode: process.platform === 'win32' ? 0o666 : 0o600,
        precondition: 'absent', references: []
      }],
      verification: { commands: [{ executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 8192, network: false }], preparation: [] }
    };
    await writeFile(path.join(source.staging, 'feature.ts'), 'export const preservedValue = 42;\n');
    const proposalPath = path.join(source.staging, 'proposal.json');
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    const preview = await invoke(source, { proposal: proposalPath, check: true });
    expect(preview.report.blockers).toEqual([]);
    expect(preview.code).toBe(2);
    const earlyWrite = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
    expect(earlyWrite.code).toBe(2);
    expect(earlyWrite.report.committed).toBe(false);
    const verified = await invoke(source, { verifyPlan: preview.report.plan!.fingerprint }, { runner: new NodeCommandRunner() });
    expect(verified.report.blockers).toEqual([]);
    expect(verified.code).toBe(2);
    expect(verified.report.status).toBe('verified');
    expect(verified.report.effects.projectCommands).toBe(1);
    expect(await readdir(source.root)).not.toContain('feature.ts');
    expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    const committed = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
    expect(committed.report.blockers).toEqual([]);
    expect(committed.code).toBe(0);
    const manifest = await loadManifest(source.root);
    const addition = manifest.projectArtifacts.find((entry) => entry.logicalName === 'custom-feature');
    expect(addition?.addition?.producer).toBe('reviewed-project-proposal');
    expect(addition).not.toHaveProperty('generatedBy');
    expect(await readFile(path.join(source.root, 'feature.ts'), 'utf8')).toBe('export const preservedValue = 42;\n');
  });

  it('requires separate official framework staging and reviews its actual exact-byte output before commit', async () => {
    const source = await fixture();
    const baseline = await inspectAdoption({ project: source.root, profile: 'vue-component', now: clock });
    const proposal: AdoptionProposal = {
      schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: source.root,
      inspectionDigest: baseline.inventory.inspectionDigest, projectName: 'custom-vue', profile: 'vue-component',
      componentRootPathParts: [], framework: { workflow: 'openspec', agents: ['github-copilot'], initialize: true, copilotCloud: false },
      governanceProfile: 'none', dynamicReferencesReviewed: true, patch: null, additions: [],
      verification: { commands: [], preparation: [] }
    };
    const proposalPath = path.join(source.staging, 'proposal.json');
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    const nativeResolve = nativeExecutableObserver.resolve.bind(nativeExecutableObserver);
    vi.spyOn(nativeExecutableObserver, 'resolve').mockImplementation(async (name, context) =>
      name === 'openspec'
        ? { executable: name, resolution: 'resolved', resolvedPath: process.execPath, realPath: process.execPath, kind: 'executable', origin: 'standalone', evidence: 'path-search' }
        : nativeResolve(name, context));
    const ready = new ReadyInitRunner();
    const real = new NodeCommandRunner();
    const runner: CommandRunner = {
      run: async (command, options) => {
        if (options?.cwd?.endsWith(`${path.sep}project`) && (command.args[0] === 'init' || command.args[0] === '--version')) {
          const output = await ready.run({ executable: 'openspec', args: command.args }, options);
          return { ...output, processTreeSettled: true };
        }
        return real.run(command, options);
      }
    };
    const preview = await invoke(source, { proposal: proposalPath, check: true }, { runner });
    expect(preview.report.blockers).toEqual([]);
    expect(preview.report.plan?.frameworkPreparation.status).toBe('required');
    expect(preview.report.plan?.permissions.fileTransaction).toBe(false);
    const noNetwork = await invoke(source, { verifyPlan: preview.report.plan!.fingerprint }, { runner });
    expect(noNetwork.report.effects.frameworkCommands).toBe(0);
    expect(await readdir(source.root)).not.toContain('openspec');
    const staged = await invoke(source, { verifyPlan: preview.report.plan!.fingerprint, allowNetwork: true }, { runner });
    expect(staged.report.blockers).toEqual([]);
    expect(staged.report.effects.frameworkCommands).toBe(1);
    expect(staged.report.plan?.frameworkPreparation.status).toBe('prepared');
    expect(staged.report.plan?.fingerprint).not.toBe(preview.report.plan?.fingerprint);
    expect(staged.report.plan?.effects.some((effect) => effect.producer === 'framework')).toBe(true);
    expect(await readdir(source.root)).not.toContain('openspec');
    expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    const applied = await invoke(source, { approvePlan: staged.report.plan!.fingerprint }, { runner });
    expect(applied.report.blockers).toEqual([]);
    expect(applied.code).toBe(0);
    const manifest = await loadManifest(source.root);
    expect(manifest.framework.state).toBe('initialized');
    expect(manifest.project.agents).toEqual(['github-copilot']);
    expect(manifest.managedArtifacts.map((artifact) => artifact.logicalName)).toEqual(['liftoff-repair-copilot']);
    expect(manifest.project.workload).toEqual({ kind: 'components' });
    expect(await readdir(source.root)).not.toContain('.git');
  });

  it('retains earlier verified command effects when interactive file approval is declined', async () => {
    const source = await fixture();
    await writeFile(path.join(source.root, 'check.mjs'), "process.stdout.write('declared check ran\\n');\n");
    const baseline = await inspectAdoption({ project: source.root, profile: 'vue-component', now: clock });
    const proposal: AdoptionProposal = {
      schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: source.root,
      inspectionDigest: baseline.inventory.inspectionDigest, projectName: 'custom-vue', profile: 'vue-component',
      componentRootPathParts: [], framework: { workflow: 'openspec', agents: [], initialize: false, copilotCloud: false },
      governanceProfile: 'none', dynamicReferencesReviewed: true, patch: null, additions: [],
      verification: { commands: [{ executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 8192, network: false }], preparation: [] }
    };
    const proposalPath = path.join(source.staging, 'proposal.json');
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    const stdout = new CaptureStream(), stderr = ttyCaptureStream();
    const consent = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const code = await adoptProject({ project: source.root, proposal: proposalPath }, {
      cwd: source.parent, stdout, stderr, stdin: scriptedTtyInput(''), runner: new NodeCommandRunner(),
      presentation: new PresentationSession({ stdout, stderr }), approveAdoptionPlan: consent,
      updateNow: () => clock, updatePreview: { homedir: source.home, env: {}, repositoryRoot: source.root }
    });
    expect(code).toBe(2);
    expect(consent).toHaveBeenCalledTimes(2);
    expect(consent.mock.calls.every(([question]) => question.default === false)).toBe(true);
    expect(stdout.text() + stderr.text()).toMatch(/Verification commands:?\s+1/);
    expect(stdout.text() + stderr.text()).toMatch(/File transaction was declined/);
    expect(await readdir(source.root)).not.toContain('liftoff.manifest.json');
    expect(await readdir(source.root)).not.toContain('liftoff.config.json');
  });

  it('recovers a committed journal after final checkpoint failure without rewriting adoption history', async () => {
    const source = await fixture();
    const preview = await invoke(source, { profile: 'vue-component', check: true });
    const commitKey = canonicalSha256({ kind: 'adoption-committed', recordId: preview.report.plan!.recordId });
    const failure = await invoke(source, { approvePlan: preview.report.plan!.fingerprint }, {
      updatePreview: {
        homedir: source.home, env: {}, repositoryRoot: source.root,
        fileSystem: {
          ...nodeUpdatePreviewFileSystem,
          openFile: async (file, access, mode) => {
            if (file.includes(commitKey) && access === 'create-exclusive') throw new Error('injected checkpoint storage failure');
            return nodeUpdatePreviewFileSystem.openFile(file, access, mode);
          }
        }
      }
    });
    expect(failure.code).toBe(2);
    expect(failure.report.committed).toBe(true);
    expect(failure.report.complete).toBe(false);
    expect(failure.report.nextActions[0]?.args).toContain('--recover');
    const historyPath = path.join(source.root, '.liftoff', 'adoption-history', preview.report.plan!.recordId, 'record.json');
    const history = await readFile(historyPath);
    const journal = (await readFile(path.join(source.root, '.liftoff', 'reviewed-adoption-transaction.json'), 'utf8')).split('\n')[0]!;
    const header = JSON.parse(journal);
    expect(header.schemaVersion).toBe(1);
    expect(header.transactionKind).toBe('adoption');
    expect(header.adoptionIdentity.adoptionContractVersion).toBe(1);
    expect(header).not.toHaveProperty('repairIdentity');
    const originalDirectory = path.join(source.parent, 'original-project');
    const preservedReplacement = path.join(source.parent, 'replacement-project');
    await rename(source.root, originalDirectory);
    await cp(originalDirectory, source.root, { recursive: true });
    const changedRoot = await invoke(source, { recover: true });
    expect(changedRoot.code).toBe(2);
    expect(changedRoot.report.committed).toBe(true);
    expect(changedRoot.report.blockers.join(' ')).toMatch(/creation identity or mode changed/);
    expect(await readFile(historyPath)).toEqual(history);
    await rename(source.root, preservedReplacement);
    await rename(originalDirectory, source.root);
    const recovered = await invoke(source, { recover: true });
    expect(recovered.report.blockers).toEqual([]);
    expect(recovered.code).toBe(0);
    expect(recovered.report.committed).toBe(true);
    expect(await readFile(historyPath)).toEqual(history);
    const current = await invoke(source, { check: true });
    expect(current.report.status).toBe('current');
    expect(current.code).toBe(0);
  });

  it('rejects forged adopted observations and never falls back to unchecked v8 metadata', async () => {
    const source = await fixture();
    const preview = await invoke(source, { profile: 'vue-component', check: true });
    expect((await invoke(source, { approvePlan: preview.report.plan!.fingerprint })).code).toBe(0);
    const manifest = await loadManifest(source.root);
    const artifact = manifest.projectArtifacts[0]!;
    if (!artifact.adoption) throw new Error('Expected observed adoption provenance.');
    artifact.adoption.observedHash = `sha256:${'f'.repeat(64)}`;
    await writeFile(path.join(source.root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(loadManifest(source.root)).rejects.toThrow(/observations differ/);
    const { validateGeneratedProject } = await import('../src/application/diagnose/generated-project.js');
    expect((await validateGeneratedProject(source.root)).join(' ')).toMatch(/observations differ/);
  });

  it('reuses exact application-patch mappings and reference review for a customized adopted layout', async () => {
    const source = await fixture();
    await writeFile(path.join(source.root, 'main.ts'), "import App from './App.vue';\nexport const businessView = App;\n");
    await writeFile(path.join(source.root, 'check.mjs'), "import { readFileSync } from 'node:fs';\nif (!readFileSync('views/Dashboard.vue', 'utf8').includes('Preserved business dashboard')) throw new Error('behavior changed');\n");
    const baseline = await inspectAdoption({ project: source.root, profile: 'vue-component', now: clock });
    const app = baseline.inventory.files.find((file) => file.pathParts.join('/') === 'App.vue')!;
    const main = baseline.inventory.files.find((file) => file.pathParts.join('/') === 'main.ts')!;
    const reference = baseline.inventory.references.find((reference) => reference.sourcePathParts.join('/') === 'main.ts')!;
    expect(reference).toBeDefined();
    const verification = {
      commands: [{ executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 8192, network: false }],
      preparation: []
    };
    const proposal: AdoptionProposal = {
      schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: source.root,
      inspectionDigest: baseline.inventory.inspectionDigest, projectName: 'custom-vue', profile: 'vue-component',
      componentRootPathParts: [], framework: { workflow: 'openspec', agents: [], initialize: false, copilotCloud: false },
      governanceProfile: 'none', dynamicReferencesReviewed: true, additions: [], verification,
      patch: {
        schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: source.root,
        inspectionDigest: baseline.inventory.inspectionDigest, targetLayoutDigest: baseline.inventory.target!.digest,
        dynamicReferencesReviewed: true, unresolvedMappings: [], verification,
        mappings: [
          {
            sourcePathParts: ['App.vue'], targetPathParts: ['views', 'Dashboard.vue'],
            expectedSourceDigest: app.digest, expectedSourceMode: app.mode, stagedPathParts: ['Dashboard.vue'], targetMode: app.mode,
            role: 'application', targetIdentity: { kind: 'custom-component', logicalName: 'frontend-package' },
            customization: 'preserved', references: []
          },
          {
            sourcePathParts: ['main.ts'], targetPathParts: ['main.ts'],
            expectedSourceDigest: main.digest, expectedSourceMode: main.mode, stagedPathParts: ['main.ts'], targetMode: main.mode,
            role: 'reference', targetIdentity: { kind: 'custom-component', logicalName: 'frontend-package' },
            customization: 'reviewed-edit',
            references: [{ referenceId: reference.id, disposition: 'updated', afterTargetPathParts: ['views', 'Dashboard.vue'] }]
          }
        ]
      }
    };
    await writeFile(path.join(source.staging, 'Dashboard.vue'), await readFile(path.join(source.root, 'App.vue')));
    await writeFile(path.join(source.staging, 'main.ts'), "import App from './views/Dashboard.vue';\nexport const businessView = App;\n");
    const proposalPath = path.join(source.staging, 'proposal.json');
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    const preview = await invoke(source, { check: true, proposal: proposalPath });
    expect(preview.report.blockers).toEqual([]);
    const verified = await invoke(source, { verifyPlan: preview.report.plan!.fingerprint });
    expect(verified.report.blockers).toEqual([]);
    expect(verified.report.status).toBe('verified');
    const applied = await invoke(source, { approvePlan: preview.report.plan!.fingerprint });
    expect(applied.report.blockers).toEqual([]);
    expect(applied.code).toBe(0);
    expect(applied.report.backup?.indexKey).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(source.root)).not.toContain('App.vue');
    expect(await readFile(path.join(source.root, 'views', 'Dashboard.vue'), 'utf8')).toContain('Preserved business dashboard');
    const manifest = await loadManifest(source.root);
    const moved = manifest.projectArtifacts.find((artifact) => artifact.pathParts.join('/') === 'views/Dashboard.vue')!;
    expect(moved.adoption?.sourcePathParts).toEqual(['App.vue']);
    expect(moved.adoption?.observedHash).toBe(`sha256:${app.digest}`);
    expect(await readFile(path.join(source.root, '.liftoff', 'adoption-history', preview.report.plan!.recordId, 'record.json'), 'utf8'))
      .not.toContain('Preserved business dashboard');
  });
});

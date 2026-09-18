import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { validateGeneratedProject } from '../src/application/diagnose/generated-project.js';
import { diagnoseProject } from '../src/application/diagnose/doctor.js';
import { helperCommand } from '../src/cli/commands/helpers.js';
import { selectWorkstationRequirements } from '../src/workstation.js';
import { PresentationSession } from '../src/terminal.js';
import type { LiftoffManifestV8 } from '../src/domain/project/contracts.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import { getProfileIdentity, loadPackagedProfilesCatalog, loadPackagedTemplateCatalog } from '../src/adapters/packaged-assets/resource-catalog.js';
import { adoptionExecutionIdentity } from '../src/domain/project-evolution/adoption/identity.js';
import { liftoffVersion } from '../src/version.js';
import { componentDesiredState } from '../src/application/project/component-artifacts.js';

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function createTestDir(): Promise<string> {
  const dir = path.join(process.cwd(), `.test-fixture-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

function makeV8ComponentManifest(overrides: Partial<LiftoffManifestV8> = {}): LiftoffManifestV8 {
  const defaultManifest: LiftoffManifestV8 = {
    artifactVersion: 8,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project: {
      name: 'vue-component-app',
      workload: {
        kind: 'components'
      },
      specWorkflow: 'openspec',
      agents: []
    },
    framework: {
      state: 'uninitialized',
      adapter: 'openspec'
    },
    governance: {
      profile: 'none',
      state: 'disabled'
    },
    managedArtifacts: [],
    projectArtifacts: [],
    standards: {
      schemaVersion: 1,
      catalogDigest: 'sha256:' + 'a'.repeat(64),
      resourceCatalogDigest: 'sha256:' + 'b'.repeat(64),
      components: [
        {
          id: 'frontend',
          profile: {
            schemaVersion: 1,
            id: 'vue-component',
            revision: '1',
            digest: 'sha256:' + 'c'.repeat(64)
          },
          rootPathParts: ['src', 'client']
        }
      ]
    },
    provenance: {
      kind: 'adopted',
      recordId: 'a'.repeat(64),
      observationDigest: 'd'.repeat(64),
      repairs: []
    }
  };

  const manifest: LiftoffManifestV8 = {
    ...defaultManifest,
    ...overrides,
    project: {
      ...defaultManifest.project,
      ...(overrides.project ?? {})
    },
    framework: {
      ...defaultManifest.framework,
      ...(overrides.framework ?? {})
    },
    standards: {
      ...defaultManifest.standards,
      ...(overrides.standards ?? {})
    }
  };
  manifest.standards.catalogDigest = loadPackagedProfilesCatalog().digest;
  manifest.standards.resourceCatalogDigest = loadPackagedTemplateCatalog().digest;
  manifest.standards.components = manifest.standards.components.map((component) => ({
    ...component, profile: getProfileIdentity(component.profile.id)
  }));
  manifest.projectArtifacts = manifest.projectArtifacts.map((artifact) => artifact.adoption
    ? { ...artifact, adoption: { ...artifact.adoption, recordId: 'a'.repeat(64) } }
    : artifact);
  return manifest;
}

async function writeComponentManifest(root: string, manifest: LiftoffManifestV8) {
  if (manifest.provenance.kind !== 'adopted') throw new Error('Expected adopted fixture.');
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(root, 'liftoff.manifest.json'), bytes);
  await writeFile(path.join(root, 'liftoff.config.json'), componentDesiredState(manifest));
  const directory = path.join(root, '.liftoff', 'adoption-history', manifest.provenance.recordId);
  await mkdir(directory, { recursive: true });
  const identity = await lstat(root);
  await writeFile(path.join(directory, 'record.json'), `${JSON.stringify({
    schemaVersion: 1, kind: 'liftoff-adoption-record', ...adoptionExecutionIdentity(liftoffVersion),
    recordId: manifest.provenance.recordId, projectRoot: root,
    projectIdentity: { device: String(identity.dev), inode: String(identity.ino), birthtime: String(identity.birthtimeMs) },
    fingerprint: 'f'.repeat(64), reviewedAt: '2026-09-14T16:00:00.000Z', standards: manifest.standards,
    assessmentDigest: manifest.provenance.observationDigest,
    source: manifest.projectArtifacts.flatMap((artifact) => artifact.adoption ? [{
      pathParts: artifact.adoption.sourcePathParts, digest: artifact.adoption.observedHash.slice(7), mode: artifact.adoption.observedMode
    }] : []),
    effects: [],
    verification: { status: 'not-required', digest: null }, backup: null,
    authorization: { namespace: 'adoption-approval', fingerprint: 'f'.repeat(64), boundary: 'exact-transaction-digest' },
    manifestHash: createHash('sha256').update(bytes).digest('hex'), activationEvidence: 'not-issued'
  }, null, 2)}\n`);
}

describe('Task 7.2 component-only manifest consumers', () => {
  describe('validateGeneratedProject', () => {
    it('accepts valid v8 component-only forms without inventing generated project files', async () => {
      const dir = await createTestDir();
      const manifest = makeV8ComponentManifest({
        projectArtifacts: [
          {
            logicalName: 'custom-app',
            category: 'source',
            pathParts: ['src', 'client', 'App.vue'],
            adoption: {
              recordId: 'rec-1',
              componentId: 'frontend',
              sourcePathParts: ['src', 'client', 'App.vue'],
              observedHash: 'sha256:' + 'e'.repeat(64),
              observedMode: 0o644
            }
          }
        ]
      });

      await writeComponentManifest(dir, manifest);
      const issues = await validateGeneratedProject(dir);
      expect(issues).toEqual([]);
    });

    it('flags unsafe component rootPathParts escaping project boundary', async () => {
      const dir = await createTestDir();
      const manifest = makeV8ComponentManifest({
        standards: {
          schemaVersion: 1,
          catalogDigest: 'sha256:' + 'a'.repeat(64),
          resourceCatalogDigest: 'sha256:' + 'b'.repeat(64),
          components: [
            {
              id: 'frontend',
              profile: {
                schemaVersion: 1,
                id: 'vue-component',
                revision: '1',
                digest: 'sha256:' + 'c'.repeat(64)
              },
              rootPathParts: ['..', 'escaped']
            }
          ]
        }
      });

      await writeComponentManifest(dir, manifest);
      const issues = await validateGeneratedProject(dir);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).toMatch(/unsafe path/i);
    });

    it('flags unsafe adopted source paths', async () => {
      const dir = await createTestDir();
      const manifest = makeV8ComponentManifest({
        projectArtifacts: [
          {
            logicalName: 'unsafe-adopted',
            category: 'source',
            pathParts: ['safe', 'App.vue'],
            adoption: {
              recordId: 'rec-1',
              componentId: 'frontend',
              sourcePathParts: ['..', 'outside', 'App.vue'],
              observedHash: 'sha256:' + 'e'.repeat(64),
              observedMode: 0o644
            }
          }
        ]
      });

      await writeComponentManifest(dir, manifest);
      const issues = await validateGeneratedProject(dir);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).toMatch(/unsafe path/i);
    });

    it('validates framework only when initialized, does not fail uninitialized state', async () => {
      const dir = await createTestDir();
      const manifest = makeV8ComponentManifest({
        framework: {
          state: 'uninitialized',
          adapter: 'openspec'
        }
      });

      await writeComponentManifest(dir, manifest);
      const issues = await validateGeneratedProject(dir);
      expect(issues).toEqual([]);
    });
  });

  describe('selectWorkstationRequirements', () => {
    it('selects Node and npm for Vue component without Python, Go, Docker, OpenTofu, or Azure', () => {
      const requirements = selectWorkstationRequirements({
        workload: {
          kind: 'components',
          components: [
            { id: 'frontend', profileId: 'vue-component' }
          ]
        },
        specWorkflow: { id: 'openspec' },
        framework: { version: '1.11.0' },
        agents: []
      }, { includeFramework: false });

      const ids = requirements.map((r) => r.id);
      expect(ids).toContain('node');
      expect(ids).toContain('npm');
      expect(ids).not.toContain('python');
      expect(ids).not.toContain('uv');
      expect(ids).not.toContain('go');
      expect(ids).not.toContain('docker');
      expect(ids).not.toContain('opentofu');
      expect(ids).not.toContain('azure-cli');
    });

    it('selects Python and uv only when actual component profile requires Python', () => {
      const requirements = selectWorkstationRequirements({
        workload: {
          kind: 'components',
          components: [
            { id: 'api', profileId: 'python-fastapi' }
          ]
        },
        specWorkflow: { id: 'openspec' },
        framework: { version: '1.11.0' },
        agents: []
      }, { includeFramework: false });

      const ids = requirements.map((r) => r.id);
      expect(ids).toContain('node');
      expect(ids).toContain('python');
      expect(ids).toContain('uv');
      expect(ids).not.toContain('go');
    });

    it('selects Go only when actual component profile requires Go', () => {
      const requirements = selectWorkstationRequirements({
        workload: {
          kind: 'components',
          components: [
            { id: 'api', profileId: 'go-huma' }
          ]
        },
        specWorkflow: { id: 'openspec' },
        framework: { version: '1.11.0' },
        agents: []
      }, { includeFramework: false });

      const ids = requirements.map((r) => r.id);
      expect(ids).toContain('node');
      expect(ids).toContain('go');
      expect(ids).not.toContain('python');
    });

    it('selects Azure CLI only when cloud is explicitly specified', () => {
      const requirements = selectWorkstationRequirements({
        workload: {
          kind: 'components',
          components: [
            { id: 'frontend', profileId: 'vue-component' }
          ],
          provider: { id: 'azure' }
        },
        specWorkflow: { id: 'openspec' },
        framework: { version: '1.11.0' },
        agents: []
      }, { includeFramework: false });

      const ids = requirements.map((r) => r.id);
      expect(ids).toContain('azure-cli');
    });
  });

  describe('doctor truthful component diagnostics', () => {
    it('diagnoses Vue component at custom root and verifies valid package.json', async () => {
      const dir = await createTestDir();
      const customRoot = path.join(dir, 'packages', 'web-app');
      await mkdir(customRoot, { recursive: true });
      await writeFile(
        path.join(customRoot, 'package.json'),
        JSON.stringify({ name: 'my-custom-vue-app', version: '1.0.0' }, null, 2)
      );

      const manifest = makeV8ComponentManifest({
        standards: {
          schemaVersion: 1,
          catalogDigest: 'sha256:' + 'a'.repeat(64),
          resourceCatalogDigest: 'sha256:' + 'b'.repeat(64),
          components: [
            {
              id: 'frontend',
              profile: {
                schemaVersion: 1,
                id: 'vue-component',
                revision: '1',
                digest: 'sha256:' + 'c'.repeat(64)
              },
              rootPathParts: ['packages', 'web-app']
            }
          ]
        }
      });
      await writeComponentManifest(dir, manifest);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const presentation = new PresentationSession({ stdout, stderr, json: true });
      const runner = new ReadyInitRunner();

      const exitCode = await diagnoseProject(
        { json: true },
        { cwd: dir, stdout, stderr, presentation, runner, stableReleaseLookup: async () => { throw new Error('offline fixture'); } }
      );

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout.text());
      const layerTitles = output.layers.map((l: { title: string }) => l.title);
      expect(layerTitles).toContain('CLI');
      expect(layerTitles).toContain('Environment');
      expect(layerTitles).toContain('Project');
      expect(layerTitles).not.toContain('Cloud - azure');

      const projectLayer = output.layers.find((l: { title: string }) => l.title === 'Project');
      const componentCheck = projectLayer.checks.find((c: { label: string }) =>
        c.label.includes('frontend')
      );
      expect(componentCheck).toBeDefined();
      expect(componentCheck.severity).toBe('ok');
      expect(componentCheck.detail).toContain('my-custom-vue-app');

      const frameworkCheck = projectLayer.checks.find((c: { id?: string }) =>
        c.id === 'framework-uninitialized-state'
      );
      expect(frameworkCheck).toBeDefined();
      expect(frameworkCheck.severity).toBe('warn');
      expect(frameworkCheck.state).toBe('uninitialized');
    });

    it('reports failure when package.json is missing in custom component root', async () => {
      const dir = await createTestDir();
      const customRoot = path.join(dir, 'custom-ui');
      await mkdir(customRoot, { recursive: true });

      const manifest = makeV8ComponentManifest({
        standards: {
          schemaVersion: 1,
          catalogDigest: 'sha256:' + 'a'.repeat(64),
          resourceCatalogDigest: 'sha256:' + 'b'.repeat(64),
          components: [
            {
              id: 'frontend',
              profile: {
                schemaVersion: 1,
                id: 'vue-component',
                revision: '1',
                digest: 'sha256:' + 'c'.repeat(64)
              },
              rootPathParts: ['custom-ui']
            }
          ]
        }
      });
      await writeComponentManifest(dir, manifest);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const presentation = new PresentationSession({ stdout, stderr, json: true });
      const runner = new ReadyInitRunner();

      const exitCode = await diagnoseProject(
        { json: true },
        { cwd: dir, stdout, stderr, presentation, runner, stableReleaseLookup: async () => { throw new Error('offline fixture'); } }
      );

      expect(exitCode).toBe(1);
      const output = JSON.parse(stdout.text());
      const projectLayer = output.layers.find((l: { title: string }) => l.title === 'Project');
      const componentCheck = projectLayer.checks.find((c: { label: string }) =>
        c.label.includes('frontend')
      );
      expect(componentCheck).toBeDefined();
      expect(componentCheck.severity).toBe('fail');
      expect(componentCheck.detail).toContain('missing package.json at custom-ui');
    });

    it('runs cloud layer only when explicit --cloud is passed', async () => {
      const dir = await createTestDir();
      const rootPkg = path.join(dir, 'package.json');
      await writeFile(rootPkg, JSON.stringify({ name: 'root-vue' }, null, 2));

      const manifest = makeV8ComponentManifest({
        standards: {
          schemaVersion: 1,
          catalogDigest: 'sha256:' + 'a'.repeat(64),
          resourceCatalogDigest: 'sha256:' + 'b'.repeat(64),
          components: [
            {
              id: 'vue-app',
              profile: {
                schemaVersion: 1,
                id: 'vue-component',
                revision: '1',
                digest: 'sha256:' + 'c'.repeat(64)
              },
              rootPathParts: []
            }
          ]
        }
      });
      await writeComponentManifest(dir, manifest);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const presentation = new PresentationSession({ stdout, stderr, json: true });
      const runner = new ReadyInitRunner();

      await diagnoseProject(
        { json: true, cloud: 'azure' },
        { cwd: dir, stdout, stderr, presentation, runner, stableReleaseLookup: async () => { throw new Error('offline fixture'); } }
      );

      const output = JSON.parse(stdout.text());
      const layerTitles = output.layers.map((l: { title: string }) => l.title);
      expect(layerTitles).toContain('Cloud - azure');
    });
  });

  describe('dev and infra helpers on component-only projects', () => {
    it('dev helper rejects component-only project without compose config and guides to liftoff assess', async () => {
      const dir = await createTestDir();
      const manifest = makeV8ComponentManifest();
      await writeComponentManifest(dir, manifest);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const presentation = new PresentationSession({ stdout, stderr });

      const parsed = parseArgs(['dev']);
      const code = await helperCommand(parsed, { cwd: dir, stdout, stderr, presentation }, 'docker compose');

      expect(code).toBe(1);
      const text = stderr.text() + stdout.text();
      expect(text).toContain('inapplicable');
      expect(text).toContain('liftoff assess');
    });

    it('dev helper emits command when compose config actually exists', async () => {
      const dir = await createTestDir();
      const manifest = makeV8ComponentManifest();
      await writeComponentManifest(dir, manifest);
      await writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  app:\n    image: nginx\n');

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const presentation = new PresentationSession({ stdout, stderr });

      const parsed = parseArgs(['dev']);
      const code = await helperCommand(parsed, { cwd: dir, stdout, stderr, presentation }, 'docker compose');

      expect(code).toBe(0);
      const text = stdout.text();
      expect(text).toContain('docker compose up --build');
    });

    it('infra helper rejects component-only project without tofu config and guides to liftoff assess', async () => {
      const dir = await createTestDir();
      const manifest = makeV8ComponentManifest();
      await writeComponentManifest(dir, manifest);

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const presentation = new PresentationSession({ stdout, stderr });

      const parsed = parseArgs(['infra']);
      const code = await helperCommand(parsed, { cwd: dir, stdout, stderr, presentation }, 'tofu');

      expect(code).toBe(1);
      const text = stderr.text() + stdout.text();
      expect(text).toContain('inapplicable');
      expect(text).toContain('liftoff assess');
    });
  });
});

import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyProjectFileTransaction,
  deleteProjectFile,
  loadManifest,
  resolveProjectPath,
  validateArtifactPathParts,
  validateGeneratedProject,
  writeArtifacts,
  writeProjectFile
} from '../src/file-system.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const cleanups: string[] = [];

interface TestManifest {
  artifactVersion?: unknown;
  project: {
    frontend: unknown;
    agents?: unknown;
    defaultAgent?: unknown;
  };
  framework?: unknown;
  artifacts: Array<{
    logicalName: string;
    pathParts: string[];
    contentHash: string;
  }>;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function fixtureManifest(): Promise<TestManifest> {
  return JSON.parse(await readFile(path.join(fixturesDir, 'manifest-v2.json'), 'utf8')) as TestManifest;
}

async function manifestRoot(mutate?: (manifest: TestManifest) => void): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-manifest-'));
  cleanups.push(root);
  const manifest = await fixtureManifest();
  mutate?.(manifest);
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return root;
}

async function namedManifestRoot(
  fixtureName: string,
  mutate?: (manifest: Record<string, unknown>) => void
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-manifest-named-'));
  cleanups.push(root);
  const parsed = JSON.parse(await readFile(path.join(fixturesDir, fixtureName), 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Fixture ${fixtureName} must contain an object.`);
  }

  const manifest = parsed as Record<string, unknown>;
  mutate?.(manifest);
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return root;
}

async function v5ManifestRoot(
  values: Partial<Parameters<typeof buildProjectPlan>[0]> = {},
  mutate?: (manifest: Record<string, unknown>) => void
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-manifest-v5-'));
  cleanups.push(root);
  const artifacts = buildArtifacts(buildProjectPlan({
    projectName: 'Manifest V5',
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure',
    ...values
  }, { requireProjectName: true }));
  const manifest = JSON.parse(
    artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content
  ) as Record<string, unknown>;
  const managedArtifacts = manifest.managedArtifacts as Array<Record<string, unknown>>;
  const projectArtifacts = manifest.projectArtifacts as Array<Record<string, unknown>>;
  manifest.artifactVersion = 5;
  manifest.artifacts = [
    ...managedArtifacts,
    ...projectArtifacts.map((artifact) => ({
      logicalName: artifact.logicalName,
      category: artifact.category,
      pathParts: artifact.pathParts,
      contentHash: artifact.generationHash
    }))
  ];
  delete manifest.managedArtifacts;
  delete manifest.projectArtifacts;
  mutate?.(manifest);
  await writeFile(
    path.join(root, 'liftoff.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return root;
}

async function v6ManifestRoot(
  mutate?: (manifest: Record<string, unknown>) => void
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-manifest-v6-'));
  cleanups.push(root);
  const artifacts = buildArtifacts(buildProjectPlan({
    projectName: 'Manifest V6',
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure'
  }, { requireProjectName: true }));
  const manifest = JSON.parse(
    artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content
  ) as Record<string, unknown>;
  mutate?.(manifest);
  await writeFile(
    path.join(root, 'liftoff.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return root;
}

describe('manifest validation', () => {
  it('loads the supported frozen manifest', async () => {
    const root = await manifestRoot();
    const manifest = await loadManifest(root);
    expect(manifest.project.workload.kind).toBe('genai');
    expect(manifest.governance).toEqual({
      profile: 'unspecified',
      state: 'unspecified'
    });
    expect(manifest.projectArtifacts.length).toBeGreaterThan(0);
  });

  it.each([
    ['manifest-v2.json', 'genai'],
    ['manifest-v3.json', 'standard'],
    ['manifest-v4-genai.json', 'genai'],
    ['manifest-v4-standard.json', 'standard'],
    ['manifest-v4-power-apps.json', 'power-apps-code-app']
  ])('normalizes %s into workload %s', async (fixtureName, expectedKind) => {
    const root = await namedManifestRoot(fixtureName);
    const manifest = await loadManifest(root);
    expect(manifest.project.workload.kind).toBe(expectedKind);
    expect(manifest.governance).toEqual({
      profile: 'unspecified',
      state: 'unspecified'
    });
  });

  it.each([
    ['manifest-v2.json', false],
    ['manifest-v4-genai.json', true]
  ] as const)('accepts generic identity in supported legacy fixture %s', async (
    fixtureName,
    nestedWorkload
  ) => {
    const root = await namedManifestRoot(fixtureName, (manifest) => {
      const project = manifest.project as Record<string, unknown>;
      if (nestedWorkload) {
        (project.workload as Record<string, unknown>).pattern = 'generic';
      } else {
        project.pattern = 'generic';
      }
    });
    const manifest = await loadManifest(root);
    expect(manifest.project.workload).toMatchObject({
      kind: 'genai',
      pattern: 'generic'
    });
  });

  it('accepts generic identity in schema v5 and rejects missing or unknown patterns', async () => {
    const genericV3Root = await manifestRoot((manifest) => {
      manifest.artifactVersion = 3;
      const project = manifest.project as Record<string, unknown>;
      project.projectType = 'genai';
      project.apiStack = 'python-fastapi';
      project.pattern = 'generic';
      project.agents = ['github-copilot'];
      manifest.framework = {
        state: 'initialized',
        adapter: 'openspec',
        contractVersion: '1.11.0'
      };
    });
    expect((await loadManifest(genericV3Root)).project.workload).toMatchObject({
      kind: 'genai',
      pattern: 'generic'
    });

    const genericV5 = await loadManifest(await v5ManifestRoot({
      projectType: 'genai',
      apiStack: 'python',
      pattern: 'generic'
    }));
    expect(genericV5.project.workload).toMatchObject({
      kind: 'genai',
      pattern: 'generic'
    });

    for (const value of [undefined, 'not-a-pattern']) {
      const root = await namedManifestRoot('manifest-v4-genai.json', (manifest) => {
        const workload = (manifest.project as {
          workload: Record<string, unknown>;
        }).workload;
        if (value === undefined) {
          delete workload.pattern;
        } else {
          workload.pattern = value;
        }
      });
      await expect(loadManifest(root)).rejects.toThrow(
        value === undefined
          ? /pattern must be a non-empty string/
          : /require a valid pattern/
      );
    }
  });

  it('loads immutable Power Apps starter identity and plugin preference from v4', async () => {
    const root = await namedManifestRoot('manifest-v4-power-apps.json');
    const manifest = await loadManifest(root);
    expect(manifest.project.workload).toEqual({
      kind: 'power-apps-code-app',
      starter: {
        repository: 'https://github.com/microsoft/PowerAppsCodeApps',
        path: 'templates/starter',
        commit: '3438c352483e40982f6c5c0fc36fd71f8e7adbbb'
      },
      codeAppsPlugin: false
    });
  });

  it('strictly loads enabled and disabled schema-v5 governance state', async () => {
    const enabled = await loadManifest(await v5ManifestRoot());
    expect(enabled.artifactVersion).toBe(5);
    expect(enabled.governance).toEqual({
      profile: 'single-maintainer-gitflow',
      policyVersion: '5',
      state: 'handoff-generated'
    });

    const previousPolicy = await loadManifest(await v5ManifestRoot({}, (manifest) => {
      (manifest.governance as Record<string, unknown>).policyVersion = '2';
    }));
    expect(previousPolicy.governance).toEqual({
      profile: 'single-maintainer-gitflow',
      policyVersion: '2',
      state: 'handoff-generated'
    });

    const disabled = await loadManifest(await v5ManifestRoot({
      governanceProfile: 'none'
    }));
    expect(disabled.governance).toEqual({
      profile: 'none',
      state: 'disabled'
    });
    expect(disabled.managedArtifacts.some((artifact) =>
      artifact.category === 'governance'
    )).toBe(false);

    const partial = await loadManifest(await v5ManifestRoot({}, (manifest) => {
      (manifest.governance as Record<string, unknown>).state = 'handoff-partial';
      manifest.artifacts = (manifest.artifacts as Array<Record<string, unknown>>)
        .filter((artifact) =>
          artifact.logicalName !== 'repository-governance-copilot-launcher'
        );
    }));
    expect(partial.governance).toEqual({
      profile: 'single-maintainer-gitflow',
      policyVersion: '5',
      state: 'handoff-partial'
    });
    expect(partial.managedArtifacts.some((artifact) =>
      artifact.logicalName === 'repository-governance-copilot-launcher'
    )).toBe(false);
  });

  it.each([
      [
        'unknown profile',
        (manifest: Record<string, unknown>) => {
          (manifest.governance as Record<string, unknown>).profile = 'unknown';
        },
        /governance profile "unknown" is invalid/
      ],
      [
        'wrong enabled state',
        (manifest: Record<string, unknown>) => {
          (manifest.governance as Record<string, unknown>).state = 'active';
        },
        /requires handoff-generated or handoff-partial state/
      ],
      [
        'complete partial state',
        (manifest: Record<string, unknown>) => {
          (manifest.governance as Record<string, unknown>).state = 'handoff-partial';
        },
        /handoff-partial requires at least one applicable artifact/
      ],
      [
        'future policy version',
        (manifest: Record<string, unknown>) => {
          (manifest.governance as Record<string, unknown>).policyVersion = '6';
        },
        /policyVersion cannot be newer than 5/
      ],
      [
        'malformed policy version',
        (manifest: Record<string, unknown>) => {
          (manifest.governance as Record<string, unknown>).policyVersion = 'legacy';
        },
        /policyVersion must be a positive integer/
      ],
      [
        'live enforcement field',
        (manifest: Record<string, unknown>) => {
          (manifest.governance as Record<string, unknown>).enforced = true;
        },
        /inapplicable or unknown field: enforced/
      ],
      [
        'missing launcher',
        (manifest: Record<string, unknown>) => {
          manifest.artifacts = (manifest.artifacts as Array<Record<string, unknown>>)
            .filter((artifact) =>
              artifact.logicalName !== 'repository-governance-copilot-launcher'
            );
        },
        /missing artifact repository-governance-copilot-launcher/
      ],
      [
        'managed activation baseline',
        (manifest: Record<string, unknown>) => {
          (manifest.artifacts as Array<Record<string, unknown>>).push({
            logicalName: 'activation-baseline',
            category: 'governance',
            pathParts: ['governance', 'activation-baseline.json'],
            contentHash: `sha256:${'a'.repeat(64)}`
          });
        },
        /activation-baseline\.json is user-owned/
      ]
  ])('rejects invalid v5 governance: %s', async (_name, mutate, expected) => {
    await expect(loadManifest(await v5ManifestRoot({}, mutate))).rejects
      .toThrow(expected);
  });

  it.each([
    [
      'unknown manifest version',
      (manifest: Record<string, unknown>) => {
        manifest.artifactVersion = 7;
      },
      /Unsupported manifest artifactVersion 7.*2, 3, 4, 5, 6/
    ],
    [
      'mutable Power Apps starter ref',
      (manifest: Record<string, unknown>) => {
        const project = manifest.project as { workload: { starter: { commit: string } } };
        project.workload.starter.commit = 'main';
      },
      /40-character lowercase Git commit/
    ],
    [
      'missing Power Apps starter path',
      (manifest: Record<string, unknown>) => {
        const project = manifest.project as { workload: { starter: Record<string, unknown> } };
        delete project.workload.starter.path;
      },
      /starter\.path must be a non-empty string/
    ],
    [
      'Power Apps API field',
      (manifest: Record<string, unknown>) => {
        const project = manifest.project as { workload: Record<string, unknown> };
        project.workload.apiStack = 'node-fastify';
      },
      /inapplicable or unknown field: apiStack/
    ],
    [
      'standard GenAI field',
      (manifest: Record<string, unknown>) => {
        const project = manifest.project as { workload: Record<string, unknown> };
        project.workload.pattern = 'rag';
      },
      /inapplicable or unknown field: pattern/
    ]
  ])('rejects malformed v4 state: %s', async (_label, mutate, expected) => {
    const fixture = _label === 'standard GenAI field'
      ? 'manifest-v4-standard.json'
      : 'manifest-v4-power-apps.json';
    const root = await namedManifestRoot(fixture, mutate);
    await expect(loadManifest(root)).rejects.toThrow(expected);
  });

  it.each<Array<[string[], string]>>([
    [['..', 'outside.txt'], 'unsafe path part'],
    [['/tmp'], 'unsafe path part'],
    [['C:', 'outside.txt'], 'unsafe path part'],
    [['\\\\server\\share'], 'unsafe path part'],
    [['nested/file.txt'], 'unsafe path part'],
    [['nested\\file.txt'], 'unsafe path part'],
    [[''], 'non-empty string']
  ])('rejects unsafe path parts %j', async (pathParts, message) => {
    const root = await manifestRoot((manifest) => {
      manifest.artifacts[0].pathParts = pathParts;
    });
    await expect(loadManifest(root)).rejects.toThrow(message);
  });

  it('rejects malformed project and artifact fields with field-specific errors', async () => {
    const invalidFrontend = await manifestRoot((manifest) => {
      manifest.project.frontend = 'false';
    });
    await expect(loadManifest(invalidFrontend)).rejects.toThrow('Manifest.project.frontend must be a boolean');

    const invalidHash = await manifestRoot((manifest) => {
      manifest.artifacts[0].contentHash = 'not-a-hash';
    });
    await expect(loadManifest(invalidHash)).rejects.toThrow('contentHash must be a sha256-prefixed');
  });

  it('rejects duplicate logical names and paths', async () => {
    const duplicateName = await manifestRoot((manifest) => {
      manifest.artifacts[1].logicalName = manifest.artifacts[0].logicalName;
    });
    await expect(loadManifest(duplicateName)).rejects.toThrow('duplicate logicalName');

    const duplicatePath = await manifestRoot((manifest) => {
      manifest.artifacts[1].pathParts = manifest.artifacts[0].pathParts;
    });
    await expect(loadManifest(duplicatePath)).rejects.toThrow('duplicate artifact path');
  });

  it.each([
    [
      'unknown managed logical name',
      (manifest: Record<string, unknown>) => {
        (manifest.managedArtifacts as Array<Record<string, unknown>>).push({
          logicalName: 'production-source',
          category: 'backend',
          pathParts: ['backend', 'main.ts'],
          contentHash: `sha256:${'a'.repeat(64)}`
        });
      },
      /not an explicit managed-core logical name/
    ],
    [
      'managed core in project provenance',
      (manifest: Record<string, unknown>) => {
        const managed = manifest.managedArtifacts as Array<Record<string, unknown>>;
        const [artifact] = managed.splice(0, 1);
        (manifest.projectArtifacts as Array<Record<string, unknown>>).push({
          logicalName: artifact.logicalName,
          category: artifact.category,
          pathParts: artifact.pathParts,
          generatedBy: '0.9.0',
          generationHash: artifact.contentHash,
          provisioningGroup: 'base'
        });
      },
      /cannot contain a managed-core logical name/
    ],
    [
      'invalid project generation hash',
      (manifest: Record<string, unknown>) => {
        (manifest.projectArtifacts as Array<Record<string, unknown>>)[0].generationHash = 'invalid';
      },
      /generationHash must be a sha256-prefixed/
    ],
    [
      'invalid project generating version',
      (manifest: Record<string, unknown>) => {
        (manifest.projectArtifacts as Array<Record<string, unknown>>)[0].generatedBy = 'latest';
      },
      /generatedBy must be a valid semantic version/
    ],
    [
      'invalid provisioning group',
      (manifest: Record<string, unknown>) => {
        (manifest.projectArtifacts as Array<Record<string, unknown>>)[0].provisioningGroup = 'configuration';
      },
      /provisioningGroup is invalid/
    ],
    [
      'duplicate cross-authority path',
      (manifest: Record<string, unknown>) => {
        const managed = (manifest.managedArtifacts as Array<Record<string, unknown>>)[0];
        (manifest.projectArtifacts as Array<Record<string, unknown>>)[0].pathParts = managed.pathParts;
      },
      /duplicate artifact path/
    ]
  ])('rejects invalid v6 authority: %s', async (_name, mutate, expected) => {
    await expect(loadManifest(await v6ManifestRoot(mutate))).rejects.toThrow(expected);
  });

  it.each([
    [
      'non-canonical agents',
      (manifest: TestManifest) => {
        manifest.artifactVersion = 3;
        manifest.project.agents = ['claude', 'github-copilot'];
        manifest.project.defaultAgent = 'claude';
        manifest.framework = { state: 'initialized', adapter: 'openspec', contractVersion: '1.6.0' };
      },
      /canonical order/
    ],
    [
      'initialized framework without a contract',
      (manifest: TestManifest) => {
        manifest.artifactVersion = 3;
        manifest.project.agents = ['github-copilot'];
        manifest.framework = { state: 'initialized', adapter: 'openspec' };
      },
      /requires Manifest\.framework\.contractVersion/
    ],
    [
      'legacy framework claiming integrations',
      (manifest: TestManifest) => {
        manifest.artifactVersion = 3;
        manifest.project.agents = ['github-copilot'];
        manifest.framework = { state: 'legacy', adapter: 'openspec' };
      },
      /Legacy framework state cannot claim/
    ]
  ])('rejects invalid v3 state: %s', async (_label, mutate, expected) => {
    const root = await manifestRoot(mutate);
    await expect(loadManifest(root)).rejects.toThrow(expected);
  });
});

describe('project-confined paths', () => {
  it('accepts portable path parts and resolves them below the project root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-path-'));
    cleanups.push(root);
    expect(validateArtifactPathParts(['backend', 'apis', 'main.py'])).toEqual(['backend', 'apis', 'main.py']);
    expect(await resolveProjectPath(root, ['backend', 'apis', 'main.py']))
      .toBe(path.join(root, 'backend', 'apis', 'main.py'));
  });

  it('rejects symlinks that leave the project before reads or mutations', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-symlink-'));
    cleanups.push(parent);
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'keep\n', 'utf8');
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(resolveProjectPath(root, ['linked', 'sentinel.txt'])).rejects.toThrow('escapes project root');
    await expect(writeProjectFile(root, ['linked', 'sentinel.txt'], 'replace\n')).rejects.toThrow('escapes project root');
    await expect(deleteProjectFile(root, ['linked', 'sentinel.txt'])).rejects.toThrow('escapes project root');
    expect(await readFile(sentinel, 'utf8')).toBe('keep\n');
  });

  it('allows a symlink whose resolved target remains inside the project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-internal-symlink-'));
    cleanups.push(root);
    await mkdir(path.join(root, 'real'));
    await symlink(path.join(root, 'real'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFile(root, ['linked', 'file.txt'], 'content\n');
    await access(path.join(root, 'real', 'file.txt'));
  });

  it('reports project-provenance paths that escape through a symlink', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-provenance-symlink-'));
    cleanups.push(parent);
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    await writeArtifacts(root, buildArtifacts(buildProjectPlan({
      projectName: 'Provenance Paths',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure'
    }, { requireProjectName: true })));
    await rm(path.join(root, 'backend'), { recursive: true });
    await symlink(
      outside,
      path.join(root, 'backend'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    expect(await validateGeneratedProject(root)).toContainEqual(
      expect.stringContaining(
        'Unsafe project provenance path for go-backend-module at backend/go.mod'
      )
    );
  });

  it('atomically replaces a project file without leaving temporary artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-atomic-write-'));
    cleanups.push(root);
    await writeProjectFile(root, ['README.md'], 'first\n');
    await writeProjectFile(root, ['README.md'], 'second\n');
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('second\n');
    expect((await readdir(root)).filter((name) => name.includes('.liftoff-'))).toEqual([]);
  });

  it('rolls back applied project mutations and created directories after a failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-transaction-'));
    cleanups.push(root);
    const original = Buffer.from([0, 1, 2, 255]);
    await writeFile(path.join(root, 'existing.bin'), original);
    await writeFile(path.join(root, 'remove.txt'), 'restore me\n', 'utf8');

    await expect(applyProjectFileTransaction(root, [
      { type: 'write', pathParts: ['existing.bin'], content: 'replacement\n' },
      { type: 'delete', pathParts: ['remove.txt'] },
      {
        type: 'write',
        pathParts: ['.liftoff', 'governance', 'policy.md'],
        content: 'new governance policy\n'
      },
      { type: 'write', pathParts: ['liftoff.manifest.json'], content: '{}\n' }
    ], {
      onBeforeMutation: async (_mutation, index) => {
        if (index === 3) {
          throw new Error('simulated manifest failure');
        }
      }
    })).rejects.toThrow('All applied changes were rolled back');

    expect(await readFile(path.join(root, 'existing.bin'))).toEqual(original);
    expect(await readFile(path.join(root, 'remove.txt'), 'utf8')).toBe('restore me\n');
    await expect(access(path.join(root, '.liftoff'))).rejects.toThrow();
    await expect(access(path.join(root, 'liftoff.manifest.json'))).rejects.toThrow();
  });
});

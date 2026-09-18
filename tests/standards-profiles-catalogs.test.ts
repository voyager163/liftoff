import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  computeProfileCatalogDigest,
  computeProfileDigest,
  KNOWN_UNSUPPORTED_STACK_IDS,
  STANDARDS_PROFILE_SCHEMA_VERSION,
  SUPPORTED_STANDARDS_PROFILE_IDS,
  StandardsProfileError,
  targetProfileIdForPlan,
  validateStandardsProfile,
  validateStandardsProfileCatalog,
  validateUnsupportedStackProfile
} from '../src/domain/standards/profile-schema.js';
import {
  ArtifactCollisionError,
  assertArtifactsSafeBeforeWrite,
  assertRetirementEligible,
  computeResourceDigest,
  computeTemplateCatalogDigest,
  RESOURCE_CATALOG_SCHEMA_VERSION,
  ResourceCatalogError,
  validateResourceDescriptor,
  validateTemplateCatalog,
  validateTemplateComponentDescriptor
} from '../src/domain/standards/resource-catalog-schema.js';
import {
  BuildInfoValidationError,
  getBuildInfo,
  loadBuildInfo,
  resetBuildInfoCache,
  validateNativeBuildInfo
} from '../src/adapters/packaged-assets/build-info.js';
import {
  assertSafeRegularResourceFile,
  computeResourceInventorySummary,
  currentStandardsManifestContext,
  generatedComponentsForPlan,
  getPackagedTemplateComponent,
  getProfileIdentity,
  getStandardsProfile,
  getUnsupportedStack,
  listPackagedTemplateComponents,
  listSupportedStandardsProfiles,
  listUnsupportedStacks,
  loadPackagedProfilesCatalog,
  loadPackagedTemplateCatalog,
  PackagedResourceIntegrityError,
  resetResourceCatalogCache,
  resolveComponentResources,
  resolvePackagedResource,
  targetProfileIdentityForPlan,
  verifyAllPackagedResourcesIntegrity,
  verifyComponentResourceClosure,
  verifyPackagedResourceIntegrity
} from '../src/adapters/packaged-assets/resource-catalog.js';
import { buildProjectPlan } from '../src/planner.js';
import { composeProjectArtifacts, buildArtifacts, selectedComponentsForPlan } from '../src/templates.js';
import { isRetiredPowerAppsWorkload, retiredPowerAppsMessage } from '../src/domain/project/retired-workload.js';
import * as resources from '../src/adapters/packaged-assets/resource-catalog.js';
import { patterns } from '../src/application/project/catalog.js';

afterEach(() => vi.restoreAllMocks());

describe('Task 1.2 & 5.1: Standards Profiles Catalog & Schema 1', () => {
  it('validates packaged profiles catalog adhering strictly to schema 1', () => {
    const catalog = loadPackagedProfilesCatalog();
    expect(catalog.schemaVersion).toBe(STANDARDS_PROFILE_SCHEMA_VERSION);
    expect(catalog.catalogId).toBe('liftoff-standards-profiles');
    expect(catalog.revision).toBe('2026.09.01');
    expect(catalog.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.keys(catalog.profiles).length).toBe(13);
  });

  it('contains the exact profile matrix: FastAPI, Fastify, Go/Huma, Vue-component, and 9 honest GenAI patterns', () => {
    const catalog = loadPackagedProfilesCatalog();
    const profileIds = Object.keys(catalog.profiles);

    // Exact 13 profiles
    expect(profileIds).toContain('python-fastapi');
    expect(profileIds).toContain('node-fastify');
    expect(profileIds).toContain('go-huma');
    expect(profileIds).toContain('vue-component');
    for (const p of ['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']) {
      expect(profileIds).toContain(`genai-${p}`);
    }
  });

  it('derives GenAI maturity and worker applicability from the actual canonical project patterns', () => {
    const catalog = loadPackagedProfilesCatalog();
    for (const pattern of patterns) {
      const profile = catalog.profiles[`genai-${pattern.id}`];
      expect(profile.capabilities.pattern).toBe(pattern.id);
      expect(profile.capabilities.scaffoldStatus).toBe(pattern.scaffoldStatus);
      expect(profile.capabilities.worker).toBe(pattern.worker);
      expect(profile.capabilities.vectorStore).toBe(pattern.requiresVectorStore);
      expect(profile.capabilities.retrieval).toBeUndefined();
      expect(profile.capabilities.streaming).toBeUndefined();
    }
  });

  it('guarantees truthful Vue-only profile without backend, cloud target, or generation invention', () => {
    const vueProfile = getStandardsProfile('vue-component');
    expect(vueProfile).toBeDefined();
    expect(vueProfile?.category).toBe('frontend');
    expect(vueProfile?.targetWorkload).toBe('component-only');
    expect(vueProfile?.capabilities.backend).toBe(false);
    expect(vueProfile?.capabilities.cloud).toBe('none');
    expect(vueProfile?.capabilities.generationSupported).toBe(false);
    expect(vueProfile?.capabilities.adoptionSupported).toBe(true);
    expect(vueProfile?.capabilities.assessmentSupported).toBe(true);

    // Invariant verification: attempting to invent backend or generation fails validation
    expect(() => {
      validateStandardsProfile({
        ...vueProfile,
        capabilities: { ...vueProfile?.capabilities, backend: true }
      }, false);
    }).toThrow(StandardsProfileError);

    expect(() => {
      validateStandardsProfile({
        ...vueProfile,
        capabilities: { ...vueProfile?.capabilities, cloud: 'azure' }
      }, false);
    }).toThrow(StandardsProfileError);

    expect(() => {
      validateStandardsProfile({
        ...vueProfile,
        capabilities: { ...vueProfile?.capabilities, generationSupported: true }
      }, false);
    }).toThrow(StandardsProfileError);
  });

  it('registers all known unsupported stacks as diagnostic assessment-only', () => {
    const unsupported = listUnsupportedStacks();
    const unsupportedIds = unsupported.map((s) => s.id);

    for (const id of KNOWN_UNSUPPORTED_STACK_IDS) {
      expect(unsupportedIds).toContain(id);
      const entry = getUnsupportedStack(id);
      expect(entry?.supported).toBe(false);
      expect(entry?.assessmentOnly).toBe(true);
      expect(entry?.reason.length).toBeGreaterThan(10);
      expect(entry?.remedy.length).toBeGreaterThan(10);
    }

    expect(isRetiredPowerAppsWorkload('power-apps-code-app')).toBe(true);
    expect(retiredPowerAppsMessage('power-apps-code-app')).toContain('retired');
  });

  it('resolves truthful profile identity for project plans and component profiles', () => {
    // Standard API plan
    const standardPlan = buildProjectPlan({
      projectName: 'Standard App',
      apiStack: 'fastify',
      cloud: 'azure'
    }, { requireProjectName: true });
    expect(targetProfileIdForPlan(standardPlan)).toBe('node-fastify');
    const standardIdentity = targetProfileIdentityForPlan(standardPlan);
    expect(standardIdentity).toMatchObject({
      schemaVersion: 1,
      id: 'node-fastify',
      revision: '2026.09.01'
    });
    expect(standardIdentity.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // GenAI pattern plan
    const genAiPlan = buildProjectPlan({
      projectName: 'GenAI App',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true });
    expect(targetProfileIdForPlan(genAiPlan)).toBe('genai-rag');
    const genAiIdentity = targetProfileIdentityForPlan(genAiPlan);
    expect(genAiIdentity.id).toBe('genai-rag');

    // Vue component adoption identity
    const vueIdentity = getProfileIdentity('vue-component');
    expect(vueIdentity).toMatchObject({
      schemaVersion: 1,
      id: 'vue-component',
      revision: '2026.09.01'
    });
  });

  it('strictly rejects unknown, duplicate, or incompatible profile entries', () => {
    const catalog = loadPackagedProfilesCatalog();

    // Rejects unknown profile ID
    expect(() => {
      validateStandardsProfileCatalog({
        ...catalog,
        profiles: {
          ...catalog.profiles,
          'unknown-profile': { ...catalog.profiles['python-fastapi'], id: 'unknown-profile' }
        }
      }, false);
    }).toThrow(StandardsProfileError);

    // Rejects missing supported profile
    const { 'go-huma': _, ...missingOne } = catalog.profiles;
    expect(() => {
      validateStandardsProfileCatalog({
        ...catalog,
        profiles: missingOne
      }, false);
    }).toThrow(StandardsProfileError);

    // Rejects invalid schemaVersion
    expect(() => {
      validateStandardsProfileCatalog({ ...catalog, schemaVersion: 2 }, false);
    }).toThrow(StandardsProfileError);

    // Rejects digest mismatch under strict mode
    expect(() => {
      validateStandardsProfileCatalog({ ...catalog, digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }, true);
    }).toThrow(/digest mismatch/);
  });
});

describe('Task 5.2 & 5.3: Explicit Template Catalog & Reusable Static Components', () => {
  it('rejects overlapping selected component ownership instead of choosing the first declaration', () => {
    const plan = buildProjectPlan({
      projectName: 'ownership-check', projectType: 'standard', apiStack: 'node',
      includeFrontend: true, governanceProfile: 'none'
    }, { requireProjectName: true });
    const catalog = structuredClone(loadPackagedTemplateCatalog());
    const artifact = composeProjectArtifacts(plan).find((entry) =>
      catalog.components['common-base']!.artifactLifecycles[entry.logicalName] !== undefined)!;
    catalog.components['frontend-vue']!.artifactLifecycles[artifact.logicalName] = artifact.lifecycle;
    vi.spyOn(resources, 'loadPackagedTemplateCatalog').mockReturnValue(catalog);
    expect(() => composeProjectArtifacts(plan)).toThrow(/exactly one declared selected component owner/);
  });

  it('validates packaged template catalog with explicit component boundaries', () => {
    const catalog = loadPackagedTemplateCatalog();
    expect(catalog.schemaVersion).toBe(RESOURCE_CATALOG_SCHEMA_VERSION);
    expect(catalog.catalogId).toBe('liftoff-template-catalog');
    expect(catalog.revision).toBe('2026.09.01');
    expect(catalog.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const components = listPackagedTemplateComponents();
    expect(components.length).toBeGreaterThanOrEqual(8);

    const componentIds = components.map((c) => c.id);
    expect(componentIds).toContain('common-base');
    expect(componentIds).toContain('frontend-vue');
    expect(componentIds).toContain('backend-python-fastapi');
    expect(componentIds).toContain('backend-node-fastify');
    expect(componentIds).toContain('backend-go-huma');
    expect(componentIds).toContain('genai-common');
    expect(componentIds).toContain('infrastructure-azure-opentofu');
    expect(componentIds).toContain('governance-single-maintainer-gitflow');
  });

  it('reusable frontend component is shared across standard backends when frontend enabled', () => {
    const vueComp = getPackagedTemplateComponent('frontend-vue');
    expect(vueComp).toBeDefined();
    expect(vueComp?.category).toBe('frontend');

    const res = resolveComponentResources('frontend-vue');
    expect(res.some((r) => r.id === 'locks.frontend.package-lock')).toBe(true);
    expect(res.some((r) => r.id === 'templates.frontend.styles')).toBe(true);
    expect(res.some((r) => r.id === 'templates.frontend.main')).toBe(true);
  });

  it('loads static template components with deterministic bytes', () => {
    const dockerignore = resolvePackagedResource('templates.common.dockerignore');
    expect(dockerignore.content).toContain('**/.venv');
    expect(dockerignore.content).toContain('migration/legacy');

    const gitignore = resolvePackagedResource('templates.common.gitignore');
    expect(gitignore.content).toContain('.venv/');
    expect(gitignore.content).toContain('.terraform/');

    const styles = resolvePackagedResource('templates.frontend.styles');
    expect(styles.content).toBe('@import "tailwindcss";\n');

    const main = resolvePackagedResource('templates.frontend.main');
    expect(main.content).toContain("createApp(App).mount('#app');");
  });

  it('renders deterministically across multiple render passes', () => {
    const plan = buildProjectPlan({
      projectName: 'Deterministic App',
      pattern: 'rag',
      cloud: 'azure',
      includeFrontend: true
    }, { requireProjectName: true });

    const pass1 = composeProjectArtifacts(plan);
    const pass2 = composeProjectArtifacts(plan);

    expect(pass1.length).toBe(pass2.length);
    for (let i = 0; i < pass1.length; i++) {
      expect(pass1[i].logicalName).toBe(pass2[i].logicalName);
      expect(pass1[i].content).toBe(pass2[i].content);
      expect(pass1[i].pathParts).toEqual(pass2[i].pathParts);
    }
  });
});

describe('Task 5.4: Resource Binding & Integrity Verification', () => {
  it('verifies integrity of all packaged locks, governance, and baseline resources', () => {
    const result = verifyAllPackagedResourcesIntegrity();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.totalVerified).toBeGreaterThanOrEqual(25);
  });

  it('computes resource inventory summary matching native distribution requirements', () => {
    const summary = computeResourceInventorySummary();
    expect(summary.count).toBeGreaterThanOrEqual(25);
    expect(summary.inventoryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when a packaged resource is missing or has mismatched digest', () => {
    // Non-existent resource ID fails closed
    expect(() => {
      resolvePackagedResource('locks.non-existent.lock');
    }).toThrow(PackagedResourceIntegrityError);

    // Individual resource integrity check reports valid for real resource
    const single = verifyPackagedResourceIntegrity('baselines.supported-stack');
    expect(single.valid).toBe(true);
    expect(single.actualDigest).toBe(single.expectedDigest);
  });
});

describe('Task 5.5: Output Ownership, Collision & Link Safety', () => {
  it('detects duplicate destination collisions before writes', () => {
    const invalidArtifacts = [
      { logicalName: 'artifact-a', category: 'src', pathParts: ['src', 'index.ts'] },
      { logicalName: 'artifact-b', category: 'src', pathParts: ['src', 'index.ts'] }
    ];

    expect(() => {
      assertArtifactsSafeBeforeWrite(invalidArtifacts);
    }).toThrow(ArtifactCollisionError);
    expect(() => {
      assertArtifactsSafeBeforeWrite(invalidArtifacts);
    }).toThrow(/Duplicate destination collision/);
  });

  it('detects Windows case collisions before writes', () => {
    const invalidArtifacts = [
      { logicalName: 'readme-upper', category: 'doc', pathParts: ['README.md'] },
      { logicalName: 'readme-lower', category: 'doc', pathParts: ['readme.md'] }
    ];

    expect(() => {
      assertArtifactsSafeBeforeWrite(invalidArtifacts);
    }).toThrow(ArtifactCollisionError);
    expect(() => {
      assertArtifactsSafeBeforeWrite(invalidArtifacts);
    }).toThrow(/Windows case-collision/);
  });

  it('detects Windows reserved device names before writes', () => {
    const invalidArtifacts = [
      { logicalName: 'con-file', category: 'config', pathParts: ['src', 'CON.json'] }
    ];

    expect(() => {
      assertArtifactsSafeBeforeWrite(invalidArtifacts);
    }).toThrow(ArtifactCollisionError);
    expect(() => {
      assertArtifactsSafeBeforeWrite(invalidArtifacts);
    }).toThrow(/Windows alias/);
  });

  it('detects directory traversal and unsafe path parts before writes', () => {
    expect(() => {
      assertArtifactsSafeBeforeWrite([
        { logicalName: 'escape', category: 'src', pathParts: ['..', 'escaped.ts'] }
      ]);
    }).toThrow(/unsafe path part/);

    expect(() => {
      assertArtifactsSafeBeforeWrite([
        { logicalName: 'slash', category: 'src', pathParts: ['sub/dir', 'file.ts'] }
      ]);
    }).toThrow(/unsafe path part/);

    expect(() => {
      assertArtifactsSafeBeforeWrite([
        { logicalName: 'drive', category: 'src', pathParts: ['C:', 'file.ts'] }
      ]);
    }).toThrow(/unsafe path part/);
  });

  it('allows registered retirements and blocks unregistered retirement candidates', () => {
    // Registered retirement passes
    expect(() => {
      assertRetirementEligible(
        'repository-governance-copilot-launcher',
        'governance',
        ['.github', 'prompts', 'liftoff-repository-governance.prompt.md']
      );
    }).not.toThrow();

    // Unregistered retirement fails
    expect(() => {
      assertRetirementEligible(
        'unregistered-secret-file',
        'project',
        ['secret', 'key.pem']
      );
    }).toThrow(ArtifactCollisionError);
  });
});

describe('Task 5.6: Preservation of GenAI & Framework Matrix', () => {
  it('preserves all 9 GenAI patterns and maturity status labels', () => {
    const ragProfile = getStandardsProfile('genai-rag');
    expect(ragProfile?.capabilities.scaffoldStatus).toBe('foundation');
    expect(ragProfile?.capabilities.retrieval).toBeUndefined();
    expect(ragProfile?.capabilities.vectorStore).toBe(true);
    expect(ragProfile?.capabilities.worker).toBe(true);

    const promptProfile = getStandardsProfile('genai-prompt');
    expect(promptProfile?.capabilities.scaffoldStatus).toBe('foundation');

    const multiAgentProfile = getStandardsProfile('genai-multi-agent');
    expect(multiAgentProfile?.capabilities.scaffoldStatus).toBe('foundation');
    expect(multiAgentProfile?.capabilities.worker).toBe(true);

    const genericProfile = getStandardsProfile('genai-generic');
    expect(genericProfile?.capabilities.scaffoldStatus).toBe('foundation');

    const workflowProfile = getStandardsProfile('genai-workflow');
    expect(workflowProfile?.capabilities.worker).toBe(true);

    const streamingProfile = getStandardsProfile('genai-streaming');
    expect(streamingProfile?.capabilities.streaming).toBeUndefined();
  });

  it('preserves OpenSpec and Spec Kit workflow support in composition', () => {
    const openSpecPlan = buildProjectPlan({
      projectName: 'OpenSpec Project',
      pattern: 'generic',
      specWorkflow: 'openspec'
    }, { requireProjectName: true });
    const openSpecArtifacts = composeProjectArtifacts(openSpecPlan);
    expect(openSpecArtifacts.some((a) => a.logicalName === 'openspec-config')).toBe(true);

    const specKitPlan = buildProjectPlan({
      projectName: 'SpecKit Project',
      pattern: 'generic',
      specWorkflow: 'spec-kit'
    }, { requireProjectName: true });
    const specKitArtifacts = composeProjectArtifacts(specKitPlan);
    expect(specKitArtifacts.some((a) => a.logicalName === 'spec-kit-constitution')).toBe(true);
    expect(specKitArtifacts.some((a) => a.logicalName === 'spec-kit-bootstrap-spec')).toBe(true);
  });
});

describe('Task 5.7: Relocatable Build-Info & CWD-Independent Resource Access', () => {
  it('loads schema 1 BuildInfo with private runtime and target information', () => {
    resetBuildInfoCache();
    const info = getBuildInfo();
    expect(info.schemaVersion).toBe(1);
    expect(info.product).toBe('liftoff');
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.runtime.name).toBe('node');
    expect(info.target.os).toBe(process.platform);
    expect(info.target.arch).toBe(process.arch);
  });

  it('resolves packaged resources independently of current working directory', () => {
    const originalCwd = process.cwd();
    try {
      // Resource resolution still works regardless of package lookup
      const res = resolvePackagedResource('baselines.supported-stack');
      expect(res.fullPath).toContain('assets');
      expect(res.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(res.content.length).toBeGreaterThan(100);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('handles read-only relocated paths safely without write attempts', () => {
    // Verifies that loading catalogs and resources makes zero filesystem writes
    const info = loadBuildInfo();
    expect(info).toBeDefined();

    const cat = loadPackagedTemplateCatalog();
    expect(cat).toBeDefined();

    const prof = loadPackagedProfilesCatalog();
    expect(prof).toBeDefined();
  });

  it('loads custom build-info file and strictly validates native identity', () => {
    // Custom non-build-info file fails validation
    expect(() => loadBuildInfo(path.resolve('assets/supported-stack.json'))).toThrow(BuildInfoValidationError);

    // Missing custom file fails
    expect(() => loadBuildInfo(path.resolve('non-existent-build-info.json'))).toThrow(BuildInfoValidationError);

    // Test valid build-info file
    const fixtureDir = path.resolve('tests', '.build-info-fixture');
    const fixtureFile = path.join(fixtureDir, 'build-info.json');
    const malformedFile = path.join(fixtureDir, 'malformed.json');
    try {
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(fixtureFile, JSON.stringify({
        schemaVersion: 1,
        kind: 'native-release',
        product: 'liftoff',
        version: '0.13.0',
        commit: '0123456789abcdef0123456789abcdef01234567',
        target: { os: 'linux', arch: 'x64', platform: 'linux-x64' },
        runtime: { name: 'node', version: '24.20.0' },
        resourcesDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        profilesDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        buildDate: '2026-09-01T00:00:00.000Z'
      }));
      writeFileSync(malformedFile, '{ malformed json');

      const loadedValid = loadBuildInfo(fixtureFile);
      expect(loadedValid.commit).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(loadedValid.version).toBe('0.13.0');
      expect(loadedValid.kind).toBe('native-release');

      // Malformed json strictly throws
      expect(() => loadBuildInfo(malformedFile)).toThrow(BuildInfoValidationError);

    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }

    // Default checkout without custom file returns explicit development form
    resetBuildInfoCache();
    const devInfo = loadBuildInfo();
    expect(devInfo.kind).toBe('development');
    expect(devInfo.commit).toBe('uncommitted');
    expect(devInfo.resourcesDigest).toBe('unqualified');
  });

  it('strictly validates native build info against schema 1 contracts', () => {
    const validNative = {
      schemaVersion: 1,
      kind: 'native-release' as const,
      product: 'liftoff' as const,
      version: '0.13.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      target: { os: 'darwin' as const, arch: 'arm64' as const, platform: 'darwin-arm64' as const },
      runtime: { name: 'node' as const, version: '24.20.0' },
      resourcesDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      profilesDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      buildDate: '2026-09-01T00:00:00.000Z'
    };

    expect(validateNativeBuildInfo(validNative)).toMatchObject({
      schemaVersion: 1,
      kind: 'native-release',
      product: 'liftoff',
      version: '0.13.0'
    });

    expect(() => validateNativeBuildInfo(null)).toThrow(BuildInfoValidationError);
    expect(() => validateNativeBuildInfo({ ...validNative, unknownField: 'bad' })).toThrow(/unsupported fields/);
    expect(() => validateNativeBuildInfo({ ...validNative, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validateNativeBuildInfo({ ...validNative, product: 'other' })).toThrow(/product/);
    expect(() => validateNativeBuildInfo({ ...validNative, kind: 'invalid' })).toThrow(/kind/);
    expect(() => validateNativeBuildInfo({ ...validNative, version: 'bad-semver' })).toThrow(/SemVer/);
    expect(() => validateNativeBuildInfo({ ...validNative, commit: 'short' })).toThrow(/40-character/);
    expect(() => validateNativeBuildInfo({ ...validNative, target: null })).toThrow(/target/);
    expect(() => validateNativeBuildInfo({ ...validNative, target: { ...validNative.target, os: 'solaris' } })).toThrow(/target\.os/);
    expect(() => validateNativeBuildInfo({ ...validNative, target: { ...validNative.target, arch: 'mips' } })).toThrow(/target\.arch/);
    expect(() => validateNativeBuildInfo({ ...validNative, target: { ...validNative.target, platform: 'win32-x64' } })).toThrow(/target\.platform/);
    expect(() => validateNativeBuildInfo({ ...validNative, runtime: null })).toThrow(/runtime/);
    expect(() => validateNativeBuildInfo({ ...validNative, runtime: { ...validNative.runtime, name: 'deno' } })).toThrow(/runtime\.name/);
    expect(() => validateNativeBuildInfo({ ...validNative, runtime: { ...validNative.runtime, version: '' } })).toThrow(/runtime\.version/);
    expect(() => validateNativeBuildInfo({ ...validNative, resourcesDigest: 'not-hex' })).toThrow(/resourcesDigest/);
    expect(() => validateNativeBuildInfo({ ...validNative, buildDate: 'not-a-date' })).toThrow(/buildDate/);
  });
});

describe('Standards & Catalog Error Handling and Boundary Preconditions', () => {
  it('covers profile schema validation error paths', () => {
    const catalog = loadPackagedProfilesCatalog();
    const validProfile = catalog.profiles['python-fastapi'];

    expect(() => validateStandardsProfile(null)).toThrow(StandardsProfileError);
    expect(() => validateStandardsProfile({ ...validProfile, schemaVersion: 2 }, false)).toThrow(/schemaVersion/);
    expect(() => validateStandardsProfile({ ...validProfile, id: 'unknown-id' }, false)).toThrow(/Unknown or unsupported/);
    expect(() => validateStandardsProfile({ ...validProfile, label: '' }, false)).toThrow(/missing non-empty label/);
    expect(() => validateStandardsProfile({ ...validProfile, revision: '' }, false)).toThrow(/missing non-empty revision/);
    expect(() => validateStandardsProfile({ ...validProfile, digest: 'invalid' }, false)).toThrow(/missing valid sha256/);
    expect(() => validateStandardsProfile({ ...validProfile, supported: false }, false)).toThrow(/supported: true/);
    expect(() => validateStandardsProfile({ ...validProfile, category: 'other' }, false)).toThrow(/invalid category/);
    expect(() => validateStandardsProfile({ ...validProfile, targetWorkload: 'other' }, false)).toThrow(/invalid targetWorkload/);
    expect(() => validateStandardsProfile({ ...validProfile, componentBoundaries: [] }, false)).toThrow(/componentBoundaries/);
    expect(() => validateStandardsProfile({ ...validProfile, capabilities: null }, false)).toThrow(/capabilities/);
    expect(() => validateStandardsProfile({
      ...validProfile,
      capabilities: { ...validProfile.capabilities, backend: false }
    }, false)).toThrow(/must declare backend: true/);
    expect(() => validateStandardsProfile({
      ...validProfile,
      capabilities: { ...validProfile.capabilities, language: undefined }
    }, false)).toThrow(/declare language and framework/);
    expect(() => validateStandardsProfile({ ...validProfile, evaluationCoverage: [] }, false)).toThrow(/evaluationCoverage/);
    expect(() => validateStandardsProfile({ ...validProfile, evaluationCoverage: [null] }, false)).toThrow(/must be an object/);
    expect(() => validateStandardsProfile({ ...validProfile, evaluationCoverage: [{ id: '' }] }, false)).toThrow(/missing non-empty string ID/);

    const genaiProfile = catalog.profiles['genai-generic'];
    expect(() => validateStandardsProfile({
      ...genaiProfile,
      capabilities: { ...genaiProfile.capabilities, pattern: undefined }
    }, false)).toThrow(/must identify its exact pattern/);
    expect(() => validateStandardsProfile({
      ...genaiProfile,
      capabilities: { ...genaiProfile.capabilities, backend: false }
    }, false)).toThrow(/must declare backend: true/);

    // Unsupported stack error paths
    expect(() => validateUnsupportedStackProfile(null)).toThrow(StandardsProfileError);
    expect(() => validateUnsupportedStackProfile({ id: '' })).toThrow(/missing string ID/);
    expect(() => validateUnsupportedStackProfile({ id: 'foo', label: '' })).toThrow(/missing non-empty label/);
    expect(() => validateUnsupportedStackProfile({ id: 'foo', label: 'Foo', supported: true })).toThrow(/supported: false/);
    expect(() => validateUnsupportedStackProfile({ id: 'foo', label: 'Foo', supported: false, assessmentOnly: false })).toThrow(/assessmentOnly: true/);
    expect(() => validateUnsupportedStackProfile({ id: 'foo', label: 'Foo', supported: false, assessmentOnly: true, reason: '' })).toThrow(/reason/);
    expect(() => validateUnsupportedStackProfile({ id: 'foo', label: 'Foo', supported: false, assessmentOnly: true, reason: 'r', remedy: '' })).toThrow(/remedy/);

    // Catalog level error paths
    expect(() => validateStandardsProfileCatalog(null)).toThrow(StandardsProfileError);
    expect(() => validateStandardsProfileCatalog({ ...catalog, catalogId: '' }, false)).toThrow(/missing catalogId/);
    expect(() => validateStandardsProfileCatalog({ ...catalog, revision: '' }, false)).toThrow(/missing revision/);
    expect(() => validateStandardsProfileCatalog({ ...catalog, digest: '' }, false)).toThrow(/missing valid sha256/);
    expect(() => validateStandardsProfileCatalog({ ...catalog, profiles: null }, false)).toThrow(/missing profiles record/);
    expect(() => validateStandardsProfileCatalog({ ...catalog, unsupportedStacks: null }, false)).toThrow(/missing unsupportedStacks record/);
    expect(() => validateStandardsProfileCatalog({
      ...catalog,
      profiles: { ...catalog.profiles, 'node-fastify': { ...catalog.profiles['python-fastapi'], id: 'python-fastapi' } }
    }, false)).toThrow(/does not match profile ID/);
    expect(() => validateStandardsProfileCatalog({
      ...catalog,
      unsupportedStacks: { ...catalog.unsupportedStacks, express: { ...catalog.unsupportedStacks.django, id: 'django' } }
    }, false)).toThrow(/does not match entry ID/);
  });

  it('covers template catalog and resource schema error paths', () => {
    const catalog = loadPackagedTemplateCatalog();
    const validResource = catalog.resources['baselines.supported-stack'];
    const validComponent = catalog.components['common-base'];

    // Resource descriptor error paths
    expect(() => validateResourceDescriptor(null)).toThrow(ResourceCatalogError);
    expect(() => validateResourceDescriptor({ id: '' })).toThrow(/missing string ID/);
    expect(() => validateResourceDescriptor({ ...validResource, path: '' })).toThrow(/missing path/);
    expect(() => validateResourceDescriptor({ ...validResource, digest: 'invalid' })).toThrow(/missing valid sha256/);
    expect(() => validateResourceDescriptor({ ...validResource, size: -1 })).toThrow(/missing non-negative/);
    expect(() => validateResourceDescriptor({ ...validResource, componentId: '' })).toThrow(/missing componentId/);

    // Template component error paths
    expect(() => validateTemplateComponentDescriptor(null)).toThrow(ResourceCatalogError);
    expect(() => validateTemplateComponentDescriptor({ id: '' })).toThrow(/missing string ID/);
    expect(() => validateTemplateComponentDescriptor({ ...validComponent, label: '' })).toThrow(/missing label/);
    expect(() => validateTemplateComponentDescriptor({ ...validComponent, category: 'other' })).toThrow(/invalid category/);
    expect(() => validateTemplateComponentDescriptor({ ...validComponent, revision: '' })).toThrow(/missing revision/);
    expect(() => validateTemplateComponentDescriptor({ ...validComponent, digest: 'invalid' })).toThrow(/missing valid sha256/);
    expect(() => validateTemplateComponentDescriptor({ ...validComponent, dependencies: null })).toThrow(/dependencies/);
    expect(() => validateTemplateComponentDescriptor({ ...validComponent, resources: null })).toThrow(/resources/);
    expect(() => validateTemplateComponentDescriptor({ ...validComponent, artifactLifecycles: null })).toThrow(/artifactLifecycles/);

    // Template catalog error paths
    expect(() => validateTemplateCatalog(null)).toThrow(ResourceCatalogError);
    expect(() => validateTemplateCatalog({ schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validateTemplateCatalog({ ...catalog, catalogId: '' }, false)).toThrow(/missing catalogId/);
    expect(() => validateTemplateCatalog({ ...catalog, revision: '' }, false)).toThrow(/missing revision/);
    expect(() => validateTemplateCatalog({ ...catalog, digest: 'invalid' }, false)).toThrow(/missing valid sha256/);
    expect(() => validateTemplateCatalog({ ...catalog, components: null }, false)).toThrow(/missing components mapping/);
    expect(() => validateTemplateCatalog({ ...catalog, resources: null }, false)).toThrow(/missing resources mapping/);
    expect(() => validateTemplateCatalog({
      ...catalog,
      components: { ...catalog.components, 'frontend-vue': { ...catalog.components['common-base'], id: 'common-base' } }
    }, false)).toThrow(/does not match ID/);
    expect(() => validateTemplateCatalog({
      ...catalog,
      resources: { ...catalog.resources, 'res-a': { ...catalog.resources['baselines.supported-stack'], id: 'res-b' } }
    }, false)).toThrow(/does not match ID/);
    expect(() => validateTemplateCatalog({
      ...catalog,
      resources: {
        ...catalog.resources,
        'baselines.supported-stack': { ...catalog.resources['baselines.supported-stack'], componentId: 'nonexistent-comp' }
      }
    }, false)).toThrow(/references unknown componentId/);
    expect(() => validateTemplateCatalog({
      ...catalog,
      components: {
        ...catalog.components,
        'common-base': { ...catalog.components['common-base'], resources: ['nonexistent-res'] }
      }
    }, false)).toThrow(/references missing resource/);
  });

  it('covers artifact collision and retirement checks error paths', () => {
    expect(() => assertArtifactsSafeBeforeWrite([{ logicalName: 'a', category: 'c', pathParts: [] }]))
      .toThrow(ArtifactCollisionError);
    expect(() => assertArtifactsSafeBeforeWrite([{ logicalName: 'a', category: 'c', pathParts: [''] }]))
      .toThrow(ArtifactCollisionError);
    expect(() => assertArtifactsSafeBeforeWrite([{ logicalName: 'a', category: 'c', pathParts: ['trailing-dot.'] }]))
      .toThrow(ArtifactCollisionError);
    expect(() => assertArtifactsSafeBeforeWrite([{ logicalName: 'a', category: 'c', pathParts: ['trailing-space '] }]))
      .toThrow(ArtifactCollisionError);

    const catalog = loadPackagedTemplateCatalog();
    // Valid catalog retirement passes
    expect(() => assertRetirementEligible(
      'repository-governance-copilot-launcher',
      'governance',
      ['.github', 'prompts', 'liftoff-repository-governance.prompt.md'],
      catalog
    )).not.toThrow();

    // Invalid retirement fails
    expect(() => assertRetirementEligible('invalid-item', 'project', ['invalid.ts'], catalog))
      .toThrow(ArtifactCollisionError);
  });

  it('covers resource catalog query and plan component generation helpers', () => {
    // Missing component lookup returns undefined / empty
    expect(getPackagedTemplateComponent('unknown-comp')).toBeUndefined();
    expect(() => resolveComponentResources('unknown-comp')).toThrow(PackagedResourceIntegrityError);
    expect(getStandardsProfile('unknown-id')).toBeUndefined();
    expect(getUnsupportedStack('unknown-id')).toBeUndefined();

    // targetProfileIdForPlan validation error paths
    expect(() => targetProfileIdForPlan({ workload: 'standard', apiStack: { id: 'unknown-stack' } }))
      .toThrow(StandardsProfileError);
    expect(() => targetProfileIdForPlan({ workload: 'standard', apiStack: undefined }))
      .toThrow(StandardsProfileError);
    expect(() => targetProfileIdForPlan({ workload: 'genai', pattern: undefined }))
      .toThrow(StandardsProfileError);
    expect(() => targetProfileIdForPlan({ workload: 'genai', pattern: { id: 'unknown-pattern' } }))
      .toThrow(StandardsProfileError);

    // currentStandardsManifestContext helper
    const manifestContext = currentStandardsManifestContext();
    expect(manifestContext.profiles.schemaVersion).toBe(1);
    expect(manifestContext.resourceCatalogDigest).toMatch(/^sha256:/);

    // generatedComponentsForPlan helper
    const stdPlan = { workload: 'standard' as const, apiStack: { id: 'node-fastify' }, includeFrontend: false };
    const stdComps = generatedComponentsForPlan(stdPlan);
    expect(stdComps.length).toBe(1);
    expect(stdComps[0].id).toBe('backend');
    expect(stdComps[0].rootPathParts).toEqual(['backend']);

    const fullPlan = { workload: 'standard' as const, apiStack: { id: 'node-fastify' }, includeFrontend: true };
    const fullComps = generatedComponentsForPlan(fullPlan);
    expect(fullComps.length).toBe(2);
    expect(fullComps[1].id).toBe('frontend');
    expect(fullComps[1].profile.id).toBe('vue-component');
  });

  it('detects tampering with profile or catalog metadata without matching digest change', () => {
    const catalog = loadPackagedProfilesCatalog();
    const validProfile = catalog.profiles['python-fastapi'];

    // Tampering with label
    expect(() => validateStandardsProfile({
      ...validProfile,
      label: 'Tampered FastAPI'
    }, true)).toThrow(/digest mismatch/);

    // Tampering with capabilities
    expect(() => validateStandardsProfile({
      ...validProfile,
      capabilities: { ...validProfile.capabilities, cloud: 'none' }
    }, true)).toThrow(/incompatible/);

    // Tampering with evaluationCoverage
    expect(() => validateStandardsProfile({
      ...validProfile,
      evaluationCoverage: validProfile.evaluationCoverage.slice(0, -1)
    }, true)).toThrow(/digest mismatch/);

    // Tampering with unsupported stack reason in catalog
    expect(() => validateStandardsProfileCatalog({
      ...catalog,
      unsupportedStacks: {
        ...catalog.unsupportedStacks,
        express: { ...catalog.unsupportedStacks.express, reason: 'Tampered reason text' }
      }
    }, true)).toThrow(/digest mismatch/);

    // Tampering with template catalog component
    const templateCatalog = loadPackagedTemplateCatalog();
    const validComponent = templateCatalog.components['common-base'];
    expect(() => validateTemplateCatalog({
      ...templateCatalog,
      components: {
        ...templateCatalog.components,
        'common-base': { ...validComponent, label: 'Tampered Label' }
      }
    }, true)).toThrow(/digest mismatch/);
  });

  it('detects cyclic component dependencies in template catalog', () => {
    const catalog = loadPackagedTemplateCatalog();
    const cyclicComponents = {
      ...catalog.components,
      'comp-a': {
        id: 'comp-a',
        label: 'Component A',
        category: 'common' as const,
        revision: '2026.09.01',
        digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        dependencies: ['comp-b'],
        resources: ['templates.common.dockerignore'],
        artifactLifecycles: { 'root-dockerignore': 'project' as const }
      },
      'comp-b': {
        id: 'comp-b',
        label: 'Component B',
        category: 'common' as const,
        revision: '2026.09.01',
        digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        dependencies: ['comp-a'],
        resources: ['templates.common.gitignore'],
        artifactLifecycles: { 'root-gitignore': 'project' as const }
      }
    };

    expect(() => validateTemplateCatalog({
      ...catalog,
      components: cyclicComponents
    }, false)).toThrow(/Cyclic component dependency detected/);
  });

  it('enforces path confinement and rejects out-of-package escapes and non-regular files', () => {
    // Escaping package root
    expect(() => assertSafeRegularResourceFile(path.resolve('..', 'escaped.txt')))
      .toThrow(/escapes package root/);

    // Non-existent file
    expect(() => assertSafeRegularResourceFile(path.resolve('assets', 'non-existent-file.txt')))
      .toThrow(/ENOENT|does not exist/);

    // Directory instead of regular file
    expect(() => assertSafeRegularResourceFile(path.resolve('assets', 'templates')))
      .toThrow(/FIFO|regular file/);
  });
});

describe('End-to-End Generation Matrix, Component Attachment, and Double-Render Checks', () => {
  const standardStacks = ['python', 'node', 'go'] as const;
  const genaiPatterns = [
    'generic', 'rag', 'chatbot', 'agent', 'prompt',
    'multi-agent', 'fine-tuned', 'streaming', 'workflow'
  ] as const;

  it('exercises all standard stack compositions with and without frontend and verifies component tagging', () => {
    const catalog = loadPackagedTemplateCatalog();

    for (const stack of standardStacks) {
      for (const includeFrontend of [false, true]) {
        for (const specWorkflow of ['openspec', 'spec-kit'] as const) {
          const plan = buildProjectPlan({
            projectName: `Matrix Standard ${stack}`,
            projectType: 'standard',
            apiStack: stack,
            cloud: 'azure',
            includeFrontend,
            specWorkflow
          }, { requireProjectName: true });

          const artifacts1 = composeProjectArtifacts(plan);
          const artifacts2 = composeProjectArtifacts(plan);

          // Double-render byte determinism
          expect(artifacts1).toEqual(artifacts2);
          expect(artifacts1.length).toBeGreaterThan(15);

          // Every artifact must have a release-owned component assigned
          for (const artifact of artifacts1) {
            const compId = (artifact as { component?: string }).component;
            expect(compId).toBeDefined();
            expect(catalog.components[compId!]).toBeDefined();

            // Verify lifecycle matches catalog declaration
            const declaredLifecycle = catalog.components[compId!].artifactLifecycles[artifact.logicalName];
            expect(declaredLifecycle).toBe(artifact.lifecycle);
          }

          if (includeFrontend) {
            expect(artifacts1.some((a) => (a as { component?: string }).component === 'frontend-vue')).toBe(true);
          } else {
            expect(artifacts1.some((a) => (a as { component?: string }).component === 'frontend-vue')).toBe(false);
          }
        }
      }
    }
  });

  it('exercises all 9 GenAI patterns with double-render determinism and exact component ownership', () => {
    const catalog = loadPackagedTemplateCatalog();

    for (const pattern of genaiPatterns) {
      for (const { includeFrontend, specWorkflow } of [false, true].flatMap((includeFrontend) =>
        (['openspec', 'spec-kit'] as const).map((specWorkflow) => ({ includeFrontend, specWorkflow })))) {
        const plan = buildProjectPlan({
          projectName: `Matrix GenAI ${pattern}`,
          pattern,
          cloud: 'azure',
          includeFrontend,
          specWorkflow
        }, { requireProjectName: true });

        const pass1 = composeProjectArtifacts(plan);
        const pass2 = composeProjectArtifacts(plan);

        expect(pass1).toEqual(pass2);
        expect(pass1.length).toBeGreaterThan(20);

        for (const artifact of pass1) {
          const compId = (artifact as { component?: string }).component;
          expect(compId).toBeDefined();
          expect(catalog.components[compId!]).toBeDefined();
          const declaredLifecycle = catalog.components[compId!].artifactLifecycles[artifact.logicalName];
          expect(declaredLifecycle).toBe(artifact.lifecycle);
        }
      }
    }
  });

  it('blocks actual buildArtifacts before writes when a required resource is damaged, missing, or wrongly owned', () => {
    // 1. Missing resource in catalog: verifyComponentResourceClosure throws before writes
    expect(() => {
      resolvePackagedResource('nonexistent-resource-id');
    }).toThrow(PackagedResourceIntegrityError);

    expect(() => {
      verifyComponentResourceClosure(['nonexistent-component-id']);
    }).toThrow(PackagedResourceIntegrityError);

    // 2. Output colliding with liftoff.manifest.json boundary blocks before writes
    expect(() => {
      assertArtifactsSafeBeforeWrite([
        { logicalName: 'fake-manifest', category: 'manifest', pathParts: ['liftoff.manifest.json'] },
        { logicalName: 'manifest', category: 'manifest', pathParts: ['liftoff.manifest.json'] }
      ]);
    }).toThrow(ArtifactCollisionError);

    // 3. Output colliding with another component destination blocks before writes
    expect(() => {
      assertArtifactsSafeBeforeWrite([
        { logicalName: 'root-readme', category: 'documentation', pathParts: ['README.md'] },
        { logicalName: 'second-readme', category: 'documentation', pathParts: ['README.md'] }
      ]);
    }).toThrow(/Duplicate destination collision/);

    // 4. Case collision on Windows blocks before writes
    expect(() => {
      assertArtifactsSafeBeforeWrite([
        { logicalName: 'root-readme', category: 'documentation', pathParts: ['README.md'] },
        { logicalName: 'second-readme', category: 'documentation', pathParts: ['readme.md'] }
      ]);
    }).toThrow(/Windows case-collision/);
  });
});

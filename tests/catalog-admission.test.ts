import { describe, expect, it } from 'vitest';
import {
  loadPackagedProfilesCatalog, loadPackagedTemplateCatalog
} from '../src/adapters/packaged-assets/resource-catalog.js';
import { validateStandardsProfile } from '../src/domain/standards/profile-schema.js';
import {
  assertArtifactsSafeBeforeWrite, assertRetirementEligible, computeTemplateCatalogDigest,
  validateResourceDescriptor, validateTemplateCatalog, validateTemplateComponentDescriptor
} from '../src/domain/standards/resource-catalog-schema.js';

describe('strict release-owned catalog admission', () => {
  it.each([
    { category: null }, { category: 'unregistered' }, { logicalName: {} }, { description: false },
    { path: '../outside' }, { path: '/absolute' }, { path: 'assets\\file' }, { path: 'assets/COM1.txt' },
    { path: 'assets/a:stream' }, { path: 'assets/line\nbreak' }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { size: 10 * 1024 * 1024 + 1 }, { digest: `sha256:${'a'.repeat(64)}\n` }
  ])('rejects malformed or unsupported resource descriptors %j', (changed) => {
    const resource = loadPackagedTemplateCatalog().resources['baselines.supported-stack']!;
    expect(() => validateResourceDescriptor({ ...resource, ...changed })).toThrow();
  });

  it('rejects duplicate resource and dependency claims within a component', () => {
    const component = loadPackagedTemplateCatalog().components['common-base']!;
    expect(() => validateTemplateComponentDescriptor({
      ...component, dependencies: ['frontend-vue', 'frontend-vue']
    })).toThrow(/unique/);
    expect(() => validateTemplateComponentDescriptor({
      ...component, resources: [component.resources[0], component.resources[0]]
    })).toThrow(/unique/);
  });

  it('rejects incompatible profile facts even when digest checking is not requested', () => {
    const catalog = loadPackagedProfilesCatalog();
    const profile = catalog.profiles['python-fastapi'];
    for (const changed of [
      { category: 'frontend' }, { targetWorkload: 'genai' },
      { capabilities: { ...profile.capabilities, framework: {} } },
      { capabilities: { ...profile.capabilities, worker: 'true' } },
      { componentBoundaries: ['backend', 'backend'] },
      { evaluationCoverage: [profile.evaluationCoverage[0], profile.evaluationCoverage[0]] },
      { requiredArtifacts: ['one', 'one'] }
    ]) {
      expect(() => validateStandardsProfile({ ...profile, ...changed }, false)).toThrow();
    }
    const genai = catalog.profiles['genai-rag'];
    expect(() => validateStandardsProfile({
      ...genai, capabilities: { ...genai.capabilities, pattern: 'generic' }
    }, false)).toThrow(/exact supported pattern/);
  });

  it('does not turn a caller-rehashed catalog retirement into deletion eligibility', () => {
    const catalog = structuredClone(loadPackagedTemplateCatalog());
    catalog.retirements = {
      ...catalog.retirements,
      'user-file': {
        retiredLogicalName: 'user-file', category: 'project',
        pathParts: ['business.ts'], reason: 'A caller asserted that this may be deleted.'
      }
    };
    catalog.digest = computeTemplateCatalogDigest(catalog);
    expect(() => validateTemplateCatalog(catalog)).toThrow(/reader-registered/);
    expect(() => assertRetirementEligible('user-file', 'project', ['business.ts'], catalog)).toThrow();
  });

  it('rejects duplicate logical identities and normalization/device aliases before output writes', () => {
    expect(() => assertArtifactsSafeBeforeWrite([
      { logicalName: 'same', category: 'project', pathParts: ['one.ts'] },
      { logicalName: 'same', category: 'project', pathParts: ['two.ts'] }
    ])).toThrow(/unique/);
    for (const filename of ['\u212a.ts', 'COM\u00b9.txt', 'file:stream', 'line\nbreak']) {
      expect(() => assertArtifactsSafeBeforeWrite([
        { logicalName: 'source', category: 'project', pathParts: [filename] }
      ])).toThrow();
    }
  });
});

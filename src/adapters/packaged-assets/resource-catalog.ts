import { createHash } from 'node:crypto';
import path from 'node:path';
import { getPackageRoot } from './package-root.js';
import {
  PackagedResourceIntegrityError, packagedPathParts, readBoundedPackagedFile, validatePackagedPathParts
} from './resource-file.js';
import {
  type StandardsProfile,
  type StandardsProfileCatalog,
  type StandardsProfileId,
  type UnsupportedStackProfile,
  targetProfileIdForPlan,
  validateStandardsProfileCatalog
} from '../../domain/standards/profile-schema.js';
import {
  type ResourceDescriptor,
  type TemplateCatalog,
  type TemplateComponentDescriptor,
  validateTemplateCatalog
} from '../../domain/standards/resource-catalog-schema.js';
import type { ManifestComponent } from '../../domain/project/contracts.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import { type BuildInfo, loadBuildInfo } from './build-info.js';
import { liftoffVersion } from '../../version.js';

export { getPackageRoot, setPackageRootOverride } from './package-root.js';
export { PackagedResourceIntegrityError } from './resource-file.js';

let cachedProfilesCatalog: StandardsProfileCatalog | undefined;
let cachedTemplateCatalog: TemplateCatalog | undefined;
let cachedProfilesRoot: string | undefined;
let cachedTemplateRoot: string | undefined;
let cachedProfilesSource: string | undefined;
let cachedTemplateSource: string | undefined;

export interface PackagedResourceReadOptions {
  expectedPathParts?: readonly string[];
  maximumBytes?: number;
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj) || ArrayBuffer.isView(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object') {
      deepFreeze(val);
    }
  }
  return obj;
}

export function resetResourceCatalogCache(): void {
  cachedProfilesCatalog = undefined;
  cachedTemplateCatalog = undefined;
  cachedProfilesRoot = undefined;
  cachedTemplateRoot = undefined;
  cachedProfilesSource = undefined;
  cachedTemplateSource = undefined;
}

export function assertConfinedToPackageRoot(fullPath: string): void {
  const root = getPackageRoot();
  const resolved = path.resolve(fullPath);
  const rootWithSep = root.endsWith(path.sep)
    ? root
    : `${root}${path.sep}`;
  if (!resolved.startsWith(rootWithSep) && resolved !== root) {
    throw new PackagedResourceIntegrityError(
      `Resource path escapes package root: ${resolved} is outside ${root}.`
    );
  }
}

export function assertSafeRegularResourceFile(fullPath: string, expectedSize?: number): void {
  assertConfinedToPackageRoot(fullPath);
  const root = getPackageRoot();
  readBoundedPackagedFile(root, path.relative(root, fullPath).split(path.sep), { expectedSize });
}

export function loadPackagedProfilesCatalog(reload = false): StandardsProfileCatalog {
  const root = getPackageRoot();
  const bytes = readBoundedPackagedFile(root, ['assets', 'profiles', 'catalog.json']);
  const source = createHash('sha256').update(bytes).digest('hex');
  if (cachedProfilesCatalog && !reload && cachedProfilesRoot === root && cachedProfilesSource === source) return cachedProfilesCatalog;
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const raw = parseStrictManifestJson(content, 'Packaged profiles catalog');
  const validated = validateStandardsProfileCatalog(raw, true);
  cachedProfilesCatalog = deepFreeze(validated);
  cachedProfilesRoot = root;
  cachedProfilesSource = source;
  return cachedProfilesCatalog;
}

export function loadPackagedTemplateCatalog(reload = false): TemplateCatalog {
  const root = getPackageRoot();
  const bytes = readBoundedPackagedFile(root, ['assets', 'templates', 'catalog.json']);
  const source = createHash('sha256').update(bytes).digest('hex');
  if (cachedTemplateCatalog && !reload && cachedTemplateRoot === root && cachedTemplateSource === source) return cachedTemplateCatalog;
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const raw = parseStrictManifestJson(content, 'Packaged templates catalog');
  const validated = validateTemplateCatalog(raw, true);
  cachedTemplateCatalog = deepFreeze(validated);
  cachedTemplateRoot = root;
  cachedTemplateSource = source;
  return cachedTemplateCatalog;
}

export function resolvePackagedResource(resourceId: string, options: PackagedResourceReadOptions = {}): {
  descriptor: ResourceDescriptor;
  fullPath: string;
  buffer: Buffer;
  content: string;
  digest: string;
} {
  const root = getPackageRoot();
  const catalog = loadPackagedTemplateCatalog(true);
  const descriptor = catalog.resources[resourceId];
  if (!descriptor) {
    throw new PackagedResourceIntegrityError(
      `Unknown packaged resource ID: ${JSON.stringify(resourceId)}. Mutation or network recovery is prohibited.`
    );
  }

  const parts = packagedPathParts(descriptor.path);
  if (options.expectedPathParts !== undefined &&
      parts.join('/') !== validatePackagedPathParts(options.expectedPathParts).join('/')) {
    throw new PackagedResourceIntegrityError(`Packaged resource ${resourceId} does not use its exact registered consumer path.`);
  }
  const fullPath = path.join(root, ...parts);
  const buffer = readBoundedPackagedFile(root, parts, { expectedSize: descriptor.size, maximumBytes: options.maximumBytes });
  const actualDigest = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  if (actualDigest !== descriptor.digest) {
    throw new PackagedResourceIntegrityError(
      `Packaged resource ${resourceId} is damaged or modified. Expected digest ${descriptor.digest}, but found ${actualDigest}. Refusing execution without mutable replacement.`
    );
  }

  return deepFreeze({
    descriptor,
    fullPath,
    buffer,
    content: buffer.toString('utf8'),
    digest: actualDigest
  });
}

export function verifyPackagedResourceIntegrity(resourceId: string): {
  valid: boolean;
  expectedDigest: string;
  actualDigest: string;
} {
  const catalog = loadPackagedTemplateCatalog(true);
  const descriptor = catalog.resources[resourceId];
  if (!descriptor) {
    throw new PackagedResourceIntegrityError(`Unknown resource ID: ${resourceId}`);
  }
  let buffer: Buffer;
  try {
    buffer = readBoundedPackagedFile(getPackageRoot(), packagedPathParts(descriptor.path), { expectedSize: descriptor.size });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') {
      return { valid: false, expectedDigest: descriptor.digest, actualDigest: 'missing' };
    }
    throw error;
  }
  const actualDigest = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  return {
    valid: actualDigest === descriptor.digest,
    expectedDigest: descriptor.digest,
    actualDigest
  };
}

export function verifyAllPackagedResourcesIntegrity(): {
  valid: boolean;
  totalVerified: number;
  errors: string[];
} {
  const catalog = loadPackagedTemplateCatalog(true);
  const errors: string[] = [];
  let totalVerified = 0;

  for (const [id, descriptor] of Object.entries(catalog.resources)) {
    try {
      const buffer = readBoundedPackagedFile(getPackageRoot(), packagedPathParts(descriptor.path), { expectedSize: descriptor.size });
      const digest = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
      if (digest !== descriptor.digest) errors.push(`Damaged resource ${id}: expected ${descriptor.digest}, found ${digest}`);
      else totalVerified++;
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    valid: errors.length === 0,
    totalVerified,
    errors
  };
}

export function listSupportedStandardsProfiles(): StandardsProfile[] {
  const catalog = loadPackagedProfilesCatalog();
  return Object.values(catalog.profiles);
}

export function getStandardsProfile(id: string): StandardsProfile | undefined {
  const catalog = loadPackagedProfilesCatalog();
  return catalog.profiles[id as StandardsProfileId];
}

export function getProfileIdentity(id: string): {
  schemaVersion: 1;
  id: string;
  revision: string;
  digest: string;
} {
  const profile = getStandardsProfile(id);
  if (!profile) {
    throw new PackagedResourceIntegrityError(`Unknown profile ID: ${id}`);
  }
  return {
    schemaVersion: 1,
    id: profile.id,
    revision: profile.revision,
    digest: profile.digest
  };
}

export function targetProfileIdentityForPlan(plan: {
  workload: 'standard' | 'genai';
  apiStack?: { id: string };
  pattern?: { id: string };
}): {
  schemaVersion: 1;
  id: string;
  revision: string;
  digest: string;
} {
  const profileId = targetProfileIdForPlan(plan);
  return getProfileIdentity(profileId);
}

export function listUnsupportedStacks(): UnsupportedStackProfile[] {
  const catalog = loadPackagedProfilesCatalog();
  return Object.values(catalog.unsupportedStacks);
}

export function getUnsupportedStack(id: string): UnsupportedStackProfile | undefined {
  const catalog = loadPackagedProfilesCatalog();
  return catalog.unsupportedStacks[id];
}

export function listPackagedTemplateComponents(): TemplateComponentDescriptor[] {
  const catalog = loadPackagedTemplateCatalog();
  return Object.values(catalog.components);
}

export function getPackagedTemplateComponent(componentId: string): TemplateComponentDescriptor | undefined {
  const catalog = loadPackagedTemplateCatalog();
  return catalog.components[componentId];
}

export function resolveComponentResources(componentId: string): ResourceDescriptor[] {
  const catalog = loadPackagedTemplateCatalog();
  const component = catalog.components[componentId];
  if (!component) {
    throw new PackagedResourceIntegrityError(`Unknown component ID: ${JSON.stringify(componentId)}.`);
  }
  return component.resources.map((rId) => {
    const res = catalog.resources[rId];
    if (!res) {
      throw new PackagedResourceIntegrityError(
        `Component ${componentId} references missing resource: ${JSON.stringify(rId)}.`
      );
    }
    return res;
  });
}

export function verifyComponentResourceClosure(componentIds: readonly string[]): void {
  const catalog = loadPackagedTemplateCatalog();
  for (const compId of componentIds) {
    const component = catalog.components[compId];
    if (!component) {
      throw new PackagedResourceIntegrityError(`Selected component not found in catalog: ${compId}.`);
    }
    for (const resId of component.resources) {
      resolvePackagedResource(resId);
    }
    for (const dep of component.dependencies) {
      if (catalog.components[dep]) {
        for (const depResId of catalog.components[dep].resources) {
          resolvePackagedResource(depResId);
        }
      } else if (catalog.resources[dep]) {
        resolvePackagedResource(dep);
      } else {
        throw new PackagedResourceIntegrityError(
          `Component ${compId} depends on unknown dependency: ${dep}.`
        );
      }
    }
  }
}

export function computeResourceInventorySummary(customCatalog?: TemplateCatalog): {
  inventoryHash: string;
  count: number;
} {
  const catalog = customCatalog ?? loadPackagedTemplateCatalog();
  const resourceEntries = Object.entries(catalog.resources).sort(([a], [b]) => a.localeCompare(b));
  const hasher = createHash('sha256');
  for (const [id, res] of resourceEntries) {
    hasher.update(`${id}:${res.path}:${res.digest}:${res.size};`);
  }
  return {
    inventoryHash: hasher.digest('hex'),
    count: resourceEntries.length
  };
}

export function validateInstalledPackageContext(): {
  buildInfo: BuildInfo;
  profilesCatalog: StandardsProfileCatalog;
  templateCatalog: TemplateCatalog;
  resourceSummary: { inventoryHash: string; count: number };
} {
  const buildInfo = loadBuildInfo();
  const profilesCatalog = loadPackagedProfilesCatalog();
  const templateCatalog = loadPackagedTemplateCatalog();
  const resourceSummary = computeResourceInventorySummary(templateCatalog);

  if (buildInfo.kind === 'native-release' || buildInfo.kind === 'native') {
    if (buildInfo.version !== liftoffVersion || buildInfo.target.os !== process.platform ||
        buildInfo.target.arch !== process.arch || buildInfo.runtime.version !== process.versions.node) {
      throw new PackagedResourceIntegrityError('Installed native build-info does not match the running CLI version, host and declared Node runtime.');
    }
    const expected = templateCatalog.digest.startsWith('sha256:')
      ? templateCatalog.digest
      : `sha256:${templateCatalog.digest}`;
    const actual = buildInfo.resourcesDigest.startsWith('sha256:')
      ? buildInfo.resourcesDigest
      : `sha256:${buildInfo.resourcesDigest}`;
    if (actual !== expected) {
      throw new PackagedResourceIntegrityError(
        `Installed build-info resourcesDigest mismatch: build-info has ${buildInfo.resourcesDigest}, but template catalog has ${templateCatalog.digest}.`
      );
    }
    if (buildInfo.profilesDigest !== profilesCatalog.digest) {
      throw new PackagedResourceIntegrityError('Installed build-info profilesDigest does not match the full packaged profiles catalog identity.');
    }
  }

  return {
    buildInfo,
    profilesCatalog,
    templateCatalog,
    resourceSummary
  };
}

export function currentStandardsManifestContext(): {
  profiles: StandardsProfileCatalog;
  resourceCatalogDigest: string;
  buildInfo: BuildInfo;
} {
  const context = validateInstalledPackageContext();
  return {
    profiles: context.profilesCatalog,
    resourceCatalogDigest: context.templateCatalog.digest,
    buildInfo: context.buildInfo
  };
}

export function generatedComponentsForPlan(plan: {
  workload: 'standard' | 'genai';
  apiStack?: { id: string };
  pattern?: { id: string };
  includeFrontend?: boolean;
}): ManifestComponent[] {
  const components: ManifestComponent[] = [];
  const backendProfileId = targetProfileIdForPlan(plan);
  components.push({
    id: 'backend',
    profile: getProfileIdentity(backendProfileId),
    rootPathParts: ['backend']
  });
  if (plan.includeFrontend) {
    components.push({
      id: 'frontend',
      profile: getProfileIdentity('vue-component'),
      rootPathParts: ['frontend']
    });
  }
  return components;
}

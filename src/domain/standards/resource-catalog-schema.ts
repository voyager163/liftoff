import { createHash } from 'node:crypto';
import type { ArtifactLifecycle } from '../project/contracts.js';
import { validateArtifactPathParts } from '../project/paths.js';
import {
  isRetiredManagedCoreLogicalName,
  retiredManagedCoreIdentityMap
} from '../project/artifact-lifecycle.js';

export const RESOURCE_CATALOG_SCHEMA_VERSION = 1 as const;

export type ComponentCategory =
  | 'common'
  | 'backend'
  | 'genai'
  | 'frontend'
  | 'infrastructure'
  | 'workflow'
  | 'governance';

export interface ResourceDescriptor {
  id: string;
  path: string;
  logicalName?: string;
  category: string;
  componentId: string;
  digest: string;
  size: number;
  lifecycle?: ArtifactLifecycle;
  description?: string;
}

export interface TemplateComponentDescriptor {
  id: string;
  label: string;
  category: ComponentCategory;
  revision: string;
  digest: string;
  dependencies: string[];
  resources: string[];
  artifactLifecycles: Record<string, ArtifactLifecycle>;
}

export interface RetiredArtifactDeclaration {
  retiredLogicalName: string;
  category: string;
  pathParts: string[];
  replacementLogicalName?: string;
  reason: string;
}

export interface TemplateCatalog {
  schemaVersion: 1;
  catalogId: string;
  revision: string;
  digest: string;
  components: Record<string, TemplateComponentDescriptor>;
  resources: Record<string, ResourceDescriptor>;
  retirements?: Record<string, RetiredArtifactDeclaration>;
}

export class ResourceCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceCatalogError';
  }
}

export class ArtifactCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactCollisionError';
  }
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const VALID_LIFECYCLES = new Set([
  'managed-core',
  'project',
  'desired-state',
  'framework',
  'seed',
  'manifest'
]);
const RESOURCE_CATEGORIES = new Set(['template', 'baseline', 'lock', 'governance', 'repair', 'skill']);

function boundedText(value: unknown, label: string, maximum = 1024): asserts value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ResourceCatalogError(`${label} requires bounded text without controls or surrounding whitespace.`);
  }
}

function portableParts(value: unknown, label: string): string[] {
  let parts: string[];
  try { parts = validateArtifactPathParts(value, label); }
  catch (error) { throw new ResourceCatalogError(error instanceof Error ? error.message : `${label} is unsafe.`); }
  if (parts.length > 64 || parts.join('/').length > 4096 || parts.some((part) =>
    part !== part.normalize('NFKC') || part.length > 255 || /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) ||
    /^(?:com|lpt)[¹²³](?:\.|$)/iu.test(part))) {
    throw new ResourceCatalogError(`${label} contains an unsafe or nonportable path component.`);
  }
  return parts;
}

function distinctStrings(value: unknown[], label: string): void {
  if (value.length > 4096 || Object.keys(value).length !== value.length ||
      new Set(value).size !== value.length) throw new ResourceCatalogError(`${label} must be a bounded, dense, unique list.`);
  for (const entry of value) boundedText(entry, label, 256);
}

function assertOnlyKeys(obj: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ResourceCatalogError(`${label} contains unknown field: ${JSON.stringify(key)}.`);
    }
  }
}

function computeCanonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ResourceCatalogError('Non-finite numbers cannot be canonicalized.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => computeCanonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${computeCanonicalJson(record[key])}`).join(',')}}`;
  }
  throw new ResourceCatalogError(`Unsupported value type for canonical JSON: ${typeof value}`);
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function computeResourceDigest(content: string | Buffer): string {
  return `sha256:${sha256Hex(content)}`;
}

export function computeComponentDigest(
  component: Omit<TemplateComponentDescriptor, 'digest'>,
  catalogResources?: Record<string, ResourceDescriptor>
): string {
  const canonical = computeCanonicalJson({
    id: component.id,
    label: component.label,
    category: component.category,
    revision: component.revision,
    dependencies: [...component.dependencies].sort(),
    resources: [...component.resources].sort().map((rId) => {
      const r = catalogResources?.[rId];
      return r
        ? {
            id: r.id,
            path: r.path,
            category: r.category,
            digest: r.digest,
            size: r.size,
            lifecycle: r.lifecycle
          }
        : rId;
    }),
    artifactLifecycles: Object.fromEntries(
      Object.keys(component.artifactLifecycles)
        .sort()
        .map((k) => [k, component.artifactLifecycles[k]])
    )
  });
  return `sha256:${sha256Hex(canonical)}`;
}

export function computeTemplateCatalogDigest(
  catalog: Omit<TemplateCatalog, 'digest'>
): string {
  const canonical = computeCanonicalJson({
    schemaVersion: catalog.schemaVersion,
    catalogId: catalog.catalogId,
    revision: catalog.revision,
    components: Object.fromEntries(
      Object.keys(catalog.components)
        .sort()
        .map((k) => {
          const c = catalog.components[k];
          return [
            k,
            {
              id: c.id,
              label: c.label,
              category: c.category,
              revision: c.revision,
              digest: c.digest,
              dependencies: [...c.dependencies].sort(),
              resources: [...c.resources].sort(),
              artifactLifecycles: Object.fromEntries(
                Object.keys(c.artifactLifecycles).sort().map((ak) => [ak, c.artifactLifecycles[ak]])
              )
            }
          ];
        })
    ),
    resources: Object.fromEntries(
      Object.keys(catalog.resources)
        .sort()
        .map((k) => {
          const r = catalog.resources[k];
          return [
            k,
            {
              id: r.id,
              path: r.path,
              category: r.category,
              componentId: r.componentId,
              digest: r.digest,
              size: r.size,
              lifecycle: r.lifecycle,
              logicalName: r.logicalName,
              description: r.description
            }
          ];
        })
    ),
    retirements: catalog.retirements
      ? Object.fromEntries(
          Object.keys(catalog.retirements)
            .sort()
            .map((k) => {
              const ret = catalog.retirements![k];
              return [
                k,
                {
                  retiredLogicalName: ret.retiredLogicalName,
                  category: ret.category,
                  pathParts: ret.pathParts,
                  replacementLogicalName: ret.replacementLogicalName,
                  reason: ret.reason
                }
              ];
            })
        )
      : undefined
  });
  return `sha256:${sha256Hex(canonical)}`;
}

function assertNoDependencyCycles(components: Record<string, TemplateComponentDescriptor>): void {
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(node: string, pathChain: string[]): void {
    visited.add(node);
    recStack.add(node);
    const comp = components[node];
    if (comp) {
      for (const dep of comp.dependencies) {
        if (components[dep]) {
          if (!visited.has(dep)) {
            dfs(dep, [...pathChain, dep]);
          } else if (recStack.has(dep)) {
            throw new ResourceCatalogError(
              `Cyclic component dependency detected: ${[...pathChain, dep].join(' -> ')}.`
            );
          }
        }
      }
    }
    recStack.delete(node);
  }

  for (const compId of Object.keys(components)) {
    if (!visited.has(compId)) {
      dfs(compId, [compId]);
    }
  }
}

export function validateResourceDescriptor(raw: unknown): ResourceDescriptor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ResourceCatalogError('Resource descriptor must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(
    obj,
    ['id', 'path', 'logicalName', 'category', 'componentId', 'digest', 'size', 'lifecycle', 'description'],
    'Resource descriptor'
  );

  const id = obj['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new ResourceCatalogError('Resource descriptor missing string ID.');
  }

  const componentId = obj['componentId'];
  if (typeof componentId !== 'string' || componentId.trim().length === 0) {
    throw new ResourceCatalogError(`Resource ${id} missing componentId.`);
  }
  boundedText(id, 'Resource ID', 256);
  boundedText(componentId, `Resource ${id} componentId`, 256);

  const p = obj['path'];
  if (typeof p !== 'string' || p.trim().length === 0) {
    throw new ResourceCatalogError(`Resource ${id} missing path.`);
  }
  boundedText(p, `Resource ${id} path`, 4096);
  portableParts(p.split('/'), `Resource ${id} path`);

  const digest = obj['digest'];
  if (typeof digest !== 'string' || digest.length !== 71 || !SHA256_PATTERN.test(digest)) {
    throw new ResourceCatalogError(`Resource ${id} missing valid sha256:64hex digest, received: ${JSON.stringify(digest)}.`);
  }

  const size = obj['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > 10 * 1024 * 1024) {
    throw new ResourceCatalogError(`Resource ${id} missing non-negative integer size, received: ${JSON.stringify(size)}.`);
  }
  if (typeof obj.category !== 'string' || !RESOURCE_CATEGORIES.has(obj.category)) {
    throw new ResourceCatalogError(`Resource ${id} has an unsupported category.`);
  }
  if (obj.logicalName !== undefined) boundedText(obj.logicalName, `Resource ${id} logicalName`, 256);
  if (obj.description !== undefined) boundedText(obj.description, `Resource ${id} description`, 4096);

  const lifecycle = obj['lifecycle'];
  if (lifecycle !== undefined && (typeof lifecycle !== 'string' || !VALID_LIFECYCLES.has(lifecycle))) {
    throw new ResourceCatalogError(`Resource ${id} has invalid lifecycle: ${JSON.stringify(lifecycle)}.`);
  }

  return raw as ResourceDescriptor;
}

export function validateTemplateComponentDescriptor(raw: unknown): TemplateComponentDescriptor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ResourceCatalogError('Template component descriptor must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(
    obj,
    ['id', 'label', 'category', 'revision', 'digest', 'dependencies', 'resources', 'artifactLifecycles'],
    'Template component descriptor'
  );

  const id = obj['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new ResourceCatalogError('Template component missing string ID.');
  }

  const label = obj['label'];
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new ResourceCatalogError(`Component ${id} missing label.`);
  }

  const category = obj['category'];
  const validCategories = new Set([
    'common', 'backend', 'genai', 'frontend', 'infrastructure', 'workflow', 'governance'
  ]);
  if (typeof category !== 'string' || !validCategories.has(category)) {
    throw new ResourceCatalogError(`Component ${id} has invalid category ${JSON.stringify(category)}.`);
  }

  const revision = obj['revision'];
  if (typeof revision !== 'string' || revision.trim().length === 0) {
    throw new ResourceCatalogError(`Component ${id} missing revision.`);
  }

  const digest = obj['digest'];
  if (typeof digest !== 'string' || digest.length !== 71 || !SHA256_PATTERN.test(digest)) {
    throw new ResourceCatalogError(`Component ${id} missing valid sha256:64hex digest, received: ${JSON.stringify(digest)}.`);
  }

  if (!Array.isArray(obj['dependencies'])) {
    throw new ResourceCatalogError(`Component ${id} missing dependencies array.`);
  }
  for (const dep of obj['dependencies']) {
    if (typeof dep !== 'string' || dep.trim().length === 0) {
      throw new ResourceCatalogError(`Component ${id} dependency must be a non-empty string.`);
    }
    distinctStrings(obj.dependencies, `Component ${id} dependencies`);
  }

  if (!Array.isArray(obj['resources'])) {
    throw new ResourceCatalogError(`Component ${id} missing resources array.`);
  }
  for (const res of obj['resources']) {
    if (typeof res !== 'string' || res.trim().length === 0) {
      throw new ResourceCatalogError(`Component ${id} resource must be a non-empty string.`);
    }
    distinctStrings(obj.resources, `Component ${id} resources`);
    boundedText(id, 'Component ID', 256);
    boundedText(label, `Component ${id} label`);
    boundedText(revision, `Component ${id} revision`, 256);
  }

  if (!obj['artifactLifecycles'] || typeof obj['artifactLifecycles'] !== 'object' || Array.isArray(obj['artifactLifecycles'])) {
    throw new ResourceCatalogError(`Component ${id} missing artifactLifecycles mapping.`);
  }
  const lifecycles = obj['artifactLifecycles'] as Record<string, unknown>;
  for (const [artName, artLifecycle] of Object.entries(lifecycles)) {
    boundedText(artName, `Component ${id} artifact ID`, 256);
    if (typeof artLifecycle !== 'string' || !VALID_LIFECYCLES.has(artLifecycle)) {
      throw new ResourceCatalogError(
        `Component ${id} artifact ${artName} has invalid lifecycle: ${JSON.stringify(artLifecycle)}.`
      );
    }
  }

  return raw as TemplateComponentDescriptor;
}

export function validateTemplateCatalog(raw: unknown, strict = true): TemplateCatalog {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ResourceCatalogError('Template catalog must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(
    obj,
    ['schemaVersion', 'catalogId', 'revision', 'digest', 'components', 'resources', 'retirements'],
    'Template catalog'
  );

  if (obj['schemaVersion'] !== RESOURCE_CATALOG_SCHEMA_VERSION) {
    throw new ResourceCatalogError(
      `Unsupported template catalog schemaVersion: expected 1, received ${JSON.stringify(obj['schemaVersion'])}.`
    );
  }

  if (typeof obj['catalogId'] !== 'string' || obj['catalogId'].trim().length === 0) {
    throw new ResourceCatalogError('Catalog missing catalogId.');
  }

  if (typeof obj['revision'] !== 'string' || obj['revision'].trim().length === 0) {
    throw new ResourceCatalogError('Catalog missing revision.');
  }

  const digest = obj['digest'];
  if (typeof digest !== 'string' || digest.length !== 71 || !SHA256_PATTERN.test(digest)) {
    throw new ResourceCatalogError(`Catalog missing valid sha256:64hex digest, received: ${JSON.stringify(digest)}.`);
  }

  const components = obj['components'];
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    throw new ResourceCatalogError('Catalog missing components mapping.');
  }

  const resources = obj['resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new ResourceCatalogError('Catalog missing resources mapping.');
  }

  const componentRecord = components as Record<string, TemplateComponentDescriptor>;
  const resourceRecord = resources as Record<string, ResourceDescriptor>;

  const seenComponentIds = new Set<string>();
  for (const [key, compValue] of Object.entries(componentRecord)) {
    if (seenComponentIds.has(key)) {
      throw new ResourceCatalogError(`Duplicate component ID: ${key}.`);
    }
    seenComponentIds.add(key);
    const comp = validateTemplateComponentDescriptor(compValue);
    if (comp.id !== key) {
      throw new ResourceCatalogError(`Component key ${key} does not match ID ${comp.id}.`);
    }
  }

  const seenResourceIds = new Set<string>();
  const seenResPaths = new Map<string, string>();
  const seenCaseFoldedRes = new Map<string, string>();

  for (const [key, resValue] of Object.entries(resourceRecord)) {
    if (seenResourceIds.has(key)) {
      throw new ResourceCatalogError(`Duplicate resource ID: ${key}.`);
    }
    seenResourceIds.add(key);
    const res = validateResourceDescriptor(resValue);
    if (res.id !== key) {
      throw new ResourceCatalogError(`Resource key ${key} does not match ID ${res.id}.`);
    }
    // Verify component link
    if (!seenComponentIds.has(res.componentId)) {
      throw new ResourceCatalogError(
        `Resource ${key} references unknown componentId: ${res.componentId}.`
      );
    }
    // Check path collisions across resources
    const normPath = res.path.replace(/\\/g, '/');
    if (seenResPaths.has(normPath)) {
      throw new ResourceCatalogError(
        `Resource destination collision: ${normPath} is claimed by both ${seenResPaths.get(normPath)} and ${key}.`
      );
    }
    seenResPaths.set(normPath, key);

    const cfPath = normPath.normalize('NFKC').toUpperCase().toLowerCase();
    if (seenCaseFoldedRes.has(cfPath)) {
      throw new ResourceCatalogError(
        `Resource Windows case-collision: ${normPath} for ${key} collides with ${seenCaseFoldedRes.get(cfPath)}.`
      );
    }
    seenCaseFoldedRes.set(cfPath, key);
  }

  // Verify component resource links exist
  for (const comp of Object.values(componentRecord)) {
    for (const resId of comp.resources) {
      if (!seenResourceIds.has(resId)) {
        throw new ResourceCatalogError(
          `Component ${comp.id} references missing resource: ${resId}.`
        );
      }
    }
  }

  // Check for dependency cycles
  assertNoDependencyCycles(componentRecord);

  // Validate retirements if present
  if (obj['retirements'] !== undefined) {
    if (typeof obj['retirements'] !== 'object' || Array.isArray(obj['retirements'])) {
      throw new ResourceCatalogError('retirements must be an object.');
    }
    const retirements = obj['retirements'] as Record<string, unknown>;
    for (const [retKey, retValue] of Object.entries(retirements)) {
      if (!retValue || typeof retValue !== 'object' || Array.isArray(retValue)) {
        throw new ResourceCatalogError(`Retirement entry ${retKey} must be an object.`);
      }
      const r = retValue as Record<string, unknown>;
      assertOnlyKeys(r, ['retiredLogicalName', 'category', 'pathParts', 'replacementLogicalName', 'reason'], `Retirement ${retKey}`);
      if (typeof r['retiredLogicalName'] !== 'string' || r['retiredLogicalName'].trim().length === 0) {
        throw new ResourceCatalogError(`Retirement ${retKey} missing retiredLogicalName.`);
      }
      if (!Array.isArray(r['pathParts']) || r['pathParts'].length === 0) {
        throw new ResourceCatalogError(`Retirement ${retKey} missing pathParts array.`);
      }
      if (typeof r['reason'] !== 'string' || r['reason'].trim().length === 0) {
        throw new ResourceCatalogError(`Retirement ${retKey} missing reason.`);
      }
      boundedText(r.reason, `Retirement ${retKey} reason`, 4096);
      const parts = portableParts(r.pathParts, `Retirement ${retKey}`);
      const registered = retiredManagedCoreIdentityMap.get(retKey);
      if (!registered || r.retiredLogicalName !== retKey || r.category !== registered.category ||
          parts.join('/') !== registered.pathParts.join('/') || r.replacementLogicalName !== registered.replacementLogicalName) {
        throw new ResourceCatalogError(`Retirement ${retKey} is not an exact reader-registered retirement identity.`);
      }
    }
  }

  if (strict) {
    const computed = computeTemplateCatalogDigest(obj as unknown as Omit<TemplateCatalog, 'digest'>);
    if (computed !== obj['digest']) {
      throw new ResourceCatalogError(
        `Template catalog digest mismatch: expected ${computed}, received ${obj['digest']}.`
      );
    }
  }

  return raw as TemplateCatalog;
}

const WINDOWS_RESERVED_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

export interface ArtifactCandidate {
  logicalName: string;
  category: string;
  pathParts: string[];
  lifecycle?: string;
  content?: string;
}

export function assertArtifactsSafeBeforeWrite(
  artifacts: readonly ArtifactCandidate[]
): void {
  const seenPaths = new Map<string, string>(); // normalizedPath -> logicalName
  const seenCaseFolded = new Map<string, string>(); // lowercasePath -> logicalName
  const logicalNames = new Set<string>();

  for (const artifact of artifacts) {
    const { logicalName, pathParts } = artifact;
    if (typeof logicalName !== 'string' || !logicalName || logicalNames.has(logicalName)) {
      throw new ArtifactCollisionError('Artifact logical identities must be nonempty and unique.');
    }
    logicalNames.add(logicalName);

    if (!pathParts || !Array.isArray(pathParts) || pathParts.length === 0) {
      throw new ArtifactCollisionError(
        `Artifact ${logicalName} has empty or missing path parts.`
      );
    }

    // Check each path part
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];
      if (typeof part !== 'string' || part.trim().length === 0) {
        throw new ArtifactCollisionError(
          `Artifact ${logicalName} path part ${i + 1} must be a non-empty string.`
        );
      }

      if (
        part === '.' ||
        part === '..' ||
        part.includes('/') ||
        part.includes('\\') ||
        part.includes('\0') ||
        WINDOWS_DRIVE_PATTERN.test(part)
      ) {
        throw new ArtifactCollisionError(
          `Artifact ${logicalName} contains unsafe path part ${JSON.stringify(part)}.`
        );
      }

      if (part.endsWith('.') || part.endsWith(' ') || WINDOWS_RESERVED_PATTERN.test(part)) {
        throw new ArtifactCollisionError(
          `Artifact ${logicalName} contains non-portable Windows alias path part ${JSON.stringify(part)}.`
        );
      }
      if (part !== part.normalize('NFKC') || /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) ||
          /^(?:com|lpt)[¹²³](?:\.|$)/iu.test(part)) {
        throw new ArtifactCollisionError(`Artifact ${logicalName} has an ambiguous or nonportable path component.`);
      }
    }

    const normalizedPath = pathParts.join('/');
    const caseFolded = pathParts.map((p) => p.normalize('NFKC').toUpperCase().toLowerCase()).join('/');

    // Check 1: exact duplicate destination
    if (seenPaths.has(normalizedPath)) {
      const priorLogical = seenPaths.get(normalizedPath);
      throw new ArtifactCollisionError(
        `Duplicate destination collision: ${normalizedPath} is claimed by both ${priorLogical} and ${logicalName}.`
      );
    }
    seenPaths.set(normalizedPath, logicalName);

    // Check 2: Windows case alias collision
    if (seenCaseFolded.has(caseFolded)) {
      const priorLogical = seenCaseFolded.get(caseFolded);
      throw new ArtifactCollisionError(
        `Windows case-collision: ${normalizedPath} for ${logicalName} collides with ${priorLogical} on case-insensitive filesystems.`
      );
    }
    seenCaseFolded.set(caseFolded, logicalName);
  }
}

export function assertRetirementEligible(
  logicalName: string,
  category: string,
  pathParts: readonly string[],
  catalog?: TemplateCatalog
): void {
  if (catalog) validateTemplateCatalog(catalog);
  // Check against registered retired managed core identities
  const managedCoreRetired = retiredManagedCoreIdentityMap.get(logicalName);
  if (managedCoreRetired) {
    if (
      managedCoreRetired.category === category &&
      managedCoreRetired.pathParts.join('/') === pathParts.join('/')
    ) {
      return; // Valid registered retirement
    }
  }

  throw new ArtifactCollisionError(
    `Unregistered retirement candidate rejected: ${logicalName} (${category}: ${pathParts.join('/')}) is not in the declared retirement inventory.`
  );
}

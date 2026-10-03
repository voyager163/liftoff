import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinAssets } from '../src/plugins/builtin/assets.ts';

export const canonicalNpmRegistry = 'https://registry.npmjs.org';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export const templateDependencyInventory = Object.freeze([
  Object.freeze({
    id: 'liftoff-cli',
    label: 'Liftoff CLI',
    pathParts: Object.freeze(['package-lock.json'])
  }),
  Object.freeze({
    id: 'telemetry-ingest',
    label: 'Telemetry ingest service',
    pathParts: Object.freeze(['services', 'telemetry-ingest', 'package-lock.json'])
  }),
  Object.freeze({
    id: 'node-backend',
    label: 'Standard Node.js backend',
    pathParts: Object.freeze(['assets', 'plugins', 'node-fastify', 'node-backend', 'package-lock.json'])
  }),
  Object.freeze({
    id: 'standard-frontend',
    label: 'Standard frontend',
    pathParts: Object.freeze(['assets', 'templates', 'common', 'frontend', 'package-lock.json'])
  })
]);

export const resolvedTemplateAdvisories = Object.freeze([
  Object.freeze({
    manifestId: 'node-backend',
    advisoryId: 'GHSA-gpj5-g38j-94v9',
    package: 'drizzle-orm'
  }),
  Object.freeze({
    manifestId: 'standard-frontend',
    advisoryId: 'GHSA-67mh-4wv8-2f99',
    package: 'esbuild'
  }),
  Object.freeze({
    manifestId: 'standard-frontend',
    advisoryId: 'GHSA-4w7w-66w2-5vf9',
    package: 'vite'
  }),
  Object.freeze({
    manifestId: 'standard-frontend',
    advisoryId: 'GHSA-fx2h-pf6j-xcff',
    package: 'vite'
  }),
  Object.freeze({
    manifestId: 'standard-frontend',
    advisoryId: 'GHSA-v6wh-96g9-6wx3',
    package: 'vite'
  })
]);

export const templateDependencyPolicyPathParts = Object.freeze([
  'security',
  'template-dependency-exceptions.json'
]);

// Tooling metadata for the six packaged template dependency sets. Members, paths and roles come
// from the C1 declaration table; this list adds only the ecosystem, the audit coverage and
// baseline pointers (key paths into assets/supported-stack.json). It holds no paths or hashes.
export const templateDependencySets = Object.freeze([
  Object.freeze({
    id: 'node-backend',
    ecosystem: 'npm',
    audit: Object.freeze({ mode: 'npm-audit', inventoryId: 'node-backend' }),
    baselineViews: Object.freeze([Object.freeze(['npmProjects', 'node-backend'])])
  }),
  Object.freeze({
    id: 'frontend',
    ecosystem: 'npm',
    audit: Object.freeze({ mode: 'npm-audit', inventoryId: 'standard-frontend' }),
    baselineViews: Object.freeze([Object.freeze(['npmProjects', 'frontend'])])
  }),
  Object.freeze({
    id: 'python-standard',
    ecosystem: 'pypi',
    audit: Object.freeze({
      mode: 'unaudited',
      reason: 'No PyPI advisory source is configured for this release.'
    }),
    baselineViews: Object.freeze([Object.freeze(['pythonProjects', 'standard-backend'])])
  }),
  Object.freeze({
    id: 'python-genai',
    ecosystem: 'pypi',
    audit: Object.freeze({
      mode: 'unaudited',
      reason: 'No PyPI advisory source is configured for this release.'
    }),
    baselineViews: Object.freeze([
      Object.freeze(['pythonProjects', 'genai-backend']),
      Object.freeze(['pythonProjects', 'function-worker'])
    ])
  }),
  Object.freeze({
    id: 'go-backend',
    ecosystem: 'go',
    audit: Object.freeze({
      mode: 'unaudited',
      reason: 'No Go module advisory source is configured for this release.'
    }),
    baselineViews: Object.freeze([Object.freeze(['goModules', 'go-backend'])]),
    toolPins: Object.freeze([
      Object.freeze(['goModules', 'go-backend', 'tools', 'github.com/pressly/goose/v3'])
    ])
  }),
  Object.freeze({
    id: 'opentofu-azure',
    ecosystem: 'opentofu',
    audit: Object.freeze({
      mode: 'unaudited',
      reason: 'No OpenTofu provider advisory source is configured for this release.'
    }),
    // The shared view also covers the repository's own infrastructure, so it is a superset.
    baselineViews: Object.freeze([Object.freeze(['opentofu'])])
  })
]);

export const templateDependencyStructure = Object.freeze({
  assets: builtinAssets,
  sets: templateDependencySets
});

const allowedDispositions = new Set(['vulnerable-code-not-used', 'mitigated']);
const advisoryPattern = /^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const millisecondsPerDay = 86_400_000;

export class TemplateDependencyPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateDependencyPolicyError';
  }
}

export class TemplateDependencyAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateDependencyAuditError';
  }
}

export class TemplateDependencyStructureError extends TemplateDependencyPolicyError {
  constructor(issues) {
    const details = issues.map((issue) => {
      const subject = [issue.set, issue.path].filter(Boolean).join(' ') || 'structure';
      return `[${issue.code}] ${subject}: ${issue.detail}`;
    });
    super(
      `Template dependency structure is invalid (${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}): ${details.join('; ')}.`
    );
    this.name = 'TemplateDependencyStructureError';
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export function resolveTemplateDependencyAuditRegistry(value) {
  if (value === undefined || value.trim() === '') {
    return canonicalNpmRegistry;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TemplateDependencyAuditError(
      'LIFTOFF_NPM_AUDIT_REGISTRY must be an absolute HTTPS URL.'
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TemplateDependencyAuditError(
      'LIFTOFF_NPM_AUDIT_REGISTRY must be a credential-free HTTPS URL without query parameters or fragments.'
    );
  }
  return parsed.toString();
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stablePath(pathParts) {
  return pathParts.join('/');
}

function dependencyChainKey(chain) {
  return chain.join('\0');
}

function compareDependencyChains(left, right) {
  return left.length - right.length || left.join('/').localeCompare(right.join('/'));
}

function assertAllowedKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new TemplateDependencyPolicyError(
      `${label} contains unsupported fields: ${unexpected.sort().join(', ')}.`
    );
  }
}

function requiredString(value, field, label) {
  if (typeof value[field] !== 'string' || value[field].trim() === '') {
    throw new TemplateDependencyPolicyError(`${label}.${field} must be a nonempty string.`);
  }
  return value[field].trim();
}

function requiredStringArray(value, field, label) {
  if (
    !Array.isArray(value[field]) ||
    value[field].length === 0 ||
    value[field].some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw new TemplateDependencyPolicyError(
      `${label}.${field} must be a nonempty array of nonempty strings.`
    );
  }
  return value[field].map((entry) => entry.trim());
}

function requiredDependencyChains(value, field, label) {
  if (!Array.isArray(value[field]) || value[field].length === 0) {
    throw new TemplateDependencyPolicyError(
      `${label}.${field} must be a nonempty array of nonempty string arrays.`
    );
  }
  const chains = value[field].map((chain, index) => {
    if (
      !Array.isArray(chain) ||
      chain.length === 0 ||
      chain.some((entry) => typeof entry !== 'string' || entry.trim() === '')
    ) {
      throw new TemplateDependencyPolicyError(
        `${label}.${field}[${index}] must be a nonempty array of nonempty strings.`
      );
    }
    return chain.map((entry) => entry.trim());
  });
  const keys = chains.map(dependencyChainKey);
  if (new Set(keys).size !== keys.length) {
    throw new TemplateDependencyPolicyError(`${label}.${field} contains a duplicate chain.`);
  }
  return chains.sort(compareDependencyChains);
}

function validatePathParts(pathParts, label) {
  for (const part of pathParts) {
    if (
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      path.isAbsolute(part)
    ) {
      throw new TemplateDependencyPolicyError(
        `${label} contains an unsafe path part: ${JSON.stringify(part)}.`
      );
    }
  }
}

function parseIsoDate(value, label) {
  if (typeof value !== 'string' || !isoDatePattern.test(value)) {
    throw new TemplateDependencyPolicyError(`${label} must use YYYY-MM-DD format.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  const roundTrip = [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0')
  ].join('-');
  if (roundTrip !== value) {
    throw new TemplateDependencyPolicyError(`${label} is not a valid calendar date.`);
  }
  return timestamp;
}

function exceptionKey(manifestPathParts, advisoryId, packageName) {
  return `${stablePath(manifestPathParts)}\0${advisoryId}\0${packageName}`;
}

function findingKey(finding) {
  return exceptionKey(finding.manifestPathParts, finding.advisoryId, finding.package);
}

function resolvedAdvisoryKey(value) {
  return `${value.manifestId}\0${value.advisoryId.toUpperCase()}\0${value.package}`;
}

function packagePathFromLockPath(pathParts) {
  return [...pathParts.slice(0, -1), 'package.json'];
}

export function resolveTemplateDependencyPath(
  repositoryRoot,
  pathParts,
  pathApi = path
) {
  return pathApi.join(repositoryRoot, ...pathParts);
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function validateTemplateDependencyInventory(
  repositoryRoot,
  inventory = templateDependencyInventory,
  packagedPaths
) {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new TemplateDependencyPolicyError('Template dependency inventory must not be empty.');
  }

  const ids = new Set();
  const paths = new Set();
  const resolved = [];

  for (const [index, entry] of inventory.entries()) {
    const label = `inventory[${index}]`;
    if (!isRecord(entry)) {
      throw new TemplateDependencyPolicyError(`${label} must be an object.`);
    }
    const id = requiredString(entry, 'id', label);
    const displayLabel = requiredString(entry, 'label', label);
    const pathParts = requiredStringArray(entry, 'pathParts', label);
    validatePathParts(pathParts, `${label}.pathParts`);
    if (pathParts.at(-1) !== 'package-lock.json') {
      throw new TemplateDependencyPolicyError(`${label} must identify package-lock.json.`);
    }

    const stable = stablePath(pathParts);
    if (ids.has(id)) {
      throw new TemplateDependencyPolicyError(`Duplicate inventory id: ${id}.`);
    }
    if (paths.has(stable)) {
      throw new TemplateDependencyPolicyError(`Duplicate inventory path: ${stable}.`);
    }
    ids.add(id);
    paths.add(stable);

    const lockPath = resolveTemplateDependencyPath(repositoryRoot, pathParts);
    const packagePathParts = packagePathFromLockPath(pathParts);
    const packagePath = resolveTemplateDependencyPath(repositoryRoot, packagePathParts);
    const [lockStats, packageStats] = await Promise.all([stat(lockPath), stat(packagePath)]);
    if (!lockStats.isFile()) {
      throw new TemplateDependencyPolicyError(`${stable} is not a regular lockfile.`);
    }
    if (!packageStats.isFile()) {
      throw new TemplateDependencyPolicyError(
        `${stablePath(packagePathParts)} is not a regular package manifest.`
      );
    }

    resolved.push({
      id,
      label: displayLabel,
      pathParts,
      stablePath: stable,
      lockPath,
      packagePath,
      directory: path.dirname(lockPath)
    });
  }

  if (packagedPaths !== undefined) {
    const packagedLocks = [...new Set(packagedPaths)]
      .filter((filePath) => filePath.startsWith('assets/') && filePath.endsWith('/package-lock.json'))
      .sort();
    const inventoryLocks = [...paths]
      .filter((filePath) => filePath.startsWith('assets/'))
      .sort();
    if (JSON.stringify(packagedLocks) !== JSON.stringify(inventoryLocks)) {
      const missing = packagedLocks.filter((filePath) => !paths.has(filePath));
      const absent = inventoryLocks.filter((filePath) => !packagedLocks.includes(filePath));
      const detail = [
        missing.length > 0 ? `untracked packaged locks: ${missing.join(', ')}` : '',
        absent.length > 0 ? `inventory locks absent from package: ${absent.join(', ')}` : ''
      ].filter(Boolean).join('; ');
      throw new TemplateDependencyPolicyError(`Packaged lockfile inventory mismatch: ${detail}.`);
    }
  }

  return resolved;
}

const dependencyEcosystems = Object.freeze(['npm', 'pypi', 'go', 'opentofu']);
const dependencyRoles = new Set(['manifest', 'lock', 'export']);
const dependencySetKeys = new Set(['id', 'ecosystem', 'audit', 'baselineViews', 'toolPins']);
// Mirrors the registry's packaged-asset rule without importing it: portable names only, so drive
// prefixes, stream colons, separators, trailing dots and Windows device names are all rejected.
const portableMemberPartPattern = /^[A-Za-z0-9._-]+$/;
const windowsReservedNamePattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const packageEntryPatternCharacters = /[*?[\]{}()!+@]/;
// Reporting order: declaration issues first, then filesystem and package declaration issues.
const structureIssueCodes = Object.freeze([
  'invalid-dependency-member',
  'duplicate-dependency-member',
  'invalid-dependency-set',
  'undeclared-dependency-set',
  'empty-dependency-set',
  'dependency-set-shape',
  'npm-set-layout',
  'missing-audit-inventory',
  'audit-inventory-mismatch',
  'unowned-audit-inventory',
  'unreadable-package-manifest',
  'missing-dependency-member',
  'non-regular-dependency-member',
  'undeclared-package-member',
  'unexpected-package-entry'
]);

// Index-based so that holes in sparse arrays are checked instead of skipped.
function isStringList(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') {
      return false;
    }
  }
  return true;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStructureIssues(left, right) {
  return structureIssueCodes.indexOf(left.code) - structureIssueCodes.indexOf(right.code) ||
    compareText(left.set ?? '', right.set ?? '') ||
    compareText(left.path ?? '', right.path ?? '') ||
    compareText(left.detail, right.detail);
}

function memberOwnerKey(owner) {
  if (!isRecord(owner)) {
    return undefined;
  }
  const keys = Object.keys(owner).sort().join(',');
  if (owner.kind === 'core' && keys === 'kind') {
    return 'core';
  }
  if (
    owner.kind === 'plugin' &&
    keys === 'category,id,kind' &&
    typeof owner.category === 'string' && owner.category !== '' &&
    typeof owner.id === 'string' && owner.id !== ''
  ) {
    return `plugin:${owner.category}:${owner.id}`;
  }
  return undefined;
}

function dependencyMemberProblem(member) {
  if (!isRecord(member)) {
    return 'must be an object';
  }
  if (memberOwnerKey(member.owner) === undefined) {
    return 'owner must be the core owner or a plugin owner with a category and id';
  }
  if (typeof member.id !== 'string' || member.id.trim() === '') {
    return 'id must be a nonempty string';
  }
  if (typeof member.set !== 'string' || member.set.trim() === '') {
    return 'set must be a nonempty string';
  }
  if (!dependencyRoles.has(member.role)) {
    return 'role must be manifest, lock or export';
  }
  if (!Array.isArray(member.pathParts) || member.pathParts.length < 2 || member.pathParts[0] !== 'assets') {
    return 'pathParts must name a file below assets';
  }
  // Index-based: undefined parts and holes are rejected like any other non-string part.
  for (let index = 0; index < member.pathParts.length; index += 1) {
    const part = member.pathParts[index];
    if (
      typeof part !== 'string' ||
      !portableMemberPartPattern.test(part) ||
      part.endsWith('.') ||
      windowsReservedNamePattern.test(part)
    ) {
      const shown = typeof part === 'string' ? JSON.stringify(part) : part === null ? 'null' : typeof part;
      return `path part ${index} (${shown}) is not a portable name`;
    }
  }
  return undefined;
}

function dependencySetProblem(set) {
  if (!isRecord(set)) {
    return 'must be an object';
  }
  const unexpected = Object.keys(set).filter((key) => !dependencySetKeys.has(key));
  if (unexpected.length > 0) {
    return `contains unsupported fields: ${unexpected.sort().join(', ')}`;
  }
  if (typeof set.id !== 'string' || set.id.trim() === '') {
    return 'id must be a nonempty string';
  }
  if (!dependencyEcosystems.includes(set.ecosystem)) {
    return `ecosystem must be one of ${dependencyEcosystems.join(', ')}`;
  }
  const audit = set.audit;
  const auditKeys = isRecord(audit) ? Object.keys(audit).sort().join(',') : '';
  if (isRecord(audit) && audit.mode === 'npm-audit') {
    if (set.ecosystem !== 'npm') {
      return 'npm-audit applies only to the npm ecosystem';
    }
    return auditKeys === 'inventoryId,mode' && typeof audit.inventoryId === 'string' && audit.inventoryId.trim() !== ''
      ? undefined
      : 'npm-audit must name exactly one nonempty inventoryId';
  }
  if (isRecord(audit) && audit.mode === 'unaudited') {
    return auditKeys === 'mode,reason' && typeof audit.reason === 'string' && audit.reason.trim() !== ''
      ? undefined
      : 'unaudited must give exactly one nonempty reason';
  }
  return 'audit.mode must be npm-audit or unaudited';
}

// Portable comparison key: case-insensitive and normalization-insensitive hosts treat these as the
// same path, so an alias such as ASSETS/plugins is classified like assets/plugins.
function foldedPath(value) {
  return value.normalize('NFKC').toLowerCase();
}

// True when a package.json files entry equals, lies inside or contains the set directory, or is a
// pattern or negation whose literal prefix is related to it, compared as portable aliases. Such an
// entry would package the set by directory, pattern or alias instead of by exact member paths.
function packageEntryTouchesDirectory(entry, directory) {
  const normalized = foldedPath(entry.replaceAll('\\', '/').replace(/^!+/, '').replace(/^(?:\.\/|\/)+/, '').replace(/\/+$/, ''));
  const target = foldedPath(directory);
  const patternIndex = normalized.search(packageEntryPatternCharacters);
  if (patternIndex !== -1) {
    const literal = normalized.slice(0, patternIndex);
    const prefix = literal.slice(0, literal.lastIndexOf('/') + 1).replace(/\/$/, '');
    return prefix === '' || prefix === target || target.startsWith(`${prefix}/`) || prefix.startsWith(`${target}/`);
  }
  return normalized === target || normalized.startsWith(`${target}/`) || target.startsWith(`${normalized}/`);
}

/**
 * Structural preflight for the packaged template dependency sets. Phase A checks declarations
 * without touching the filesystem; phase B checks that every declared member exists as a regular
 * file and is an exact package.json files entry. Structural problems throw one
 * TemplateDependencyStructureError; unexpected filesystem errors propagate unchanged.
 */
export async function validateTemplateDependencyStructure({ repositoryRoot, inventory, structure }) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot === '') {
    throw new TypeError('repositoryRoot must be a nonempty string.');
  }
  if (!Array.isArray(inventory)) {
    throw new TypeError('inventory must be an array.');
  }
  if (!isRecord(structure) || !Array.isArray(structure.assets) || !Array.isArray(structure.sets)) {
    throw new TypeError('structure must provide assets and sets arrays.');
  }
  const issues = [];
  const report = (code, set, filePath, detail) => {
    issues.push({ code, set: set ?? null, path: filePath ?? null, detail });
  };
  const fail = () => {
    throw new TemplateDependencyStructureError(issues.sort(compareStructureIssues));
  };

  const members = [];
  const identities = new Set();
  const aliasPaths = new Set();
  for (const [index, member] of structure.assets.entries()) {
    const set = isRecord(member) && typeof member.set === 'string' ? member.set : undefined;
    const memberPath = isRecord(member) && isStringList(member.pathParts) ? stablePath(member.pathParts) : undefined;
    const problem = dependencyMemberProblem(member);
    if (problem) {
      report('invalid-dependency-member', set, memberPath, `assets[${index}] ${problem}`);
      continue;
    }
    const identity = `${memberOwnerKey(member.owner)}\0${member.id}`;
    const alias = memberPath.normalize('NFC').toLowerCase();
    if (identities.has(identity)) {
      report('duplicate-dependency-member', set, memberPath, `assets[${index}] repeats owner and id ${member.id}`);
    } else if (aliasPaths.has(alias)) {
      report('duplicate-dependency-member', set, memberPath, `assets[${index}] repeats a declared path`);
    } else {
      identities.add(identity);
      aliasPaths.add(alias);
      members.push(member);
    }
  }

  const declaredSetIds = new Set();
  const setsById = new Map();
  for (const [index, set] of structure.sets.entries()) {
    const id = isRecord(set) && typeof set.id === 'string' ? set.id : undefined;
    const problem = dependencySetProblem(set);
    if (id !== undefined) {
      declaredSetIds.add(id);
    }
    if (problem) {
      report('invalid-dependency-set', id, undefined, `sets[${index}] ${problem}`);
    } else if (setsById.has(id)) {
      report('invalid-dependency-set', id, undefined, `sets[${index}] repeats set id ${id}`);
    } else {
      setsById.set(id, set);
    }
  }

  const membersBySet = new Map();
  for (const member of members) {
    membersBySet.set(member.set, [...(membersBySet.get(member.set) ?? []), member]);
  }
  for (const id of membersBySet.keys()) {
    if (!declaredSetIds.has(id)) {
      report('undeclared-dependency-set', id, undefined, 'C1 declares members for a set without dependency metadata');
    }
  }
  for (const id of setsById.keys()) {
    if (!membersBySet.has(id)) {
      report('empty-dependency-set', id, undefined, 'dependency metadata names a set without C1 members');
    }
  }

  const directories = new Map();
  for (const [id, setMembers] of membersBySet) {
    const owners = new Set(setMembers.map((member) => memberOwnerKey(member.owner)));
    const setDirectories = new Set(setMembers.map((member) => stablePath(member.pathParts.slice(0, -1))));
    const count = (role) => setMembers.filter((member) => member.role === role).length;
    if (owners.size !== 1) {
      report('dependency-set-shape', id, undefined, `members have ${owners.size} owners; expected 1`);
    }
    if (setDirectories.size !== 1) {
      report('dependency-set-shape', id, undefined, `members span ${setDirectories.size} directories; expected 1`);
    }
    if (count('manifest') !== 1) {
      report('dependency-set-shape', id, undefined, `declares ${count('manifest')} manifests; expected 1`);
    }
    if (count('lock') !== 1) {
      report('dependency-set-shape', id, undefined, `declares ${count('lock')} locks; expected 1`);
    }
    if (count('export') > 1) {
      report('dependency-set-shape', id, undefined, `declares ${count('export')} exports; expected at most 1`);
    }
    for (const directory of setDirectories) {
      if (directories.has(directory)) {
        report('dependency-set-shape', id, directory, `shares its directory with set ${directories.get(directory)}`);
      } else {
        directories.set(directory, id);
      }
    }
  }

  const inventoryById = new Map();
  for (const entry of inventory) {
    if (isRecord(entry) && typeof entry.id === 'string' && !inventoryById.has(entry.id)) {
      inventoryById.set(entry.id, entry);
    }
  }
  const auditingSets = new Map();
  for (const [id, set] of setsById) {
    if (set.audit.mode !== 'npm-audit') {
      continue;
    }
    const inventoryId = set.audit.inventoryId;
    auditingSets.set(inventoryId, (auditingSets.get(inventoryId) ?? 0) + 1);
    const setMembers = membersBySet.get(id) ?? [];
    for (const [role, fileName] of [['manifest', 'package.json'], ['lock', 'package-lock.json']]) {
      for (const member of setMembers.filter((candidate) => candidate.role === role)) {
        if (member.pathParts.at(-1) !== fileName) {
          report('npm-set-layout', id, stablePath(member.pathParts), `npm audit reads ${fileName} as the ${role}`);
        }
      }
    }
    const entry = inventoryById.get(inventoryId);
    if (!entry) {
      report('missing-audit-inventory', id, undefined, `inventory has no entry ${inventoryId}`);
      continue;
    }
    const locks = setMembers.filter((member) => member.role === 'lock');
    const entryPath = isStringList(entry.pathParts) ? stablePath(entry.pathParts) : undefined;
    if (locks.length === 1 && entryPath !== stablePath(locks[0].pathParts)) {
      report(
        'audit-inventory-mismatch',
        id,
        entryPath,
        `inventory ${inventoryId} does not name the declared lock ${stablePath(locks[0].pathParts)}`
      );
    }
  }
  for (const entry of inventory) {
    if (!isRecord(entry) || !isStringList(entry.pathParts) || foldedPath(entry.pathParts[0] ?? '') !== 'assets') {
      continue;
    }
    const namedBy = typeof entry.id === 'string' ? auditingSets.get(entry.id) ?? 0 : 0;
    if (namedBy !== 1) {
      const id = typeof entry.id === 'string' ? entry.id : `(${entry.id === null ? 'null' : typeof entry.id} id)`;
      report(
        'unowned-audit-inventory',
        undefined,
        stablePath(entry.pathParts),
        `inventory ${id} is named by ${namedBy} npm-audit sets; expected 1`
      );
    }
  }
  if (issues.length > 0) {
    fail();
  }

  let packageFiles;
  try {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    if (isRecord(manifest) && isStringList(manifest.files)) {
      packageFiles = manifest.files;
    } else {
      report('unreadable-package-manifest', undefined, 'package.json', 'files must be an array of strings');
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      report('unreadable-package-manifest', undefined, 'package.json', 'is not valid JSON');
    } else if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      report('unreadable-package-manifest', undefined, 'package.json', 'is missing');
    } else {
      throw error;
    }
  }

  const sortedMembers = [...members].sort((left, right) =>
    compareText(stablePath(left.pathParts), stablePath(right.pathParts))
  );
  for (const member of sortedMembers) {
    const memberPath = stablePath(member.pathParts);
    let memberStats;
    try {
      memberStats = await stat(resolveTemplateDependencyPath(repositoryRoot, member.pathParts));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        report('missing-dependency-member', member.set, memberPath, `${member.role} is missing`);
        continue;
      }
      throw error;
    }
    if (!memberStats.isFile()) {
      report('non-regular-dependency-member', member.set, memberPath, `${member.role} is not a regular file`);
    }
  }

  if (packageFiles !== undefined) {
    const declared = new Set(packageFiles);
    const memberPaths = new Set(members.map((member) => stablePath(member.pathParts)));
    for (const member of sortedMembers) {
      const memberPath = stablePath(member.pathParts);
      if (!declared.has(memberPath)) {
        report('undeclared-package-member', member.set, memberPath, 'is not an exact package.json files entry');
      }
    }
    for (const entry of new Set(packageFiles)) {
      if (memberPaths.has(entry)) {
        continue;
      }
      for (const [directory, id] of directories) {
        if (packageEntryTouchesDirectory(entry, directory)) {
          report('unexpected-package-entry', id, entry, `package.json files entry is not an exact member of ${directory}`);
        }
      }
    }
  }
  if (issues.length > 0) {
    fail();
  }

  return Object.freeze([...setsById.values()].map((set) => Object.freeze({
    id: set.id,
    ecosystem: set.ecosystem,
    audit: set.audit,
    members: Object.freeze(membersBySet.get(set.id).map((member) => Object.freeze({
      id: member.id,
      role: member.role,
      path: stablePath(member.pathParts)
    })))
  })));
}

export function parseTemplateDependencyPolicy(
  source,
  inventory = templateDependencyInventory
) {
  let value = source;
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new TemplateDependencyPolicyError(
        `Template dependency policy is not valid JSON: ${error.message}`
      );
    }
  }
  if (!isRecord(value)) {
    throw new TemplateDependencyPolicyError('Template dependency policy must be an object.');
  }
  assertAllowedKeys(value, new Set(['schemaVersion', 'exceptions']), 'policy');
  if (value.schemaVersion !== 1) {
    throw new TemplateDependencyPolicyError('Template dependency policy schemaVersion must be 1.');
  }
  if (!Array.isArray(value.exceptions)) {
    throw new TemplateDependencyPolicyError('Template dependency policy exceptions must be an array.');
  }

  const inventoryPaths = new Set(inventory.map((entry) => stablePath(entry.pathParts)));
  const keys = new Set();
  const exceptions = value.exceptions.map((entry, index) => {
    const label = `exceptions[${index}]`;
    if (!isRecord(entry)) {
      throw new TemplateDependencyPolicyError(`${label} must be an object.`);
    }
    assertAllowedKeys(entry, new Set([
      'advisoryId',
      'package',
      'manifestPathParts',
      'dependencyChains',
      'disposition',
      'rationale',
      'mitigation',
      'owner',
      'reviewedAt',
      'reviewBy',
      'upstreamReference'
    ]), label);

    const advisoryId = requiredString(entry, 'advisoryId', label).toUpperCase();
    if (!advisoryPattern.test(advisoryId)) {
      throw new TemplateDependencyPolicyError(`${label}.advisoryId must be a GHSA identifier.`);
    }
    const packageName = requiredString(entry, 'package', label);
    const manifestPathParts = requiredStringArray(entry, 'manifestPathParts', label);
    validatePathParts(manifestPathParts, `${label}.manifestPathParts`);
    const manifestPath = stablePath(manifestPathParts);
    if (!inventoryPaths.has(manifestPath)) {
      throw new TemplateDependencyPolicyError(
        `${label}.manifestPathParts is not in the packaged lockfile inventory: ${manifestPath}.`
      );
    }
    const dependencyChains = requiredDependencyChains(entry, 'dependencyChains', label);
    for (const [chainIndex, dependencyChain] of dependencyChains.entries()) {
      if (dependencyChain.at(-1) !== packageName) {
        throw new TemplateDependencyPolicyError(
          `${label}.dependencyChains[${chainIndex}] must end with the affected package ${packageName}.`
        );
      }
    }
    const disposition = requiredString(entry, 'disposition', label);
    if (!allowedDispositions.has(disposition)) {
      throw new TemplateDependencyPolicyError(
        `${label}.disposition must be one of ${[...allowedDispositions].join(', ')}.`
      );
    }
    const rationale = requiredString(entry, 'rationale', label);
    const mitigation = requiredString(entry, 'mitigation', label);
    const owner = requiredString(entry, 'owner', label);
    const reviewedAt = requiredString(entry, 'reviewedAt', label);
    const reviewBy = requiredString(entry, 'reviewBy', label);
    const reviewedAtTimestamp = parseIsoDate(reviewedAt, `${label}.reviewedAt`);
    const reviewByTimestamp = parseIsoDate(reviewBy, `${label}.reviewBy`);
    if (reviewByTimestamp < reviewedAtTimestamp) {
      throw new TemplateDependencyPolicyError(
        `${label}.reviewBy must not be earlier than reviewedAt.`
      );
    }
    let upstreamReference;
    if (entry.upstreamReference !== undefined) {
      upstreamReference = requiredString(entry, 'upstreamReference', label);
      let url;
      try {
        url = new URL(upstreamReference);
      } catch {
        throw new TemplateDependencyPolicyError(
          `${label}.upstreamReference must be an absolute HTTPS URL.`
        );
      }
      if (url.protocol !== 'https:') {
        throw new TemplateDependencyPolicyError(
          `${label}.upstreamReference must be an absolute HTTPS URL.`
        );
      }
    }

    const key = exceptionKey(manifestPathParts, advisoryId, packageName);
    if (keys.has(key)) {
      throw new TemplateDependencyPolicyError(
        `${label} duplicates ${advisoryId} for ${packageName} in ${manifestPath}.`
      );
    }
    keys.add(key);

    return {
      advisoryId,
      package: packageName,
      manifestPathParts,
      dependencyChains,
      disposition,
      rationale,
      mitigation,
      owner,
      reviewedAt,
      reviewBy,
      ...(upstreamReference ? { upstreamReference } : {})
    };
  });

  return { schemaVersion: 1, exceptions };
}

function dependencyChainsFor(name, vulnerabilities, stack = new Set()) {
  if (stack.has(name)) {
    return [];
  }
  const vulnerability = vulnerabilities[name];
  if (!isRecord(vulnerability)) {
    return [[name]];
  }
  const directChains = vulnerability.isDirect === true ? [[name]] : [];
  const parents = Array.isArray(vulnerability.effects)
    ? vulnerability.effects.filter((entry) => typeof entry === 'string' && isRecord(vulnerabilities[entry]))
    : [];
  if (parents.length === 0) {
    return directChains.length > 0 ? directChains : [[name]];
  }

  const nextStack = new Set(stack);
  nextStack.add(name);
  return [
    ...directChains,
    ...parents.flatMap((parent) =>
      dependencyChainsFor(parent, vulnerabilities, nextStack).map((chain) => [...chain, name])
    )
  ];
}

function uniqueDependencyChains(chains) {
  const byValue = new Map();
  for (const chain of chains) {
    byValue.set(dependencyChainKey(chain), chain);
  }
  return [...byValue.values()].sort(compareDependencyChains);
}

function advisoryIdFromUrl(url) {
  if (typeof url !== 'string') {
    return undefined;
  }
  return url.match(/GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i)?.[0]?.toUpperCase();
}

export function normalizeNpmAuditReport(entry, auditReport) {
  if (!isRecord(auditReport) || auditReport.auditReportVersion !== 2) {
    throw new TemplateDependencyAuditError(
      `${entry.label} returned an unsupported npm audit report.`
    );
  }
  if (!isRecord(auditReport.vulnerabilities)) {
    throw new TemplateDependencyAuditError(
      `${entry.label} npm audit report does not contain a vulnerabilities object.`
    );
  }
  const vulnerabilityMetadata = isRecord(auditReport.metadata)
    ? auditReport.metadata.vulnerabilities
    : undefined;
  if (
    !isRecord(vulnerabilityMetadata) ||
    !Number.isSafeInteger(vulnerabilityMetadata.total) ||
    vulnerabilityMetadata.total < 0
  ) {
    throw new TemplateDependencyAuditError(
      `${entry.label} npm audit report does not contain a valid vulnerability total.`
    );
  }
  const vulnerabilityCount = Object.keys(auditReport.vulnerabilities).length;
  if (vulnerabilityMetadata.total !== vulnerabilityCount) {
    throw new TemplateDependencyAuditError(
      `${entry.label} npm audit report claims ${vulnerabilityMetadata.total} vulnerabilities but contains ${vulnerabilityCount} records.`
    );
  }

  for (const [name, vulnerability] of Object.entries(auditReport.vulnerabilities)) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit vulnerability ${name} has an unsupported shape.`
      );
    }
    if (typeof vulnerability.isDirect !== 'boolean') {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit vulnerability ${name} does not declare whether it is direct.`
      );
    }
    if (
      !Array.isArray(vulnerability.effects) ||
      vulnerability.effects.some((effect) => typeof effect !== 'string')
    ) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit vulnerability ${name} has unsupported effects.`
      );
    }
    if (
      !Array.isArray(vulnerability.nodes) ||
      vulnerability.nodes.some((node) => typeof node !== 'string')
    ) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit vulnerability ${name} has unsupported affected nodes.`
      );
    }
    for (const reference of vulnerability.via) {
      if (typeof reference === 'string') {
        if (!isRecord(auditReport.vulnerabilities[reference])) {
          throw new TemplateDependencyAuditError(
            `${entry.label} npm audit vulnerability ${name} references unknown vulnerability ${reference}.`
          );
        }
      } else if (!isRecord(reference)) {
        throw new TemplateDependencyAuditError(
          `${entry.label} npm audit vulnerability ${name} has an unsupported via entry.`
        );
      }
    }
    for (const effect of vulnerability.effects) {
      if (!isRecord(auditReport.vulnerabilities[effect])) {
        throw new TemplateDependencyAuditError(
          `${entry.label} npm audit vulnerability ${name} references unknown parent ${effect}.`
        );
      }
    }
  }

  const validatedDependencyPaths = new Set();
  function assertDirectDependencyPaths(name, stack = new Set()) {
    if (validatedDependencyPaths.has(name)) {
      return;
    }
    if (stack.has(name)) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit dependency graph contains a cycle through ${name}.`
      );
    }
    const vulnerability = auditReport.vulnerabilities[name];
    if (vulnerability.isDirect !== true && vulnerability.effects.length === 0) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit vulnerability ${name} does not reach a direct dependency.`
      );
    }
    const nextStack = new Set(stack);
    nextStack.add(name);
    for (const parent of vulnerability.effects) {
      assertDirectDependencyPaths(parent, nextStack);
    }
    validatedDependencyPaths.add(name);
  }

  for (const name of Object.keys(auditReport.vulnerabilities)) {
    assertDirectDependencyPaths(name);
  }

  function hasAdvisoryPath(name, stack = new Set()) {
    if (stack.has(name)) {
      return false;
    }
    const vulnerability = auditReport.vulnerabilities[name];
    const nextStack = new Set(stack);
    nextStack.add(name);
    return vulnerability.via.some((reference) =>
      isRecord(reference) ||
      hasAdvisoryPath(reference, nextStack)
    );
  }

  for (const name of Object.keys(auditReport.vulnerabilities)) {
    if (!hasAdvisoryPath(name)) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit vulnerability ${name} has no resolvable advisory record.`
      );
    }
  }

  const findings = new Map();
  for (const [vulnerabilityName, vulnerability] of Object.entries(auditReport.vulnerabilities)) {
    const dependencyChains = uniqueDependencyChains(
      dependencyChainsFor(vulnerabilityName, auditReport.vulnerabilities)
    );
    const affectedNodes = Array.isArray(vulnerability.nodes)
      ? [...new Set(vulnerability.nodes.filter((node) => typeof node === 'string'))].sort()
      : [];

    for (const advisory of vulnerability.via) {
      if (!isRecord(advisory)) {
        continue;
      }
      const advisoryId = advisoryIdFromUrl(advisory.url);
      if (!advisoryId) {
        const identifier = advisory.source ?? advisory.title ?? 'unknown';
        throw new TemplateDependencyAuditError(
          `${entry.label} npm audit advisory ${JSON.stringify(identifier)} has no GHSA identifier.`
        );
      }
      const packageName = typeof advisory.dependency === 'string'
        ? advisory.dependency
        : vulnerabilityName;
      const severity = typeof advisory.severity === 'string'
        ? advisory.severity.toLowerCase()
        : typeof vulnerability.severity === 'string'
          ? vulnerability.severity.toLowerCase()
          : 'unknown';
      const key = [
        entry.id,
        advisoryId,
        packageName,
        affectedNodes.join('\0')
      ].join('\0');
      findings.set(key, {
        manifestId: entry.id,
        manifestLabel: entry.label,
        manifestPathParts: [...entry.pathParts],
        manifestPath: stablePath(entry.pathParts),
        advisoryId,
        package: packageName,
        severity,
        title: typeof advisory.title === 'string' ? advisory.title : advisoryId,
        url: typeof advisory.url === 'string' ? advisory.url : undefined,
        vulnerableRange: typeof advisory.range === 'string' ? advisory.range : undefined,
        affectedNodes,
        dependencyChains
      });
    }
  }

  return [...findings.values()].sort((left, right) =>
    left.manifestPath.localeCompare(right.manifestPath) ||
    left.advisoryId.localeCompare(right.advisoryId) ||
    left.package.localeCompare(right.package)
  );
}

function dateOnlyTimestamp(value) {
  if (value instanceof Date) {
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  return parseIsoDate(value, 'evaluation date');
}

function reviewWindowForSeverity(severity) {
  return severity === 'moderate' || severity === 'low' || severity === 'info' ? 90 : 30;
}

function dependencyChainSetsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const rightKeys = new Set(right.map(dependencyChainKey));
  return left.every((chain) => rightKeys.has(dependencyChainKey(chain)));
}

function formatDependencyChains(chains) {
  return chains.length > 0
    ? chains.map((chain) => chain.join(' -> ')).join(' | ')
    : '(none reported)';
}

function formatAffectedNodes(nodes) {
  return nodes.length > 0 ? nodes.join(', ') : '(none reported)';
}

export function evaluateTemplateDependencyAudits({
  auditResults,
  policy,
  today = new Date(),
  resolvedAdvisories = resolvedTemplateAdvisories,
  sets
}) {
  if (!Array.isArray(sets)) {
    throw new TypeError('sets must be an array of template dependency sets.');
  }
  for (const set of sets) {
    if (
      set.audit.mode === 'npm-audit' &&
      !auditResults.some(({ entry }) => entry.id === set.audit.inventoryId)
    ) {
      throw new TemplateDependencyPolicyError(
        `Template dependency set ${set.id} has no npm audit result for ${set.audit.inventoryId}.`
      );
    }
  }
  const unaudited = Object.freeze(sets
    .filter((set) => set.audit.mode === 'unaudited')
    .map((set) => Object.freeze({ id: set.id, ecosystem: set.ecosystem, reason: set.audit.reason })));
  const findings = auditResults.flatMap(({ entry, auditReport }) =>
    normalizeNpmAuditReport(entry, auditReport)
  );
  const findingByKey = new Map(findings.map((finding) => [findingKey(finding), finding]));
  const exceptionByKey = new Map(
    policy.exceptions.map((entry) => [
      exceptionKey(entry.manifestPathParts, entry.advisoryId, entry.package),
      entry
    ])
  );
  const evaluationDate = dateOnlyTimestamp(today);
  const reviewed = [];
  const issues = [];

  for (const finding of findings) {
    const key = findingKey(finding);
    const exception = exceptionByKey.get(key);
    if (!exception) {
      issues.push({
        code: 'unreviewed-finding',
        message: `${finding.advisoryId} for ${finding.package} in ${finding.manifestPath} is unreviewed; severity ${finding.severity}; affected nodes ${formatAffectedNodes(finding.affectedNodes)}; dependency chains ${formatDependencyChains(finding.dependencyChains)}.`,
        finding
      });
      continue;
    }

    if (!dependencyChainSetsEqual(finding.dependencyChains, exception.dependencyChains)) {
      issues.push({
        code: 'dependency-chain-mismatch',
        message: `${finding.advisoryId} for ${finding.package} no longer matches its reviewed dependency-chain set; reviewed ${formatDependencyChains(exception.dependencyChains)}; reported ${formatDependencyChains(finding.dependencyChains)}.`,
        finding,
        exception
      });
      continue;
    }

    const reviewedAt = parseIsoDate(exception.reviewedAt, 'reviewedAt');
    const reviewBy = parseIsoDate(exception.reviewBy, 'reviewBy');
    const windowDays = (reviewBy - reviewedAt) / millisecondsPerDay;
    const maximumDays = reviewWindowForSeverity(finding.severity);
    if (windowDays > maximumDays) {
      issues.push({
        code: 'overlong-exception',
        message: `${finding.advisoryId} review window is ${windowDays} days; ${finding.severity} findings allow at most ${maximumDays}.`,
        finding,
        exception
      });
      continue;
    }
    if (reviewedAt > evaluationDate) {
      issues.push({
        code: 'future-review',
        message: `${finding.advisoryId} was reviewed after the evaluation date.`,
        finding,
        exception
      });
      continue;
    }
    if (reviewBy < evaluationDate) {
      issues.push({
        code: 'expired-exception',
        message: `${finding.advisoryId} exception owned by ${exception.owner} expired on ${exception.reviewBy}.`,
        finding,
        exception
      });
      continue;
    }
    reviewed.push({ finding, exception });
  }

  for (const exception of policy.exceptions) {
    const key = exceptionKey(
      exception.manifestPathParts,
      exception.advisoryId,
      exception.package
    );
    if (!findingByKey.has(key)) {
      issues.push({
        code: 'stale-exception',
        message: `${exception.advisoryId} for ${exception.package} in ${stablePath(exception.manifestPathParts)} is no longer reported.`,
        exception
      });
    }
  }

  const currentResolvedKeys = new Set(
    findings.map((finding) =>
      resolvedAdvisoryKey({
        manifestId: finding.manifestId,
        advisoryId: finding.advisoryId,
        package: finding.package
      })
    )
  );
  const fixed = resolvedAdvisories.filter(
    (entry) => !currentResolvedKeys.has(resolvedAdvisoryKey(entry))
  );
  const clean = auditResults
    .filter(({ entry }) => !findings.some((finding) => finding.manifestId === entry.id))
    .map(({ entry }) => entry);

  return {
    ok: issues.length === 0,
    audited: auditResults.length,
    findings,
    fixed,
    reviewed,
    clean,
    unaudited,
    issues
  };
}

export function formatTemplateDependencyAudit(result) {
  const lines = [
    `Template dependency audit: ${result.ok ? 'PASS' : 'FAIL'}`,
    `Audited ${result.audited} templates: ${result.fixed.length} fixed, ${result.reviewed.length} reviewed, ${result.clean.length} clean, ${result.issues.length} issues.`
  ];

  for (const fixed of result.fixed) {
    lines.push(
      `[fixed] ${fixed.manifestId}: ${fixed.advisoryId} (${fixed.package})`
    );
  }
  for (const { finding, exception } of result.reviewed) {
    lines.push(
      `[reviewed] ${finding.manifestPath}: ${finding.advisoryId} (${finding.package}, ${finding.severity}) until ${exception.reviewBy}; chains ${formatDependencyChains(exception.dependencyChains)}`
    );
  }
  for (const entry of result.clean) {
    lines.push(`[clean] ${entry.stablePath ?? stablePath(entry.pathParts)}`);
  }
  for (const entry of result.unaudited) {
    lines.push(`[not audited] ${entry.id} (${entry.ecosystem}): ${entry.reason}`);
  }
  for (const issue of result.issues) {
    lines.push(`[${issue.code}] ${issue.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatTemplateDependencyAuditMarkdown(result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  const lines = [
    `## Template dependency audit: ${status}`,
    '',
    `| Audited | Fixed | Reviewed | Clean | Issues |`,
    `| ---: | ---: | ---: | ---: | ---: |`,
    `| ${result.audited} | ${result.fixed.length} | ${result.reviewed.length} | ${result.clean.length} | ${result.issues.length} |`
  ];
  if (result.issues.length > 0) {
    lines.push('', '### Issues', '');
    for (const issue of result.issues) {
      lines.push(`- **${issue.code}**: ${issue.message}`);
    }
  }
  if (result.reviewed.length > 0) {
    lines.push('', '### Reviewed exceptions', '');
    for (const { finding, exception } of result.reviewed) {
      lines.push(
        `- \`${finding.advisoryId}\` in \`${finding.manifestPath}\` — severity ${finding.severity}, ${exception.disposition}, review by ${exception.reviewBy}; affected nodes: ${formatAffectedNodes(finding.affectedNodes)}; dependency chains: ${formatDependencyChains(exception.dependencyChains)}.`
      );
    }
  }
  if (result.unaudited.length > 0) {
    lines.push('', '### Not audited', '');
    for (const entry of result.unaudited) {
      lines.push(`- \`${entry.id}\` (${entry.ecosystem}): ${entry.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function parseNpmAuditCommandResult(entry, commandResult) {
  if (commandResult.errorMessage) {
    throw new TemplateDependencyAuditError(
      `${entry.label} npm audit could not start: ${commandResult.errorMessage}`
    );
  }
  if (commandResult.timedOut) {
    throw new TemplateDependencyAuditError(`${entry.label} npm audit timed out.`);
  }
  if (commandResult.status !== 0 && commandResult.status !== 1) {
    const detail = commandResult.stderr?.trim().split(/\r?\n/, 1)[0];
    throw new TemplateDependencyAuditError(
      `${entry.label} npm audit failed with exit code ${commandResult.status}${detail ? `: ${detail}` : '.'}`
    );
  }
  let auditReport;
  try {
    auditReport = JSON.parse(commandResult.stdout);
  } catch (error) {
    throw new TemplateDependencyAuditError(
      `${entry.label} npm audit returned malformed JSON: ${error.message}`
    );
  }
  if (!isRecord(auditReport) || auditReport.auditReportVersion !== 2) {
    const detail = isRecord(auditReport)
      ? [
          auditReport.message,
          isRecord(auditReport.error) ? auditReport.error.summary : undefined,
          isRecord(auditReport.error) ? auditReport.error.message : undefined
        ].find((value) => typeof value === 'string' && value.trim() !== '')
      : undefined;
    throw new TemplateDependencyAuditError(
      `${entry.label} npm audit returned an unsupported response${detail ? `: ${detail}` : '.'}`
    );
  }
  return auditReport;
}

export async function auditTemplateDependencyInventory({
  repositoryRoot,
  inventory = templateDependencyInventory,
  structure,
  runAudit
}) {
  if (typeof runAudit !== 'function') {
    throw new TypeError('runAudit must be a function.');
  }
  await validateTemplateDependencyStructure({ repositoryRoot, inventory, structure });
  const resolvedInventory = await validateTemplateDependencyInventory(
    repositoryRoot,
    inventory
  );
  const auditResults = [];

  for (const entry of resolvedInventory) {
    const nodeModulesPath = path.join(entry.directory, 'node_modules');
    const [packageBefore, lockBefore, nodeModulesExisted] = await Promise.all([
      readFile(entry.packagePath),
      readFile(entry.lockPath),
      pathExists(nodeModulesPath)
    ]);
    const commandResult = await runAudit(entry);
    const auditReport = parseNpmAuditCommandResult(entry, commandResult);
    const [packageAfter, lockAfter, nodeModulesExistsAfter] = await Promise.all([
      readFile(entry.packagePath),
      readFile(entry.lockPath),
      pathExists(nodeModulesPath)
    ]);

    if (!packageBefore.equals(packageAfter) || !lockBefore.equals(lockAfter)) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit modified package metadata.`
      );
    }
    if (!nodeModulesExisted && nodeModulesExistsAfter) {
      throw new TemplateDependencyAuditError(
        `${entry.label} npm audit created node_modules.`
      );
    }
    auditResults.push({ entry, auditReport });
  }

  return auditResults;
}

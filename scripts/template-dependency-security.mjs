import { readFileSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const canonicalNpmRegistry = 'https://registry.npmjs.org';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const supportedStack = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'assets', 'supported-stack.json'), 'utf8')
);
const powerAppsCommit = supportedStack.upstreams['power-apps-code-app'].commit;

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
    pathParts: Object.freeze(['assets', 'locks', 'node-backend', 'package-lock.json'])
  }),
  Object.freeze({
    id: 'standard-frontend',
    label: 'Standard frontend',
    pathParts: Object.freeze(['assets', 'locks', 'frontend', 'package-lock.json'])
  }),
  Object.freeze({
    id: 'power-apps-code-app',
    label: 'Power Apps code app starter',
    pathParts: Object.freeze([
      'assets',
      'power-apps-code-app',
      powerAppsCommit,
      'starter',
      'package-lock.json'
    ])
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
  resolvedAdvisories = resolvedTemplateAdvisories
}) {
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
  runAudit
}) {
  if (typeof runAudit !== 'function') {
    throw new TypeError('runAudit must be a function.');
  }
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

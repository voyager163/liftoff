// Shared contract for the packed and installed package checks in scripts/package-smoke-test.mjs.
// It is importable so the same lists and decisions run in offline tests. Importing it only loads
// modules; the installed-package checks read files when they are called.
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { builtinAssets } from '../src/plugins/builtin/assets.ts';

export const maximumUnpackedPackageBytes = 12 * 1024 * 1024;

export function assertUnpackedPackageSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError('Packed package unpacked size must be a non-negative safe integer.');
  }
  if (bytes > maximumUnpackedPackageBytes) {
    throw new Error(`Packed package unexpectedly exceeds the 12 MiB unpacked-size budget: ${bytes}`);
  }
}

// Core ancillary assets the package must always contain. The list is independent of package.json
// files, so a path omitted from both the declaration and the pack still fails.
export const requiredAncillaryAssets = Object.freeze([
  'assets/governance/modern/source-contracts.json',
  'assets/governance/single-maintainer-gitflow/activation-v2-graph.json',
  'assets/governance/single-maintainer-gitflow/activation-v3-graph.json',
  'assets/governance/single-maintainer-gitflow/assessment-controls.json',
  'assets/governance/single-maintainer-gitflow/policy-v7.md',
  'assets/governance/single-maintainer-gitflow/policy.md',
  'assets/governance/team-gitflow/policy-v1.md',
  'assets/repair/windows-job-controller.ps1',
  'assets/skills/governance-assessment.md',
  'assets/skills/repair.md',
  'assets/skills/setup.md',
  'assets/supported-stack.json'
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The template assets declared in C1 plus the core ancillary assets, sorted. */
export const requiredPackagedAssets = Object.freeze([
  ...builtinAssets.map((asset) => asset.pathParts.join('/')),
  ...requiredAncillaryAssets
].sort(compareText));

const assetIssueCodes = Object.freeze([
  'invalid-asset-entry',
  'duplicate-asset-entry',
  'directory-asset-entry',
  'declared-asset-not-packed',
  'unexpected-declared-asset',
  'duplicate-packaged-asset',
  'undeclared-packaged-asset',
  'required-asset-not-packed'
]);
const planIssueCodes = Object.freeze([
  'plan-output-malformed',
  'plan-decision-mismatch',
  'plan-artifact-missing',
  'plan-artifact-path-mismatch',
  'plan-excluded-artifact-present'
]);
const patternCharacters = /[*?[\]{}()!+@]/;
const canonicalSegment = /^[A-Za-z0-9._-]+$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function strippedEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^(?:!|\.\/|\/)+/, '');
}

// Portable aliases of the asset root (ASSETS/, Assets/ and similar) are admitted into validation so
// that they are rejected; only the exact lower-case root can form an accepted asset path.
function hasAssetRoot(value) {
  return value.split('/')[0].normalize('NFKC').toLowerCase() === 'assets';
}

function affectsAssets(entry) {
  if (typeof entry !== 'string' || patternCharacters.test(entry)) {
    return true;
  }
  return hasAssetRoot(strippedEntry(entry));
}

function isCanonicalAssetPath(entry) {
  if (entry !== strippedEntry(entry) || patternCharacters.test(entry) || entry.endsWith('/')) {
    return false;
  }
  const segments = entry.split('/');
  return segments[0] === 'assets' && segments.every((segment) =>
    segment !== '.' && segment !== '..' && canonicalSegment.test(segment)
  );
}

function aliasKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function sortedIssues(issues, codes, subjectKey) {
  return Object.freeze(issues
    .sort((left, right) =>
      codes.indexOf(left.code) - codes.indexOf(right.code) ||
      compareText(left[subjectKey], right[subjectKey]) ||
      compareText(left.detail ?? '', right.detail ?? ''))
    .map((issue) => Object.freeze(issue)));
}

/**
 * Compares the packed file list with the package.json files declarations and the required asset
 * list. Pure: it never reads the filesystem. Data problems are returned as sorted issues; only a
 * malformed argument throws. Whether an entry is a file or a directory is decided from the pack
 * list, never from its name.
 */
export function packagedAssetIssues({ packedPaths, declaredFiles }) {
  if (!Array.isArray(packedPaths) || !Array.isArray(declaredFiles)) {
    throw new TypeError('packedPaths and declaredFiles must be arrays.');
  }
  if (!isStringList(packedPaths)) {
    throw new TypeError('packedPaths must contain only strings.');
  }
  const issues = [];
  const report = (code, entryPath, detail) => {
    issues.push({ code, path: entryPath, detail });
  };
  const packed = new Set(packedPaths);
  const required = new Set(requiredPackagedAssets);
  const exact = new Set();
  const declaredAliases = new Set();
  for (const entry of declaredFiles) {
    if (!affectsAssets(entry)) {
      continue;
    }
    if (typeof entry !== 'string' || !isCanonicalAssetPath(entry)) {
      report(
        'invalid-asset-entry',
        typeof entry === 'string' ? entry : `<${entry === null ? 'null' : typeof entry}>`,
        'asset entries must be exact canonical paths without patterns'
      );
      continue;
    }
    const alias = aliasKey(entry);
    if (declaredAliases.has(alias)) {
      report('duplicate-asset-entry', entry, 'repeats an earlier asset entry');
      continue;
    }
    declaredAliases.add(alias);
    if (packed.has(entry)) {
      exact.add(entry);
      if (!required.has(entry)) {
        report('unexpected-declared-asset', entry, 'is not a required template or core ancillary asset');
      }
      continue;
    }
    const below = packedPaths.filter((packedPath) => packedPath.startsWith(`${entry}/`)).length;
    if (below > 0) {
      report('directory-asset-entry', entry, `packs ${below} files as a directory`);
    } else {
      report('declared-asset-not-packed', entry, 'is declared but absent from the pack');
    }
  }
  const packedAliases = new Set();
  // Exact-root paths are registered first, so a root alias is the reported duplicate in any order.
  const packedAssets = [
    ...packedPaths.filter((packedPath) => hasAssetRoot(packedPath) && packedPath.split('/')[0] === 'assets'),
    ...packedPaths.filter((packedPath) => hasAssetRoot(packedPath) && packedPath.split('/')[0] !== 'assets')
  ];
  for (const packedPath of packedAssets) {
    const alias = aliasKey(packedPath);
    if (packedAliases.has(alias)) {
      report('duplicate-packaged-asset', packedPath, 'repeats an earlier packed asset path');
      continue;
    }
    packedAliases.add(alias);
    if (!exact.has(packedPath)) {
      report('undeclared-packaged-asset', packedPath, 'is packed without an exact files entry');
    }
  }
  for (const requiredPath of requiredPackagedAssets) {
    if (!packed.has(requiredPath)) {
      report('required-asset-not-packed', requiredPath, 'required asset is absent from the pack');
    }
  }
  return sortedIssues(issues, assetIssueCodes, 'path');
}

function assertAbsoluteRoot(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path.`);
  }
}

/**
 * Compares every required asset in an installed package with the checkout bytes, without decoding
 * them. Links are followed, matching the trusted package-manager layout. Only a missing installed
 * file becomes an issue; every other error, including a missing checkout file, propagates.
 */
export async function installedAssetByteIssues({ installedRoot, sourceRoot }) {
  assertAbsoluteRoot(installedRoot, 'installedRoot');
  assertAbsoluteRoot(sourceRoot, 'sourceRoot');
  for (const assetPath of requiredPackagedAssets) {
    if (typeof assetPath !== 'string' || !isCanonicalAssetPath(assetPath)) {
      throw new TypeError(`Required asset path is not canonical: ${typeof assetPath === 'string' ? assetPath : typeof assetPath}`);
    }
  }
  const issues = [];
  for (const assetPath of requiredPackagedAssets) {
    const parts = assetPath.split('/');
    const expected = await readFile(path.join(sourceRoot, ...parts));
    let actual;
    try {
      actual = await readFile(path.join(installedRoot, ...parts));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        issues.push(Object.freeze({ code: 'missing-installed-asset', path: assetPath, detail: 'is absent from the installed package' }));
        continue;
      }
      throw error;
    }
    if (!actual.equals(expected)) {
      issues.push(Object.freeze({
        code: 'installed-asset-bytes-differ',
        path: assetPath,
        detail: `installed ${actual.length} bytes differ from the ${expected.length} checkout bytes`
      }));
    }
  }
  return Object.freeze(issues);
}

/** The retained, unowned assets/locks root must never be installed. */
export async function installedRetainedAssetIssues({ installedRoot }) {
  assertAbsoluteRoot(installedRoot, 'installedRoot');
  try {
    await lstat(path.join(installedRoot, 'assets', 'locks'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return Object.freeze([]);
    }
    throw error;
  }
  return Object.freeze([Object.freeze({
    code: 'retained-asset-installed',
    path: 'assets/locks',
    detail: 'the retained repository-only asset root is installed'
  })]);
}

function frozenCase(value) {
  return Object.freeze({
    ...value,
    args: Object.freeze([...value.args]),
    decisions: Object.freeze({ ...value.decisions }),
    artifacts: Object.freeze({ ...value.artifacts }),
    excludedPathPrefixes: Object.freeze([...value.excludedPathPrefixes])
  });
}

const commonDecisions = {
  Cloud: 'Azure',
  Region: 'East US / eastus',
  'Coding agents': 'GitHub Copilot'
};
const standardDecisions = {
  ...commonDecisions,
  'Project type': 'Standard application',
  'Spec workflow': 'OpenSpec'
};
const opentofuArtifacts = {
  'opentofu-application-versions': 'infrastructure/opentofu/azure/modules/application/versions.tf',
  'opentofu-dev-versions': 'infrastructure/opentofu/azure/environments/dev/versions.tf',
  'opentofu-dev-provider-lock': 'infrastructure/opentofu/azure/environments/dev/.terraform.lock.hcl'
};
const nodeArtifacts = {
  'node-backend-package': 'backend/package.json',
  'node-backend-lock': 'backend/package-lock.json'
};
const pythonArtifacts = {
  'backend-pyproject': 'backend/pyproject.toml',
  'backend-uv-lock': 'backend/uv.lock'
};
const frontendArtifacts = {
  'frontend-package': 'frontend/package.json',
  'frontend-lock': 'frontend/package-lock.json'
};
const standardArgs = (api, frontend) => [
  '--no-genai', '--api', api, '--cloud', 'azure', '--region', 'eastus',
  '--spec', 'openspec', '--agents', 'copilot', frontend ? '--frontend' : '--no-frontend'
];

/**
 * Installed `liftoff plan` contracts: exact arguments, the working directory (relative to the
 * smoke root), exact decisions, representative artifact rows and excluded path prefixes.
 */
export const installedPlanCases = Object.freeze([
  frozenCase({
    id: 'node-api',
    directory: 'outside',
    args: standardArgs('node', false),
    decisions: { ...standardDecisions, 'API stack': 'Node.js / Fastify / TypeScript', Frontend: 'Not generated' },
    artifacts: { ...nodeArtifacts, ...opentofuArtifacts },
    excludedPathPrefixes: ['frontend/']
  }),
  frozenCase({
    id: 'node-api-frontend',
    directory: 'outside with spaces',
    args: standardArgs('node', true),
    decisions: {
      ...standardDecisions,
      'API stack': 'Node.js / Fastify / TypeScript',
      Frontend: 'Vue 3 + Tailwind (API starter)'
    },
    artifacts: { ...nodeArtifacts, ...frontendArtifacts, ...opentofuArtifacts },
    excludedPathPrefixes: []
  }),
  frozenCase({
    id: 'python-api',
    directory: 'outside with spaces',
    args: standardArgs('python', false),
    decisions: { ...standardDecisions, 'API stack': 'Python / FastAPI', Frontend: 'Not generated' },
    artifacts: { ...pythonArtifacts, ...opentofuArtifacts },
    excludedPathPrefixes: ['frontend/']
  }),
  frozenCase({
    id: 'go-api',
    directory: 'outside with spaces',
    args: standardArgs('go', false),
    decisions: { ...standardDecisions, 'API stack': 'Go / Huma / Chi', Frontend: 'Not generated' },
    artifacts: {
      'go-backend-module': 'backend/go.mod',
      'go-backend-checksums': 'backend/go.sum',
      ...opentofuArtifacts
    },
    excludedPathPrefixes: ['frontend/']
  }),
  frozenCase({
    id: 'genai-rag',
    directory: 'outside with spaces',
    args: [
      '--pattern', 'rag', '--cloud', 'azure', '--region', 'eastus',
      '--spec', 'spec-kit', '--agents', 'copilot', '--frontend'
    ],
    decisions: {
      ...commonDecisions,
      'Project type': 'GenAI application',
      Pattern: 'RAG (Knowledge Retrieval) (foundation)',
      Frontend: 'Vue 3 + Tailwind (RAG foundation interface)',
      'Spec workflow': 'Spec Kit'
    },
    artifacts: {
      ...pythonArtifacts,
      'function-worker-requirements': 'functions/rag-worker/requirements.txt',
      ...frontendArtifacts,
      ...opentofuArtifacts
    },
    excludedPathPrefixes: []
  }),
  frozenCase({
    id: 'manual-cli-only',
    directory: 'outside with spaces',
    args: [
      '--type', 'standard', '--api', 'go', '--cloud', 'azure', '--region', 'eastus',
      '--spec', 'manual', '--agents', 'none', '--no-frontend', '--governance', 'none'
    ],
    decisions: {
      ...commonDecisions, 'Project type': 'Standard application',
      'API stack': 'Go / Huma / Chi', 'Spec workflow': 'Manual',
      'Coding agents': 'None (CLI only)', Frontend: 'Not generated'
    },
    artifacts: {
      'go-backend-module': 'backend/go.mod',
      'go-backend-checksums': 'backend/go.sum',
      ...opentofuArtifacts
    },
    excludedPathPrefixes: [
      'frontend/', 'openspec/', '.specify/', '.claude/', '.agents/',
      '.github/prompts/', '.github/skills/', '.liftoff/governance/'
    ]
  })
]);

const artifactHeadingPattern = /^Artifacts \((\d+)\)$/;
const artifactRowPattern = /^Artifact: (\S+) \| Lifecycle: ([^|]+) \| Path: (\S+)$/;

function lineIndexes(lines, predicate) {
  return lines.flatMap((line, index) => (predicate(line) ? [index] : []));
}

/**
 * Checks plain-layout `liftoff plan` output against one installed plan case. Pure: it returns
 * sorted issues and throws only for a non-string output or a malformed case.
 */
export function planContractIssues(stdout, planCase) {
  if (typeof stdout !== 'string') {
    throw new TypeError('stdout must be a string.');
  }
  const stringValues = (value) => isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
  if (
    !isRecord(planCase) ||
    typeof planCase.id !== 'string' ||
    !stringValues(planCase.decisions) ||
    !stringValues(planCase.artifacts) ||
    !isStringList(planCase.excludedPathPrefixes)
  ) {
    throw new TypeError('planCase must provide an id, decisions, artifacts and excludedPathPrefixes.');
  }
  const issues = [];
  const report = (code, subject, detail) => {
    issues.push({ code, subject, detail });
  };
  const lines = stdout.split(/\r?\n/);
  const decisionHeadings = lineIndexes(lines, (line) => line === 'Project decisions');
  const artifactHeadings = lineIndexes(lines, (line) => artifactHeadingPattern.test(line));
  const requirementHeadings = lineIndexes(lines, (line) => line === 'Workstation requirements');
  if (decisionHeadings.length !== 1) {
    report('plan-output-malformed', 'Project decisions', `found ${decisionHeadings.length} headings; expected 1`);
  }
  if (artifactHeadings.length !== 1) {
    report('plan-output-malformed', 'Artifacts', `found ${artifactHeadings.length} headings; expected 1`);
  }
  if (
    requirementHeadings.length !== 1 ||
    (artifactHeadings.length === 1 && requirementHeadings[0] < artifactHeadings[0])
  ) {
    report('plan-output-malformed', 'Workstation requirements', 'expected one heading after the artifacts');
  }
  if (issues.length > 0) {
    return sortedIssues(issues, planIssueCodes, 'subject');
  }

  const decisions = new Map();
  for (let index = decisionHeadings[0] + 1; index < lines.length && lines[index] !== ''; index += 1) {
    const separator = lines[index].indexOf(': ');
    if (separator <= 0) {
      report('plan-output-malformed', 'Project decisions', `line ${index + 1} is not "Label: value"`);
      continue;
    }
    const label = lines[index].slice(0, separator);
    if (decisions.has(label)) {
      report('plan-output-malformed', 'Project decisions', `label ${label} repeats`);
      continue;
    }
    decisions.set(label, lines[index].slice(separator + 2));
  }

  const heading = artifactHeadings[0];
  const count = Number(artifactHeadingPattern.exec(lines[heading])[1]);
  // Bound the count before iterating: overflow (Infinity), unsafe or oversized counts are malformed.
  const linesAfterHeading = lines.length - heading - 1;
  if (!Number.isSafeInteger(count) || count > linesAfterHeading) {
    report(
      'plan-output-malformed',
      'Artifacts',
      `artifact count is not a safe integer within the ${linesAfterHeading} lines after the heading`
    );
    return sortedIssues(issues, planIssueCodes, 'subject');
  }
  const rows = new Map();
  const rowPaths = new Set();
  for (let offset = 1; offset <= count; offset += 1) {
    const match = artifactRowPattern.exec(lines[heading + offset] ?? '');
    if (!match) {
      report('plan-output-malformed', 'Artifacts', `row ${offset} of ${count} is missing or malformed`);
      continue;
    }
    const [, name, , artifactPath] = match;
    if (rows.has(name)) {
      report('plan-output-malformed', 'Artifacts', `artifact ${name} repeats`);
    } else if (rowPaths.has(artifactPath)) {
      report('plan-output-malformed', 'Artifacts', `path ${artifactPath} repeats`);
    } else {
      rows.set(name, artifactPath);
      rowPaths.add(artifactPath);
    }
  }
  if (lines[heading + count + 1] !== '') {
    report('plan-output-malformed', 'Artifacts', `expected exactly ${count} rows followed by a blank line`);
  }

  for (const [label, value] of Object.entries(planCase.decisions)) {
    if (!decisions.has(label)) {
      report('plan-decision-mismatch', label, 'is missing');
    } else if (decisions.get(label) !== value) {
      report('plan-decision-mismatch', label, `expected ${JSON.stringify(value)}; rendered ${JSON.stringify(decisions.get(label))}`);
    }
  }
  for (const [name, artifactPath] of Object.entries(planCase.artifacts)) {
    if (!rows.has(name)) {
      report('plan-artifact-missing', name, `expected at ${artifactPath}`);
    } else if (rows.get(name) !== artifactPath) {
      report('plan-artifact-path-mismatch', name, `expected ${artifactPath}; rendered ${rows.get(name)}`);
    }
  }
  for (const prefix of planCase.excludedPathPrefixes) {
    for (const [name, artifactPath] of rows) {
      if (artifactPath.startsWith(prefix)) {
        report('plan-excluded-artifact-present', name, `${artifactPath} is under ${prefix}`);
      }
    }
  }
  return sortedIssues(issues, planIssueCodes, 'subject');
}

/** One line per issue, for error messages. */
export function formatSmokeIssues(title, issues) {
  return [
    `${title}:`,
    ...issues.map((issue) =>
      `- [${issue.code}] ${issue.path ?? issue.subject}${issue.detail ? `: ${issue.detail}` : ''}`)
  ].join('\n');
}

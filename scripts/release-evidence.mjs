import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { exactKeys, object, requireValue } from './release-evidence-github.mjs';
import { loadTelemetryReleaseContract, TELEMETRY_BASELINE_FIXTURE, TELEMETRY_CONTRACT_PATH } from './release-telemetry-gateway.mjs';
import {
  DocumentationClosureError, isPublicDocumentationFile, MAX_MARKDOWN_BYTES, MAX_MARKDOWN_TOTAL_BYTES,
  REQUIRED_PUBLIC_DOCUMENTS, validateDocumentShippingEntries, verifyPublicMarkdownLinks
} from './distribution/native-document-links.mjs';

export const EVIDENCE_SCHEMA = 1;
export const EVIDENCE_KIND = 'liftoff-coordinated-release-evidence';
export const CANONICAL_PRODUCT_NAME = '@msn-control/liftoff';
export const CANONICAL_NATIVE_PRODUCT = 'liftoff';
export const CANONICAL_REPOSITORY = 'voyager163/liftoff';
export const SCOPE_PATH = 'assets/qualification/release-scope.json';
export const REQUIRED_NATIVE_TARGETS = ['darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'];
const BASELINE_COMMIT = '70d10881b46d873118d825735696f39b6d35ebe0';
const PRODUCTION_GAPS = [
  'bootstrap-workflow-source-ready', 'workflow-source-ready', 'credential-ready', 'provider-ready',
  'state-path-selected', 'existing-private-path', 'bootstrap-local', 'runner-ready', 'private-backend-proof',
  'remote-import-verified', 'application-prerequisites-ready', 'application-artifact-ready', 'application-foundation',
  'dev-proof', 'staging-qualified', 'production-rehearsed', 'green-red-proof', 'rulesets-applied', 'live-readback'
];
export const NATIVE_CHECKS = [
  'host-floor', 'runtime-closure', 'public-entrypoint', 'read-only-relocation', 'project-tool-execution',
  'resource-integrity', 'owner-inspection', 'owner-handover', 'stale-approval', 'partial-failure-recovery',
  'platform-signature'
];
export const HELPER_CHECKS = ['normal-exit', 'failure', 'cancellation', 'process-settlement', 'recovery'];
export const DASHBOARD_CHECKS = [
  'rendered-kql-agreement', 'time-command-version-filters', 'successful-empty', 'denied-query-failure',
  'current-user-rbac', 'native-layout', 'idempotent-provisioning', 'retention-ingestion-preserved'
];

export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  object(value, 'Canonical JSON value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function same(actual, expected, label) {
  requireValue(canonicalJson(actual) === canonicalJson(expected), `${label} does not match the exact canonical identity`);
}

export function exactIds(actual, expected, label) {
  requireValue(Array.isArray(actual) && actual.every((id) => typeof id === 'string' && id.length > 0), `${label} requires an explicit identity array`);
  requireValue(new Set(actual).size === actual.length, `${label} contains duplicate identities`);
  requireValue(new Set(expected).size === expected.length, `${label} canonical inventory contains duplicate identities`);
  same([...actual].sort(), [...expected].sort(), `${label} inventory (missing, extra, or substituted identity)`);
}

export function confinedDirectory(root, relativePath, create = false) {
  requireValue(typeof relativePath === 'string' && relativePath.length > 0 && !path.isAbsolute(relativePath) && !/[\u0000-\u001f:\\]/.test(relativePath), 'Output/evidence directory must be a confined relative path');
  const parts = relativePath.split('/');
  requireValue(parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'Unsafe output/evidence directory');
  let current = fs.realpathSync(root);
  for (const part of parts) {
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Linked or non-directory evidence output is forbidden');
  }
  return current;
}

export function confinedFile(root, relativePath) {
  requireValue(typeof relativePath === 'string' && relativePath.length > 0 && relativePath.length <= 512 && !relativePath.includes('\\') && !/[\u0000-\u001f:]/.test(relativePath) && !path.isAbsolute(relativePath), 'Evidence requires a confined relative POSIX file path');
  const parts = relativePath.split('/');
  requireValue(parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'Unsafe evidence path component');
  const actualRoot = fs.realpathSync(root);
  let current = actualRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    requireValue(!stat.isSymbolicLink(), `Linked evidence/source path is not admitted: ${relativePath}`);
    requireValue(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), `Non-regular evidence/source path: ${relativePath}`);
  }
  return current;
}

function sameFileObservation(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readObservedEvidenceFile(root, relativePath, expectedDigest, maxBytes, captureContent) {
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'Evidence byte limit must be a positive safe integer');
  const absolutePath = confinedFile(root, relativePath);
  if (expectedDigest !== undefined) requireValue(
    typeof expectedDigest === 'string' && expectedDigest.length === 64 && /^[a-f0-9]{64}$/.test(expectedDigest),
    `Invalid SHA-256 for ${relativePath}`
  );
  const parents = [];
  let directory = fs.realpathSync(root);
  for (const part of ['', ...relativePath.split('/').slice(0, -1)]) {
    if (part) directory = path.join(directory, part);
    const observed = fs.lstatSync(directory, { bigint: true });
    requireValue(observed.isDirectory() && !observed.isSymbolicLink(), `Linked evidence/source directory: ${relativePath}`);
    parents.push({ path: directory, observed });
  }
  const assertParents = () => {
    for (const parent of parents) {
      const current = fs.lstatSync(parent.path, { bigint: true });
      requireValue(current.isDirectory() && !current.isSymbolicLink() && current.dev === parent.observed.dev &&
        current.ino === parent.observed.ino && current.mode === parent.observed.mode,
      `Evidence/source directory changed during observation: ${relativePath}`);
    }
  };
  const selected = fs.lstatSync(absolutePath, { bigint: true });
  requireValue(selected.isFile() && selected.nlink === 1n && selected.size > 0n && selected.size <= BigInt(maxBytes),
    `Empty, linked or oversized evidence/source file: ${relativePath}`);
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireValue(before.isFile() && sameFileObservation(selected, before), `File changed before integrity verification: ${relativePath}`);
    assertParents();
    const hash = createHash('sha256');
    const size = Number(before.size);
    const buffer = Buffer.alloc(Math.min(1024 * 1024, size + 1));
    const chunks = [];
    let total = 0;
    while (total <= size) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size + 1 - total), null);
      if (length === 0) break;
      total += length;
      requireValue(total <= size, `File changed beyond its captured byte bound: ${relativePath}`);
      const chunk = buffer.subarray(0, length);
      hash.update(chunk);
      if (captureContent) chunks.push(Buffer.from(chunk));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(absolutePath, { bigint: true });
    requireValue(total === size && sameFileObservation(before, after) && current.isFile() &&
      sameFileObservation(before, current), `File changed during integrity verification: ${relativePath}`);
    assertParents();
    const digest = hash.digest('hex');
    requireValue(expectedDigest === undefined || digest === expectedDigest, `Final-byte checksum mismatch: ${relativePath}`);
    return {
      file: { path: relativePath, absolutePath, name: path.posix.basename(relativePath), sha256: digest, size },
      ...(captureContent ? { bytes: Buffer.concat(chunks, size) } : {})
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectFile(root, relativePath, expectedDigest, maxBytes = 2 * 1024 ** 3) {
  return readObservedEvidenceFile(root, relativePath, expectedDigest, maxBytes, false).file;
}

export function readJsonFile(root, relativePath, expectedDigest) {
  const { file, bytes } = readObservedEvidenceFile(root, relativePath, expectedDigest, 12 * 1024 * 1024, true);
  try {
    return { file, value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new Error(`Invalid UTF-8 JSON evidence/source document: ${relativePath}`);
  }
}

export function readTextFile(root, relativePath, expectedDigest, maxBytes = MAX_MARKDOWN_BYTES) {
  const { file, bytes } = readObservedEvidenceFile(root, relativePath, expectedDigest, maxBytes, true);
  try {
    return { file, value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new DocumentationClosureError('invalid-utf8', `Invalid UTF-8 packaged documentation: ${relativePath}`, { target: relativePath });
  }
}

export function collectPublicDocumentInventory(projectRoot, packageFiles) {
  validateDocumentShippingEntries(packageFiles);
  const selected = new Set([...REQUIRED_PUBLIC_DOCUMENTS, ...packageFiles.filter((entry) =>
    !entry.includes('/') && /\.md$/i.test(entry))]);
  let entries = 0;
  const walk = (relative) => {
    const directory = confinedDirectory(projectRoot, relative);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      requireValue(++entries <= 16384, 'Public documentation source exceeds the inventory bound');
      requireValue(!entry.isSymbolicLink(), `Linked documentation source is forbidden: ${relative}/${entry.name}`);
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else selected.add(name);
    }
  };
  walk('docs');
  return Object.fromEntries([...selected].sort().map((name) => {
    const file = inspectFile(projectRoot, name, undefined, 32 * 1024 * 1024);
    return [name, { sha256: file.sha256, size: file.size }];
  }));
}

export function verifyPackagedDocumentation(bundleRoot, inventory) {
  const files = new Map(inventory.map((entry) => [entry.path, entry]));
  let total = 0;
  return verifyPublicMarkdownLinks((name) => {
    const expected = files.get(name);
    requireValue(expected, `Uninventoried packaged document: ${name}`);
    requireValue((total += expected.size) <= MAX_MARKDOWN_TOTAL_BYTES, 'Packaged Markdown closure exceeds the total byte bound');
    const { file, value } = readTextFile(bundleRoot, name, expected.sha256);
    requireValue(file.size === expected.size, `Packaged document size changed: ${name}`);
    return value;
  }, inventory);
}

export function verifySourceWorktree(projectRoot, sourceCommit) {
  requireValue(typeof sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(sourceCommit), 'An explicit immutable 40-character lowercase reviewed source commit is required');
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const git = (args) => execFileSync('git', ['--no-pager', ...args], {
    cwd: projectRoot, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...gitEnvironment, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  }).trim();
  requireValue(fs.realpathSync(git(['rev-parse', '--show-toplevel'])) === fs.realpathSync(projectRoot),
    'Expected source must be the exact reviewed Git worktree root, not a nested candidate or redirected worktree');
  requireValue(git(['rev-parse', '--verify', 'HEAD']) === sourceCommit, 'Checked-out source is not the reviewed candidate commit');
  git(['diff', '--no-ext-diff', '--no-textconv', '--quiet', 'HEAD', '--']);
  requireValue(git(['ls-files', '--', 'build/release-evidence', 'build/source-validation']) === '', 'Evidence output directories must not contain tracked source');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  requireValue(untracked.every((file) => file.startsWith('build/release-evidence/') || file.startsWith('build/source-validation/')), 'Reviewed source worktree has untracked files outside the two evidence-output directories; local edits are not immutable release evidence');
  git(['merge-base', '--is-ancestor', BASELINE_COMMIT, sourceCommit]);
  return { sourceCommit };
}

export async function loadReleaseContracts(projectRoot, sourceCommit) {
  verifySourceWorktree(projectRoot, sourceCommit);
  const load = (relative) => import(pathToFileURL(path.join(projectRoot, 'dist', relative)).href);
  const [identity, native, graph, phases, registry, profiles, resources, telemetry, buildInfo, packagedResources,
    activationTypes, activationJson, publicProtocol, skillAssets, skillContracts, skillValidation, projections,
    projectCatalog, governanceCatalog, repairIdentity, repairRegistry] = await Promise.all([
    load('release-identity.js'), load('domain/distribution/index.js'),
    load('domain/governance/activation/graph.js'), load('domain/governance/activation/capabilities.js'),
    load('application/engine-composition.js'), load('domain/standards/profile-schema.js'),
    load('domain/standards/resource-catalog-schema.js'),
    load('telemetry/contract.js'),
    load('adapters/packaged-assets/build-info.js'),
    load('adapters/packaged-assets/resource-catalog.js'),
    load('domain/governance/activation/types.js'), load('domain/governance/activation/canonical-json.js'),
    load('protocol/capabilities.js'), load('adapters/packaged-assets/skill-assets.js'),
    load('domain/skills/contracts.js'), load('domain/skills/catalog.js'),
    load('adapters/skills/host-projections.js'), load('domain/project/catalog.js'), load('application/project/catalog.js'),
    load('domain/repair/identity.js'), load('application/repair/capabilities.js')
  ]);
  return {
    verifyReleaseIdentity: identity.verifyReleaseIdentity,
    native,
    graph: graph.canonicalPhaseGraph,
    phaseGraphHash: graph.canonicalPhaseGraphHash,
    phaseDigests: graph.canonicalPhaseContractDigests,
    phaseIds: activationTypes.phaseIds,
    computePhaseDigests: graph.phaseContractDigests,
    canonicalSha256: activationJson.canonicalSha256,
    phases: phases.phaseCapabilities,
    publicCapabilities: registry.buildPublicCapabilitiesEnvelope(),
    validatePublicCapabilities: publicProtocol.validatePublicCapabilitiesEnvelope,
    skillCatalog: skillAssets.loadCanonicalSkillCatalog(),
    skillIds: skillContracts.CANONICAL_SKILL_IDS,
    skillHosts: skillContracts.SUPPORTED_SKILL_HOSTS,
    validateSkillMetadata: skillValidation.validateSkillCatalogMetadata,
    validateSkillCatalog: skillValidation.validateEnrichedSkillCatalog,
    projectSkillForHost: projections.projectSkillForHost,
    renderRetainedProjectSkill: projections.renderRetainedProjectSkill,
    retainedSkillIntegrations: projectCatalog.governanceAgentIntegrations,
    governanceProfiles: governanceCatalog.governanceProfiles,
    repair: {
      contractVersion: repairIdentity.repairContractVersion, schemas: repairIdentity.repairSchemaVersions,
      recipes: repairIdentity.repairRecipes, recoveryCompatibility: repairIdentity.repairRecoveryCompatibility,
      capabilities: repairRegistry.repairCapabilities
    },
    validateProfiles: profiles.validateStandardsProfileCatalog,
    validateResources: resources.validateTemplateCatalog,
    telemetry,
    validateNativeBuildInfo: buildInfo.validateNativeBuildInfo,
    computeResourceInventorySummary: packagedResources.computeResourceInventorySummary
  };
}

export function loadReleaseScope(projectRoot = process.cwd()) {
  try {
    const { value: scope } = readJsonFile(projectRoot, SCOPE_PATH);
    object(scope, 'Canonical release scope');
    requireValue(scope.schemaVersion === 1 && scope.product === CANONICAL_PRODUCT_NAME && scope.repository === CANONICAL_REPOSITORY && scope.change === 'modernize-liftoff-platform', 'Wrong canonical scope schema/product/repository/change');
    requireValue(scope.baseline?.version === '0.12.3' && scope.baseline?.tag === 'v0.12.3' && scope.baseline?.sourceCommit === BASELINE_COMMIT, 'Canonical v0.12.3 baseline identity changed');
    requireValue(scope.candidate?.version === '0.13.0' && scope.candidate?.publicationAuthorized === false, 'Candidate must remain explicitly unpublished 0.13.0; a scope flag cannot grant publication authority');
    const deltas = fs.readdirSync(path.join(projectRoot, 'openspec', 'changes', scope.change, 'specs'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    requireValue(deltas.length === 27, 'Canonical delta specification inventory must contain all 27 capabilities');
    exactIds(scope.capabilities?.map((entry) => entry?.id), deltas, '27 capability deltas');
    exactIds(scope.issues?.map((entry) => String(entry?.number)), ['78', '79', '80', '81', '82'], '5 tracked issues');
    exactIds(scope.requiredProductionExecutors?.map((entry) => entry?.id), PRODUCTION_GAPS, '19 required production gaps');
    exactIds(scope.requiredNativeTargets, REQUIRED_NATIVE_TARGETS, '6 native targets');
    exactIds(scope.nativeQualificationMatrix?.map((entry) => entry?.target), REQUIRED_NATIVE_TARGETS, 'Native qualification matrix');
    exactIds(scope.engines, ['standards-assessment', 'project-generation', 'project-evolution', 'repository-governance', 'azure-activation', 'distribution'], 'Capability engines');
    requireValue(Array.isArray(scope.qualificationOwners) && scope.qualificationOwners.length > 0 && new Set(scope.qualificationOwners).size === scope.qualificationOwners.length, 'Missing unique qualification owner registry');
    for (const capability of scope.capabilities) {
      requireValue(scope.engines.includes(capability.engine) && Array.isArray(capability.qualificationOwners) && capability.qualificationOwners.length > 0 && capability.qualificationOwners.every((owner) => scope.qualificationOwners.includes(owner)), `Unassigned capability ${capability.id}`);
    }
    return { valid: true, scope };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function qualificationCases(scope, contracts, profiles, skills) {
  const cases = [];
  const add = (identity, checks) => {
    for (const check of checks) cases.push({ id: sha256(canonicalJson({ ...identity, check })), ...identity, check });
  };
  for (const capability of scope.capabilities) add({ kind: 'delta', idRef: capability.id, engine: capability.engine, owners: capability.qualificationOwners }, ['outcome', 'failure-recovery']);
  for (const issue of scope.issues) add({ kind: 'issue', idRef: String(issue.number), owners: issue.qualificationOwners }, ['outcome', 'failure-recovery']);
  for (const capability of contracts.capabilities) {
    const descriptorSha256 = contracts.canonicalSha256(capability);
    for (const platform of capability.supportedPlatforms) {
      for (const profile of capability.supportedProfiles) {
        add({ kind: 'capability', idRef: capability.id, descriptorSha256, platform, profile, recovery: capability.recovery, compatibility: capability.compatibilityIdentities },
          ['none', 'n/a'].includes(capability.recovery) ? ['outcome', 'failure'] : ['outcome', 'failure', 'recovery']);
      }
    }
  }
  for (const profile of Object.values(profiles.profiles)) {
    add({ kind: 'profile', idRef: profile.id, digest: profile.digest }, ['generated-output', 'existing-project-preservation']);
  }
  for (const skill of skills.skills) {
    for (const host of skill.supportedHosts) {
      for (const deliveryScope of ['user', 'project']) {
        const { renderedContent: _content, ...projection } = contracts.projectSkillForHost(skill, host, deliveryScope);
        add({ kind: 'skill-host', idRef: skill.id, host, deliveryScope, projection },
          ['capability-negotiation', 'outcome', 'failure-recovery']);
      }
    }
  }
  exactIds(cases.map((entry) => entry.id), cases.map((entry) => entry.id), 'Registered qualification cases');
  return cases;
}

export async function loadReleaseContext(projectRoot, sourceCommit, contracts) {
  const loaded = loadReleaseScope(projectRoot);
  requireValue(loaded.valid, `Release scope validation failed: ${loaded.error}`);
  const scope = loaded.scope;
  const identity = await contracts.verifyReleaseIdentity({ packageRoot: projectRoot });
  requireValue(identity.name === CANONICAL_PRODUCT_NAME && identity.version === scope.candidate.version, 'Root package/lock identity is not the canonical unpublished candidate');
  const packageJson = readJsonFile(projectRoot, 'package.json').value;
  requireValue(packageJson.repository?.url === `git+https://github.com/${CANONICAL_REPOSITORY}.git` && packageJson.license === 'GPL-3.0-only', 'Canonical source repository or license metadata mismatch');
  const profiles = contracts.validateProfiles(readJsonFile(projectRoot, 'assets/profiles/catalog.json').value, true);
  const resources = contracts.validateResources(readJsonFile(projectRoot, 'assets/templates/catalog.json').value, true);
  const skillMetadata = contracts.validateSkillMetadata(readJsonFile(projectRoot, 'assets/skills/catalog.json').value);
  const skills = contracts.validateSkillCatalog(contracts.skillCatalog);
  same({ ...skills, skills: skills.skills.map(({ content: _content, contentHash: _hash, ...metadata }) => metadata) },
    skillMetadata, 'Validated packaged skill catalog');
  exactIds(skills.skills.map((entry) => entry.id), contracts.skillIds, 'Skill registry');
  for (const skill of skills.skills) {
    exactIds(skill.supportedHosts, contracts.skillHosts, `Skill ${skill.id} hosts`);
  }
  requireValue(contracts.native.canonicalProductName === CANONICAL_NATIVE_PRODUCT && contracts.native.canonicalRepository === CANONICAL_REPOSITORY, 'Wrong canonical native product/source registry');
  exactIds(contracts.native.allNativeTargets, REQUIRED_NATIVE_TARGETS, 'Registered native targets');
  requireValue(contracts.graph?.schemaVersion === 3 && Array.isArray(contracts.graph.phases), 'Missing canonical current phase graph');
  exactIds(contracts.graph.phases.map((phase) => phase.id), contracts.phaseIds, 'Graph declared phase IDs');
  exactIds(contracts.graph.phases.map((phase) => phase.id), Object.keys(contracts.phases), 'Graph producer registry');
  same(contracts.phaseGraphHash, contracts.canonicalSha256(contracts.graph), 'Canonical whole graph hash');
  same(contracts.phaseDigests, contracts.computePhaseDigests(contracts.graph), 'Canonical phase behavior digests');
  requireValue(PRODUCTION_GAPS.every((id) => Object.hasOwn(contracts.phases, id)), 'Required production gap missing from canonical graph');
  const publicCapabilities = contracts.validatePublicCapabilities(contracts.publicCapabilities);
  requireValue(publicCapabilities.cliVersion === identity.version, 'Public capability registry belongs to another compiled CLI version');
  requireValue(publicCapabilities.capabilities.length > 0, 'Missing public capability registry');
  exactIds(publicCapabilities.engines.map((engine) => engine.id), scope.engines, 'Public engine registry');
  for (const capability of publicCapabilities.capabilities) {
    requireValue(capability.supportedProfiles.length > 0, `Missing advertised profile scope for capability ${capability.id}`);
  }
  for (const skill of skills.skills) {
    requireValue(publicCapabilities.capabilities.some((capability) => capability.id === skill.requiredCapability),
      `Canonical skill ${skill.id} requires missing public capability ${skill.requiredCapability}`);
  }
  contracts = { ...contracts, publicCapabilities, capabilities: publicCapabilities.capabilities };
  requireValue(Array.isArray(contracts.governanceProfiles) && contracts.governanceProfiles.length > 0, 'Missing canonical governance profile registry');
  const governanceProfileIds = contracts.governanceProfiles.map((profile) => profile.id);
  exactIds(governanceProfileIds, governanceProfileIds, 'Governance profile registry');
  const implementationBlockers = [];
  for (const [id, phase] of Object.entries(contracts.phases)) {
    if (phase.executor !== 'built-in' || phase.implementation !== 'complete') implementationBlockers.push(`Production producer implementation missing: ${id}`);
  }
  for (const capability of contracts.capabilities) {
    if (capability.executor !== 'built-in' || capability.verifier === 'unavailable' || ['implementation-missing', 'planner-only'].includes(capability.qualificationState)) implementationBlockers.push(`Registered capability implementation missing: ${capability.id}`);
    for (const profile of capability.supportedProfiles) {
      const standards = Object.hasOwn(profiles.profiles, profile);
      const governance = capability.engine === 'repository-governance' &&
        governanceProfileIds.includes(profile);
      const installation = capability.engine === 'distribution' && profile === 'all';
      if (!standards && !governance && !installation) {
        implementationBlockers.push(`Unregistered capability profile scope: ${capability.id}/${profile}; standards, governance, and installation applicability are distinct`);
      }
    }
  }
  const resourceFiles = {};
  const resourcePaths = [];
  for (const [id, descriptor] of Object.entries(resources.resources)) {
    requireValue(descriptor.id === id && /^sha256:[a-f0-9]{64}$/.test(descriptor.digest), `Invalid registered resource identity: ${id}`);
    const file = inspectFile(projectRoot, descriptor.path, descriptor.digest.slice(7), 32 * 1024 * 1024);
    requireValue(file.size === descriptor.size, `Source resource size mismatch: ${id}`);
    resourcePaths.push(descriptor.path.normalize('NFC').toLowerCase());
    resourceFiles[id] = { path: descriptor.path, sha256: file.sha256, size: file.size };
  }
  exactIds(resourcePaths, resourcePaths, 'Native resource destinations');
  for (const skill of skills.skills) {
    const resource = resourceFiles[`skills.${skill.id}`];
    requireValue(resource?.path === `assets/skills/${skill.entrypoint}` && resource.sha256 === skill.contentHash,
      `Canonical skill ${skill.id} does not bind the selected source resource bytes`);
  }
  const resourceInventory = contracts.computeResourceInventorySummary(resources);
  requireValue(Number.isSafeInteger(resourceInventory.count) && resourceInventory.count > 0 && resourceInventory.count === Object.keys(resourceFiles).length,
    'An empty or mismatched packaged resource inventory cannot qualify');
  const sourceFiles = {};
  for (const file of [
    SCOPE_PATH, 'package.json', 'package-lock.json', 'LICENSE', 'assets/profiles/catalog.json',
    'assets/templates/catalog.json', 'assets/skills/catalog.json', 'assets/supported-stack.json',
    'assets/repair/windows-job-controller.ps1', 'infrastructure/opentofu/telemetry/dashboard.json',
    TELEMETRY_CONTRACT_PATH, TELEMETRY_BASELINE_FIXTURE
  ]) sourceFiles[file] = inspectFile(projectRoot, file).sha256;
  const documentationFiles = collectPublicDocumentInventory(projectRoot, packageJson.files);
  for (const [name, file] of Object.entries(documentationFiles)) sourceFiles[name] = file.sha256;
  const dashboard = readJsonFile(projectRoot, 'infrastructure/opentofu/telemetry/dashboard.json').value;
  requireValue(typeof dashboard.uid === 'string' && dashboard.uid.length > 0, 'Missing committed dashboard definition identity');
  const cases = qualificationCases(scope, contracts, profiles, skills);
  const telemetry = loadTelemetryReleaseContract(projectRoot, scope, contracts.telemetry);
  const retainedSkills = [];
  for (const [host, integrations] of Object.entries(contracts.retainedSkillIntegrations)) {
    requireValue(contracts.skillHosts.includes(host), `Unregistered retained skill host: ${host}`);
    for (const [operation, skillId] of [['setup', 'setup'], ['assessment', 'governance-assess'], ['repair', 'repair']]) {
      const skill = skills.skills.find((entry) => entry.id === skillId);
      retainedSkills.push({ host, skillId, ...object(integrations[operation], `Retained ${host}/${operation} integration`),
        contentHash: sha256(contracts.renderRetainedProjectSkill(skill, host)) });
    }
  }
  exactIds(Object.keys(contracts.retainedSkillIntegrations), contracts.skillHosts, 'Retained skill host registry');
  requireValue(contracts.repair?.capabilities?.cliVersion === identity.version, 'Repair registry belongs to another compiled CLI version');
  same(contracts.repair.capabilities.repairContractVersion, contracts.repair.contractVersion, 'Repair contract version');
  same(contracts.repair.capabilities.schemas, contracts.repair.schemas, 'Independent repair schemas');
  same(contracts.repair.capabilities.recipes, Object.values(contracts.repair.recipes), 'Repair recipe registry');
  same(contracts.repair.capabilities.recoveryCompatibility, contracts.repair.recoveryCompatibility, 'Repair recovery compatibility');
  const registryBindings = {
    schemaVersion: 1, kind: 'liftoff-release-registry-bindings',
    publicCapabilities,
    activation: { graph: contracts.graph, graphHash: contracts.phaseGraphHash, phaseIds: contracts.phaseIds,
      phaseDigests: contracts.phaseDigests, producers: contracts.phases },
    standards: { profilesDigest: profiles.digest, resourcesDigest: resources.digest },
    governance: { profiles: contracts.governanceProfiles },
    skills: { ...skills, skills: skills.skills.map(({ content: _content, ...definition }) => definition), retainedSkills },
    repair: contracts.repair, cases
  };
  return {
    projectRoot, sourceCommit, scope, contracts, sourceFiles, documentationFiles, resourceFiles, resourceInventory, profiles, resources, skills, cases, implementationBlockers, telemetry,
    dashboard: { id: dashboard.uid, sha256: sourceFiles['infrastructure/opentofu/telemetry/dashboard.json'], resourceType: scope.operatorDashboard.resourceType, apiVersion: scope.operatorDashboard.apiVersion },
    registryBindings, registrySha256: contracts.canonicalSha256(registryBindings)
  };
}

export function inspectNativeArchive(file, format, target, projectRoot) {
  try {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    return JSON.parse(execFileSync(python, [path.join(projectRoot, 'scripts/release-evidence-archive.py'), file.absolutePath, format, target], {
      cwd: projectRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    }));
  } catch (error) {
    const detail = typeof error.stderr === 'string' ? error.stderr.trim().slice(0, 300) : 'bounded archive inspection failed; Python 3 is required';
    throw new Error(`Native archive ${target}: ${detail}`);
  }
}

export function inspectArchiveDocumentation(file, format, archiveRoot, projectRoot) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const observed = JSON.parse(execFileSync(python, [
    path.join(projectRoot, 'scripts/release-evidence-archive.py'), '--inspect-documentation',
    file.absolutePath, format, archiveRoot
  ], { cwd: projectRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
  requireValue(observed.kind === 'archive-documentation-inspection' && observed.archiveRoot === archiveRoot,
    'Documentation inspection did not observe the exact selected archive root');
  return verifyPublicMarkdownLinks(observed.documents, observed.files);
}

export function verifyNativeManifest(raw, context) {
  const { scope, sourceCommit, contracts } = context;
  const manifest = contracts.native.parseNativeReleaseManifest(raw);
  exactKeys(manifest, ['$schema', 'schemaVersion', 'product', 'version', 'sourceCommit', 'publishedAt', 'targets'], 'Native manifest schema 1');
  requireValue(manifest.product === CANONICAL_NATIVE_PRODUCT && manifest.version === scope.candidate.version && manifest.sourceCommit === sourceCommit, 'Native manifest canonical product/candidate/source mismatch');
  exactIds(Object.keys(manifest.targets), scope.requiredNativeTargets, 'Final native manifest targets');
  for (const target of scope.requiredNativeTargets) {
    const payload = manifest.targets[target];
    exactKeys(payload, ['os', 'arch', 'archiveUrl', 'archiveFormat', 'checksumSha256', 'signatureUrl', 'provenanceUrl', 'runtime', 'resources'], `Native target ${target} schema 1`);
    const [os, arch] = target.split('-');
    const matrix = scope.nativeQualificationMatrix.find((entry) => entry.target === target);
    requireValue(payload.os === os && payload.arch === arch && matrix.os === os && matrix.arch === arch, `Native target identity mismatch: ${target}`);
    requireValue(payload.archiveFormat === (os === 'win32' ? 'zip' : 'tar.gz'), `Wrong native archive format: ${target}`);
    requireValue(payload.runtime.nodeVersion === matrix.nodeEngineFloor, `Wrong pinned private runtime version: ${target}`);
    for (const [key, floor] of Object.entries(contracts.native.nativeTargetFloors[os])) {
      if (key !== 'minimumBuild') requireValue(payload.runtime[key] === floor, `Wrong native target/host floor ${target}: ${key}`);
    }
    requireValue(Number.isSafeInteger(payload.resources?.count) && payload.resources.count > 0 && /^[a-f0-9]{64}$/.test(payload.resources.inventoryHash), `Missing exact resource inventory: ${target}`);
    for (const key of ['archiveUrl', 'signatureUrl', 'provenanceUrl']) {
      requireValue(typeof payload[key] === 'string', `Missing native ${key}: ${target}`);
      const url = new URL(payload[key]);
      requireValue(url.protocol === 'https:' && url.hostname === 'github.com' && url.port === '' && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(`/${CANONICAL_REPOSITORY}/`), `Noncanonical native ${key}: ${target}`);
    }
    requireValue(new URL(payload.archiveUrl).pathname === `/${CANONICAL_REPOSITORY}/releases/download/v${scope.candidate.version}/liftoff-v${scope.candidate.version}-${target}.${payload.archiveFormat}`, `Artifact URL does not name the exact candidate release/target channel artifact: ${target}`);
    same(payload.resources, context.resourceInventory, `Manifest measured resource inventory ${target}`);
  }
  return manifest;
}

export function verifyNativeArchiveContents(archive, payload, target, context) {
  const { scope, sourceCommit } = context;
  requireValue(archive.archiveRoot === `liftoff-v${scope.candidate.version}-${target}`,
    `Observed native archive root does not match the canonical release/channel layout: ${target}`);
  same(payload.resources, context.resourceInventory, `Packaged measured resource inventory ${target}`);
  const files = new Map(archive.files.map((entry) => [entry.path, entry]));
  exactIds(archive.files.map((entry) => entry.path), [...files.keys()], `Archive ${target} exact file inventory`);
  const build = context.contracts.validateNativeBuildInfo(archive.metadata['build-info.json']);
  const templates = context.contracts.validateResources(archive.metadata['assets/templates/catalog.json'], true);
  const profiles = context.contracts.validateProfiles(archive.metadata['assets/profiles/catalog.json'], true);
  requireValue(build.schemaVersion === 1 && build.product === CANONICAL_NATIVE_PRODUCT && build.version === scope.candidate.version && build.commit === sourceCommit, `Packaged build identity mismatch: ${target}`);
  same(build.target, { os: payload.os, arch: payload.arch, platform: target }, `Packaged native target ${target}`);
  requireValue(build.runtime?.name === 'node' && build.runtime.version === payload.runtime.nodeVersion &&
    build.resourcesDigest === templates.digest && build.profilesDigest === profiles.digest,
  `Packaged runtime/catalog identity mismatch: ${target}`);
  const buildManifest = object(archive.metadata['liftoff-build-manifest.json'], `Missing native build manifest: ${target}`);
  requireValue(buildManifest.schemaVersion === 1 && buildManifest.product === CANONICAL_NATIVE_PRODUCT && buildManifest.version === scope.candidate.version && buildManifest.sourceCommit === sourceCommit && buildManifest.target === target, `Build manifest identity mismatch: ${target}`);
  same(buildManifest.resources, payload.resources, `Build manifest resources ${target}`);
  same(buildManifest.runtime, payload.runtime, `Build manifest runtime ${target}`);
  const pkg = object(archive.metadata['package.json'], `Missing packaged product metadata: ${target}`);
  requireValue(pkg.name === CANONICAL_PRODUCT_NAME && pkg.version === scope.candidate.version, `Packaged product/version mismatch: ${target}`);
  for (const [id, resource] of Object.entries(context.resourceFiles)) {
    requireValue(files.get(resource.path)?.sha256 === resource.sha256 && files.get(resource.path)?.size === resource.size, `Packaged resource bytes mismatch ${target}: ${id}`);
  }
  for (const source of ['LICENSE', 'assets/templates/catalog.json', 'assets/profiles/catalog.json', 'assets/skills/catalog.json', 'assets/supported-stack.json']) {
    requireValue(files.get(source)?.sha256 === context.sourceFiles[source], `Packaged source definition differs ${target}: ${source}`);
  }
  exactIds(archive.files.filter((file) => isPublicDocumentationFile(file.path)).map((file) => file.path),
    Object.keys(context.documentationFiles), `Packaged public documentation ${target}`);
  for (const [name, source] of Object.entries(context.documentationFiles)) {
    requireValue(files.get(name)?.sha256 === source.sha256 && files.get(name)?.size === source.size,
      `Packaged public document differs from reviewed source ${target}: ${name}`);
  }
  const documentation = verifyPublicMarkdownLinks(archive.documents, archive.files);
  const runtimePath = payload.os === 'win32' ? 'runtime/node.exe' : 'runtime/node';
  const launcherPath = payload.os === 'win32' ? 'bin/liftoff.exe' : 'bin/liftoff';
  const runtime = files.get(runtimePath);
  const launcher = files.get(launcherPath);
  requireValue(runtime && launcher && files.get('dist/cli.js'), `Native runtime/launcher/CLI closure missing: ${target}`);
  if (payload.os !== 'win32') requireValue((runtime.mode & 0o111) !== 0 && (launcher.mode & 0o111) !== 0, `Native runtime or launcher lacks executable mode: ${target}`);
  const helpers = [{ id: payload.os === 'win32' ? 'windows-launcher' : 'posix-launcher', path: launcherPath, sha256: launcher.sha256 }];
  if (payload.os === 'win32') {
    const helperPath = 'assets/repair/windows-job-controller.ps1';
    requireValue(files.get(helperPath)?.sha256 === context.sourceFiles[helperPath], `Windows controller bytes differ from reviewed source: ${target}`);
    helpers.push({ id: 'windows-job-controller', path: helperPath, sha256: files.get(helperPath).sha256 });
  }
  return {
    artifactSha256: payload.checksumSha256, archiveRoot: archive.archiveRoot,
    runtime: { ...payload.runtime, path: runtimePath, sha256: runtime.sha256 },
    resources: { ...payload.resources, filesSha256: sha256(canonicalJson(archive.files)) },
    buildInfoSha256: files.get('build-info.json').sha256, helpers,
    documentation: { documents: documentation.documents, linksSha256: sha256(canonicalJson(documentation.links)) }
  };
}

export function buildReleaseSubject(context, manifestFile, targets) {
  return {
    schemaVersion: 1, product: CANONICAL_NATIVE_PRODUCT, package: CANONICAL_PRODUCT_NAME,
    version: context.scope.candidate.version, repository: CANONICAL_REPOSITORY, sourceCommit: context.sourceCommit,
    manifestSha256: manifestFile.sha256, sourceFiles: context.sourceFiles, registrySha256: context.registrySha256,
    registryBindingSchemaVersion: context.registryBindings.schemaVersion,
    phaseGraphHash: context.contracts.phaseGraphHash, qualificationRegistrySha256: context.qualificationRegistry?.sha256 ?? null,
    dashboard: context.dashboard, telemetry: context.telemetry, telemetryGateway: context.scope.verification?.telemetryGateway ?? null, targets
  };
}

export async function verifyNativeManifestFile(context, pointer, evidenceRoot, verifier, trackedFiles) {
  exactKeys(pointer, ['path', 'sha256', 'origin'], 'Signed native manifest');
  const file = inspectFile(evidenceRoot, pointer.path, pointer.sha256);
  trackedFiles.push(file);
  const manifest = verifyNativeManifest(readJsonFile(evidenceRoot, file.path, file.sha256).value, context);
  requireValue(pointer.origin?.workflow === context.scope.verification?.nativeSigning?.workflow, 'Native manifest must use the registered native signer');
  await verifier.verifyFile(file, pointer.origin, 'native-manifest');
  return { file, manifest };
}

export async function verifyNativeArtifactFile(context, manifest, target, pointer, evidenceRoot, verifier, trackedFiles) {
  exactKeys(pointer, ['path', 'sha256', 'origin'], `Final ${target} artifact`);
  const file = inspectFile(evidenceRoot, pointer.path, pointer.sha256);
  trackedFiles.push(file);
  const payload = manifest.targets[target];
  requireValue(file.sha256 === payload.checksumSha256 && file.name === path.posix.basename(new URL(payload.archiveUrl).pathname), `Final signed ${target} bytes/name differ from manifest`);
  requireValue(pointer.origin?.workflow === context.scope.verification?.nativeSigning?.workflow, `Missing registered native signature authority for ${target}`);
  await verifier.verifyFile(file, pointer.origin, 'native-artifact');
  return verifyNativeArchiveContents(inspectNativeArchive(file, payload.archiveFormat, target, context.projectRoot), payload, target, context);
}

export async function readVerifiedReleaseReport(pointer, id, subject, evidenceRoot, verifier, trackedFiles) {
  exactKeys(pointer, ['path', 'sha256', 'origin'], `Required ${id} evidence`);
  const { file, value: report } = readJsonFile(evidenceRoot, pointer.path, pointer.sha256);
  trackedFiles.push(file);
  exactKeys(report, ['schemaVersion', 'kind', 'type', 'binding', 'data'], `${id} report`);
  requireValue(report.schemaVersion === 1 && report.kind === 'liftoff-release-report' && report.type === id, `Unsupported or mismatched ${id} report schema`);
  same(report.binding, { product: subject.product, version: subject.version, repository: subject.repository,
    sourceCommit: subject.sourceCommit, releaseSubjectSha256: sha256(canonicalJson(subject)) }, `${id} release/artifact/runtime/resource/definition binding`);
  return { data: object(report.data, `${id} measured data`), file, origin: pointer.origin, verifiedFile: await verifier.verifyFile(file, pointer.origin, id) };
}

export function verifyChecks(observed, expectedIds, label) {
  requireValue(Array.isArray(observed), `${label} requires measured check results`);
  exactIds(observed.map((entry) => entry?.id), expectedIds, label);
  for (const check of observed) {
    exactKeys(check, ['id', 'passed', 'failed', 'skipped'], `${label} check`);
    requireValue(Number.isSafeInteger(check.passed) && check.passed > 0 && check.failed === 0 && check.skipped === 0, `${label} check ${check.id} lacks successful non-skipped measurements`);
  }
}

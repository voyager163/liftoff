import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  digest, parseSecurityReport, portableParts, SecurityEvidenceError,
  type EvidenceIdentity, type SecurityFinding, type SecurityReport
} from './evidence.ts';
import { createImageRegistry, type LocalImageIdentity } from './images.ts';
import { generatedSecurityCases, imageCases } from './inventory.ts';
import { createSecurityWorkspace } from './workspace.ts';
import { restoreImagePythonPreparation } from './image-preparation.ts';
import { classifyTrivyAdvisory, projectUnclassifiedTrivyAdvisories, recognizedTrivyAdvisory } from './trivy-advisory.ts';
import { verifyGeneratedHealthResponses } from './generated-health.ts';
import { verifyGeneratedArtifactBinding, type GeneratedArtifactBinding } from './generated-artifact-binding.ts';

export interface GeneratedImageHealth {
  kind: 'issued-local-generated-image-health';
  generatedCase: string;
  target: 'backend' | 'frontend';
  artifactInventoryDigest: string;
  dockerfileDigest: string;
  imageDigest: string;
  platform: string;
  runId: string;
  completedAt: string;
  checks: readonly string[];
  externalServicesQualified: false;
  orchestratorProbesClaimed: false;
}
const issuedHealth = new WeakMap<object, string>();
export function verifiedGeneratedImageHealth(value: unknown): GeneratedImageHealth {
  if (!value || typeof value !== 'object') fail('unissued-health-proof');
  const registered = issuedHealth.get(value);
  if (!registered || hash(JSON.stringify(value)) !== registered) fail('unissued-health-proof');
  return structuredClone(value as GeneratedImageHealth);
}

/**
 * Local opt-in only. No context discovery, remote image source, Trivy server,
 * configuration/secret scan, credential helper, or inherited tool configuration.
 * Installing the pinned tool and refreshing its public advisory DB are separate
 * from an offline, digest-selected local image scan.
 */
export const TRIVY_POLICY = Object.freeze({
  version: '0.69.3',
  databaseRepository: 'ghcr.io/aquasecurity/trivy-db:2',
  reportBytes: 32 * 1024 * 1024,
  processTimeoutMs: 10 * 60_000,
  databaseMaxAgeMs: 24 * 60 * 60_000,
  ownerLabel: 'org.liftoff.security.run',
  caseLabel: 'org.liftoff.security.case'
});
export const TRIVY_ARCHIVES = Object.freeze({
  'darwin-arm64': {
    asset: 'trivy_0.69.3_macOS-ARM64.tar.gz',
    sha256: 'a2f2179afd4f8bb265ca3c7aefb56a666bc4a9a411663bc0f22c3549fbc643a5'
  },
  'darwin-x64': {
    asset: 'trivy_0.69.3_macOS-64bit.tar.gz',
    sha256: 'fec4a9f7569b624dd9d044fca019e5da69e032700edbb1d7318972c448ec2f4e'
  },
  'linux-x64': {
    asset: 'trivy_0.69.3_Linux-64bit.tar.gz',
    sha256: '1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75'
  },
  'linux-arm64': {
    asset: 'trivy_0.69.3_Linux-ARM64.tar.gz',
    sha256: '7e3924a974e912e57b4a99f65ece7931f8079584dae12eb7845024f97087bdfd'
  }
});
export const TRIVY_FIXTURE = Object.freeze({
  package: 'lodash',
  version: '4.17.20',
  url: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
  integrity: 'sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA==',
  advisory: 'CVE-2021-23337'
});

const hash = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fail(code: string): never { throw new SecurityEvidenceError(`trivy-${code}`); }
const safePath = (value: string) => {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail('invalid-path');
  return value;
};
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-report');
  return value as Record<string, unknown>;
};
const boundedText = (value: unknown, max = 500): string => {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('invalid-report');
  return value as string;
};
const list = (value: unknown, max = 100_000): unknown[] => {
  if (!Array.isArray(value) || value.length > max) fail('invalid-report');
  return value as unknown[];
};

export function trivyReportShape(source: Uint8Array) {
  if (source.byteLength > TRIVY_POLICY.reportBytes) return { parsed: false, reason: 'oversize' };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)); }
  catch { return { parsed: false, reason: 'invalid-json' }; }
  const row = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const report = row(value), metadata = row(report.Metadata);
  const results = Array.isArray(report.Results) ? report.Results : [];
  return {
    parsed: true, osMetadataPresent: metadata.OS !== undefined && metadata.OS !== null,
    resultsArray: Array.isArray(report.Results), resultCount: results.length, omittedDiagnostics: Math.max(0, results.length - 20),
    results: results.slice(0, 20).map((value, index) => {
      const result = row(value), packages = Array.isArray(result.Packages) ? result.Packages.slice(0, 100_000).map(row) : [];
      const findings = Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities.slice(0, 20_000).map(row) : [];
      return {
        index, class: result.Class === 'os-pkgs' || result.Class === 'lang-pkgs' ? result.Class : 'unrecognized',
        type: typeof result.Type === 'string' && ['alpine', 'debian', 'node-pkg', 'python-pkg', 'gobinary', 'rustbinary'].includes(result.Type)
          ? result.Type : 'unrecognized',
        targetString: typeof result.Target === 'string', targetEmpty: result.Target === '',
        packagesArray: Array.isArray(result.Packages), packages: packages.length,
        packageDiagnosticsTruncated: Array.isArray(result.Packages) && result.Packages.length > packages.length,
        missingNames: packages.filter(pkg => typeof pkg.Name !== 'string' || !pkg.Name).length,
        missingVersions: packages.filter(pkg => pkg.Version === undefined).length,
        emptyVersions: packages.filter(pkg => pkg.Version === '').length,
        nonstringVersions: packages.filter(pkg => pkg.Version !== undefined && typeof pkg.Version !== 'string').length,
        vulnerabilities: findings.length,
        missingInstalledVersions: findings.filter(finding => typeof finding.InstalledVersion !== 'string' || !finding.InstalledVersion).length,
        findingDiagnosticsTruncated: Array.isArray(result.Vulnerabilities) && result.Vulnerabilities.length > findings.length,
        unknownSeverities: findings.filter(finding => typeof finding.Severity !== 'string' ||
          !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(finding.Severity)).length,
        unclassifiedAdvisories: projectUnclassifiedTrivyAdvisories(result)
      };
    })
  };
}

export class TrivyReportError extends SecurityEvidenceError {
  readonly diagnostic: ReturnType<typeof trivyReportShape>;
  constructor(code: string, source: Uint8Array) {
    super(code);
    this.diagnostic = trivyReportShape(source);
  }
}

export interface PrivateProcessOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  discardStderr?: boolean;
}

/** Failed stdout/stderr are destroyed, never included in an Error or log. */
export async function captureTrivyProcess(
  executable: string, args: readonly string[], options: PrivateProcessOptions
): Promise<Buffer> {
  safePath(executable);
  safePath(options.cwd);
  const limit = options.maxBytes ?? TRIVY_POLICY.reportBytes;
  const timeout = options.timeoutMs ?? TRIVY_POLICY.processTimeoutMs;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 20 * 60_000) fail('invalid-process-bound');
  return new Promise((resolve, reject) => {
    let failure: string | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    const child = (() => {
      try {
        return spawn(executable, [...args], {
          cwd: options.cwd, env: options.environment, shell: false, stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch { return fail('process-failed'); }
    })();
    const stop = (code: string) => {
      failure ??= code;
      chunks.forEach(chunk => chunk.fill(0));
      chunks.length = 0;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) stop('output-limit');
      if (!failure) chunks.push(Buffer.from(chunk));
      chunk.fill(0);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      chunk.fill(0);
      if (size > limit) stop('output-limit');
      else if (!options.discardStderr) stop('unexpected-stderr');
    });
    child.on('error', () => { failure ??= 'process-failed'; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) failure ??= 'process-failed';
      if (failure) {
        chunks.forEach(chunk => chunk.fill(0));
        reject(new SecurityEvidenceError(`trivy-${failure}`));
      } else {
        const output = Buffer.concat(chunks);
        chunks.forEach(chunk => chunk.fill(0));
        resolve(output);
      }
    });
  });
}

/** Checks metadata only; calling this does not contact any daemon. */
export async function validateLocalDockerEndpoint(endpoint: string): Promise<string> {
  try {
    if (!endpoint.startsWith('unix:///') || /[%?#\x00-\x20\x7f]/.test(endpoint)) fail('nonlocal-docker');
    const socket = endpoint.slice('unix://'.length);
    if (path.normalize(socket) !== socket || await realpath(socket) !== socket) fail('nonlocal-docker');
    const status = await lstat(socket);
    if (!status.isSocket() || status.isSymbolicLink() ||
        process.getuid && status.uid !== process.getuid() && status.uid !== 0) fail('nonlocal-docker');
    return endpoint;
  } catch { return fail('nonlocal-docker'); }
}

export function privateImageEnvironment(root: string, endpoint: string): NodeJS.ProcessEnv {
  safePath(root);
  if (!/^unix:\/\/\//.test(endpoint) || /[%?#\x00-\x20\x7f]/.test(endpoint)) fail('nonlocal-docker');
  return {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    DOCKER_CONFIG: path.join(root, 'docker'), DOCKER_HOST: endpoint,
    DOCKER_BUILDKIT: '1', BUILDX_BUILDER: 'default', BUILDX_CONFIG: path.join(root, 'buildx'),
    BUILDX_NO_DEFAULT_ATTESTATIONS: '1',
    TMPDIR: path.join(root, 'scratch'), TMP: path.join(root, 'scratch'), TEMP: path.join(root, 'scratch'),
    npm_config_cache: path.join(root, 'cache', 'npm'),
    npm_config_userconfig: path.join(root, 'npm-userconfig'), npm_config_globalconfig: path.join(root, 'npm-globalconfig'),
    npm_config_registry: 'https://registry.npmjs.org',
    UV_DEFAULT_INDEX: 'https://pypi.org/simple', UV_CACHE_DIR: path.join(root, 'cache', 'uv'),
    UV_NO_CONFIG: '1', UV_KEYRING_PROVIDER: 'disabled',
    GOPATH: path.join(root, 'cache', 'go'), GOCACHE: path.join(root, 'cache', 'go-build'), GOENV: 'off',
    GOTOOLCHAIN: 'local', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty'),
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
    LC_ALL: 'C', LANG: 'C', TZ: 'UTC'
  };
}

export interface LocalBuilderIdentity {
  name: 'default';
  driver: 'docker';
  node: 'default';
  endpointDigest: string;
  buildkitVersion: string;
  platforms: string[];
}

/** Parse only the explicitly selected default builder; never list or bootstrap builders. */
export function normalizeLocalBuilderInspection(source: string, endpoint: string): LocalBuilderIdentity {
  privateImageEnvironment(path.resolve('.'), endpoint);
  if (Buffer.byteLength(source) > 65_536 || /[\x00-\x08\x0b-\x1f\x7f]/.test(source)) fail('invalid-builder-report');
  const sections = source.split(/^Nodes:\s*$/m);
  if (sections.length !== 2) fail('invalid-builder-report');
  const field = (section: string, name: string) => {
    const values = [...section.matchAll(new RegExp(`^${name}:\\s*([^\\n]+)$`, 'gm'))];
    if (values.length !== 1) return fail('invalid-builder-report');
    return values[0]![1]!.trim();
  };
  const header = sections[0]!, node = sections[1]!;
  if (field(header, 'Name') !== 'default' || field(header, 'Driver') !== 'docker' ||
      field(node, 'Name') !== 'default' || field(node, 'Status') !== 'running' ||
      /^(?:Error|Flags|Driver Options):/m.test(source)) fail('nonlocal-or-inactive-builder');
  // "default" is accepted only after the caller verifies its private context's
  // resolved Host equals the explicit Unix endpoint, without any stored context.
  if (![endpoint, 'default'].includes(field(node, 'Endpoint'))) fail('nonlocal-builder-endpoint');
  const buildkitVersion = field(node, '(?:BuildKit|BuildKit version)');
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(buildkitVersion)) fail('invalid-builder-version');
  const platforms = field(node, 'Platforms').split(/,\s*/).sort();
  if (!platforms.includes('linux/amd64') || new Set(platforms).size !== platforms.length ||
      platforms.some(value => !/^[a-z0-9]+\/[a-z0-9]+(?:\/[a-z0-9]+)?$/.test(value))) fail('builder-platform-unavailable');
  return { name: 'default', driver: 'docker', node: 'default', endpointDigest: hash(endpoint), buildkitVersion, platforms };
}

export interface LocalBuildOptions {
  context: string;
  dockerfile?: readonly string[];
  registryKind?: 'npm' | 'python';
  network?: 'none';
  generatedInput?: GeneratedArtifactBinding;
}

export interface ImageCoverage {
  id: string;
  platform: LocalImageIdentity['platform'];
  os: 'required' | 'inapplicable-scratch-fixture';
  application: 'required' | 'inapplicable-static-assets';
}

export function imageCoverage(id: string): ImageCoverage {
  const entry = imageCases.find(entry => entry.id === id);
  if (!entry) fail('unregistered-image');
  return {
    id, platform: entry.platform as LocalImageIdentity['platform'], os: 'required',
    application: id === 'frontend' ? 'inapplicable-static-assets' : 'required'
  };
}

export interface ImageAssessment {
  caseId: string;
  imageDigest: string;
  platform: LocalImageIdentity['platform'];
  toolVersion: string;
  databaseDigest: string;
  generatedAt: string;
  completedAt: string;
  coverage: {
    os: { status: ImageCoverage['os']; packages: number };
    application: { status: ImageCoverage['application']; packages: number };
  };
  findings: SecurityFinding[];
  sourceComponents: { componentDigest: string; targetDigest: string; moduleDigest: string; version: null; binding: 'built-source-module' }[];
}
export interface GoImageSourceBinding { moduleName: string; moduleDigest: string; target: 'app/api'; }

export function generatedGoSourceBinding(source: string): GoImageSourceBinding {
  if (Buffer.byteLength(source) > 65_536) fail('go-source-module-bound');
  const module = /^module (example\.com\/[a-z0-9][a-z0-9-]*\/backend)\r?\n/.exec(source);
  if (!module) fail('unsupported-go-source-module');
  return { moduleName: module[1]!, moduleDigest: hash(source), target: 'app/api' };
}
export interface TrivyDatabaseMetadata {
  version: 2;
  updatedAt: string;
  downloadedAt: string;
  nextUpdate: string;
}

/**
 * Deliberately do not retain image history, environment, labels, file paths,
 * descriptions or scanner diagnostics. Package/version/location identities are
 * hashes of exact scanner values; this also keeps arbitrary image bytes out of
 * retained evidence. Recognized public advisory IDs are exposed; other bounded
 * advisory identities are hashed, never dropped or treated as clean findings.
 */
export function normalizeTrivyReport(
  source: Buffer | string, image: LocalImageIdentity, coverage: ImageCoverage,
  databaseDigest: string, generatedAt: string, completedAt: string, goSource?: GoImageSourceBinding
): ImageAssessment {
  if (Buffer.byteLength(source) > TRIVY_POLICY.reportBytes) fail('report-too-large');
  digest(image.id);
  digest(databaseDigest);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(coverage.id) || image.platform !== coverage.platform ||
      !['required', 'inapplicable-scratch-fixture'].includes(coverage.os) ||
      !['required', 'inapplicable-static-assets'].includes(coverage.application) ||
      coverage.os !== 'required' && coverage.id !== 'scratch-package-fixture' ||
      coverage.application !== 'required' && coverage.id !== 'frontend') fail('coverage-mismatch');
  const expected = imageCases.find(entry => entry.id === coverage.id);
  if (!expected && coverage.id !== 'scratch-package-fixture') fail('unregistered-image');
  if (expected && JSON.stringify(coverage) !== JSON.stringify(imageCoverage(coverage.id))) fail('coverage-mismatch');
  for (const stamp of [generatedAt, completedAt]) {
    if (!Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) fail('invalid-time');
  }
  if (completedAt < generatedAt) fail('invalid-time');
  let report: Record<string, unknown>;
  try { report = object(JSON.parse(source.toString())); } catch { return fail('invalid-json'); }
  if (report.SchemaVersion !== 2 || report.ArtifactType !== 'container_image' || report.ArtifactName !== image.id) {
    fail('artifact-mismatch');
  }
  const metadata = object(report.Metadata), config = object(metadata.ImageConfig);
  if (metadata.ImageID !== image.id || `${config.os}/${config.architecture}` !== image.platform) fail('artifact-mismatch');
  let osFamily: string | undefined;
  if (coverage.os === 'required') {
    const os = object(metadata.OS);
    osFamily = boundedText(os.Family);
    boundedText(os.Name);
    if (os.Eosl === true) fail('unsupported-os');
  } else if (metadata.OS !== undefined && metadata.OS !== null) fail('coverage-mismatch');
  let osPackages = 0, applicationPackages = 0;
  const findings: SecurityFinding[] = [];
  const sourceComponents: ImageAssessment['sourceComponents'] = [];
  if (goSource) {
    if (coverage.id !== 'go' || goSource.target !== 'app/api' ||
        !/^example\.com\/[a-z0-9][a-z0-9-]*\/backend$/.test(goSource.moduleName)) fail('invalid-go-source-binding');
    digest(goSource.moduleDigest);
  }
  const targets = new Set<string>();
  for (const entry of list(report.Results, 1_000)) {
    const result = object(entry);
    if (result.Class !== 'os-pkgs' && result.Class !== 'lang-pkgs') fail('unexpected-analysis');
    if (['Misconfigurations', 'Secrets', 'Licenses', 'CustomResources'].some(key =>
      result[key] !== undefined && list(result[key]).length !== 0)) fail('unexpected-analysis');
    const type = boundedText(result.Type), target = boundedText(result.Target, 4_096);
    if (result.Class === 'os-pkgs' && type !== osFamily) fail('os-coverage-mismatch');
    if (result.Class === 'lang-pkgs' && !['node-pkg', 'python-pkg', 'gobinary', 'rustbinary'].includes(type)) {
      fail('unsupported-package-type');
    }
    const targetKey = `${result.Class}\0${type}\0${target}`;
    if (targets.has(targetKey)) fail('duplicate-target');
    targets.add(targetKey);
    const packages = list(result.Packages);
    if (!packages.length) fail('empty-packages');
    const installed = new Set<string>();
    for (const value of packages) {
      const pkg = object(value);
      if (pkg.Version === undefined || pkg.Version === '') {
        if (!goSource || result.Class !== 'lang-pkgs' || type !== 'gobinary' ||
            target.replace(/^\//, '') !== goSource.target || pkg.Name !== goSource.moduleName ||
            pkg.ID !== goSource.moduleName || pkg.Relationship !== 'root' || sourceComponents.length !== 0) {
          fail('unbound-package-version');
        }
        const dependencies = list(pkg.DependsOn);
        if (!dependencies.length || new Set(dependencies).size !== dependencies.length ||
            dependencies.some(id => typeof id !== 'string' ||
              !packages.some(value => {
                const dependency = object(value);
                return dependency.ID === id && dependency.Name !== goSource.moduleName &&
                  typeof dependency.Version === 'string' && dependency.Version.length > 0;
              }))) fail('go-source-component-coverage');
        sourceComponents.push({
          componentDigest: hash(goSource.moduleName), targetDigest: hash(goSource.target),
          moduleDigest: goSource.moduleDigest, version: null, binding: 'built-source-module'
        });
        continue;
      }
      let version = boundedText(pkg.Version);
      // Trivy 0.69.3's scan/utils.FormatVersion uses epoch:version-release
      // in findings, but lists the three OS package fields separately.
      if (result.Class === 'os-pkgs') {
        if (pkg.Release !== undefined && pkg.Release !== '') version += `-${boundedText(pkg.Release)}`;
        if (pkg.Epoch !== undefined) {
          if (!Number.isSafeInteger(pkg.Epoch) || Number(pkg.Epoch) < 0) fail('invalid-package-epoch');
          if (pkg.Epoch !== 0) version = `${pkg.Epoch}:${version}`;
        }
      }
      installed.add(`${boundedText(pkg.Name)}\0${version}`);
    }
    if (result.Class === 'os-pkgs') osPackages += packages.length;
    else applicationPackages += packages.length;
    for (const value of result.Vulnerabilities === undefined ? [] : list(result.Vulnerabilities, 20_000)) {
      const item = object(value), name = boundedText(item.PkgName);
      if (goSource && name === goSource.moduleName && sourceComponents.length) fail('unversioned-source-finding');
      const version = boundedText(item.InstalledVersion);
      const advisory = boundedText(item.VulnerabilityID, 100);
      const publicAdvisory = recognizedTrivyAdvisory(advisory, result.Class, type);
      if (!installed.has(`${name}\0${version}`)) fail('finding-outside-packages');
      const classification = classifyTrivyAdvisory(item, result.Class, type);
      if (findings.length >= 20_000) fail('report-too-large');
      const component = hash(name), encodedVersion = hash(version);
      findings.push({
        id: hash(`${coverage.id}\0${targetKey}\0${name}\0${version}\0${advisory}`),
        ...classification, tool: 'trivy', rule: publicAdvisory ? advisory : hash(`advisory\0${advisory}`), scope: coverage.id,
        component, version: encodedVersion, chains: [[component]],
        location: ['image', result.Class, ...(classification.kind === 'policy' ? [type] : []), hash(target).slice(7)],
        artifactDigest: image.id, owner: 'repository-maintainer'
      });
    }
  }
  if (coverage.os === 'required' ? osPackages === 0 : osPackages !== 0) fail('missing-os-coverage');
  if (coverage.application === 'required' ? applicationPackages === 0 : applicationPackages !== 0) {
    fail('missing-application-coverage');
  }
  if (new Set(findings.map(item => item.id)).size !== findings.length) fail('duplicate-finding');
  const assessment: ImageAssessment = {
    caseId: coverage.id, imageDigest: image.id, platform: image.platform, toolVersion: TRIVY_POLICY.version,
    databaseDigest, generatedAt, completedAt,
    coverage: { os: { status: coverage.os, packages: osPackages },
      application: { status: coverage.application, packages: applicationPackages } },
    findings, sourceComponents
  };
  if (Buffer.byteLength(JSON.stringify(assessment)) > 4 * 1024 * 1024) fail('report-too-large');
  return assessment;
}

export function imageSecurityReport(assessment: ImageAssessment, identity: EvidenceIdentity): SecurityReport {
  return parseSecurityReport(JSON.stringify({
    schemaVersion: 1, role: 'image-vulnerabilities', identity,
    tool: { name: 'trivy', version: assessment.toolVersion, database: assessment.databaseDigest },
    generatedAt: assessment.generatedAt, completedAt: assessment.completedAt, complete: true,
    units: [{ id: assessment.caseId, inputDigest: assessment.imageDigest,
      count: assessment.coverage.os.packages + assessment.coverage.application.packages, platform: assessment.platform }],
    findings: assessment.findings
  }));
}

export function trivyImageArguments(root: string, endpoint: string, imageId: string): string[] {
  safePath(root);
  privateImageEnvironment(root, endpoint);
  digest(imageId);
  return ['image', '--config', path.join(root, 'trivy.yaml'), '--cache-dir', path.join(root, 'cache', 'trivy'),
    '--quiet', '--image-src', 'docker', '--docker-host', endpoint,
    '--scanners', 'vuln', '--pkg-types', 'os,library', '--list-all-pkgs', '--format', 'json',
    '--ignorefile', path.join(root, 'empty'), '--cache-backend', 'memory', '--parallel', '1',
    '--offline-scan', '--skip-db-update', '--skip-java-db-update', '--skip-version-check', imageId];
}

async function fileDigest(file: string, maximum = 2 * 1024 * 1024 * 1024, allowEmpty = false): Promise<string> {
  const status = await lstat(file);
  if (!status.isFile() || status.isSymbolicLink() || await realpath(file) !== file ||
      status.size === 0 && !allowEmpty || status.size > maximum) fail('invalid-file');
  const result = createHash('sha256');
  for await (const chunk of createReadStream(file)) result.update(chunk);
  return `sha256:${result.digest('hex')}`;
}

async function download(url: string, maximum: number): Promise<Buffer> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
    if (!response.ok || !response.body) fail('download-failed');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) { chunks.forEach(value => value.fill(0)); fail('download-too-large'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch { return fail('download-failed'); }
}

/**
 * Only descendants of this freshly registered private root can be removed.
 * Enumeration registers tool-produced files, never invents assessment targets.
 * Symlinks are unlinked as entries, never followed; replacement aborts cleanup.
 */
async function privateRuntime(repositoryRoot: string, parent: string,
  plugins: readonly { name: 'docker-buildx' | 'docker-compose'; bytes: Uint8Array; digest: string }[]) {
  const repository = await realpath(safePath(repositoryRoot)), destination = await realpath(safePath(parent));
  const workspace = await createSecurityWorkspace(destination);
  if (inside(repository, workspace.root)) { await workspace.cleanup(); return fail('workspace-inside-source'); }
  const runId = randomUUID(), marker = JSON.stringify({ runId });
  await workspace.write(['run.json'], marker);
  const root = path.join(workspace.root, 'runtime');
  await mkdir(root, { mode: 0o700 });
  const rootIdentity = await lstat(root);
  const directoryIdentities = new Map<string, { ino: number; dev: number }>();
  for (const name of ['home', 'docker', 'buildx', 'scratch', 'tool', 'cache', 'contexts']) {
    const directory = path.join(root, name);
    await mkdir(directory, { mode: 0o700 });
    directoryIdentities.set(directory, await lstat(directory));
  }
  await writeFile(path.join(root, 'docker', 'config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  const pluginDirectory = path.join(root, 'docker', 'cli-plugins');
  await mkdir(pluginDirectory, { mode: 0o700 });
  directoryIdentities.set(pluginDirectory, await lstat(pluginDirectory));
  const pluginFiles: {
    name: 'docker-buildx' | 'docker-compose'; digest: string; path: string; identity: { ino: number; dev: number };
  }[] = [];
  for (const plugin of plugins) {
    const pluginPath = path.join(pluginDirectory, plugin.name);
    await writeFile(pluginPath, plugin.bytes, { flag: 'wx', mode: 0o700 });
    pluginFiles.push({ name: plugin.name, digest: plugin.digest, path: pluginPath, identity: await lstat(pluginPath) });
  }
  await writeFile(path.join(root, 'empty'), '', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(root, 'npm-userconfig'), '', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(root, 'npm-globalconfig'), '', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(root, 'trivy.yaml'), '{}\n', { flag: 'wx', mode: 0o600 });
  const configurations = [
    { file: path.join(root, 'docker', 'config.json'), contents: '{}\n' },
    { file: path.join(root, 'trivy.yaml'), contents: '{}\n' },
    { file: path.join(root, 'empty'), contents: '' },
    { file: path.join(root, 'npm-userconfig'), contents: '' },
    { file: path.join(root, 'npm-globalconfig'), contents: '' }
  ];
  const configurationIdentities = await Promise.all(configurations.map(async item => ({
    ...item, identity: await lstat(item.file)
  })));
  async function check() {
    await workspace.verify(['run.json'], marker);
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() ||
        current.ino !== rootIdentity.ino || current.dev !== rootIdentity.dev) fail('workspace-changed');
    for (const [directory, identity] of directoryIdentities) {
      const status = await lstat(directory);
      if (status.isSymbolicLink() || !status.isDirectory() ||
          status.ino !== identity.ino || status.dev !== identity.dev) fail('workspace-changed');
    }
    for (const item of configurationIdentities) {
      const status = await lstat(item.file);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
          status.ino !== item.identity.ino || status.dev !== item.identity.dev ||
          await readFile(item.file, 'utf8') !== item.contents) fail('configuration-changed');
    }
    for (const plugin of pluginFiles) {
      const currentPlugin = await lstat(plugin.path);
      if (!currentPlugin.isFile() || currentPlugin.isSymbolicLink() || currentPlugin.nlink !== 1 ||
          currentPlugin.ino !== plugin.identity.ino || currentPlugin.dev !== plugin.identity.dev ||
          await fileDigest(plugin.path, 128 * 1024 * 1024) !== plugin.digest) {
        fail(plugin.name === 'docker-buildx' ? 'buildx-plugin-drift' : 'compose-plugin-drift');
      }
    }
    if (JSON.stringify((await readdir(pluginDirectory)).sort()) !== JSON.stringify(pluginFiles.map(plugin => plugin.name).sort())) {
      fail(pluginFiles.length === 1 ? 'buildx-plugin-drift' : 'docker-plugin-drift');
    }
    for (const parts of [['docker', 'contexts'], ['buildx', 'instances'], ['buildx', 'defaults'], ['buildx', 'current']]) {
      const entry = path.join(root, ...parts);
      try {
        const status = await lstat(entry);
        if (!status.isDirectory() || status.isSymbolicLink() || (await readdir(entry)).length !== 0) {
          fail('unexpected-builder-configuration');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return {
    root, runId, check,
    async cleanup() {
      await check();
      const entries: { file: string; ino: number; dev: number; directory: boolean }[] = [];
      async function register(directory: string, depth: number) {
        if (depth > 100 || entries.length > 500_000) fail('cleanup-bound');
        for (const name of await readdir(directory)) {
          const file = path.join(directory, name), status = await lstat(file);
          if (!status.isFile() && !status.isDirectory() && !status.isSymbolicLink()) fail('cleanup-file-type');
          entries.push({ file, ino: status.ino, dev: status.dev, directory: status.isDirectory() });
          if (status.isDirectory()) await register(file, depth + 1);
        }
      }
      await register(root, 0);
      for (const entry of entries) {
        const status = await lstat(entry.file);
        if (status.ino !== entry.ino || status.dev !== entry.dev || status.isDirectory() !== entry.directory) {
          fail('cleanup-drift');
        }
      }
      if (!constants.O_DIRECTORY || !constants.O_NOFOLLOW) fail('cleanup-filesystem-unqualified');
      for (const entry of entries.filter(entry => entry.directory)) {
        if (!inside(root, entry.file) || await realpath(entry.file) !== entry.file) fail('cleanup-drift');
        const handle = await open(entry.file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const status = await handle.stat();
          if (!status.isDirectory() || status.ino !== entry.ino || status.dev !== entry.dev ||
              status.uid !== rootIdentity.uid) fail('cleanup-drift');
          await handle.chmod(0o700);
        } finally { await handle.close(); }
      }
      for (const entry of entries.filter(entry => !entry.directory)) await unlink(entry.file);
      for (const entry of entries.filter(entry => entry.directory).reverse()) await rmdir(entry.file);
      await rmdir(root);
      await workspace.cleanup();
    }
  };
}

export interface LocalImageSessionOptions {
  repositoryRoot: string;
  workspaceParent: string;
  dockerExecutable: string;
  dockerEndpoint: string;
  buildxPlugin: { executable: string; digest: string };
  composePlugin?: { executable: string; digest: string };
  pythonExecutable?: string;
  cases: readonly string[];
  scratchFixture?: boolean;
}

export async function createLocalImageSession(options: LocalImageSessionOptions) {
  const endpoint = await validateLocalDockerEndpoint(options.dockerEndpoint);
  if (!options.cases.length || options.cases.length > 100 || new Set(options.cases).size !== options.cases.length ||
      options.cases.some(id => id === 'scratch-package-fixture'
    ? !options.scratchFixture : !imageCases.some(entry => entry.id === id))) fail('unregistered-image');
  const dockerExecutable = await realpath(safePath(options.dockerExecutable));
  if (!options.buildxPlugin) fail('missing-buildx-plugin-pin');
  const pluginPath = await realpath(safePath(options.buildxPlugin.executable));
  const pluginStat = await lstat(pluginPath);
  const buildxPluginDigest = digest(options.buildxPlugin.digest);
  if (!pluginStat.isFile() || pluginStat.size < 1 || pluginStat.size > 128 * 1024 * 1024 ||
      (pluginStat.mode & 0o022) !== 0 || (pluginStat.mode & 0o111) === 0) fail('unsafe-buildx-plugin');
  const pluginBytes = await readFile(pluginPath);
  if (hash(pluginBytes) !== buildxPluginDigest) { pluginBytes.fill(0); fail('buildx-plugin-identity-mismatch'); }
  let composeBytes: Buffer | undefined, composePluginDigest: string | undefined;
  let owned: Awaited<ReturnType<typeof privateRuntime>>;
  try {
    if (options.composePlugin) {
      const file = await realpath(safePath(options.composePlugin.executable)), status = await lstat(file);
      composePluginDigest = digest(options.composePlugin.digest);
      if (!status.isFile() || status.size < 1 || status.size > 128 * 1024 * 1024 ||
          (status.mode & 0o022) !== 0 || (status.mode & 0o111) === 0) fail('unsafe-compose-plugin');
      composeBytes = await readFile(file);
      if (hash(composeBytes) !== composePluginDigest) fail('compose-plugin-identity-mismatch');
    }
    owned = await privateRuntime(options.repositoryRoot, options.workspaceParent, [
      { name: 'docker-buildx', bytes: pluginBytes, digest: buildxPluginDigest },
      ...(composeBytes && composePluginDigest
        ? [{ name: 'docker-compose' as const, bytes: composeBytes, digest: composePluginDigest }] : [])
    ]);
  } finally { pluginBytes.fill(0); composeBytes?.fill(0); }
  const registry = createImageRegistry(owned.runId, options.cases);
  const environment = Object.freeze(privateImageEnvironment(owned.root, endpoint));
  const containers = new Map<string, { id?: string; image: string; caseId: string }>();
  const goSourceBindings = new Map<string, GoImageSourceBinding>();
  const healthInputs = new Map<string, { caseId: string; target: 'backend' | 'frontend'; artifactInventoryDigest: string; dockerfileDigest: string }>();
  let executable: string | undefined, executableDigest: string | undefined, databaseDigest: string | undefined;
  let databaseMetadata: TrivyDatabaseMetadata | undefined;
  let pythonPreparation: Awaited<ReturnType<typeof restoreImagePythonPreparation>> | undefined;
  let daemonPin: { idDigest: string; version: string; os: string; architecture: string } | undefined;
  let builderPin: { buildxVersion: string; builder: LocalBuilderIdentity } | undefined;
  const dockerBinaryDigest = await fileDigest(dockerExecutable, 512 * 1024 * 1024);
  const socketIdentity = await lstat(endpoint.slice('unix://'.length));
  const prefixDocker = (args: readonly string[]) => ['--host', endpoint, '--config', environment.DOCKER_CONFIG!, ...args];
  const dockerArgs = (args: readonly string[]) => {
    if (args[0] === 'compose' && !composePluginDigest) fail('unqualified-compose-plugin');
    if (args[0] === 'compose' && ![
      ['version', '--short'], ['config', '-q'], ['--profile', 'observability', 'config', '-q']
    ].some(allowed => JSON.stringify(args.slice(1)) === JSON.stringify(allowed))) fail('uncontrolled-docker-command');
    if (!['version', 'info', 'image', 'container', 'compose', 'run', 'port', 'inspect', 'cp', 'stop'].includes(args[0] ?? '') ||
        args.some(arg => /^(?:--(?:host|context|config|builder|cache-to|cache-from|output|push|export-cache|import-cache)|-H)(?:=|$)/.test(arg))) {
      fail('uncontrolled-docker-command');
    }
    return prefixDocker(args);
  };
  const execute = async (file: string, args: readonly string[], overrides: Partial<PrivateProcessOptions> = {}) => {
    await owned.check();
    await validateLocalDockerEndpoint(endpoint);
    const socket = await lstat(endpoint.slice('unix://'.length));
    if (socket.ino !== socketIdentity.ino || socket.dev !== socketIdentity.dev) fail('daemon-socket-drift');
    return captureTrivyProcess(file, args, { cwd: owned.root, ...overrides, environment });
  };
  const rawDocker = async (args: readonly string[], overrides: Partial<PrivateProcessOptions> = {}) => {
    if (await fileDigest(dockerExecutable, 512 * 1024 * 1024) !== dockerBinaryDigest) fail('docker-cli-drift');
    return execute(dockerExecutable, prefixDocker(args), overrides);
  };
  async function readDaemon() {
    const output = await rawDocker(['info', '--format',
      '{"id":{{json .ID}},"version":{{json .ServerVersion}},"os":{{json .OSType}},"architecture":{{json .Architecture}}}'],
    { maxBytes: 4096, timeoutMs: 15_000 });
    try {
      const value = object(JSON.parse(output.toString()));
      const id = boundedText(value.id, 200), version = boundedText(value.version, 60);
      if (!/^[A-Za-z0-9:-]+$/.test(id) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) ||
          value.os !== 'linux' || !['amd64', 'arm64', 'x86_64', 'aarch64'].includes(String(value.architecture))) {
        fail('unsupported-daemon');
      }
      return { idDigest: hash(id), version, os: 'linux', architecture: String(value.architecture) };
    } catch { return fail('invalid-daemon-report'); }
    finally { output.fill(0); }
  }
  async function verifyDaemon() {
    const observed = await readDaemon();
    if (!daemonPin || JSON.stringify(observed) !== JSON.stringify(daemonPin)) fail('daemon-identity-drift');
  }
  const docker = async (args: readonly string[], overrides: Partial<PrivateProcessOptions> = {}) => {
    dockerArgs(args);
    if (daemonPin) await verifyDaemon();
    return rawDocker(args, overrides);
  };
  const jsonDocker = async (args: readonly string[]) => {
    const output = await docker(args, { maxBytes: 1024 * 1024, timeoutMs: 30_000 });
    try { return JSON.parse(output.toString()) as unknown; }
    catch { return fail('invalid-docker-report'); }
    finally { output.fill(0); }
  };
  function labels(value: unknown, caseId: string) {
    const observed = object(value);
    if (observed[TRIVY_POLICY.ownerLabel] !== owned.runId || observed[TRIVY_POLICY.caseLabel] !== caseId) {
      fail('ownership-mismatch');
    }
  }
  const inspect = async (tag: string): Promise<LocalImageIdentity> => {
    const caseId = options.cases.find(id => registry.tagFor(id) === tag);
    if (!caseId) return fail('unregistered-image');
    const values = list(await jsonDocker(['image', 'inspect', tag]), 1);
    if (values.length !== 1) fail('image-not-built');
    const value = object(values[0]);
    labels(object(value.Config).Labels, caseId);
    const platform = `${value.Os}/${value.Architecture}`;
    const expected = caseId === 'scratch-package-fixture' ? 'linux/amd64' : imageCoverage(caseId).platform;
    if (platform !== expected || !list(value.RepoTags).includes(tag)) fail('platform-or-tag-mismatch');
    return { tag, id: digest(value.Id), platform: platform as LocalImageIdentity['platform'] };
  };
  const operations = {
    inspect, removeTag: async (tag: string) => { (await docker(['image', 'rm', '--no-prune', tag])).fill(0); }
  };
  async function inspectContainer(name: string) {
    const expected = containers.get(name);
    if (!expected) return fail('unregistered-container');
    const values = list(await jsonDocker(['container', 'inspect', name]), 1);
    if (values.length !== 1) fail('container-cleanup-drift');
    const value = object(values[0]);
    labels(object(value.Config).Labels, expected.caseId);
    if (value.Name !== `/${name}` || value.Image !== expected.image || !/^[a-f0-9]{64}$/.test(String(value.Id)) ||
        expected.id && value.Id !== expected.id) fail('container-cleanup-drift');
    return { ...expected, id: String(value.Id) };
  }
  async function removeContainer(name: string) {
    if (!containers.has(name)) fail('unregistered-container');
    const output = await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
      { maxBytes: 4096, timeoutMs: 30_000 });
    try {
      if (!output.toString().trim()) { containers.delete(name); return; }
      const expected = await inspectContainer(name);
      if (output.toString().trim() !== expected.id) fail('container-cleanup-drift');
      (await docker(['container', 'rm', '--force', expected.id])).fill(0);
      containers.delete(name);
    } finally { output.fill(0); }
  }
  async function tool(args: readonly string[], overrides: Partial<PrivateProcessOptions> = {}) {
    if (!executable || !executableDigest || await fileDigest(executable, 512 * 1024 * 1024) !== executableDigest) {
      return fail('unverified-tool');
    }
    return execute(executable, args, overrides);
  }
  const common = ['--config', path.join(owned.root, 'trivy.yaml'), '--cache-dir', path.join(owned.root, 'cache', 'trivy'),
    '--quiet'];
  const databasePath = path.join(owned.root, 'cache', 'trivy', 'db', 'trivy.db');
  async function validateDatabase() {
    let metadata: Record<string, unknown>;
    try {
      const file = path.join(path.dirname(databasePath), 'metadata.json');
      if (await realpath(file) !== file || (await lstat(file)).size > 4096) fail('invalid-database-metadata');
      metadata = object(JSON.parse(await readFile(file, 'utf8')));
    }
    catch { return fail('missing-database'); }
    const updated = Date.parse(boundedText(metadata.UpdatedAt)), downloaded = Date.parse(boundedText(metadata.DownloadedAt));
    const next = Date.parse(boundedText(metadata.NextUpdate));
    if (metadata.Version !== 2 || !Number.isFinite(updated) || !Number.isFinite(downloaded) ||
        !Number.isFinite(next) || next < Date.now() ||
        downloaded > Date.now() || updated > Date.now() || Date.now() - downloaded > TRIVY_POLICY.databaseMaxAgeMs ||
        Date.now() - updated > TRIVY_POLICY.databaseMaxAgeMs) fail('stale-database');
    return {
      digest: await fileDigest(databasePath),
      metadata: { version: 2 as const, updatedAt: new Date(updated).toISOString(),
        downloadedAt: new Date(downloaded).toISOString(), nextUpdate: new Date(next).toISOString() }
    };
  }
  async function readBuilder() {
    await verifyDaemon();
    const context = await rawDocker(['context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}'],
      { maxBytes: 4096, timeoutMs: 15_000 });
    try {
      if (JSON.parse(context.toString()) !== endpoint) fail('default-context-endpoint-mismatch');
    } finally { context.fill(0); }
    const version = await rawDocker(['buildx', 'version'], { maxBytes: 4096, timeoutMs: 15_000 });
    let buildxVersion: string;
    try {
      buildxVersion = version.toString().trim();
      if (!/^github\.com\/docker\/buildx v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)? [a-f0-9]{40}$/.test(buildxVersion)) {
        fail('unsupported-buildx-version');
      }
    } finally { version.fill(0); }
    const inspected = await rawDocker(['buildx', 'inspect', 'default'], { maxBytes: 65_536, timeoutMs: 30_000 });
    try {
      return { buildxVersion, builder: normalizeLocalBuilderInspection(inspected.toString(), endpoint) };
    } finally { inspected.fill(0); }
  }
  async function verifyBuilder() {
    const observed = await readBuilder();
    if (!builderPin || JSON.stringify(observed) !== JSON.stringify(builderPin)) fail('builder-identity-drift');
  }
  try {
    const server = object(await jsonDocker(['version', '--format', '{{json .Server}}']));
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(boundedText(server.Version)) ||
        server.Os !== 'linux' || !['amd64', 'arm64'].includes(String(server.Arch))) fail('unsupported-daemon');
    daemonPin = await readDaemon();
    if (daemonPin.version !== server.Version) fail('daemon-version-mismatch');
  } catch {
    await owned.cleanup();
    return fail('local-daemon-unavailable');
  }
  try { builderPin = await readBuilder(); }
  catch (error) {
    await owned.cleanup();
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('local-builder-unqualified');
  }
  let composeVersion: string | undefined;
  if (composePluginDigest) {
    try {
      const output = await rawDocker(['compose', 'version', '--short'], { maxBytes: 4096, timeoutMs: 15_000 });
      try {
        composeVersion = output.toString().trim();
        if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(composeVersion)) fail('unsupported-compose-version');
      } finally { output.fill(0); }
    } catch (error) {
      await owned.cleanup();
      throw error;
    }
  }
  return {
    root: owned.root, runId: owned.runId, environment, dockerExecutable, dockerArgs,
    locality() {
      return structuredClone({ dockerBinaryDigest, buildxPluginDigest, composePluginDigest, composeVersion, endpointDigest: hash(endpoint), daemon: daemonPin,
        ...builderPin, dockerContext: 'absent', buildxSelection: 'explicit-default', buildkit: 'required' });
    },
    verifyBuilder,
    async preparePython(project: string, functions: boolean) {
      if (!options.pythonExecutable) fail('missing-python-interpreter');
      pythonPreparation ??= await restoreImagePythonPreparation(owned.root, options.pythonExecutable, execute);
      await pythonPreparation.prepare(project, functions);
      return pythonPreparation.identity;
    },
    tagFor: registry.tagFor,
    records: registry.records,
    docker,
    async build(caseId: string, build: LocalBuildOptions) {
      const tag = registry.tagFor(caseId);
      const context = await realpath(safePath(build.context));
      if (!inside(path.join(owned.root, 'contexts'), context) || context !== build.context ||
          build.network !== undefined && build.network !== 'none' ||
          build.registryKind !== undefined && !['npm', 'python'].includes(build.registryKind)) fail('unregistered-build-context');
      const dockerfile = path.join(context, ...portableParts(build.dockerfile ?? ['Dockerfile']));
      if (await realpath(dockerfile) !== dockerfile || !(await lstat(dockerfile)).isFile()) fail('unsafe-dockerfile');
      const dockerfileDigest = await fileDigest(dockerfile, 65_536);
      const generatedInput = build.generatedInput ? structuredClone(build.generatedInput) : undefined;
      if (generatedInput) {
        const selected = generatedSecurityCases.find(entry => entry.id === generatedInput.caseId);
        if (!selected || !['backend', 'frontend'].includes(generatedInput.target) ||
            generatedInput.target === 'frontend' && !selected.options.includeFrontend) fail('health-input-scope');
        digest(generatedInput.artifactInventoryDigest);
        await verifyGeneratedArtifactBinding(generatedInput, context, filename => fileDigest(filename, 8 * 1024 * 1024, true));
      }
      let goSource: GoImageSourceBinding | undefined;
      if (caseId === 'go') {
        const moduleFile = path.join(context, 'backend', 'go.mod');
        const moduleDigest = await fileDigest(moduleFile, 65_536);
        goSource = generatedGoSourceBinding(await readFile(moduleFile, 'utf8'));
        if (goSource.moduleDigest !== moduleDigest) fail('go-source-module-drift');
      }
      await verifyBuilder();
      const registryArgs = build.registryKind === 'npm'
        ? ['--build-arg', 'NPM_CONFIG_REGISTRY=https://registry.npmjs.org']
        : build.registryKind === 'python' ? ['--build-arg', 'UV_DEFAULT_INDEX=https://pypi.org/simple'] : [];
      const output = await rawDocker(['buildx', 'build', '--builder', 'default', '--load', '--pull=false',
        '--platform', 'linux/amd64', '--label', `${TRIVY_POLICY.ownerLabel}=${owned.runId}`,
        '--label', `${TRIVY_POLICY.caseLabel}=${caseId}`, '--tag', tag, '--file', dockerfile,
        ...registryArgs, ...(build.network === 'none' ? ['--network', 'none'] : []), '.'],
      { cwd: context, discardStderr: true, timeoutMs: 20 * 60_000 });
      output.fill(0);
      await verifyBuilder();
      if (await fileDigest(dockerfile, 65_536) !== dockerfileDigest) fail('dockerfile-input-drift');
      if (generatedInput) await verifyGeneratedArtifactBinding(generatedInput, context, filename => fileDigest(filename, 8 * 1024 * 1024, true));
      if (generatedInput) healthInputs.set(caseId, { ...generatedInput, dockerfileDigest });
      if (goSource) {
        if (await fileDigest(path.join(context, 'backend', 'go.mod'), 65_536) !== goSource.moduleDigest) fail('go-source-module-drift');
        goSourceBindings.set(caseId, goSource);
      }
    },
    async proveGeneratedHealth(caseId: string, name: string): Promise<GeneratedImageHealth> {
      const input = healthInputs.get(caseId);
      if (!input) fail('health-input-unregistered');
      const container = await inspectContainer(name), image = await registry.verify(caseId, operations);
      if (container.caseId !== caseId || container.image !== image.id) fail('health-image-mismatch');
      const values = list(await jsonDocker(['container', 'inspect', name]), 1);
      const details = object(values[0]);
      if (object(details.State).Running !== true) fail('health-container-not-running');
      const ports = object(object(details.NetworkSettings).Ports);
      const bindings = list(ports[input.target === 'frontend' ? '80/tcp' : '8000/tcp'], 1);
      if (bindings.length !== 1) fail('health-port-binding');
      const binding = object(bindings[0]);
      if (binding.HostIp !== '127.0.0.1' || typeof binding.HostPort !== 'string' || !/^[1-9][0-9]{0,4}$/.test(binding.HostPort)) {
        fail('health-port-binding');
      }
      const checks = await verifyGeneratedHealthResponses(`http://127.0.0.1:${binding.HostPort}`, input.target === 'frontend');
      if ((await inspectContainer(name)).id !== container.id ||
          (await registry.verify(caseId, operations)).id !== image.id) fail('health-subject-drift');
      const proof: GeneratedImageHealth = Object.freeze({
        kind: 'issued-local-generated-image-health', generatedCase: input.caseId, target: input.target,
        artifactInventoryDigest: input.artifactInventoryDigest, dockerfileDigest: input.dockerfileDigest,
        imageDigest: image.id, platform: image.platform, runId: owned.runId, completedAt: new Date().toISOString(),
        checks: Object.freeze([...checks]), externalServicesQualified: false, orchestratorProbesClaimed: false
      });
      issuedHealth.set(proof, hash(JSON.stringify(proof)));
      return proof;
    },
    async prepareContext(caseId: string, inputs: readonly (readonly string[])[]) {
      registry.tagFor(caseId);
      if (inputs.length === 0 || inputs.length > 100) fail('invalid-context-inventory');
      const source = await realpath(options.repositoryRoot);
      const context = path.join(owned.root, 'contexts', caseId);
      await mkdir(context, { mode: 0o700 });
      const files = new Map<string, string>();
      async function copy(parts: string[]) {
        const file = path.join(source, ...parts), target = path.join(context, ...parts);
        if (await realpath(file) !== file) fail('context-symlink');
        const status = await lstat(file);
        if (status.isDirectory()) {
          for (const child of await readdir(file)) await copy(portableParts([...parts, child]));
        } else {
          if (!status.isFile() || status.nlink !== 1 || status.size > 8 * 1024 * 1024 ||
              files.size > 1_000 || files.has(parts.join('/'))) fail('invalid-context-input');
          const content = await readFile(file);
          files.set(parts.join('/'), hash(content));
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, content, { flag: 'wx', mode: 0o600 });
          content.fill(0);
        }
      }
      for (const parts of inputs) await copy(portableParts(parts));
      return {
        root: context,
        async verify() {
          for (const [file, expected] of files) {
            if (await fileDigest(path.join(source, ...file.split('/'))) !== expected ||
                await fileDigest(path.join(context, ...file.split('/'))) !== expected) fail('context-input-changed');
          }
        }
      };
    },
    buildIdentityArgs(caseId: string) {
      registry.tagFor(caseId);
      return ['--platform', 'linux/amd64', '--label', `${TRIVY_POLICY.ownerLabel}=${owned.runId}`,
        '--label', `${TRIVY_POLICY.caseLabel}=${caseId}`];
    },
    containerIdentityArgs(caseId: string) {
      registry.tagFor(caseId);
      return ['--pull=never', '--platform', 'linux/amd64', '--label', `${TRIVY_POLICY.ownerLabel}=${owned.runId}`,
        '--label', `${TRIVY_POLICY.caseLabel}=${caseId}`];
    },
    async registerBuilt(caseId: string) {
      const image = await inspect(registry.tagFor(caseId));
      registry.register(caseId, image);
      return image;
    },
    async reserveContainer(caseId: string) {
      const image = await registry.verify(caseId, operations);
      const name = `liftoff-security-${owned.runId}-${caseId}`;
      if (containers.has(name)) fail('duplicate-container');
      containers.set(name, { image: image.id, caseId });
      return name;
    },
    async registerContainer(caseId: string, name: string) {
      const expected = containers.get(name);
      if (!expected || expected.caseId !== caseId || expected.id) fail('unregistered-container');
      containers.set(name, await inspectContainer(name));
    },
    removeContainer,
    async restoreTool() {
      if (executable) fail('tool-already-restored');
      const platform = `${process.platform}-${process.arch}` as keyof typeof TRIVY_ARCHIVES;
      const pin = TRIVY_ARCHIVES[platform];
      if (!pin) return fail('unsupported-host');
      const archive = await download(`https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_POLICY.version}/${pin.asset}`,
        100 * 1024 * 1024);
      if (hash(archive) !== `sha256:${pin.sha256}`) { archive.fill(0); return fail('checksum-mismatch'); }
      const archivePath = path.join(owned.root, 'tool', pin.asset);
      await writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 });
      archive.fill(0);
      const binary = await execute('/usr/bin/tar', ['-xOzf', archivePath, 'trivy'],
        { maxBytes: 512 * 1024 * 1024, discardStderr: true });
      executableDigest = hash(binary);
      executable = path.join(owned.root, 'tool', 'trivy');
      await writeFile(executable, binary, { flag: 'wx', mode: 0o700 });
      binary.fill(0);
      await chmod(executable, 0o700);
      const version = await tool(['--quiet', '--version'], { maxBytes: 4096 });
      try {
        if (version.toString().trim() !== `Version: ${TRIVY_POLICY.version}`) fail('version-mismatch');
      } finally { version.fill(0); }
      return { version: TRIVY_POLICY.version, archiveDigest: `sha256:${pin.sha256}`, executableDigest };
    },
    async refreshDatabase() {
      const output = await tool(['image', ...common, '--download-db-only', '--db-repository', TRIVY_POLICY.databaseRepository,
        '--skip-java-db-update', '--skip-version-check'], { maxBytes: 1024 * 1024 });
      output.fill(0);
      const database = await validateDatabase();
      databaseDigest = database.digest;
      databaseMetadata = database.metadata;
      return databaseDigest;
    },
    async assess(caseId: string): Promise<ImageAssessment & { databaseMetadata: TrivyDatabaseMetadata }> {
      const image = await registry.verify(caseId, operations);
      const before = await validateDatabase();
      if (!databaseDigest || !databaseMetadata || before.digest !== databaseDigest ||
          JSON.stringify(before.metadata) !== JSON.stringify(databaseMetadata)) fail('database-drift');
      const coverage: ImageCoverage = caseId === 'scratch-package-fixture'
        ? { id: caseId, platform: 'linux/amd64', os: 'inapplicable-scratch-fixture', application: 'required' }
        : imageCoverage(caseId);
      const started = new Date().toISOString();
      const output = await tool(trivyImageArguments(owned.root, endpoint, image.id));
      try {
        await registry.verify(caseId, operations);
        const after = await validateDatabase();
        if (after.digest !== databaseDigest ||
            JSON.stringify(after.metadata) !== JSON.stringify(databaseMetadata)) fail('database-drift');
        return { ...normalizeTrivyReport(output, image, coverage, databaseDigest, started, new Date().toISOString(), goSourceBindings.get(caseId)),
          databaseMetadata };
      } catch (error) {
        if (error instanceof SecurityEvidenceError) throw new TrivyReportError(error.code, output);
        throw error;
      } finally { output.fill(0); }
    },
    async cleanup() {
      for (const name of containers.keys()) await removeContainer(name);
      // A timed-out build can finish tagging before its client exits. Reconcile
      // only pre-registered unique tags and verify labels/digest/platform first.
      for (const caseId of options.cases) {
        const tag = registry.tagFor(caseId);
        if (registry.records().some(image => image.tag === tag)) continue;
        const output = await docker(['image', 'ls', '--no-trunc', '--filter', `reference=${tag}`, '--format', '{{.ID}}'],
          { maxBytes: 4096, timeoutMs: 30_000 });
        try {
          const id = output.toString().trim();
          if (!id) continue;
          digest(id);
          const observed = await inspect(tag);
          if (observed.id !== id) fail('image-cleanup-drift');
          registry.register(caseId, observed);
        } finally { output.fill(0); }
      }
      await registry.cleanup(operations);
      await owned.cleanup();
    }
  };
}

/**
 * Both existing smoke scripts retain their default behavior. To add real local
 * assessment set LIFTOFF_TRIVY_LOCAL=1, LIFTOFF_DOCKER_UNIX_ENDPOINT,
 * LIFTOFF_DOCKER_EXECUTABLE (absolute CLI path), and
 * LIFTOFF_SECURITY_WORKSPACE_PARENT (existing directory outside the checkout).
 * LIFTOFF_BUILDX_EXECUTABLE and LIFTOFF_BUILDX_SHA256 pin a separately verified
 * builder plugin. Generated Compose validation additionally requires the exact
 * LIFTOFF_COMPOSE_EXECUTABLE and LIFTOFF_COMPOSE_SHA256. Only verified plugin
 * bytes are copied into private discovery; no global Docker config is copied.
 * The default buildx builder must already be available, running, use the docker
 * driver and resolve to that exact daemon in fresh private configuration.
 * No bootstrap, legacy-builder fallback, remote driver/cache export or inherited
 * context/builder selection is permitted. Tool/database/context roots are private.
 * Neither this opt-in nor a scratch fixture qualifies hosted/fork/other-OS runs.
 */
export async function localImageSessionFromEnvironment(repositoryRoot: string, cases: readonly string[]) {
  if (process.env.LIFTOFF_TRIVY_LOCAL !== '1') return undefined;
  const dockerEndpoint = process.env.LIFTOFF_DOCKER_UNIX_ENDPOINT;
  const dockerExecutable = process.env.LIFTOFF_DOCKER_EXECUTABLE;
  const workspaceParent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
  const buildxExecutable = process.env.LIFTOFF_BUILDX_EXECUTABLE;
  const buildxDigest = process.env.LIFTOFF_BUILDX_SHA256;
  const composeExecutable = process.env.LIFTOFF_COMPOSE_EXECUTABLE;
  const composeDigest = process.env.LIFTOFF_COMPOSE_SHA256;
  const pythonExecutable = process.env.LIFTOFF_PYTHON_EXECUTABLE;
  if (!dockerEndpoint || !dockerExecutable || !workspaceParent || !buildxExecutable || !buildxDigest) fail('missing-local-configuration');
  if (cases.some(id => id !== 'telemetry-ingest') && (!composeExecutable || !composeDigest) ||
      Boolean(composeExecutable) !== Boolean(composeDigest)) fail('missing-compose-plugin-pin');
  return createLocalImageSession({ repositoryRoot, cases, dockerEndpoint, dockerExecutable, workspaceParent,
    buildxPlugin: { executable: buildxExecutable, digest: buildxDigest },
    ...(pythonExecutable ? { pythonExecutable } : {}),
    ...(composeExecutable && composeDigest ? { composePlugin: { executable: composeExecutable, digest: composeDigest } } : {}) });
}

/** Builds, but never runs, real public package bytes in a scratch image. */
export async function qualifyLocalTrivyFixture(options: Omit<LocalImageSessionOptions, 'cases' | 'scratchFixture'>) {
  const session = await createLocalImageSession({ ...options, cases: ['scratch-package-fixture'], scratchFixture: true });
  try {
    const tool = await session.restoreTool();
    const databaseDigest = await session.refreshDatabase();
    const context = path.join(session.root, 'contexts', 'scratch-package-fixture');
    await mkdir(context, { mode: 0o700 });
    const archive = await download(TRIVY_FIXTURE.url, 2 * 1024 * 1024);
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    if (integrity !== TRIVY_FIXTURE.integrity) { archive.fill(0); return fail('fixture-integrity-mismatch'); }
    const archivePath = path.join(context, 'lodash.tgz');
    await writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 });
    archive.fill(0);
    const processOptions = { cwd: context, environment: session.environment, maxBytes: 1024 * 1024 };
    const entries = await captureTrivyProcess('/usr/bin/tar', ['-tzf', archivePath], processOptions);
    try {
      if (!entries.toString().trim().split('\n').every(entry =>
        /^package\/(?:fp\/)?[A-Za-z0-9_.-]+$/.test(entry) && portableParts(entry.split('/')).length >= 2)) {
        fail('fixture-archive-path');
      }
    } finally { entries.fill(0); }
    (await captureTrivyProcess('/usr/bin/tar', ['-xzf', archivePath, '--no-same-owner'], processOptions)).fill(0);
    await writeFile(path.join(context, 'Dockerfile'),
      'FROM scratch\nCOPY package/ /app/node_modules/lodash/\nCMD ["/never-execute-fixture"]\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(context, '.dockerignore'), '*\n!package/**\n!Dockerfile\n', { flag: 'wx', mode: 0o600 });
    await session.build('scratch-package-fixture', { context, network: 'none' });
    const image = await session.registerBuilt('scratch-package-fixture');
    const assessment = await session.assess('scratch-package-fixture');
    if (!assessment.findings.some(finding => finding.rule === TRIVY_FIXTURE.advisory &&
      (finding.severity === 'high' || finding.severity === 'critical'))) fail('fixture-not-detected');
    return { tool, databaseDigest, image, assessment, locality: session.locality(), cleanup: 'completed' as const };
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('fixture-failed');
  } finally { await session.cleanup(); }
}

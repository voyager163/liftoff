import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { verifyInstalledArchiveFiles, inspectPackageArchive } from '../package-smoke-artifact.mjs';
import { canonicalDigest } from './admission.ts';
import { SecurityEvidenceError } from './evidence.ts';
import { createPrivatePackageWorkspace, capturePrivateFixtureProcess } from './gitleaks.ts';
import { verifyCandidateBytes, type NpmCandidate } from './npm-release.ts';
import { normalizeNpmAuditReport, evaluateTemplateDependencyAudits } from '../template-dependency-security.mjs';
import { npmRawFindings } from './npm-policy.ts';

const hash = (value: Uint8Array | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const wrapperName = 'liftoff-qualification-runtime';
function fail(code: string): never { throw new SecurityEvidenceError(`npm-runtime-${code}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('schema');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) return fail('schema');
  return value;
}
export function npmComponentCoordinate(name: unknown, version: unknown) {
  if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
      name.length > 200 || typeof version !== 'string' || version.length > 200 ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)*$/.test(version) || /[\r\n]/.test(name + version)) fail('coordinate');
  return { name, version, ref: `${name}@${version}` };
}
function json(source: string): unknown {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 4 * 1024 * 1024) fail('size');
  try { return JSON.parse(source); } catch { return fail('json'); }
}

function excludedByPlatform(entry: Record<string, unknown>) {
  let excluded = false;
  for (const [field, actual, known] of [
    ['os', process.platform, ['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'netbsd']],
    ['cpu', process.arch, ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64']]
  ] as const) {
    if (entry[field] === undefined) continue;
    const values = list(entry[field]);
    if (!values.length || values.some(value => typeof value !== 'string' ||
        !known.some(name => name === value || `!${name}` === value))) fail('platform-condition');
    const positives = values.filter(value => typeof value === 'string' && !value.startsWith('!'));
    excluded ||= values.includes(`!${actual}`) || positives.length > 0 && !positives.includes(actual);
  }
  return excluded;
}

export function validatePackedRuntimeManifest(source: string) {
  const manifest = object(json(source));
  if (manifest.workspaces !== undefined || manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) {
    fail('unsupported-bundled-or-workspace-runtime');
  }
  const names = new Set<string>();
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (manifest[field] === undefined) continue;
    for (const [name, range] of Object.entries(object(manifest[field]))) {
      npmComponentCoordinate(name, '0.0.0');
      if (names.has(name) || typeof range !== 'string' || range.length > 200 ||
          !/^[~^<>=0-9A-Za-z.*+| -]+$/.test(range) || !/[0-9]+\.[0-9]+\.[0-9]+/.test(range) ||
          /[\r\n]/.test(range)) fail('nonregistry-runtime-dependency');
      names.add(name);
    }
  }
  if (!names.size) fail('empty-runtime-dependencies');
  return [...names].sort();
}

/** Reconcile native installed-tree SBOM coordinates and edges against the exact private install lock. */
export function normalizePackedRuntimeSbom(source: string, lockSource: string, candidate: NpmCandidate, npmVersion: string) {
  const bom = object(json(source)), metadata = object(bom.metadata), root = object(metadata.component);
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5' || bom.version !== 1 ||
      root.name !== wrapperName || root.version !== '0.0.0' || root['bom-ref'] !== `${wrapperName}@0.0.0`) fail('root');
  const tools = list(metadata.tools);
  if (tools.length !== 1 || object(tools[0]).vendor !== 'npm' ||
      object(tools[0]).name !== 'cli' || object(tools[0]).version !== npmVersion) fail('tool');
  const components = list(bom.components).map(value => {
    const item = object(value), parsed = npmComponentCoordinate(item.name, item.version);
    const expectedPurl = `pkg:npm/${parsed.name.startsWith('@') ? parsed.name.replace('@', '%40') : parsed.name}@${parsed.version}`;
    if (item['bom-ref'] !== parsed.ref || item.purl !== expectedPurl ||
        !['required', 'optional'].includes(String(item.scope))) fail('component');
    return { type: 'library', 'bom-ref': parsed.ref, name: parsed.name, version: parsed.version,
      purl: expectedPurl, scope: item.scope };
  });
  if (!components.length || new Set(components.map(item => item['bom-ref'])).size !== components.length) fail('components');
  const lock = object(json(lockSource)), packages = object(lock.packages);
  if (lock.lockfileVersion !== 3 || lock.name !== wrapperName || lock.version !== '0.0.0' ||
      object(packages['']).name !== wrapperName) fail('lock');
  const excludedOptional: { name: string; version: string; ref: string; locationDigest: string; reason: string }[] = [];
  const inventory = Object.entries(packages).filter(([key]) => key !== '').flatMap(([key, value]) => {
    if (!key.startsWith('node_modules/') || /[\\\r\n\0]/.test(key) || key.split('/').some(part => part === '..' || !part)) fail('lock-path');
    const entry = object(value), name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 13);
    if (entry.link === true || entry.dev === true) fail('unsupported-runtime-entry');
    const parsed = npmComponentCoordinate(name, entry.version);
    if (!components.some(item => item['bom-ref'] === parsed.ref)) {
      if (entry.optional !== true || !excludedByPlatform(entry)) fail('missing-component');
      excludedOptional.push({ ...parsed, locationDigest: hash(key), reason: 'explicit-lock-os-or-cpu-condition-not-this-install-platform' });
      return [];
    }
    if (parsed.name === candidate.artifact.name) {
      if (parsed.version !== candidate.artifact.version || entry.integrity !== candidate.artifact.integrity) fail('artifact-binding');
    } else {
      if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/') ||
          new URL(entry.resolved).origin !== 'https://registry.npmjs.org' ||
          typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) fail('runtime-integrity');
    }
    return [{ ...parsed, locationDigest: hash(key), integrityDigest: hash(String(entry.integrity)) }];
  });
  const refs = [...new Set(inventory.map(item => item.ref))].sort();
  if (refs.length !== components.length || !inventory.some(item => item.name === candidate.artifact.name)) fail('component-coverage');
  const allRefs = [String(root['bom-ref']), ...refs];
  const dependencies = list(bom.dependencies).map(value => {
    const entry = object(value), ref = entry.ref;
    const dependsOn = list(entry.dependsOn);
    if (typeof ref !== 'string' || !allRefs.includes(ref) || new Set(dependsOn).size !== dependsOn.length ||
        dependsOn.some(value => typeof value !== 'string' || !allRefs.includes(value))) fail('dependency-coverage');
    return { ref, dependsOn: dependsOn as string[] };
  });
  if (dependencies.length !== allRefs.length || new Set(dependencies.map(item => item.ref)).size !== allRefs.length) fail('dependency-coverage');
  const reachable = new Set([String(root['bom-ref'])]);
  for (let index = 0; index < allRefs.length; index++) for (const entry of dependencies) {
    if (reachable.has(entry.ref)) entry.dependsOn.forEach(ref => reachable.add(ref));
  }
  if (reachable.size !== allRefs.length) fail('unreachable-component');
  const primary = components.find(item => item.name === candidate.artifact.name)!;
  const rootEdges = dependencies.find(item => item.ref === root['bom-ref'])!;
  if (rootEdges.dependsOn.length !== 1 || rootEdges.dependsOn[0] !== primary['bom-ref']) fail('wrapper-dependencies');
  return {
    kind: 'exact-installed-npm-runtime-sbom', candidateDigest: canonicalDigest(candidate),
    artifactDigest: candidate.artifact.sha256, nativeReportDigest: hash(source), lockDigest: hash(lockSource),
    tool: { name: 'npm', version: npmVersion }, installedPlatform: `${process.platform}-${process.arch}`,
    installedRuntimeComplete: true, templateGraphsComplete: false, allPlatformsQualified: false,
    components, dependencies, lockInstances: inventory, excludedOptional,
    sbom: {
      bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
      metadata: {
        component: { ...primary, type: 'application', hashes: [{ alg: 'SHA-256', content: candidate.artifact.sha256.slice(7) }] },
        properties: [
          { name: 'liftoff:scope', value: 'exact-artifact-installed-runtime-only' },
          { name: 'liftoff:platform', value: `${process.platform}-${process.arch}` },
          { name: 'liftoff:template-graphs', value: 'separately-required' },
          { name: 'liftoff:publication-qualified', value: 'false' }
        ]
      },
      components: components.filter(item => item !== primary),
      dependencies: dependencies.filter(item => item.ref !== root['bom-ref']),
      compositions: [{ aggregate: 'complete', assemblies: [primary['bom-ref']] }]
    },
    vulnerabilitiesAssessed: false, verifiableProvenance: false, publicationQualified: false
  };
}

export function normalizePackedRuntimeAudit(
  source: string, runtime: ReturnType<typeof normalizePackedRuntimeSbom>
) {
  const entry = { id: 'packed-runtime', label: 'Exact installed package runtime', pathParts: ['package-lock.json'] };
  try {
    const auditReport = object(json(source)), dependencies = object(object(auditReport.metadata).dependencies);
    if (dependencies.total !== runtime.lockInstances.length) fail('audit-component-coverage');
    const raw = npmRawFindings([{ entry, auditReport }]);
    const parsed: { advisoryId: string; package: string; severity: string; affectedNodes: string[]; dependencyChains: string[][] }[] =
      normalizeNpmAuditReport(entry, auditReport);
    const verdict = evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport }], policy: { schemaVersion: 1, exceptions: [] }, resolvedAdvisories: []
    });
    const findings = parsed.map((finding, index) => {
      if (!/^(?:GHSA-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}|CVE-[0-9]{4}-[0-9]{4,})$/i.test(finding.advisoryId)) fail('audit-advisory');
      const nodes = finding.affectedNodes.map(location =>
        runtime.lockInstances.find(item => item.locationDigest === hash(location) && item.name === finding.package));
      if (!nodes.length || nodes.some(item => !item)) fail('audit-finding-outside-install');
      return {
        id: raw[index]!.key, advisory: finding.advisoryId, severity: finding.severity,
        component: finding.package, versions: [...new Set(nodes.map(item => item!.version))].sort(),
        chainDigest: canonicalDigest(finding.dependencyChains), owner: 'voyager163', blocking: true
      };
    });
    if (verdict.issues.some((issue: { code: string }) => issue.code !== 'unreviewed-finding') ||
        verdict.issues.length !== findings.length) fail('audit-policy');
    return {
      kind: 'exact-installed-runtime-npm-audit', complete: true, passed: findings.length === 0,
      artifactDigest: runtime.artifactDigest, lockDigest: runtime.lockDigest, sourceReportDigest: hash(source),
      assessedInstalledInstances: runtime.lockInstances.length, findings,
      policy: 'existing-npm-every-finding-blocks-without-exact-adopted-exception',
      graphExceptionsTransplanted: false, publicationQualified: false
    };
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('audit-report-invalid');
  }
}

export function privateNpmEnvironment(root: string, cache: string): NodeJS.ProcessEnv {
  return {
    PATH: path.dirname(process.execPath), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    TMPDIR: path.join(root, 'scratch'), TMP: path.join(root, 'scratch'), TEMP: path.join(root, 'scratch'),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    npm_config_cache: cache, npm_config_userconfig: path.join(root, 'user.npmrc'),
    npm_config_globalconfig: path.join(root, 'global.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org', npm_config_offline: 'false',
    NODE_DISABLE_COMPILE_CACHE: '1', LIFTOFF_TELEMETRY: '0'
  };
}

export async function assessPackedNpmRuntime(options: {
  repository: string; workspaceParent: string; npmCli: string; candidate: unknown; tarball: Uint8Array;
}) {
  const candidate = verifyCandidateBytes(options.candidate, options.tarball);
  const inspected = inspectPackageArchive(Buffer.from(options.tarball), candidate.artifact, ['package.json']);
  validatePackedRuntimeManifest(inspected.selectedInputs![0]!.content);
  const npmCli = await realpath(options.npmCli), cliDigest = hash(await readFile(npmCli));
  const owned = await createPrivatePackageWorkspace(options.repository, options.workspaceParent);
  try {
    const install = await owned.directory('install'), cache = await owned.directory('npm-cache');
    const archive = await owned.write('candidate.tgz', options.tarball);
    await owned.write('user.npmrc', '');
    await owned.write('global.npmrc', '');
    const env = privateNpmEnvironment(owned.root, cache);
    const run = async (args: string[]) => {
      if (hash(await readFile(npmCli)) !== cliDigest) fail('tool-drift');
      const result = await capturePrivateFixtureProcess(process.execPath, [npmCli, ...args, '--loglevel=silent'], owned,
        { cwd: install, environment: env, maxBytes: 4 * 1024 * 1024, timeoutMs: 120_000 });
      try {
        if (result.exitCode !== 0 && !(args[0] === 'audit' && result.exitCode === 1)) fail('command-failed');
        return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      } finally { result.stdout.fill(0); await owned.register(); }
    };
    const npmVersion = (await run(['--version'])).trim();
    if (npmVersion !== '12.0.2') fail('unqualified-npm-version');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(install, 'package.json'), JSON.stringify({
      name: wrapperName, version: '0.0.0', private: true,
      dependencies: { '@msn-control/liftoff': 'file:../candidate.tgz' }
    }), { flag: 'wx', mode: 0o600 });
    await owned.register();
    await run(['install', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org', '--@msn-control:registry=https://registry.npmjs.org']);
    await verifyInstalledArchiveFiles(path.join(install, 'node_modules', '@msn-control', 'liftoff'), inspected.files);
    const lock = await readFile(path.join(install, 'package-lock.json'), 'utf8');
    const sbom = await run(['sbom', '--sbom-format=cyclonedx', '--omit=dev', '--offline']);
    const runtime = normalizePackedRuntimeSbom(sbom, lock, candidate, npmVersion);
    const startedAt = new Date().toISOString();
    const audit = await run(['audit', '--json', '--omit=dev', '--registry=https://registry.npmjs.org']);
    const vulnerabilities = normalizePackedRuntimeAudit(audit, runtime);
    if (await readFile(path.join(install, 'package-lock.json'), 'utf8') !== lock) fail('lock-drift');
    verifyCandidateBytes(candidate, await readFile(archive));
    return {
      ...runtime, vulnerabilitiesAssessed: true, vulnerabilities: { ...vulnerabilities, startedAt, completedAt: new Date().toISOString() }, cliDigest,
      toolchainSeal: 'entrypoint-digest-not-complete-installed-toolchain', cleanup: 'completed'
    };
  } finally { await owned.register(); await owned.cleanup(); }
}

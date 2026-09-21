import { readFile, realpath, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalDigest } from './admission.ts';
import { digest, SecurityEvidenceError } from './evidence.ts';
import { createPrivatePackageWorkspace, capturePrivateFixtureProcess } from './gitleaks.ts';
import { privateNpmEnvironment, validatePackedRuntimeManifest } from './npm-runtime.ts';
import { inspectPackedNpmLock } from './packed-template-inventory.ts';
import { inspectPackageArchive } from '../package-smoke-artifact.mjs';
import { verifyCandidateBytes } from './npm-release.ts';
import { normalizeNpmAuditReport, evaluateTemplateDependencyAudits } from '../template-dependency-security.mjs';

function fail(code: string): never { throw new SecurityEvidenceError(`packed-npm-${code}`); }
const hash = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return fail('audit-json'); }
}

export function normalizePackedTemplateAudit(
  graph: ReturnType<typeof inspectPackedNpmLock>, value: unknown, artifactDigest: string
) {
  digest(artifactDigest);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('audit-schema');
  const auditReport = value as Record<string, unknown>;
  const entry = { id: graph.id, label: graph.id, pathParts: ['assets', 'locks', graph.id === 'standard-frontend' ? 'frontend' : 'node-backend', 'package-lock.json'] };
  const normalized: { advisoryId: string; package: string; severity: string; affectedNodes: string[]; dependencyChains: string[][] }[] =
    normalizeNpmAuditReport(entry, auditReport);
  const metadata = auditReport.metadata;
  if (!metadata || typeof metadata !== 'object' || !('dependencies' in metadata) ||
      !metadata.dependencies || typeof metadata.dependencies !== 'object' || !('total' in metadata.dependencies) ||
      metadata.dependencies.total !== graph.components.length) fail('audit-component-coverage');
  const findings = normalized.map(finding => {
    if (!/^(?:GHSA-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}|CVE-[0-9]{4}-[0-9]{4,})$/i.test(finding.advisoryId)) fail('audit-advisory');
    const components = finding.affectedNodes.map(location =>
      graph.components.find(component => component.locationDigest === canonicalDigest(location) && component.name === finding.package));
    if (!components.length || components.some(component => component === undefined)) fail('finding-outside-packed-graph');
    return {
      id: canonicalDigest({ graph: graph.id, artifactDigest, finding }),
      advisory: finding.advisoryId, component: finding.package,
      versions: [...new Set(components.map(component => component!.version))].sort(), severity: finding.severity,
      chainDigest: canonicalDigest(finding.dependencyChains), owner: 'voyager163', blocking: true
    };
  });
  const verdict = evaluateTemplateDependencyAudits({
    auditResults: [{ entry, auditReport }], policy: { schemaVersion: 1, exceptions: [] }, resolvedAdvisories: []
  });
  if (verdict.issues.some((issue: { code: string }) => issue.code !== 'unreviewed-finding') ||
      verdict.issues.length !== findings.length) fail('audit-policy');
  return {
    graph: graph.id, artifactDigest, inputDigest: graph.inputDigest, sourceReportDigest: canonicalDigest(auditReport),
    assessedLockInstances: graph.components.length, findings, analysisComplete: true, findingsPassed: findings.length === 0,
    policy: 'every-npm-finding-blocks-without-exact-adopted-exception', exceptionsTransplanted: false
  };
}

export async function assessPackedNpmTemplates(options: {
  repository: string; workspaceParent: string; npmCli: string; candidate: unknown; tarball: Uint8Array;
}) {
  const candidate = verifyCandidateBytes(options.candidate, options.tarball);
  const graphs = [
    { id: 'node-backend', directory: 'node-backend' }, { id: 'standard-frontend', directory: 'frontend' }
  ];
  const paths = graphs.flatMap(graph => ['package.json', 'package-lock.json'].map(name => `assets/locks/${graph.directory}/${name}`));
  const archive = inspectPackageArchive(Buffer.from(options.tarball), candidate.artifact, paths);
  const npmCli = await realpath(options.npmCli), toolDigest = hash(await readFile(npmCli));
  const owned = await createPrivatePackageWorkspace(options.repository, options.workspaceParent);
  try {
    const cache = await owned.directory('npm-cache');
    await owned.write('user.npmrc', '');
    await owned.write('global.npmrc', '');
    const environment = privateNpmEnvironment(owned.root, cache);
    const reports = [];
    for (const graph of graphs) {
      const directory = await owned.directory(graph.id);
      const inputs = archive.selectedInputs!.filter(input => input.path.startsWith(`assets/locks/${graph.directory}/`));
      const manifest = inputs.find(input => input.path.endsWith('/package.json'))!;
      const parsed = JSON.parse(manifest.content);
      const lock = inputs.find(input => input.path.endsWith('/package-lock.json'))!;
      const inventory = inspectPackedNpmLock(lock.content, graph.id);
      const lockRoot = JSON.parse(lock.content).packages[''];
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (canonicalDigest(parsed[field] ?? {}) !== canonicalDigest(lockRoot[field] ?? {})) fail('manifest-lock-mismatch');
        if (Object.keys(parsed[field] ?? {}).length) validatePackedRuntimeManifest(JSON.stringify({
          ...parsed, dependencies: parsed[field], optionalDependencies: undefined
        }));
      }
      for (const input of inputs) await writeFile(path.join(directory, path.basename(input.path)), input.content, { flag: 'wx', mode: 0o600 });
      await owned.register();
      const run = async (args: string[]) => {
        if (hash(await readFile(npmCli)) !== toolDigest) fail('tool-drift');
        const result = await capturePrivateFixtureProcess(process.execPath, [npmCli, ...args, '--loglevel=silent'], owned, {
          cwd: directory, environment, timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024
        });
        try {
          if (result.exitCode !== 0 && !(args[0] === 'audit' && result.exitCode === 1)) fail('audit-command-failed');
          return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
        } finally { result.stdout.fill(0); await owned.register(); }
      };
      if ((await run(['--version'])).trim() !== '12.0.2') fail('npm-version');
      const startedAt = new Date().toISOString();
      const report = json(await run([
        'audit', '--json', '--package-lock-only', '--ignore-scripts', '--registry=https://registry.npmjs.org'
      ]));
      reports.push({
        ...normalizePackedTemplateAudit(inventory, report, candidate.artifact.sha256),
        startedAt, completedAt: new Date().toISOString()
      });
      for (const input of inputs) {
        if (await readFile(path.join(directory, path.basename(input.path)), 'utf8') !== input.content) fail('archive-input-drift');
      }
      try { await lstat(path.join(directory, 'node_modules')); fail('unexpected-install'); }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    verifyCandidateBytes(candidate, options.tarball);
    return {
      kind: 'exact-packed-npm-template-assessment', candidateDigest: canonicalDigest(candidate),
      artifactDigest: candidate.artifact.sha256, toolDigest, reports, analysisComplete: reports.length === 2,
      findingsPassed: reports.length === 2 && reports.every(report => report.findingsPassed),
      cleanup: 'completed', producerAuthenticated: false, publicationQualified: false
    };
  } finally { await owned.register(); await owned.cleanup(); }
}

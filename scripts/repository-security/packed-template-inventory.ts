import { parse as parseToml } from 'smol-toml';
import { inspectPackageArchive } from '../package-smoke-artifact.mjs';
import { templateDependencyInventory } from '../template-dependency-security.mjs';
import { canonicalDigest } from './admission.ts';
import { identifier, portableParts, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';
import { dependencyInventory } from './inventory.ts';
import { reconcileUvLock, workerRequirementsCoverage, type OsvGraph } from './osv.ts';
import { verifyCandidateBytes } from './npm-release.ts';
import { npmComponentCoordinate } from './npm-runtime.ts';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createOsvWorkspace, extractOsvGoGraphs, qualifyFrozenGo } from './osv-fixture.ts';
import { readOsvSource } from './osv-driver.ts';

function fail(code: string): never { throw new SecurityEvidenceError(`packed-template-${code}`); }
const issuedGoInventories = new WeakMap<object, string>();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('schema');
  return value as Record<string, unknown>;
}
function versions(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).map(([name, version]) =>
    [identifier(name, 'packed-template-component'), identifier(version, 'packed-template-version')]));
}

function npmIntegrity(value: unknown) {
  const match = typeof value === 'string' ? /^(sha512|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(value) : null;
  if (!match || Buffer.from(match[2]!, 'base64').length !== (match[1] === 'sha512' ? 64 : 20) ||
      Buffer.from(match[2]!, 'base64').toString('base64') !== match[2]) fail('npm-package-integrity');
  return { value: value as string, algorithm: match[1]! };
}

export function inspectPackedNpmLock(source: string, id: string) {
  if (!['node-backend', 'standard-frontend'].includes(id) || Buffer.byteLength(source) > 4 * 1024 * 1024) fail('npm-graph');
  let lock: Record<string, unknown>;
  try { lock = object(JSON.parse(source)); } catch { return fail('npm-lock-json'); }
  if (lock.lockfileVersion !== 3) fail('npm-lock-version');
  const packages = object(lock.packages);
  if (!packages['']) fail('npm-lock-root');
  const components = Object.entries(packages).filter(([name]) => name !== '').map(([location, value]) => {
    const entry = object(value);
    if (!location.startsWith('node_modules/') || entry.link === true || /[\\\r\n]/.test(location) ||
        location.split('/').some(part => part === '..' || !part)) fail('npm-package-location');
    const { name, version } = npmComponentCoordinate(
      entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 13), entry.version);
    if (entry.resolved !== undefined) {
      let resolved: URL;
      try { resolved = new URL(String(entry.resolved)); } catch { return fail('npm-package-integrity'); }
      if (typeof entry.resolved !== 'string' || resolved.origin !== 'https://registry.npmjs.org' ||
          resolved.username || resolved.password || resolved.search || resolved.hash) fail('npm-package-integrity');
    }
    let bundleParent: { locationDigest: string; integrity: string } | null = null;
    if (entry.integrity === undefined && entry.inBundle === true) {
      let ancestor = location;
      while (ancestor.includes('/node_modules/')) {
        ancestor = ancestor.slice(0, ancestor.lastIndexOf('/node_modules/'));
        const parent = object(packages[ancestor]);
        if (parent.integrity !== undefined) {
          bundleParent = { locationDigest: canonicalDigest(ancestor), integrity: npmIntegrity(parent.integrity).value };
          break;
        }
        if (parent.inBundle !== true) fail('unbound-bundled-component');
      }
      if (!bundleParent) fail('unbound-bundled-component');
    }
    const integrity = bundleParent ? null : npmIntegrity(entry.integrity);
    return {
      name, version, purl: `pkg:npm/${name.replace('@', '%40')}@${version}`,
      locationDigest: canonicalDigest(location), integrity: integrity?.value ?? null,
      integrityAlgorithm: integrity?.algorithm ?? null, legacyIntegrity: integrity?.algorithm === 'sha1',
      bundleParent, independentBundledBytesVerified: false,
      resolution: entry.resolved === undefined ? 'registry-selected-at-operation' : 'explicit-canonical-registry-url',
      development: entry.dev === true, optional: entry.optional === true
    };
  });
  if (!components.length || components.length > 10_000) fail('empty-or-oversized-graph');
  return {
    id, ecosystem: 'npm', inputDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`, components,
    coverage: 'complete-lock-component-inventory', dependencyRelationships: 'not-modelled-by-this-inventory',
    legacyIntegrityCount: components.filter(item => item.legacyIntegrity).length,
    installedRuntimeClaim: false, vulnerabilitiesAssessed: false
  };
}

/** Only component inventories declared in the exact archive; no install, scan or policy grant. */
export function inspectPackedTemplateComponents(candidateValue: unknown, bytes: Uint8Array) {
  const candidate = verifyCandidateBytes(candidateValue, bytes);
  const baselinePath = 'assets/supported-stack.json';
  const baselineInput = inspectPackageArchive(Buffer.from(bytes), candidate.artifact, [baselinePath]).selectedInputs![0]!;
  let baseline: Record<string, unknown>;
  try { baseline = object(JSON.parse(baselineInput.content)); } catch { return fail('baseline-json'); }
  const npmProjects = Object.fromEntries(Object.entries(object(baseline.npmProjects)).map(([name, value]) =>
    [name, { lockPathParts: portableParts(object(value).lockPathParts) }]));
  const pythonProjects = Object.fromEntries(Object.entries(object(baseline.pythonProjects)).map(([name, value]) => {
    const project = object(value);
    return [name, {
      lockTemplatePathParts: portableParts(project.lockTemplatePathParts), dependencies: versions(project.dependencies),
      optionalDependencies: Object.fromEntries(Object.entries(object(project.optionalDependencies)).map(([extra, value]) =>
        [identifier(extra, 'packed-template-extra'), versions(value)]))
    }];
  }));
  const goModules = Object.fromEntries(Object.entries(object(baseline.goModules)).map(([name, value]) =>
    [name, { moduleTemplatePathParts: portableParts(object(value).moduleTemplatePathParts) }]));
  const graphs = dependencyInventory({ npmProjects, pythonProjects, goModules, containers: {} }, templateDependencyInventory);
  const packedGraphs = graphs.filter(graph => graph.pathParts[0] === 'assets');
  const go = packedGraphs.find(graph => graph.ecosystem === 'go');
  if (!go) fail('missing-go-inventory');
  const workerPath = 'assets/locks/python-genai/function-requirements.txt';
  const selectedPaths = [...new Set([
    baselinePath, ...packedGraphs.map(graph => graph.pathParts.join('/')), workerPath,
    [...go.pathParts.slice(0, -1), 'go.sum'].join('/')
  ])];
  const archive = inspectPackageArchive(Buffer.from(bytes), candidate.artifact, selectedPaths);
  const input = (name: string) => archive.selectedInputs!.find(item => item.path === name) ?? fail('missing-input');
  const inventories = packedGraphs.filter(graph => graph.ecosystem !== 'go').map(graph => {
    const source = input(graph.pathParts.join('/'));
    if (graph.ecosystem === 'pypi') {
      let lock: unknown;
      try { lock = parseToml(source.content); } catch { return fail('uv-format'); }
      const reconciled = reconcileUvLock(source.content, lock, graph, pythonProjects[graph.id]!);
      const worker = graph.id === 'function-worker'
        ? workerRequirementsCoverage(input(workerPath).content, lock, reconciled).evidence : null;
      return {
        id: graph.id, ecosystem: 'pypi', inputDigest: `sha256:${source.sha256}`, components: reconciled.components.map(component => ({
          name: component.name, version: component.version, purl: `pkg:pypi/${component.name}@${component.version}`,
          chains: component.chains
        })), coverage: 'complete-universal-lock-components', workerExport: worker,
        installedRuntimeClaim: false, vulnerabilitiesAssessed: false
      };
    }

    return inspectPackedNpmLock(source.content, graph.id);
  });
  return {
    kind: 'exact-packed-template-component-inventory', candidateDigest: canonicalDigest(candidate),
    artifactDigest: candidate.artifact.sha256,
    inputs: archive.selectedInputs!.map(item => ({ pathParts: item.path.split('/'), digest: `sha256:${item.sha256}` })),
    inventories,
    unresolvedGraphs: [{ id: go.id, ecosystem: 'go', reason: 'fresh-frozen-resolved-module-and-tool-closure-required' }],
    complete: false, sourceOnlyGraphs: ['liftoff-cli-development', 'telemetry-ingest-source'],
    runtimeGraph: 'separate-exact-installation-required', vulnerabilitiesAssessed: false,
    verifiableProvenance: false, publicationQualified: false
  };
}

export async function resolvePackedGoComponents(options: {
  repository: string; workspaceParent: string; go: string; candidate: unknown; tarball: Uint8Array; python?: string;
}) {
  const candidate = verifyCandidateBytes(options.candidate, options.tarball);
  inspectPackedTemplateComponents(candidate, options.tarball);
  const paths = ['assets/supported-stack.json', 'assets/locks/go-backend/go.mod', 'assets/locks/go-backend/go.sum'];
  const archive = inspectPackageArchive(Buffer.from(options.tarball), candidate.artifact, paths);
  const baseline = object(JSON.parse(archive.selectedInputs!.find(item => item.path === paths[0])!.content));
  const go = object(object(baseline.goModules)['go-backend']);
  if (JSON.stringify(portableParts(go.moduleTemplatePathParts)) !== JSON.stringify(paths[1]!.split('/'))) fail('go-input-path');
  const repository = await realpath(options.repository);
  const contractParts = ['security', 'go-tool-graphs.json'];
  const contract = await readOsvSource(repository, contractParts);
  const workspace = await createOsvWorkspace(repository, options.workspaceParent);
  try {
    for (const item of archive.selectedInputs!) await workspace.write(item.path.split('/'), item.content);
    await workspace.write(contractParts, contract);
    const resolution = await qualifyFrozenGo(workspace.root, {
      go: options.go, restore: true, verifyToolGraph: true, workspaceParent: options.workspaceParent, python: options.python
    });
    for (const item of archive.selectedInputs!) await workspace.verify(item.path.split('/'), item.content);
    await workspace.verify(contractParts, contract);
    if (await readFile(path.join(repository, ...contractParts), 'utf8') !== contract) fail('go-tool-contract-drift');
    const union = resolution.componentInventories.find(item => item.scope === 'combined');
    if (!union || !resolution.componentInventories.some(item => item.scope === 'contract') ||
        resolution.extraction.scopes.length !== 4 ||
        resolution.extraction.scopes.some(scope => scope.selected !== scope.extracted)) fail('incomplete-go-extraction');
    const result = {
      kind: 'exact-packed-go-resolved-component-inventory', candidateDigest: canonicalDigest(candidate),
      artifactDigest: candidate.artifact.sha256,
      archiveInputs: archive.selectedInputs!.map(item => ({ pathParts: item.path.split('/'), digest: `sha256:${item.sha256}` })),
      toolContract: { pathParts: contractParts, digest: canonicalDigest(contract), provenance: 'separate-source-control-not-packed-input' },
      goVersion: resolution.goVersion, goExecutableDigest: resolution.goExecutableDigest,
      inventories: resolution.componentInventories, extraction: resolution.extraction.scopes,
      unionScopeRecognized: true, complete: true,
      advisoryQueries: false, vulnerabilitiesAssessed: false, verifiableProvenance: false,
      cleanup: 'completed', publicationQualified: false
    };
    issuedGoInventories.set(result, canonicalDigest(result));
    return result;
  } finally { await workspace.cleanup(); }
}

export function verifiedPackedGoComponents(value: Awaited<ReturnType<typeof resolvePackedGoComponents>>) {
  if (!value || issuedGoInventories.get(value) !== canonicalDigest(value)) fail('unissued-go-inventory');
  return value;
}

export function packedTemplateSbom(
  candidateValue: unknown, bytes: Uint8Array, goValue: Awaited<ReturnType<typeof resolvePackedGoComponents>>
) {
  const candidate = verifyCandidateBytes(candidateValue, bytes);
  const templates = inspectPackedTemplateComponents(candidate, bytes), go = verifiedPackedGoComponents(goValue);
  if (go.candidateDigest !== canonicalDigest(candidate) || go.artifactDigest !== candidate.artifact.sha256 ||
      go.complete !== true || go.cleanup !== 'completed') fail('go-inventory-identity');
  const components: {
    type: 'library'; 'bom-ref': string; name: string; version: string; purl: string;
    properties: { name: string; value: string }[];
  }[] = [];
  function add(graph: string, inputDigest: string, component: { name: string; version: string; purl: string }, index: number) {
    components.push({
      type: 'library', 'bom-ref': `template:${graph}:${index}:${canonicalDigest(component)}`,
      name: component.name, version: component.version, purl: component.purl,
      properties: [
        { name: 'liftoff:component-role', value: 'declared-template-dependency-not-embedded-runtime-bytes' },
        { name: 'liftoff:template-graph', value: graph },
        { name: 'liftoff:input-digest', value: inputDigest }
      ]
    });
  }
  for (const graph of templates.inventories) graph.components.forEach((component, index) => add(graph.id, graph.inputDigest, component, index));
  const combined = go.inventories.find(item => item.scope === 'combined') ?? fail('missing-go-union');
  combined.components.forEach((component, index) => add('go-backend-and-tools', combined.inputDigest, {
    ...component, purl: `pkg:golang/${component.name}@${component.version}`
  }, index));
  if (new Set(components.map(component => component['bom-ref'])).size !== components.length) fail('duplicate-sbom-component');
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: {
      component: {
        type: 'application', name: candidate.artifact.name, version: candidate.artifact.version,
        hashes: [{ alg: 'SHA-256', content: candidate.artifact.sha256.slice(7) }]
      },
      properties: [
        { name: 'liftoff:inventory-role', value: 'exact-archive-declared-template-components' },
        { name: 'liftoff:candidate-digest', value: canonicalDigest(candidate) },
        { name: 'liftoff:go-tool-source-contract', value: go.toolContract.digest },
        { name: 'liftoff:installed-runtime', value: 'separate-assessment-required' },
        { name: 'liftoff:dependency-relationships', value: 'not-asserted-by-this-component-inventory' },
        { name: 'liftoff:vulnerability-verdict', value: 'not-produced' },
        { name: 'liftoff:provenance-verification', value: 'not-established' }
      ]
    },
    components
  };
}

export async function assessPackedPythonGoTemplates(options: {
  repository: string; workspaceParent: string; python: string; candidate: unknown; tarball: Uint8Array;
  go: Awaited<ReturnType<typeof resolvePackedGoComponents>>; identity: EvidenceIdentity;
}) {
  const candidate = verifyCandidateBytes(options.candidate, options.tarball), go = verifiedPackedGoComponents(options.go);
  const templates = inspectPackedTemplateComponents(candidate, options.tarball);
  if (go.candidateDigest !== canonicalDigest(candidate) || go.artifactDigest !== candidate.artifact.sha256 ||
      options.identity.sourceSha !== candidate.source.commit) fail('assessment-subject-mismatch');
  const graphs: Record<string, OsvGraph> = {};
  for (const graph of templates.inventories) {
    if (graph.ecosystem !== 'pypi') continue;
    const pathParts = graph.id === 'standard-backend'
      ? ['assets', 'locks', 'python-standard', 'uv.lock'] : ['assets', 'locks', 'python-genai', 'uv.lock'];
    graphs[graph.id] = {
      id: graph.id, pathParts, inputDigest: graph.inputDigest,
      components: graph.components.map(component => ({
        name: component.name, version: component.version, ecosystem: 'PyPI',
        chains: 'chains' in component ? component.chains : fail('python-chain-coverage')
      }))
    };
  }
  const combined = go.inventories.find(item => item.scope === 'combined') ?? fail('missing-go-union');
  graphs['go-backend'] = {
    id: 'go-backend', pathParts: ['assets', 'locks', 'go-backend', 'go.mod'],
    inputDigest: combined.inputDigest, components: combined.components
  };
  if (Object.keys(graphs).sort().join() !== ['function-worker', 'genai-backend', 'go-backend', 'standard-backend'].sort().join()) {
    fail('assessment-graph-inventory');
  }
  const workspace = await createOsvWorkspace(options.repository, options.workspaceParent);
  try {
    const result = await extractOsvGoGraphs(workspace, graphs, 'packed-python-go', {
      python: options.python, identity: options.identity, scopes: Object.keys(graphs)
    });
    verifiedPackedGoComponents(go);
    verifyCandidateBytes(candidate, options.tarball);
    if (result.assessments.length !== 4) fail('missing-template-assessment');
    return {
      kind: 'exact-packed-python-go-vulnerability-assessment', artifactDigest: candidate.artifact.sha256,
      candidateDigest: canonicalDigest(candidate), identity: options.identity,
      extraction: result.scopes, assessments: result.assessments,
      analysisComplete: result.assessments.every(item => item.status === 'complete'),
      findingsPassed: result.assessments.every(item => item.status === 'complete' && item.passed),
      authority: 'strict-local-no-exceptions-not-adopted-release-policy',
      cleanup: 'completed', verifiableProvenance: false, publicationQualified: false
    };
  } finally { await workspace.cleanup(); }
}

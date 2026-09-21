import { describe, expect, it } from 'vitest';
import { normalizePackedRuntimeAudit, normalizePackedRuntimeSbom, validatePackedRuntimeManifest } from '../scripts/repository-security/npm-runtime.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactHashes, type NpmCandidate } from '../scripts/repository-security/npm-release.ts';

const bytes = Buffer.from('Synthetic package identity, never executed.');
const hash = `sha256:${'a'.repeat(64)}`;
const candidate: NpmCandidate = {
  schemaVersion: 1, kind: 'npm-release-candidate', source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inputsDigest: hash, dirty: true },
  artifact: { name: '@msn-control/liftoff', version: '0.12.3', filename: 'msn-control-liftoff-0.12.3.tgz',
    size: bytes.length, ...artifactHashes(bytes) }, releaseTag: 'v0.12.3', distTag: 'latest', createdAt: '2026-09-21T00:00:00.000Z'
};
const root = 'liftoff-qualification-runtime@0.0.0', cli = '@msn-control/liftoff@0.12.3', dependency = 'fixture@1.2.3';
function fixture() {
  const bom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: {
      tools: [{ vendor: 'npm', name: 'cli', version: '12.0.2' }],
      component: { name: 'liftoff-qualification-runtime', version: '0.0.0', 'bom-ref': root }
    },
    components: [
      { name: '@msn-control/liftoff', version: '0.12.3', 'bom-ref': cli, purl: 'pkg:npm/%40msn-control/liftoff@0.12.3', scope: 'required' },
      { name: 'fixture', version: '1.2.3', 'bom-ref': dependency, purl: 'pkg:npm/fixture@1.2.3', scope: 'required',
        author: 'PRIVATE_REPORT_SENTINEL', description: 'PRIVATE_REPORT_SENTINEL' }
    ],
    dependencies: [{ ref: root, dependsOn: [cli] }, { ref: cli, dependsOn: [dependency] }, { ref: dependency, dependsOn: [] }]
  };
  const lock: { name: string; version: string; lockfileVersion: number; packages: Record<string, Record<string, unknown>> } = {
    name: 'liftoff-qualification-runtime', version: '0.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'liftoff-qualification-runtime', version: '0.0.0' },
      'node_modules/@msn-control/liftoff': { version: '0.12.3', resolved: 'file:../candidate.tgz', integrity: candidate.artifact.integrity },
      'node_modules/fixture': { version: '1.2.3', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz',
        integrity: artifactHashes(Buffer.from('fixture bytes')).integrity }
    }
  };
  return { bom, lock };
}
function parse(value: ReturnType<typeof fixture>) {
  return normalizePackedRuntimeSbom(JSON.stringify(value.bom), JSON.stringify(value.lock), candidate, '12.0.2');
}

describe('exact installed npm runtime graph, distinct from template/build evidence', () => {
  it('rejects direct local/git/remote dependency overrides before installation', () => {
    expect(validatePackedRuntimeManifest(JSON.stringify({ dependencies: { fixture: '^1.2.3', '@scope/module': '>=2.0.0 <3.0.0' } })))
      .toEqual(['@scope/module', 'fixture']);
    for (const range of ['file:../../private', 'git+ssh://example.invalid/private', 'https://example.invalid/file.tgz', 'npm:alias@1.0.0', 'latest']) {
      expect(() => validatePackedRuntimeManifest(JSON.stringify({ dependencies: { fixture: range } }))).toThrow('nonregistry-runtime-dependency');
    }
    expect(() => validatePackedRuntimeManifest(JSON.stringify({ dependencies: { fixture: '1.0.0' }, workspaces: ['private'] })))
      .toThrow('unsupported-bundled-or-workspace-runtime');
  });
  it('reconciles installed coordinates/edges with lock instances and strips irrelevant native prose', () => {
    const result = parse(fixture());
    expect(result).toMatchObject({
      installedRuntimeComplete: true, templateGraphsComplete: false, allPlatformsQualified: false,
      vulnerabilitiesAssessed: false, verifiableProvenance: false, publicationQualified: false
    });
    expect(result.components).toHaveLength(2);
    expect(result.dependencies).toHaveLength(3);
    expect(result.lockInstances).toHaveLength(2);
    expect(result.sbom).toMatchObject({
      bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { 'bom-ref': cli, type: 'application' } },
      compositions: [{ aggregate: 'complete', assemblies: [cli] }]
    });
    expect(result.sbom.components).toHaveLength(1);
    expect(result.sbom.dependencies.some(item => item.ref === root)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REPORT_SENTINEL');
  });
  it('preserves strict npm blocking for lower severity and rejects incomplete installed audit coverage', async () => {
    const source = (await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'template-dependency-audit', 'direct.json'), 'utf8'))
      .replaceAll('direct-package', 'fixture').replaceAll('"high"', '"moderate"');
    const audit = JSON.parse(source);
    audit.metadata.dependencies = { total: 2 };
    const runtime = parse(fixture());
    expect(normalizePackedRuntimeAudit(JSON.stringify(audit), runtime)).toMatchObject({
      complete: true, passed: false, graphExceptionsTransplanted: false,
      findings: [{ component: 'fixture', severity: 'moderate', blocking: true }]
    });
    audit.metadata.dependencies.total = 1;
    expect(() => normalizePackedRuntimeAudit(JSON.stringify(audit), runtime)).toThrow('audit-component-coverage');
    audit.metadata.dependencies.total = 2;
    audit.vulnerabilities.fixture.nodes = ['node_modules/absent'];
    expect(() => normalizePackedRuntimeAudit(JSON.stringify(audit), runtime)).toThrow('audit-finding-outside-install');
  });
  it.each(['component', 'edge', 'unknown-edge', 'duplicate', 'version', 'integrity', 'tool', 'registry'])(
    'fails incomplete or substituted %s evidence', change => {
      const value = fixture();
      if (change === 'component') value.bom.components.pop();
      if (change === 'edge') value.bom.dependencies.pop();
      if (change === 'unknown-edge') value.bom.dependencies[0]!.dependsOn = ['unregistered@1.0.0'];
      if (change === 'duplicate') value.bom.components.push(value.bom.components[0]!);
      if (change === 'version') value.lock.packages['node_modules/@msn-control/liftoff']!.version = '0.12.4';
      if (change === 'integrity') value.lock.packages['node_modules/@msn-control/liftoff']!.integrity = 'missing';
      if (change === 'tool') value.bom.metadata.tools[0]!.version = '0.0.0';
      if (change === 'registry') value.lock.packages['node_modules/fixture']!.resolved = 'https://unapproved.invalid/fixture';
      expect(() => parse(value)).toThrow('npm-runtime-');
    }
  );
  it('does not silently drop disconnected or missing optional components', () => {
    const value = fixture();
    value.bom.dependencies[1]!.dependsOn = [];
    expect(() => parse(value)).toThrow('unreachable-component');
    const missing = fixture();
    missing.lock.packages['node_modules/missing'] = { version: '1.0.0', optional: true };
    expect(() => parse(missing)).toThrow('missing-component');
    missing.lock.packages['node_modules/missing']!.os = [process.platform];
    expect(() => parse(missing)).toThrow('missing-component');
    missing.lock.packages['node_modules/missing']!.os = [process.platform === 'win32' ? 'darwin' : 'win32'];
    expect(parse(missing).excludedOptional).toHaveLength(1);
    expect(parse(missing).allPlatformsQualified).toBe(false);
    missing.lock.packages['node_modules/missing']!.os = ['unknown-platform'];
    expect(() => parse(missing)).toThrow('platform-condition');
  });
});

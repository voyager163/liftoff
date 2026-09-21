import { describe, expect, it } from 'vitest';
import { lstat } from 'node:fs/promises';
import nodePath from 'node:path';
import {
  extractedOsvComponents, normalizeOsvReport, osvArguments, osvBounds, osvDigest,
  requireOsvExtraction, runOsvBoundary, verifyOsvDownload, verifyOsvVersion, type OsvGraph,
  reconcileUvLock, reconcileWorkerRequirements, reconcileGoResolution, frozenGoEnvironment, osvSbom,
  classifyGoStderr, parseGoJsonStream, parseGoSumdbRecord, goChecksumGaps, combineGoGraphs,
  OsvUnclassifiedSeverityError
} from '../scripts/repository-security/osv.ts';
import { evaluateSecurityReport, findingDigest } from '../scripts/repository-security/evidence.ts';
import { createOsvWorkspace } from '../scripts/repository-security/osv-fixture.ts';

const sentinel = 'NONFUNCTIONAL_OSV_OUTPUT_SENTINEL';
const graph: OsvGraph = {
  id: 'standard-backend', pathParts: ['assets', 'locks', 'python-standard', 'uv.lock'],
  inputDigest: osvDigest('fixture'), components: [
    { name: 'urllib3', version: '1.26.5', ecosystem: 'PyPI', chains: [['fixture', 'requests', 'urllib3']] }
  ]
};
const path = '/registered fixture/input.cdx.json';
const advisory = 'GHSA-34jh-p97f-mpxf';
function raw(score: string | null = '7.5') {
  return {
    results: [{ source: { path, type: 'sbom' }, packages: [{
      package: { name: 'urllib3', version: '1.26.5', ecosystem: 'PyPI' },
      ...(score === null ? {} : {
        vulnerabilities: [{ id: advisory, summary: sentinel, details: sentinel }],
        groups: [{ ids: [advisory], aliases: [advisory], max_severity: score }]
      })
    }] }],
    experimental_config: { licenses: { summary: false, allowlist: null } }
  };
}
function normalize(source = JSON.stringify(raw()), exitCode = 1, classifications?: Parameters<typeof normalizeOsvReport>[0]['classifications']) {
  const digest = osvDigest('fixture');
  return normalizeOsvReport({
    source, exitCode, expectedPath: path, graph, owner: 'voyager163',
    generatedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z', classifications,
    identity: {
      repository: 'voyager163/liftoff', event: 'workflow_dispatch', sourceSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), runId: '1', attempt: 1,
      policyDigest: digest, inventoryDigest: digest, configurationDigest: digest
    }
  });
}
describe('OSV non-npm output boundary', () => {
  it('keeps each advisory classification distinct from its alias-group maximum', () => {
    const data = raw(), other = 'PYSEC-2026-1';
    data.results[0]!.packages[0]!.vulnerabilities!.push({ id: other, summary: sentinel, details: sentinel });
    data.results[0]!.packages[0]!.groups![0]!.ids.push(other);
    const own = [
      { package: 'urllib3', version: '1.26.5', advisory, kind: 'vulnerability' as const,
        severity: 'high' as const, basis: 'published-label' as const },
      { package: 'urllib3', version: '1.26.5', advisory: other, kind: 'policy' as const,
        severity: 'high' as const, basis: 'unscored-policy' as const }
    ];
    const result = normalize(JSON.stringify(data), 1, own);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ rule: advisory, kind: 'vulnerability', severity: 'high' });
    expect(result.findings[1]).toMatchObject({
      rule: other, kind: 'policy', severity: 'high', policyClass: 'osv-valid-unscored-advisory', upstreamSeverity: 'unscored'
    });
    expect(findingDigest(result.findings[0]!)).not.toBe(findingDigest(result.findings[1]!));
    expect(() => normalize(JSON.stringify(data), 1, own.slice(0, 1))).toThrow('osv-own-classification-coverage');
  });

  it('projects exact registered classification gaps without raw scores or descriptions', () => {
    let failure: unknown;
    try { normalize(JSON.stringify(raw(sentinel))); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OsvUnclassifiedSeverityError);
    if (!(failure instanceof OsvUnclassifiedSeverityError)) throw new Error('expected classification failure');
    expect(failure.issues).toEqual([{
      componentIndex: 0, package: 'urllib3', version: '1.26.5', advisories: [advisory], classification: 'non-numeric'
    }]);
    expect(JSON.stringify(failure)).not.toContain(sentinel);
    expect(failure.code).toBe('osv-unknown-severity');
  });

  it('rejects source-local workspace parents even when ignored', async () => {
    await expect(createOsvWorkspace(process.cwd(), process.cwd())).rejects.toThrow('osv-workspace-inside-source');
    await expect(createOsvWorkspace(process.cwd(), nodePath.join(process.cwd(), '.cache'))).rejects.toThrow('osv-workspace-inside-source');
  });

  it.runIf(!!process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT)('creates only an owned external child and cleans its exact root', async () => {
    const workspace = await createOsvWorkspace(process.cwd()), root = workspace.root;
    expect(nodePath.relative(process.cwd(), root).startsWith(`..${nodePath.sep}`)).toBe(true);
    try {
      await workspace.write(['input.cdx.json'], '{}');
      await workspace.verify(['input.cdx.json'], '{}');
    } finally { await workspace.cleanup(); }
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sanitizes launch errors including synchronous spawn argument failures', async () => {
    for (const executable of [`/${sentinel}/absent`, `${sentinel}\0`]) {
      await expect(runOsvBoundary({
        executable, args: [], cwd: process.cwd(), env: {}, project: () => undefined
      })).rejects.toThrow('osv-launch-failed');
    }
  });

  it.each([
    ['stdout', `process.stdout.write('${sentinel}')`],
    ['stderr/exit', `process.stderr.write('${sentinel}'); process.exit(2)`],
    ['parser', `process.stdout.write('${sentinel}')`],
    ['missing report', ''],
    ['timeout', `process.stderr.write('${sentinel}'); setInterval(()=>{},1000)`],
    ['oversized stdout', `process.stdout.write('${sentinel}'.repeat(${osvBounds.stdout}))`],
    ['oversized stderr', `process.stderr.write('${sentinel}'.repeat(${osvBounds.stderr}))`]
  ])('does not expose %s through exceptions', async (_, program) => {
    let error: unknown;
    try {
      await runOsvBoundary({
        executable: process.execPath, args: ['-e', program], cwd: process.cwd(), env: {},
        timeoutMs: 300,
        project: source => { throw new Error(source); }
      });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sentinel);
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(String(error)).toContain('Security evidence rejected');
  });

  it('drops descriptive report content on successful projection', async () => {
    const report = await runOsvBoundary({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(raw()))}); process.exitCode=1;`],
      cwd: process.cwd(), env: {}, acceptedExits: [0, 1], project: normalize
    });
    expect(JSON.stringify(report)).not.toContain(sentinel);
    expect(report.findings[0]!.chains).toEqual([['fixture', 'requests', 'urllib3']]);
    expect(evaluateSecurityReport(report, report, { exceptions: [], blockingRules: [] },
      new Date('2026-09-20T01:00:00.000Z')).passed).toBe(false);
  });

  it('blocks even a complete clean report when stderr signals plugin failure', async () => {
    await expect(runOsvBoundary({
      executable: process.execPath,
      args: ['-e', `process.stderr.write('${sentinel}'); process.stdout.write(${JSON.stringify(JSON.stringify(raw(null)))});`],
      cwd: process.cwd(), env: {}, acceptedExits: [0, 1], project: normalize
    })).rejects.toThrow('osv-stderr-rejected');
  });

  it('permits only Go download-status lines, never arbitrary stderr at exit zero', async () => {
    expect(classifyGoStderr('go: downloading golang.org/x/text v0.3.7\n')).toBe('download-status');
    for (const source of [sentinel, `go: downloading ${sentinel}`, `go: downloading x v1.0.0\n${sentinel}`]) {
      expect(classifyGoStderr(source)).toBe('error');
      await expect(runOsvBoundary({
        executable: process.execPath, args: ['-e', `process.stderr.write(${JSON.stringify(source)})`],
        cwd: process.cwd(), env: {}, stderrMode: 'go-metadata', project: () => 'not-clean'
      })).rejects.toThrow('osv-stderr-rejected');
    }
  });

  it('classifies missing metadata and incompatible compilers without leaking Go JSON errors', async () => {
    for (const [message, code] of [
      [`${sentinel}: module lookup disabled by GOPROXY=off`, 'osv-go-metadata-missing'],
      [`${sentinel} requires go >= 1.28.0 (running go 1.27.1; GOTOOLCHAIN=local)`, 'osv-go-toolchain-incompatible']
    ]) {
      let error: unknown;
      try {
        await runOsvBoundary({
          executable: process.execPath,
          args: ['-e', `console.log(${JSON.stringify(JSON.stringify({ Error: message }))}); process.exitCode=1`],
          cwd: process.cwd(), env: {}, stderrMode: 'go-metadata', project: () => undefined
        });
      } catch (caught) { error = caught; }
      expect(String(error)).toContain(code);
      expect(String(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
  });

  it('strictly parses bounded Go JSON object streams including escaped braces', () => {
    expect(parseGoJsonStream('{"Path":"brace}\\\\\\"{"}\n{"Main":true}')).toHaveLength(2);
    for (const source of ['', '{}oops', '[{}]', '{}\n{"Path":', 'null', ' '.repeat(osvBounds.stdout + 1)]) {
      expect(() => parseGoJsonStream(source)).toThrow('Security evidence rejected');
    }
  });

  it('keeps low severity owner triage rather than suppressing it', () => {
    const report = normalize(JSON.stringify(raw('3.1')));
    expect(evaluateSecurityReport(report, report, { exceptions: [], blockingRules: [] },
      new Date('2026-09-20T01:00:00.000Z')).tracked).toEqual([report.findings[0]!.id]);
    expect(report.findings[0]!.owner).toBe('voyager163');
  });

  it('reuses exact advisory/graph/chain exceptions, never secret dispositions', () => {
    const report = normalize(), finding = report.findings[0]!, now = new Date('2026-09-20T01:00:00.000Z');
    const exception = {
      findingDigest: findingDigest(finding), disposition: 'mitigated' as const, owner: 'voyager163',
      rationale: 'Nonfunctional fixture only.', mitigation: 'Not installed or executed.',
      reviewedAt: '2026-09-01', reviewBy: '2026-10-01'
    };
    expect(evaluateSecurityReport(report, report, { exceptions: [exception], blockingRules: [] }, now).reviewed)
      .toEqual([finding.id]);
    for (const change of [{ reviewBy: '2026-10-02' }, { reviewBy: '2026-09-19' },
      { findingDigest: osvDigest('another graph') }, { disposition: 'credential-exposure' }]) {
      expect(() => evaluateSecurityReport(report, report,
        { exceptions: [{ ...exception, ...change } as typeof exception], blockingRules: [] }, now)).toThrow();
    }
    const changed = structuredClone(report);
    changed.findings[0]!.chains = [['other-parent', 'urllib3']];
    expect(() => evaluateSecurityReport(changed, changed, { exceptions: [exception], blockingRules: [] }, now))
      .toThrow('stale-exception');
  });

  it('requires all-packages completeness independently of a clean finding result', () => {
    expect(normalize(JSON.stringify(raw(null)), 0).findings).toEqual([]);
    expect(() => normalize(JSON.stringify({ ...raw(null), results: [] }), 0)).toThrow();
    expect(() => requireOsvExtraction(JSON.stringify(raw(null)), path,
      { ...graph, components: [...graph.components, { ...graph.components[0]!, name: 'missing-transitive' }] }))
      .toThrow('osv-incomplete-extraction');
    expect(() => extractedOsvComponents(JSON.stringify(raw(null)), '/other')).toThrow('osv-unexpected-source');
  });

  it.each(['', 'unknown', '-1', '11', sentinel])('blocks unknown severity %s', score => {
    expect(() => normalize(JSON.stringify(raw(score)))).toThrow('osv-unknown-severity');
  });

  it('rejects duplicate packages, ungrouped findings, reachability and wrong exit codes', () => {
    const duplicate = raw(); duplicate.results[0]!.packages.push(duplicate.results[0]!.packages[0]!);
    expect(() => normalize(JSON.stringify(duplicate))).toThrow('osv-incomplete-extraction');
    const missing = raw(); missing.results[0]!.packages[0]!.groups = [];
    expect(() => normalize(JSON.stringify(missing))).toThrow('osv-vulnerability-group-mismatch');
    const reachability = raw();
    Object.assign(reachability.results[0]!.packages[0]!.groups![0]!, { experimental_analysis: { go: { called: false } } });
    expect(() => normalize(JSON.stringify(reachability))).toThrow('osv-reachability-filter');
    expect(() => normalize(JSON.stringify(raw(null)), 1)).toThrow('osv-exit-report-mismatch');
    expect(() => normalize(JSON.stringify(raw()), 0)).toThrow('osv-exit-report-mismatch');
  });

  it('never returns arbitrary advisory identifiers, secrets or raw JSON parse errors', () => {
    const poisoned = raw(); poisoned.results[0]!.packages[0]!.vulnerabilities![0]!.id = sentinel;
    expect(() => normalize(JSON.stringify(poisoned))).toThrow('osv-invalid-advisory');
    expect(() => normalize(sentinel)).toThrow('osv-invalid-json');
    const descriptiveAlias = raw();
    descriptiveAlias.results[0]!.packages[0]!.groups![0]!.aliases.push(sentinel);
    expect(JSON.stringify(normalize(JSON.stringify(descriptiveAlias)))).not.toContain(sentinel);
  });

  it('restricts extraction to explicit plugins and disables resolution and call analysis', () => {
    const args = osvArguments('extract', 'uv', path, '/registered fixture/empty.toml');
    expect(args).toContain('--offline');
    expect(args).toContain('--experimental-no-default-plugins');
    expect(args).not.toContain('--experimental-plugins=vulnmatch/osvdev');
    expect(osvArguments('scan', 'cdx', path, '/registered fixture/empty.toml'))
      .toContain('--experimental-plugins=vulnmatch/osvdev');
    expect(args).toContain('--no-resolve');
    expect(args).toContain('--no-call-analysis=go,rust');
    expect(args).toContain('--all-packages');
  });

  it('requires pinned version and asset checksums', () => {
    expect(verifyOsvVersion('osv-scanner version: 2.6.0\n')).toBe('2.6.0');
    expect(() => verifyOsvVersion('osv-scanner version: 2.5.0\n')).toThrow('osv-tool-version');
    expect(() => verifyOsvDownload(Buffer.from(sentinel), Buffer.from(sentinel), 'darwin', 'arm64'))
      .toThrow('osv-tool-digest');
  });
});

const uvGraph = { id: 'genai-backend', ecosystem: 'pypi' as const, pathParts: ['uv.lock'], extras: ['functions', 'test'] };
const uvProject = { dependencies: { requests: '2.32.5' },
  optionalDependencies: { functions: { 'azure-functions': '2.3.0' }, test: { pytest: '9.1.1' } } };
function uvParsed() {
  return {
    version: 1, revision: 3,
    package: [
      { name: 'fixture', version: '0.0.0', source: { editable: '.' }, dependencies: [{ name: 'requests' }],
        'optional-dependencies': { functions: [{ name: 'azure-functions' }], test: [{ name: 'pytest' }] },
        metadata: { 'provides-extras': ['functions', 'test'] } },
      ...[['requests', '2.32.5'], ['urllib3', '1.26.5'], ['azure-functions', '2.3.0'], ['pytest', '9.1.1']].map(([name, version]) => ({
        name, version, source: { registry: 'https://pypi.org/simple' },
        dependencies: name === 'requests' ? [{ name: 'urllib3', marker: "sys_platform == 'win32'" }] : []
      }))
    ]
  };
}
describe('OSV full graph reconciliation', () => {
  it('covers platform markers and all optional sets independently of the host', () => {
    const graph = reconcileUvLock('lock bytes', uvParsed(), uvGraph, uvProject);
    expect(graph.components).toHaveLength(4);
    expect(graph.components.find(item => item.name === 'urllib3')!.chains).toEqual([['fixture', 'requests', 'urllib3']]);
    expect(graph.components.some(item => item.name === 'pytest')).toBe(true);
    expect(graph.components.some(item => item.name === 'azure-functions')).toBe(true);
    expect(osvSbom(graph)).not.toContain('fixture');
    expect(osvSbom(graph)).toContain('pkg:pypi/urllib3@1.26.5');
  });

  it('rejects missing extras, transitive packages, duplicated versions and private sources', () => {
    const missing = uvParsed(); missing.package.splice(2, 1);
    expect(() => reconcileUvLock('', missing, uvGraph, uvProject)).toThrow('osv-unresolved-dependency');
    const duplicate = uvParsed(); duplicate.package.push(duplicate.package[1]!);
    expect(() => reconcileUvLock('', duplicate, uvGraph, uvProject)).toThrow('osv-ambiguous-uv-versions');
    const privateSource = uvParsed(); privateSource.package[1]!.source = { registry: 'https://private.invalid' };
    expect(() => reconcileUvLock('', privateSource, uvGraph, uvProject)).toThrow('osv-private-or-unresolved-source');
    expect(() => reconcileUvLock('', { ...uvParsed(), revision: 4 }, uvGraph, uvProject)).toThrow('osv-unsupported-uv-format');
    expect(() => reconcileUvLock('', uvParsed(), { ...uvGraph, extras: [] }, uvProject)).toThrow('osv-extra-mismatch');
    expect(() => reconcileUvLock('', uvParsed(), { ...uvGraph, ecosystem: 'npm' }, uvProject)).toThrow('osv-wrong-graph');
  });

  it('requires the worker runtime/functions export, while keeping tests in full-lock coverage', () => {
    const graph = reconcileUvLock('bytes', uvParsed(), { ...uvGraph, id: 'function-worker', extras: ['test'] },
      { dependencies: { 'azure-functions': '2.3.0' }, optionalDependencies: { test: { pytest: '9.1.1' } } });
    const requirements = ['requests==2.32.5', 'urllib3==1.26.5', 'azure-functions==2.3.0']
      .map(item => `${item} --hash=sha256:${'a'.repeat(64)}`).join('\n');
    const worker = reconcileWorkerRequirements(requirements, uvParsed(), graph);
    expect(worker.inputDigest).not.toEqual(graph.inputDigest);
    expect(worker.components).toHaveLength(4);
    expect(reconcileWorkerRequirements(requirements.replace('urllib3==1.26.5 ',
      "urllib3==1.26.5 ; sys_platform == 'win32' \\\n    "), uvParsed(), graph).components).toHaveLength(4);
    expect(() => reconcileWorkerRequirements(requirements.split('\n').slice(1).join('\n'), uvParsed(), graph))
      .toThrow('osv-worker-coverage');
    expect(() => reconcileWorkerRequirements(requirements.replace('1.26.5', '1.26.6'), uvParsed(), graph))
      .toThrow('osv-worker-lock-drift');
    expect(() => reconcileWorkerRequirements('urllib3 @ https://private.invalid', uvParsed(), graph))
      .toThrow('osv-unresolved-worker-requirement');
  });

  function goInput() {
    const names = ['example.org/parent', 'example.org/transitive'], sum = `h1:${'a'.repeat(43)}=`;
    return {
      graph: { id: 'go-backend', ecosystem: 'go' as const, pathParts: ['go.mod'], extras: [] },
      goMod: 'module example.org/fixture\n\ngo 1.27.0\n\nrequire (\nexample.org/parent v1.0.0\nexample.org/transitive v1.0.0 // indirect\n)\n',
      goSum: names.flatMap(name => [`${name} v1.0.0 ${sum}`, `${name} v1.0.0/go.mod ${sum}`]).join('\n'),
      resolved: [{ Path: 'example.org/fixture', Main: true },
        ...names.map(name => ({ Path: name, Version: 'v1.0.0', Sum: sum, GoModSum: sum }))],
      moduleGraph: 'example.org/fixture example.org/parent@v1.0.0\nexample.org/fixture example.org/transitive@v1.0.0\nexample.org/parent@v1.0.0 example.org/transitive@v1.0.0\nexample.org/fixture go@1.27.0',
      expected: { dependencies: { 'example.org/parent': 'v1.0.0' }, tools: {}, goVersion: '1.27.0' }
    };
  }

  it('binds exact resolved Go modules to frozen checksums and actual graph chains', () => {
    const graph = reconcileGoResolution(goInput());
    expect(graph.components).toHaveLength(2);
    expect(graph.components[1]!.chains).toContainEqual(['example.org/fixture', 'example.org/parent@v1.0.0', 'example.org/transitive@v1.0.0']);
    expect(osvSbom(graph)).toContain('pkg:golang/example.org/transitive@v1.0.0');
  });

  it('never counts go.mod, go.sum supersets or unresolved supported tools as completeness', () => {
    expect(() => reconcileGoResolution({ ...goInput(), resolved: [] })).toThrow();
    expect(() => reconcileGoResolution({ ...goInput(), resolved: goInput().resolved.slice(0, 2) })).toThrow('osv-go-selected-version-drift');
    expect(() => reconcileGoResolution({ ...goInput(), goSum: '' })).toThrow('osv-invalid-go-checksums');
    expect(() => reconcileGoResolution({ ...goInput(), moduleGraph: 'example.org/fixture example.org/parent@v1.0.0' }))
      .toThrow('osv-go-root-graph-mismatch');
    expect(() => reconcileGoResolution({ ...goInput(),
      expected: { ...goInput().expected, tools: { 'example.org/migration-tool': 'v1.0.0' } } })).toThrow('osv-go-tool-graph-missing');
    const replaced = goInput(); Object.assign(replaced.resolved[1]!, { Replace: { Path: '../source' } });
    expect(() => reconcileGoResolution(replaced)).toThrow('osv-unresolved-go-module');
    expect(() => reconcileGoResolution({ ...goInput(), goMod: goInput().goMod + '\nreplace example.org/parent => ../source' }))
      .toThrow('osv-unsupported-go-directive');
  });

  it('retains older loaded-version edges that contribute to the selected MVS build list', () => {
    const input = goInput(), sum = `h1:${'a'.repeat(43)}=`;
    input.resolved.push({ Path: 'example.org/leaf', Version: 'v1.0.0', Sum: sum, GoModSum: sum });
    input.goSum += `\nexample.org/leaf v1.0.0 ${sum}\nexample.org/leaf v1.0.0/go.mod ${sum}`;
    input.moduleGraph += '\nexample.org/transitive@v1.0.0 example.org/parent@v0.9.0\nexample.org/parent@v0.9.0 example.org/leaf@v1.0.0';
    const selected = reconcileGoResolution(input);
    expect(selected.components.find(item => item.name === 'example.org/leaf')!.chains[0])
      .toContain('example.org/parent@v0.9.0');
    expect(selected.components).toHaveLength(3);
    expect(() => reconcileGoResolution({ ...input,
      moduleGraph: input.moduleGraph + '\nexample.org/parent@v1.0.0 example.org/transitive@v1.1.0' })).toThrow('osv-go-mvs-mismatch');
  });

  it('does not promote historical checksum entries to selected dependencies', () => {
    const input = goInput();
    expect(reconcileGoResolution({ ...input, goSum: `${input.goSum}\nexample.org/historical v9.0.0 h1:${'a'.repeat(43)}=` })
      .components).toHaveLength(2);
  });

  it('parses only exact sumdb record coordinates, without claiming the parser verifies signatures', () => {
    const hash = `h1:${'a'.repeat(43)}=`;
    const source = `123\nexample.org/parent v1.0.0 ${hash}\nexample.org/parent v1.0.0/go.mod ${hash}\n\ngo.sum database tree\n1\nfixture\n\n— sum.golang.org nonfunctional-signature\n`;
    const record = parseGoSumdbRecord(source, 'example.org/parent', 'v1.0.0');
    expect(record.sum).toBe(hash);
    expect(record.recordDigest).toBe(osvDigest(source));
    expect(() => parseGoSumdbRecord(source, 'example.org/other', 'v1.0.0')).toThrow('osv-go-sumdb-coordinate');
    expect(() => parseGoSumdbRecord(source.replace('— sum.golang.org', sentinel), 'example.org/parent', 'v1.0.0'))
      .toThrow('osv-go-sumdb-record');
  });

  it('keeps missing upstream sums distinct from exact supplemental verification observations', () => {
    const input = goInput(), sum = `h1:${'a'.repeat(43)}=`;
    input.goSum = input.goSum.split('\n').filter(line => !line.startsWith('example.org/transitive ')).join('\n');
    delete input.resolved[2]!.Sum;
    delete input.resolved[2]!.GoModSum;
    expect(goChecksumGaps(input.resolved, input.goSum)).toEqual([
      { name: 'example.org/transitive', version: 'v1.0.0', archive: 'missing', module: 'missing' }
    ]);
    const proof = { name: 'example.org/transitive', version: 'v1.0.0', sum, goModSum: sum, recordDigest: osvDigest('simulated-proof') };
    expect(() => reconcileGoResolution(input)).toThrow('osv-go-checksum-mismatch');
    expect(reconcileGoResolution({ ...input, additionalChecksums: [proof] }).components).toHaveLength(2);
    expect(() => reconcileGoResolution({ ...input, additionalChecksums: [proof, proof] })).toThrow('osv-unused-go-provenance');
    expect(() => reconcileGoResolution({ ...input, additionalChecksums: [{ ...proof, name: 'example.org/unselected' }] }))
      .toThrow('osv-unused-go-provenance');
    expect(() => reconcileGoResolution({ ...goInput(), additionalChecksums: [{ ...proof, sum: `h1:${'b'.repeat(43)}=` }] }))
      .toThrow('osv-go-checksum-mismatch');
  });

  it('requires the separate exact tool root and preserves distinct app/tool versions in coverage', () => {
    const app = reconcileGoResolution(goInput()), input = goInput(), hash = `h1:${'a'.repeat(43)}=`;
    const toolIdentity = { name: 'example.org/fixture', version: 'v3.0.0', sum: hash, goModSum: hash };
    const tool = reconcileGoResolution({ ...input, tool: toolIdentity,
      goMod: input.goMod + '\nretract (\nv2.0.0 // upstream-only retraction\n)\n',
      expected: { ...input.expected, tools: { 'example.org/fixture': 'v3.0.0' } } });
    expect(tool.components[0]!.name).toBe('example.org/fixture');
    expect(() => combineGoGraphs(app, [], { 'example.org/fixture': 'v3.0.0' })).toThrow('osv-go-tool-graph-missing');
    expect(() => combineGoGraphs(app, [tool], { 'example.org/fixture': 'v4.0.0' })).toThrow('osv-go-tool-graph-missing');
    const combined = combineGoGraphs(app, [tool], { 'example.org/fixture': 'v3.0.0' });
    expect(combined.components).toHaveLength(3);
    expect(combined.components.find(item => item.name === 'example.org/parent')!.chains).toHaveLength(2);
    const otherVersion = structuredClone(tool);
    otherVersion.components[1]!.version = 'v1.1.0';
    expect(combineGoGraphs(app, [otherVersion], { 'example.org/fixture': 'v3.0.0' }).components).toHaveLength(4);
    expect(() => reconcileGoResolution({ ...input, tool: toolIdentity,
      goMod: input.goMod + '\nretract (\nv3.0.0\n)\n',
      expected: { ...input.expected, tools: { 'example.org/fixture': 'v3.0.0' } } })).toThrow('osv-retracted-tool');
  });

  it('disables toolchain upgrades, module writes, credentials, network and global caches for Go', () => {
    const env = frozenGoEnvironment('/registered private');
    expect(env.GOTOOLCHAIN).toBe('local');
    expect(env.GOFLAGS).toBe('-mod=readonly');
    expect(env.GOPROXY).toBe('off');
    expect(env.GOWORK).toBe('off');
    expect(env.GOENV).toBe('off');
    expect(env.GOMODCACHE).toBe('/registered private');
    expect(env.GOTELEMETRY).toBe('off');
    expect(env.GOAUTH).toBe('off');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

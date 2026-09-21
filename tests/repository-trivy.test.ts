import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  captureTrivyProcess, imageCoverage, imageSecurityReport, normalizeTrivyReport,
  privateImageEnvironment, TRIVY_ARCHIVES, TRIVY_POLICY, validateLocalDockerEndpoint,
  trivyImageArguments, createLocalImageSession, normalizeLocalBuilderInspection, trivyReportShape, generatedGoSourceBinding
} from '../scripts/repository-security/trivy.ts';
import { evaluateSecurityReport, type EvidenceIdentity } from '../scripts/repository-security/evidence.ts';
import { imageCases } from '../scripts/repository-security/inventory.ts';
import { createSecurityWorkspace } from '../scripts/repository-security/workspace.ts';
import { trivyUnscoredPolicyRules } from '../scripts/repository-security/trivy-advisory.ts';

const sentinel = 'TRIVY_NONFUNCTIONAL_BOUNDARY_SENTINEL';
const image = { tag: 'liftoff-security-fixture:node', id: `sha256:${'a'.repeat(64)}`, platform: 'linux/amd64' as const };
const database = `sha256:${'b'.repeat(64)}`;
const time = '2026-09-20T00:00:00.000Z';
const identity: EvidenceIdentity = {
  repository: 'owner/repository', event: 'workflow_dispatch', sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  workflowSha: 'c'.repeat(40), runId: '1', attempt: 1,
  policyDigest: database, inventoryDigest: database, configurationDigest: database
};
function report() {
  return {
    SchemaVersion: 2, ArtifactName: image.id, ArtifactType: 'container_image',
    Metadata: {
      ImageID: image.id, OS: { Family: 'debian', Name: '12' },
      ImageConfig: { architecture: 'amd64', os: 'linux', config: { Env: [sentinel] }, history: [sentinel] }
    },
    Results: [
      { Target: 'debian:12', Class: 'os-pkgs', Type: 'debian',
        Packages: [{ Name: 'libc6', Version: '2.36-9+deb12u1' }] },
      { Target: `app/${sentinel}/node_modules/lodash/package.json`, Class: 'lang-pkgs', Type: 'node-pkg',
        Packages: [{ Name: 'lodash', Version: '4.17.20' }],
        Vulnerabilities: [{
          VulnerabilityID: 'CVE-2021-23337', PkgName: 'lodash', InstalledVersion: '4.17.20', Severity: 'HIGH',
          Title: sentinel, Description: sentinel, References: [sentinel], PkgPath: sentinel
        }] }
    ]
  };
}
const normalize = (value: unknown, coverage = imageCoverage('node')) =>
  normalizeTrivyReport(JSON.stringify(value), image, coverage, database, time, time);

describe('path-free Trivy schema diagnostics', () => {
  it('identifies missing Go versions without printing package names, paths or advisory text', () => {
    const input = report();
    Object.assign(input.Results[1], { Type: 'gobinary' });
    Object.assign(input.Results[1]!.Packages[0], { Name: sentinel, Version: undefined });
    const result = trivyReportShape(Buffer.from(JSON.stringify(input)));
    expect(result).toMatchObject({
      parsed: true, resultCount: 2,
      results: [{ missingVersions: 0 }, { type: 'gobinary', missingVersions: 1 }]
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    Object.assign(input.Results[1], { Type: { toString: sentinel } });
    expect(trivyReportShape(Buffer.from(JSON.stringify(input)))).toMatchObject({
      results: [{ type: 'debian' }, { type: 'unrecognized' }]
    });
    expect(trivyReportShape(Buffer.from(`{"untrusted":"${sentinel}`))).toEqual({ parsed: false, reason: 'invalid-json' });
  });

  it('retains the pinned upstream versionless Go root shape only with an exact built-source binding', () => {
    const input = report();
    const binding = generatedGoSourceBinding('module example.com/fixture/backend\n\ngo 1.27.0\n');
    const goResult = {
      Target: 'app/api', Class: 'lang-pkgs', Type: 'gobinary',
      Packages: [
        { ID: binding.moduleName, Name: binding.moduleName, Relationship: 'root', DependsOn: ['stdlib@v1.27.0'] },
        { ID: 'stdlib@v1.27.0', Name: 'stdlib', Version: 'v1.27.0', Relationship: 'direct' }
      ], Vulnerabilities: []
    };
    const raw = () => JSON.stringify({ ...input, Results: [input.Results[0], goResult] });
    expect(() => normalizeTrivyReport(raw(), image, imageCoverage('go'), database, time, time)).toThrow('unbound-package-version');
    const assessment = normalizeTrivyReport(raw(), image, imageCoverage('go'), database, time, time, binding);
    expect(assessment.coverage.application.packages).toBe(2);
    expect(assessment.sourceComponents).toEqual([{
      componentDigest: `sha256:${createHash('sha256').update(binding.moduleName).digest('hex')}`,
      targetDigest: `sha256:${createHash('sha256').update('app/api').digest('hex')}`,
      moduleDigest: binding.moduleDigest, version: null, binding: 'built-source-module'
    }]);
    for (const change of ['wrong-role', 'wrong-module', 'wrong-target', 'missing-stdlib-version', 'incomplete-chain', 'root-vulnerability']) {
      const result = structuredClone(goResult);
      if (change === 'wrong-role') result.Packages[0]!.Relationship = 'indirect';
      if (change === 'wrong-module') result.Packages[0]!.Name = 'example.com/another/backend';
      if (change === 'wrong-target') result.Target = 'app/unregistered';
      if (change === 'missing-stdlib-version') Object.assign(result.Packages[1]!, { Version: undefined });
      if (change === 'incomplete-chain') result.Packages[0]!.DependsOn = ['missing-package@v1'];
      if (change === 'root-vulnerability') Object.assign(result, {
        Vulnerabilities: [{ PkgName: binding.moduleName, InstalledVersion: '', VulnerabilityID: 'CVE-2026-12345', Severity: 'HIGH' }]
      });
      expect(() => normalizeTrivyReport(JSON.stringify({ ...input, Results: [input.Results[0], result] }),
        image, imageCoverage('go'), database, time, time, binding)).toThrow();
    }
  });
});

describe('pinned local Trivy boundary', () => {
  it('pins exact official artifacts rather than accepting a version string alone', () => {
    expect(TRIVY_POLICY.version).toBe('0.69.3');
    expect(TRIVY_ARCHIVES['darwin-arm64'].sha256)
      .toBe('a2f2179afd4f8bb265ca3c7aefb56a666bc4a9a411663bc0f22c3549fbc643a5');
    for (const pin of Object.values(TRIVY_ARCHIVES)) {
      expect(pin.asset).toContain(TRIVY_POLICY.version);
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('does not inherit Docker contexts, credentials, proxy or scanner configuration', () => {
    const root = path.resolve('..', 'registered-private-fixture');
    const environment = privateImageEnvironment(root, 'unix:///owned/docker.sock');
    expect(environment.DOCKER_HOST).toBe('unix:///owned/docker.sock');
    expect(environment.DOCKER_CONFIG).toBe(path.join(root, 'docker'));
    expect(environment.DOCKER_BUILDKIT).toBe('1');
    expect(environment.BUILDX_BUILDER).toBe('default');
    expect(environment.BUILDX_CONFIG).toBe(path.join(root, 'buildx'));
    expect(environment.HOME).toBe(path.join(root, 'home'));
    for (const key of ['DOCKER_CONTEXT', 'DOCKER_AUTH_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'TRIVY_SERVER', 'TRIVY_TOKEN', 'TRIVY_IGNORE_UNFIXED',
      'TRIVY_SKIP_DB_UPDATE', 'NODE_OPTIONS', 'NPM_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK',
      'BUILDKIT_HOST', 'BUILDKIT_TLS_SERVER_NAME', 'BUILDX_BAKE_FILE', 'BUILDX_GIT_AUTH_TOKEN']) {
      expect(environment[key]).toBeUndefined();
    }
  });

  describe('explicit default builder locality', () => {
    const endpoint = 'unix:///owned/docker.sock';
    const inspection = [
      'Name: default', 'Driver: docker', '', 'Nodes:', 'Name: default', `Endpoint: ${endpoint}`,
      'Status: running', 'BuildKit: v0.26.2', 'Platforms: linux/arm64, linux/amd64', ''
    ].join('\n');
    it('pins only the running Docker-driver node and its actual platform inventory', () => {
      expect(normalizeLocalBuilderInspection(inspection, endpoint)).toMatchObject({
        name: 'default', driver: 'docker', node: 'default', buildkitVersion: 'v0.26.2',
        platforms: ['linux/amd64', 'linux/arm64']
      });
      expect(normalizeLocalBuilderInspection(inspection.replace(`Endpoint: ${endpoint}`, 'Endpoint: default'), endpoint))
        .toEqual(normalizeLocalBuilderInspection(inspection, endpoint));
      expect(normalizeLocalBuilderInspection(inspection.replace('BuildKit:', 'BuildKit version:'), endpoint))
        .toEqual(normalizeLocalBuilderInspection(inspection, endpoint));
    });
    it.each([
      ['remote endpoint', (s: string) => s.replace(endpoint, 'tcp://remote:1234')],
      ['other local endpoint', (s: string) => s.replace(endpoint, 'unix:///other/docker.sock')],
      ['remote driver', (s: string) => s.replace('Driver: docker', 'Driver: remote')],
      ['container driver', (s: string) => s.replace('Driver: docker', 'Driver: docker-container')],
      ['kubernetes driver', (s: string) => s.replace('Driver: docker', 'Driver: kubernetes')],
      ['inactive builder', (s: string) => s.replace('Status: running', 'Status: inactive')],
      ['different selection', (s: string) => s.replace('Name: default', 'Name: production')],
      ['second node', (s: string) => `${s}Name: remote\nEndpoint: tcp://remote:1234\n`],
      ['missing platform', (s: string) => s.replace(', linux/amd64', '')],
      ['declared-only platform', (s: string) => s.replace('linux/amd64', 'linux/amd64*')],
      ['duplicate BuildKit labels', (s: string) => `${s}BuildKit version: v0.26.2\n`],
      ['error metadata', (s: string) => `${s}Error: ${sentinel}\n`]
    ])('rejects %s without echoing builder diagnostics', (_name, change) => {
      try {
        normalizeLocalBuilderInspection(change(inspection), endpoint);
        expect.fail('unqualified builder must fail');
      } catch (error) {
        expect(String(error)).toContain('trivy-');
        expect(String(error)).not.toContain(sentinel);
      }
    });
  });

  it.each([
    'tcp://host:2375', 'ssh://host', 'https://host', 'npipe:////./pipe/docker_engine',
    'unix://host/var/run/docker.sock', 'unix:///a/../docker.sock', 'unix:///a%2fb', 'unix:///a?token=x',
    'unix:///a#fragment', 'unix:///missing-local-socket', 'unix:///a\nsocket'
  ])('rejects unsafe, missing or remote endpoint without contacting it: %s', async endpoint => {
    await expect(validateLocalDockerEndpoint(endpoint)).rejects.toThrow('trivy-nonlocal-docker');
  });

  it('takes image case and platform coverage from the shared inventory', () => {
    expect(imageCases.map(entry => imageCoverage(entry.id).id)).toEqual(imageCases.map(entry => entry.id));
    expect(imageCoverage('frontend').application).toBe('inapplicable-static-assets');
    for (const entry of imageCases) expect(imageCoverage(entry.id).os).toBe('required');
    expect(() => imageCoverage('native-cli')).toThrow('trivy-unregistered-image');
  });

  it('scans only the exact local digest with both package analyzers and no config/secret/remote fallback', () => {
    const args = trivyImageArguments(path.resolve('..', 'registered-fixture'), 'unix:///owned/docker.sock', image.id);
    expect(args[0]).toBe('image');
    expect(args.at(-1)).toBe(image.id);
    for (const [flag, value] of [
      ['--image-src', 'docker'], ['--scanners', 'vuln'], ['--pkg-types', 'os,library'], ['--format', 'json'],
      ['--docker-host', 'unix:///owned/docker.sock'], ['--cache-backend', 'memory']
    ]) expect(args[args.indexOf(flag!) + 1]).toBe(value);
    for (const flag of ['--offline-scan', '--skip-db-update', '--skip-java-db-update', '--skip-version-check',
      '--list-all-pkgs']) expect(args).toContain(flag);
    for (const flag of ['--server', '--token', '--ignore-unfixed', '--ignore-policy', '--severity', '--skip-files',
      '--skip-dirs', '--disabled-analyzers']) expect(args).not.toContain(flag);
    expect(() => trivyImageArguments(process.cwd(), 'https://remote', image.id)).toThrow('trivy-nonlocal-docker');
    expect(() => trivyImageArguments(process.cwd(), 'unix:///owned/docker.sock', 'latest')).toThrow('invalid-digest');
  });
});

describe('sanitized bounded process boundary, before real scanner execution', () => {
  const options = { cwd: process.cwd(), environment: { PATH: '/usr/bin:/bin' }, timeoutMs: 5_000, maxBytes: 1024 };
  it.each([
    `process.stdout.write("${sentinel}"); process.exit(1)`,
    `process.stderr.write("${sentinel}")`,
    `process.stdout.write("${sentinel}".repeat(100))`
  ])('never retains raw failure content (%#)', async code => {
    let error: unknown;
    try { await captureTrivyProcess(process.execPath, ['-e', code], options); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(sentinel);
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect((error as Error).cause).toBeUndefined();
  });

  it('discards bounded build diagnostics only when explicitly requested', async () => {
    const output = await captureTrivyProcess(process.execPath,
      ['-e', `process.stderr.write("${sentinel}"); process.stdout.write("ok")`],
      { ...options, discardStderr: true });
    expect(output.toString()).toBe('ok');
    output.fill(0);
    await expect(captureTrivyProcess(process.execPath,
      ['-e', `process.stderr.write("${sentinel}".repeat(100))`],
      { ...options, discardStderr: true })).rejects.toThrow('trivy-output-limit');
  });

  it('bounds timeout and missing-tool diagnostics without echoing arguments or paths', async () => {
    await expect(captureTrivyProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { ...options, timeoutMs: 50 })).rejects.toThrow('trivy-timeout');
    try {
      await captureTrivyProcess(path.resolve(sentinel), [sentinel], options);
      expect.fail('missing executable must fail');
    } catch (error) {
      expect(String(error)).toContain('trivy-process-failed');
      expect(String(error)).not.toContain(sentinel);
    }
  });

  it('sanitizes synchronous process argument errors too', async () => {
    try {
      await captureTrivyProcess(process.execPath, [`${sentinel}\0`], options);
      expect.fail('invalid arguments must fail');
    } catch (error) {
      expect(String(error)).toContain('trivy-process-failed');
      expect(String(error)).not.toContain(sentinel);
    }
  });
});

describe('digest-bound complete image evidence', () => {
  it('projects installed OS and application coverage and an independently blocking finding', () => {
    const assessment = normalize(report());
    expect(assessment.coverage).toEqual({
      os: { status: 'required', packages: 1 }, application: { status: 'required', packages: 1 }
    });
    expect(assessment.findings[0]).toMatchObject({
      rule: 'CVE-2021-23337', severity: 'high', artifactDigest: image.id, owner: 'repository-maintainer'
    });
    expect(JSON.stringify(assessment)).not.toContain(sentinel);
    expect(JSON.stringify(assessment)).not.toContain('lodash');
    expect(assessment.findings[0]!.component).toMatch(/^sha256:[a-f0-9]{64}$/);
    const envelope = imageSecurityReport(assessment, identity);
    expect(evaluateSecurityReport(envelope, envelope, { exceptions: [], blockingRules: [] }, new Date(time)))
      .toMatchObject({ passed: false, blocking: [assessment.findings[0]!.id] });
  });

  it('retains low findings with an owner rather than silently suppressing them', () => {
    const input = report();
    input.Results[1]!.Vulnerabilities![0]!.Severity = 'LOW';
    const envelope = imageSecurityReport(normalize(input), identity);
    const verdict = evaluateSecurityReport(envelope, envelope, { exceptions: [], blockingRules: [] }, new Date(time));
    expect(verdict.passed).toBe(true);
    expect(verdict.tracked).toHaveLength(1);
  });

  it('preserves exact Debian temporary IDs only in Debian OS coverage, without waiving severity triage', () => {
    const input = report();
    input.Results[0]!.Vulnerabilities = [{
      ...input.Results[1]!.Vulnerabilities![0]!,
      VulnerabilityID: 'TEMP-0841856-B18BAF', PkgName: 'libc6', InstalledVersion: '2.36-9+deb12u1', Severity: 'LOW'
    }];
    expect(normalize(input).findings[0]!.rule).toBe('TEMP-0841856-B18BAF');
    input.Results[0]!.Vulnerabilities[0]!.Severity = 'UNKNOWN';
    const normalized = normalize(input);
    expect(normalized.findings[0]).toMatchObject({
      kind: 'policy', policyClass: 'trivy-valid-native-unscored-advisory', upstreamSeverity: 'UNKNOWN', severity: 'high'
    });
    const evidence = imageSecurityReport(normalized, identity);
    expect(evaluateSecurityReport(evidence, evidence, {
      exceptions: [], blockingRules: trivyUnscoredPolicyRules
    }, new Date(time)).passed).toBe(false);
    input.Results[0]!.Vulnerabilities = [];
    input.Results[1]!.Vulnerabilities![0]!.VulnerabilityID = 'TEMP-0841856-B18BAF';
    expect(normalize(input).findings[0]!.rule).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('reconciles Trivy OS epoch/version/release fields exactly rather than dropping OS findings', () => {
    const input = report() as any;
    input.Results[0].Packages = [{ Name: 'libc6', Version: '2.36', Epoch: 1, Release: '9+deb12u1' }];
    input.Results[0].Vulnerabilities = [{
      VulnerabilityID: 'CVE-2025-0001', PkgName: 'libc6', InstalledVersion: '1:2.36-9+deb12u1', Severity: 'HIGH'
    }];
    expect(normalize(input).findings).toHaveLength(2);
    input.Results[0].Vulnerabilities[0].InstalledVersion = '2.36';
    expect(() => normalize(input)).toThrow('trivy-finding-outside-packages');
    input.Results[0].Packages[0].Epoch = sentinel;
    expect(() => normalize(input)).toThrow('trivy-invalid-package-epoch');
  });

  it('permits empty findings only with positive installed package coverage', () => {
    const input = report();
    input.Results[1]!.Vulnerabilities = [];
    expect(normalize(input).findings).toEqual([]);
    input.Results = [];
    expect(() => normalize(input)).toThrow('trivy-missing-os-coverage');
  });

  it.each([
    ['wrong schema', (r: any) => { r.SchemaVersion = 1; }],
    ['tag instead of digest', (r: any) => { r.ArtifactName = image.tag; }],
    ['different image', (r: any) => { r.Metadata.ImageID = database; }],
    ['different platform', (r: any) => { r.Metadata.ImageConfig.architecture = 'arm64'; }],
    ['missing OS metadata', (r: any) => { delete r.Metadata.OS; }],
    ['unsupported OS', (r: any) => { r.Metadata.OS.Eosl = true; }],
    ['mismatched OS family', (r: any) => { r.Results[0].Type = 'alpine'; }],
    ['no package inventory', (r: any) => { delete r.Results[0].Packages; }],
    ['no OS packages', (r: any) => { r.Results.shift(); }],
    ['no application packages', (r: any) => { r.Results.pop(); }],
    ['unexpected scanner', (r: any) => { r.Results[0].Class = 'config'; }],
    ['secret result', (r: any) => { r.Results[0].Secrets = [{ Match: sentinel }]; }],
    ['unmapped package type', (r: any) => { r.Results[1].Type = 'maven'; }],
    ['lockfile-only application coverage', (r: any) => { r.Results[1].Type = 'npm'; }],
    ['finding outside inventory', (r: any) => { r.Results[1].Vulnerabilities[0].PkgName = sentinel; }],
    ['unsupported severity', (r: any) => { r.Results[1].Vulnerabilities[0].Severity = 'UNSUPPORTED'; }],
    ['missing severity', (r: any) => { delete r.Results[1].Vulnerabilities[0].Severity; }],
    ['missing advisory', (r: any) => { delete r.Results[1].Vulnerabilities[0].VulnerabilityID; }],
    ['duplicate target', (r: any) => { r.Results.push(r.Results[1]); }],
    ['duplicate finding', (r: any) => { r.Results[1].Vulnerabilities.push(r.Results[1].Vulnerabilities[0]); }]
  ])('fails closed on %s', (_name, change) => {
    const input = report();
    change(input);
    expect(() => normalize(input)).toThrow();
    try { normalize(input); } catch (error) {
      expect(String(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
    }
  });

  it('hashes opaque advisory identities without losing a finding, severity or gate failure', () => {
    const input = report();
    input.Results[1]!.Vulnerabilities![0]!.VulnerabilityID = sentinel;
    const assessment = normalize(input);
    expect(assessment.findings).toHaveLength(1);
    expect(assessment.findings[0]!.rule).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(assessment)).not.toContain(sentinel);
    const envelope = imageSecurityReport(assessment, identity);
    expect(evaluateSecurityReport(envelope, envelope, { exceptions: [], blockingRules: [] }, new Date(time)).passed)
      .toBe(false);
  });

  // A local Unix socket is metadata-only here; the fake CLI never connects to it,
  // starts a daemon, downloads a tool or invokes a scanner.
  describe.skipIf(process.platform === 'win32')('owned local Docker lifecycle contracts (simulated)', () => {
    async function fixture(
      operation: (session: Awaited<ReturnType<typeof createLocalImageSession>>,
        state: any, save: () => Promise<void>, read: () => Promise<any>) => Promise<void>,
      overrides: Record<string, unknown> = {}
    ) {
      const parent = path.resolve('..');
      const workspace = await createSecurityWorkspace(parent);
      const socket = path.join(workspace.root, 'docker.sock');
      const statePath = path.join(workspace.root, 'state.json');
      const executable = path.join(workspace.root, 'docker.mjs');
      const plugin = '#!/bin/sh\nexit 1\n';
      const pluginPath = path.join(workspace.root, 'docker-buildx');
      const composePath = path.join(workspace.root, 'docker-compose');
      const server = createServer();
      let session: Awaited<ReturnType<typeof createLocalImageSession>> | undefined;
      let finalState: any;
      const state: any = {
        image: undefined, container: undefined, removed: [], builds: [],
        daemon: { id: 'local-daemon', version: '29.8.0', os: 'linux', architecture: 'amd64' },
        builder: { driver: 'docker', endpoint: `unix://${socket}`, status: 'running', version: 'v0.26.2' },
        ...overrides
      };
      const save = () => writeFile(statePath, JSON.stringify(state));
      const read = async () => JSON.parse(await readFile(statePath, 'utf8'));
      await workspace.write(['state.json'], JSON.stringify(state));
      await workspace.write(['docker.mjs'], `#!${process.execPath}
  import {readFile, writeFile} from 'node:fs/promises';
  const file=new URL('./state.json',import.meta.url);
  const state=JSON.parse(await readFile(file,'utf8'));
  const args=process.argv.slice(2);
  if(args[0]!=='--host'||args[2]!=='--config'||process.env.DOCKER_CONTEXT||process.env.DOCKER_AUTH_CONFIG||
    process.env.DOCKER_BUILDKIT!=='1'||process.env.BUILDX_BUILDER!=='default'||process.env.BUILDKIT_HOST||
    !process.env.BUILDX_CONFIG.endsWith('/buildx'))process.exit(1);
  const [kind,command,...rest]=args.slice(4);
  if(kind==='version')console.log(JSON.stringify({Version:'29.8.0',Os:'linux',Arch:'amd64'}));
  else if(kind==='info')console.log(JSON.stringify(state.daemon));
  else if(kind==='context'&&command==='inspect'&&rest[0]==='default')console.log(JSON.stringify(process.env.DOCKER_HOST));
  else if(kind==='buildx'&&command==='version'){
    if(state.missingBuildx){console.error('${sentinel}');process.exit(1);}
    console.log('github.com/docker/buildx v0.26.2 ${'a'.repeat(40)}');
  }
  else if(kind==='buildx'&&command==='inspect'&&rest.join(' ')==='default'){
    console.log(['Name: default','Driver: '+state.builder.driver,'','Nodes:','Name: default',
      'Endpoint: '+state.builder.endpoint,'Status: '+state.builder.status,
      'BuildKit: '+state.builder.version,'Platforms: linux/amd64, linux/arm64',''].join('\\n'));
  }
  else if(kind==='buildx'&&command==='build')state.builds.push(args);
  else if(kind==='compose'&&command==='version')console.log('5.5.1');
  else if(kind==='compose'&&command==='config')console.log('{}');
  else if(kind==='image'&&command==='inspect'&&state.image?.RepoTags.includes(rest[0]))console.log(JSON.stringify([state.image]));
  else if(kind==='image'&&command==='ls'){if(state.image)console.log(state.image.Id);}
  else if(kind==='image'&&command==='rm'){state.removed.push(rest);state.image=undefined;}
  else if(kind==='container'&&command==='inspect'&&state.container?.Name==='/'+rest[0])console.log(JSON.stringify([state.container]));
  else if(kind==='container'&&command==='ls'){if(state.container)console.log(state.container.Id);}
  else if(kind==='container'&&command==='rm'){state.removed.push(rest);state.container=undefined;}
  else process.exit(1);
  await writeFile(file,JSON.stringify(state));
  `);
      await chmod(executable, 0o700);
      try {
        await workspace.write(['docker-buildx'], plugin);
        await chmod(pluginPath, 0o700);
        if (overrides.composePinned === true) {
          await workspace.write(['docker-compose'], plugin);
          await chmod(composePath, 0o700);
        }
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(socket, resolve);
        });
        session = await createLocalImageSession({
          repositoryRoot: process.cwd(), workspaceParent: parent, dockerExecutable: executable,
          dockerEndpoint: `unix://${socket}`, cases: ['node'],
          buildxPlugin: { executable: pluginPath, digest: `sha256:${createHash('sha256').update(plugin).digest('hex')}` },
          ...(overrides.composePinned === true ? {
            composePlugin: { executable: composePath, digest: `sha256:${createHash('sha256').update(plugin).digest('hex')}` }
          } : {})
        });
        state.image = {
          Id: image.id, Os: 'linux', Architecture: 'amd64', RepoTags: [session.tagFor('node')],
          Config: { Labels: { [TRIVY_POLICY.ownerLabel]: session.runId, [TRIVY_POLICY.caseLabel]: 'node' } }
        };
        await save();
        await operation(session, state, save, read);
      } finally {
        if (session) await session.cleanup();
        finalState = await read();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await workspace.cleanup();
      }
      return finalState;
    }

    it('verifies digest/platform/labels and removes only the exact owned tag, without force or image-ID deletion', async () => {
      let tag: string | undefined;
      const result = await fixture(async (session, _state, _save, read) => {
        tag = session.tagFor('node');
        expect(await session.registerBuilt('node')).toEqual({ ...image, tag: session.tagFor('node') });
        const root = path.relative(process.cwd(), session.root);
        expect(root.startsWith('..')).toBe(true);
        expect((await read()).removed).toEqual([]);
      });
      expect(result.removed).toEqual([['--no-prune', tag]]);
    });

    it('reconciles an owned tag left by an interrupted build before removing it', async () => {
      let tag: string | undefined;
      const result = await fixture(async session => {
        tag = session.tagFor('node');
        expect(session.records()).toEqual([]);
      });
      expect(result.removed).toEqual([['--no-prune', tag]]);
    });

    it('requires both daemon and default-builder proof before returning a usable session', async () => {
      await expect(fixture(async () => { expect.fail('must not allow materialization or builds'); },
        { missingBuildx: true })).rejects.toThrow('trivy-unexpected-stderr');
    });

    it('pins builder selection, rejects raw builds, and ignores attempted environment overrides', async () => {
      await fixture(async (session, _state, _save, read) => {
        expect(session.locality()).toMatchObject({
          daemon: { version: '29.8.0', os: 'linux' },
          builder: { name: 'default', driver: 'docker', node: 'default' },
          dockerContext: 'absent', buildxSelection: 'explicit-default'
        });
        expect(Object.isFrozen(session.environment)).toBe(true);
        for (const args of [
          ['build', '.'], ['buildx', 'build', '.'], ['--context', 'remote', 'info'],
          ['image', 'ls', '--host=tcp://remote:1234']
        ]) expect(() => session.dockerArgs(args)).toThrow('trivy-uncontrolled-docker-command');
        await session.docker(['version'], { environment: { DOCKER_CONTEXT: 'remote', BUILDX_BUILDER: 'remote' } });
        await expect(session.build('node', { context: process.cwd() })).rejects.toThrow('trivy-unregistered-build-context');
        await expect(session.build('node', { context: 'https://remote.invalid/repository.git' })).rejects.toThrow('trivy-invalid-path');
        expect((await read()).builds).toEqual([]);
        const context = await session.prepareContext('node', [['services', 'telemetry-ingest', 'Dockerfile']]);
        await session.build('node', { context: context.root, dockerfile: ['services', 'telemetry-ingest', 'Dockerfile'], network: 'none' });
        const builds = (await read()).builds;
        expect(builds).toHaveLength(1);
        expect(builds[0].slice(4, 10)).toEqual(['buildx', 'build', '--builder', 'default', '--load', '--pull=false']);
        for (const flag of ['--push', '--cache-to', '--cache-from', '--output', '--bootstrap']) expect(builds[0]).not.toContain(flag);
      });
    });

    it.each(['daemon', 'builder'] as const)('refuses source transfer after %s identity drift', async kind => {
      await fixture(async (session, state, save, read) => {
        const context = await session.prepareContext('node', [['services', 'telemetry-ingest', 'Dockerfile']]);
        const original = structuredClone(state[kind]);
        if (kind === 'daemon') state.daemon.id = 'different-local-daemon';
        else state.builder.version = 'v0.26.3';
        await save();
        try {
          await expect(session.build('node', { context: context.root, dockerfile: ['services', 'telemetry-ingest', 'Dockerfile'] }))
            .rejects.toThrow(kind === 'daemon' ? 'trivy-daemon-identity-drift' : 'trivy-builder-identity-drift');
          expect((await read()).builds).toEqual([]);
        } finally { state[kind] = original; await save(); }
      });
    });

    it('requires an explicitly pinned Compose plugin and never exposes compose up through validation', async () => {
      await fixture(async session => {
        expect(() => session.dockerArgs(['compose', 'config', '-q'])).toThrow('trivy-unqualified-compose-plugin');
      });
      await fixture(async session => {
        expect(session.locality()).toMatchObject({ composeVersion: '5.5.1' });
        const result = await session.docker(['compose', 'config', '-q']);
        result.fill(0);
        expect(() => session.dockerArgs(['compose', 'up'])).toThrow('trivy-uncontrolled-docker-command');
        const plugin = path.join(session.root, 'docker', 'cli-plugins', 'docker-compose');
        const original = await readFile(plugin);
        await writeFile(plugin, '#!/bin/sh\nexit 0\n');
        try {
          await expect(session.docker(['compose', 'config', '-q'])).rejects.toThrow('trivy-compose-plugin-drift');
        } finally { await writeFile(plugin, original); }
      }, { composePinned: true });
    });

    it('refuses stored builder indirection before invoking any builder', async () => {
      await fixture(async (session, _state, _save, read) => {
        const selector = path.join(session.root, 'buildx', 'current');
        await writeFile(selector, '{"Name":"remote"}');
        try {
          await expect(session.verifyBuilder()).rejects.toThrow('trivy-unexpected-builder-configuration');
          expect((await read()).builds).toEqual([]);
        } finally { await unlink(selector); }
      });
    });

    it('detects private plugin substitution before any source transfer', async () => {
      await fixture(async (session, _state, _save, read) => {
        const plugin = path.join(session.root, 'docker', 'cli-plugins', 'docker-buildx');
        const original = await readFile(plugin);
        await writeFile(plugin, '#!/bin/sh\nexit 0\n');
        try {
          await expect(session.verifyBuilder()).rejects.toThrow('trivy-buildx-plugin-drift');
          expect((await read()).builds).toEqual([]);
        } finally { await writeFile(plugin, original); }
      });
    });

    it('copies only explicit source context inputs and fails if copied bytes drift', async () => {
      await fixture(async session => {
        const context = await session.prepareContext('node', [['services', 'telemetry-ingest', 'Dockerfile']]);
        await context.verify();
        await writeFile(path.join(context.root, 'services', 'telemetry-ingest', 'Dockerfile'), sentinel);
        await expect(context.verify()).rejects.toThrow('trivy-context-input-changed');
      });
    });

    it('cleans only descriptor-bound owned read-only module-cache directories', async () => {
      await fixture(async session => {
        const directory = path.join(session.root, 'cache', 'go', 'module');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, 'fixture.txt'), 'nonfunctional readonly cache data', { mode: 0o444 });
        await chmod(directory, 0o555);
      });
    });

    it('refuses replaced Docker configuration parents without following a symlink', async () => {
      await fixture(async session => {
        const config = path.join(session.root, 'docker'), saved = path.join(session.root, 'saved-docker');
        await rename(config, saved);
        await symlink(path.join(session.root, 'home'), config);
        try {
          await expect(session.docker(['version'])).rejects.toThrow('trivy-workspace-changed');
        } finally {
          await unlink(config);
          await rename(saved, config);
        }
      });
    });

    it.each(['digest', 'platform', 'label'] as const)('refuses cleanup on %s drift', async kind => {
      await fixture(async (session, state, save, read) => {
        await session.registerBuilt('node');
        const original = structuredClone(state.image);
        if (kind === 'digest') state.image.Id = database;
        if (kind === 'platform') state.image.Architecture = 'arm64';
        if (kind === 'label') state.image.Config.Labels[TRIVY_POLICY.ownerLabel] = sentinel;
        await save();
        await expect(session.cleanup()).rejects.toThrow();
        expect((await read()).removed).toEqual([]);
        state.image = original;
        await save();
      });
    });

    it('requires pre-registration and verifies container identity before forced cleanup', async () => {
      await fixture(async (session, state, save, read) => {
        await session.registerBuilt('node');
        await expect(session.removeContainer('unrelated')).rejects.toThrow('trivy-unregistered-container');
        const name = await session.reserveContainer('node');
        state.container = {
          Id: 'c'.repeat(64), Image: image.id, Name: `/${name}`,
          Config: { Labels: { [TRIVY_POLICY.ownerLabel]: session.runId, [TRIVY_POLICY.caseLabel]: 'node' } }
        };
        await save();
        await session.registerContainer('node', name);
        state.container.Id = 'd'.repeat(64);
        await save();
        await expect(session.removeContainer(name)).rejects.toThrow('trivy-container-cleanup-drift');
        expect((await read()).removed).toEqual([]);
        state.container.Id = 'c'.repeat(64);
        await save();
        await session.removeContainer(name);
        expect((await read()).removed).toEqual([['--force', 'c'.repeat(64)]]);
      });
    });
  });

  it('cannot turn a scratch fixture into telemetry/generated OS coverage', () => {
    const input = report() as any;
    delete input.Metadata.OS;
    input.Results.shift();
    const coverage = { id: 'scratch-package-fixture', platform: 'linux/amd64' as const,
      os: 'inapplicable-scratch-fixture' as const, application: 'required' as const };
    expect(normalize(input, coverage).coverage.os).toEqual({ status: 'inapplicable-scratch-fixture', packages: 0 });
    expect(() => normalize(input, { ...coverage, id: 'telemetry-ingest' })).toThrow('trivy-coverage-mismatch');
    expect(() => normalize(input, imageCoverage('telemetry-ingest'))).toThrow();
  });

  it('makes the static-only frontend application inapplicability explicit', () => {
    const input = report();
    input.Results.pop();
    expect(normalize(input, imageCoverage('frontend')).coverage.application)
      .toEqual({ status: 'inapplicable-static-assets', packages: 0 });
    expect(() => normalize(report(), imageCoverage('frontend'))).toThrow('trivy-missing-application-coverage');
  });

  it('rejects malformed, oversized and empty reports with no raw content in errors', () => {
    for (const input of [sentinel, '', ' '.repeat(TRIVY_POLICY.reportBytes + 1)]) {
      expect(() => normalizeTrivyReport(input, image, imageCoverage('node'), database, time, time)).toThrow();
      try { normalizeTrivyReport(input, image, imageCoverage('node'), database, time, time); } catch (error) {
        expect(String(error)).not.toContain(sentinel);
      }
    }
  });
});

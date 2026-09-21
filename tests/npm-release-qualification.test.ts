import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest } from '../scripts/repository-security/admission.ts';
import {
  artifactHashes, parseNpmCandidate, planReleaseRetry, validateReleaseQualification, verifyCandidateBytes,
  type NpmCandidate, type ReleaseAsset, type ReleaseEvidence, type ReleaseObservation, type TrustedReleaseContext
} from '../scripts/repository-security/npm-release.ts';
import { packNpmCandidate } from '../scripts/qualify-npm-candidate.mjs';

const now = new Date('2026-09-20T12:00:00.000Z');
const bytes = Buffer.from('Synthetic artifact bytes, never a real security or release receipt.');
const hash = `sha256:${'a'.repeat(64)}`, otherHash = `sha256:${'b'.repeat(64)}`;
const commit = 'a'.repeat(40);
const cleanups: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true });
});
function sha256(value: Uint8Array) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

function candidate(version = '0.12.3'): NpmCandidate {
  return {
    schemaVersion: 1, kind: 'npm-release-candidate',
    source: { commit, tree: 'b'.repeat(40), inputsDigest: hash, dirty: false },
    artifact: { name: '@msn-control/liftoff', version, filename: `msn-control-liftoff-${version}.tgz`,
      size: bytes.length, ...artifactHashes(bytes) },
    releaseTag: `v${version}`, distTag: version.split('+')[0].includes('-') ? 'next' : 'latest',
    createdAt: '2026-09-20T11:00:00.000Z'
  };
}

function fixture() {
  const subject = candidate();
  const identity = {
    repository: 'voyager163/liftoff', event: 'workflow_dispatch' as const,
    sourceSha: commit, baseSha: commit, workflowSha: commit, runId: '123', attempt: 2,
    policyDigest: hash, inventoryDigest: hash, configurationDigest: hash
  };
  const producer = { workflow: ['.github', 'workflows', 'release.yml'], job: 'fixture-qualification',
    tool: { name: 'fixture-only', version: '1', database: 'fixture-database' } };
  const payloads = new Map<string, Buffer>();
  const reports: ReleaseEvidence[] = (['functional', 'sbom', 'provenance', 'vulnerabilities', 'secrets'] as const).map(role => {
    const payload = Buffer.from(JSON.stringify(role === 'secrets' ? {
      schemaVersion: 1, assessment: 'qualified', gate: 'passed', protection: 'not-established',
      evidenceDigest: 'a'.repeat(64), policyDigest: 'a'.repeat(64), sourceCommit: commit,
      coverage: [{ scopeIndex: 0, status: 'complete', qualified: true }], findings: [],
      counts: { unresolved: 0, 'confirmed-awaiting-remediation': 0, 'false-positive': 0, 'nonfunctional-fixture': 0, remediated: 0 }
    } : { kind: 'fixture-only', role }));
    payloads.set(sha256(payload), payload);
    return {
      schemaVersion: 1, kind: 'release-evidence', role, identity: { ...identity }, producer: structuredClone(producer),
      candidateDigest: canonicalDigest(subject), artifactDigest: subject.artifact.sha256, assetsDigest: hash,
      generatedAt: '2026-09-20T11:10:00.000Z', completedAt: '2026-09-20T11:15:00.000Z',
      validUntil: '2026-09-21T11:10:00.000Z', complete: true, verdict: 'passed',
      coverage: [{ id: 'packed-fixture-component', digest: hash }], payloadDigest: sha256(payload)
    };
  });
  const assets: ReleaseAsset[] = [
    { name: subject.artifact.filename, digest: subject.artifact.sha256 },
    ...reports.map(report => ({ name: `${report.role}.json`, digest: report.payloadDigest }))
  ].sort((a, b) => a.name < b.name ? -1 : 1);
  for (const report of reports) report.assetsDigest = canonicalDigest(assets);
  const expected: TrustedReleaseContext = {
    identity: { ...identity }, sourceRef: 'refs/heads/main', protectedMainCommit: commit,
    candidateDigest: canonicalDigest(subject), assets,
    evidence: reports.map(report => ({
      role: report.role, producer: structuredClone(report.producer), reportDigest: canonicalDigest(report),
      payloadDigest: report.payloadDigest, coverage: structuredClone(report.coverage)
    }))
  };
  return { subject, reports, expected, payloads };
}

function validate(value: ReturnType<typeof fixture>, at = now) {
  return validateReleaseQualification(value.subject, bytes, value.reports, value.payloads, value.expected, at);
}

describe('bounded npm candidate and qualification data (synthetic evidence only)', () => {
  it('preserves npm 0.12.3 identity and hashes the actual artifact bytes', () => {
    const value = fixture();
    expect(verifyCandidateBytes(value.subject, bytes)).toEqual(value.subject);
    expect(validate(value).kind).toBe('validated-release-data');
  });

  it.each(['0.12.3', '0.12.3+build-with-hyphen', '0.12.4-rc.1', '0.12.4-rc.1+build'])('preserves stable/prerelease dist-tags for %s', version => {
    expect(parseNpmCandidate(candidate(version)).distTag).toBe(version.split('+')[0].includes('-') ? 'next' : 'latest');
  });

  it.each([
    ['repacked bytes', (v: ReturnType<typeof fixture>) => { v.subject.artifact.sha256 = otherHash; }],
    ['different integrity', (v: ReturnType<typeof fixture>) => { v.subject.artifact.integrity = artifactHashes(Buffer.from('other')).integrity; }],
    ['dirty source', (v: ReturnType<typeof fixture>) => { v.subject.source.dirty = true; }],
    ['wrong protected source', (v: ReturnType<typeof fixture>) => { v.expected.protectedMainCommit = 'c'.repeat(40); }],
    ['wrong ref', (v: ReturnType<typeof fixture>) => { Object.assign(v.expected, { sourceRef: 'refs/heads/develop' }); }],
    ['PR event', (v: ReturnType<typeof fixture>) => { v.expected.identity.event = 'pull_request'; }],
    ['old attempt', (v: ReturnType<typeof fixture>) => { v.reports[0].identity.attempt--; }],
    ['wrong run', (v: ReturnType<typeof fixture>) => { v.reports[0].identity.runId = '456'; }],
    ['wrong source', (v: ReturnType<typeof fixture>) => { v.reports[0].identity.sourceSha = 'c'.repeat(40); }],
    ['wrong policy', (v: ReturnType<typeof fixture>) => { v.reports[0].identity.policyDigest = otherHash; }],
    ['wrong inventory', (v: ReturnType<typeof fixture>) => { v.reports[0].identity.inventoryDigest = otherHash; }],
    ['wrong workflow revision', (v: ReturnType<typeof fixture>) => { v.reports[0].identity.workflowSha = 'c'.repeat(40); }],
    ['wrong producer', (v: ReturnType<typeof fixture>) => { v.reports[0].producer.job = 'pull-request-job'; }],
    ['wrong database', (v: ReturnType<typeof fixture>) => { v.reports[0].producer.tool.database = 'stale-database'; }],
    ['wrong artifact', (v: ReturnType<typeof fixture>) => { v.reports[0].artifactDigest = otherHash; }],
    ['wrong descriptor', (v: ReturnType<typeof fixture>) => { v.reports[0].candidateDigest = otherHash; }],
    ['old evidence', (v: ReturnType<typeof fixture>) => { v.reports[0].generatedAt = '2026-09-19T11:59:59.999Z'; }],
    ['future evidence', (v: ReturnType<typeof fixture>) => { v.reports[0].completedAt = '2026-09-20T12:00:00.001Z'; }],
    ['expired exception deadline', (v: ReturnType<typeof fixture>) => { v.reports[0].validUntil = now.toISOString(); }],
    ['missing coverage', (v: ReturnType<typeof fixture>) => { v.reports[1].coverage = []; }],
    ['different component', (v: ReturnType<typeof fixture>) => { v.reports[1].coverage[0].digest = otherHash; }],
    ['missing verdict', (v: ReturnType<typeof fixture>) => { delete (v.reports[3] as Partial<ReleaseEvidence>).verdict; }],
    ['blocking verdict', (v: ReturnType<typeof fixture>) => { Object.assign(v.reports[3], { verdict: 'blocked' }); }],
    ['incomplete secrets', (v: ReturnType<typeof fixture>) => { Object.assign(v.reports[4], { complete: false }); }],
    ['provenance without security', (v: ReturnType<typeof fixture>) => { v.reports = [v.reports[2]]; }],
    ['duplicate report', (v: ReturnType<typeof fixture>) => { v.reports[4] = v.reports[0]; }],
    ['missing payload', (v: ReturnType<typeof fixture>) => { v.payloads.clear(); }],
    ['substituted payload', (v: ReturnType<typeof fixture>) => { v.payloads.set(v.reports[0].payloadDigest, Buffer.from('{}')); }],
    ['changed expected assets', (v: ReturnType<typeof fixture>) => { v.expected.assets.push({ name: 'unexpected.json', digest: hash }); }],
    ['unsafe asset path', (v: ReturnType<typeof fixture>) => { v.expected.assets[0].name = '../escape'; }],
    ['case alias', (v: ReturnType<typeof fixture>) => { v.expected.assets.push({ ...v.expected.assets[0], name: v.expected.assets[0].name.toUpperCase() }); }],
    ['Windows artifact traversal', (v: ReturnType<typeof fixture>) => { v.subject.artifact.filename = '..\\other.tgz'; }],
    ['wrong release channel', (v: ReturnType<typeof fixture>) => { v.subject.distTag = 'next'; }],
    ['unknown field', (v: ReturnType<typeof fixture>) => { Object.assign(v.reports[0], { approved: true }); }]
  ])('rejects %s', (_label, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => validate(value)).toThrow();
  });

  it('rejects evidence older than 24h even when a later expiry is claimed', () => {
    const value = fixture();
    expect(() => validate(value, new Date('2026-09-21T12:00:00.001Z'))).toThrow(/stale/);
  });

  it.each(['normal-admitted', 'maintenance-admitted'])('always rejects %s PR admission, including relabelled payloads', decision => {
    const value = fixture();
    const admission = { kind: 'pull-request-admission', decision };
    expect(() => validateReleaseQualification(value.subject, bytes, admission, value.payloads, value.expected, now)).toThrow(/admission-is-not/);
    const report = { ...value.reports[0], ...admission };
    expect(() => validateReleaseQualification(value.subject, bytes, [report, ...value.reports.slice(1)], value.payloads, value.expected, now)).toThrow(/admission-is-not/);
    const payload = Buffer.from(JSON.stringify(admission));
    value.payloads.delete(value.reports[0].payloadDigest);
    value.reports[0].payloadDigest = sha256(payload);
    value.payloads.set(sha256(payload), payload);
    value.expected.evidence[0].payloadDigest = sha256(payload);
    value.expected.evidence[0].reportDigest = canonicalDigest(value.reports[0]);
    expect(() => validate(value)).toThrow(/admission-is-not/);
  });
});

describe('partial release readback and safe retry planning (no executor)', () => {
  function observed(): ReleaseObservation {
    const subject = candidate();
    return {
      tag: { name: subject.releaseTag, commit },
      npm: { registry: 'https://registry.npmjs.org', name: subject.artifact.name, version: subject.artifact.version,
        integrity: subject.artifact.integrity, distTag: 'latest', distTagVersion: subject.artifact.version },
      github: null
    };
  }
  it('reports npm success/GitHub failure and never republishes existing identical npm bytes', () => {
    const value = fixture();
    const plan = planReleaseRetry(value.subject, value.expected.assets, observed());
    expect(plan.state).toBe('partial');
    expect(plan.completed).toContain('npm-canonical-verified');
    expect(plan.pending).toContain('github-immutable-published');
    expect(plan.actions).toContain('create-draft');
    expect(plan.actions.join(' ')).not.toMatch(/publish-exact-tarball|unpublish|overwrite|move-tag|delete/);
  });
  it('only uploads missing assets on an identical draft and is a no-op for a complete immutable release', () => {
    const value = fixture(), observation = observed();
    observation.github = { tag: value.subject.releaseTag, commit, state: 'draft', immutable: false, assets: [value.expected.assets[0]] };
    const partial = planReleaseRetry(value.subject, value.expected.assets, observation);
    expect(partial.actions).not.toContain(`upload-missing:${value.expected.assets[0].name}`);
    observation.github = { ...observation.github, state: 'published', immutable: true, assets: value.expected.assets };
    expect(planReleaseRetry(value.subject, value.expected.assets, observation)).toMatchObject({ state: 'complete', pending: [], actions: [] });
  });
  it.each(['version', 'integrity', 'dist-tag', 'tag', 'asset', 'extra-asset', 'published-missing', 'mutable'])('blocks %s conflict for reviewed forward correction', change => {
    const value = fixture(), observation = observed();
    observation.github = { tag: value.subject.releaseTag, commit, state: 'draft', immutable: false, assets: structuredClone(value.expected.assets) };
    if (change === 'version') observation.npm!.version = '0.12.2';
    if (change === 'integrity') observation.npm!.integrity = artifactHashes(Buffer.from('different')).integrity;
    if (change === 'dist-tag') observation.npm!.distTagVersion = '0.12.4';
    if (change === 'tag') observation.tag!.commit = 'c'.repeat(40);
    if (change === 'asset') observation.github.assets[0].digest = otherHash;
    if (change === 'extra-asset') observation.github.assets.push({ name: 'extra.txt', digest: hash });
    if (change === 'published-missing') Object.assign(observation.github, { state: 'published', immutable: true, assets: [] });
    if (change === 'mutable') Object.assign(observation.github, { state: 'published' });
    const plan = planReleaseRetry(value.subject, value.expected.assets, observation);
    expect(plan).toMatchObject({ state: 'blocked', actions: [] });
    expect(plan.reason).toContain('forward-correction');
  });
  it('rejects missing readback rather than treating lookup errors as absence', () => {
    const value = fixture();
    expect(() => planReleaseRetry(value.subject, value.expected.assets, { npm: null })).toThrow();
    expect(planReleaseRetry(value.subject, value.expected.assets, { npm: null, github: null, tag: null }).state).toBe('unpublished');
  });
});

describe('pack-once coordinator with synthetic subprocesses', () => {
  function packedFixture(): Buffer {
    const body = Buffer.from(JSON.stringify({ name: '@msn-control/liftoff', version: '0.12.3' }));
    const header = Buffer.alloc(512);
    header.write('package/package.json');
    for (const [value, start, size] of [[0o644, 100, 8], [0, 108, 8], [0, 116, 8], [body.length, 124, 12], [0, 136, 12]]) {
      header.write(`${value.toString(8).padStart(size - 1, '0')}\0`, start, size);
    }
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0' + '00', 257);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]));
  }
  async function harness(mutation = '') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-release-test-'));
    cleanups.push(root);
    const identity = { name: '@msn-control/liftoff', version: '0.12.3' };
    const packedBytes = packedFixture();
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist', 'cli.js'), '// synthetic build input\n');
    await writeFile(path.join(root, 'npm.cjs'), '// fake executor only\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify(identity));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ ...identity, packages: { '': identity } }));
    const calls: string[][] = [];
    const execute = (command: string, args: string[], _cwd: string, env: NodeJS.ProcessEnv) => {
      calls.push([command, ...args]);
      if (command === 'git') {
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
          'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS']) expect(env[name]).toBeUndefined();
        expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
        expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1');
        expect(env.GIT_NO_LAZY_FETCH).toBe('1');
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
          return mutation === 'wrong-root' ? path.dirname(root) : root;
        }
        if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? commit : 'b'.repeat(40);
        if (args[0] === 'ls-files') return 'package.json\0package-lock.json\0npm.cjs\0';
        if (args[0] === 'status') return ' M package.json\n';
      }
      throw new Error('Unexpected fake command');
    };
    // A synchronous fixture executor must write synchronously, just as npm does.
    const fs = await import('node:fs');
    const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
      if (args.includes('pack')) {
        calls.push([command, ...args]);
        expect(args).toContain('--ignore-scripts');
        const output = args[args.indexOf('--pack-destination') + 1];
        const filename = 'msn-control-liftoff-0.12.3.tgz';
        fs.writeFileSync(path.join(output, filename), packedBytes);
        const result = { ...identity, filename, size: packedBytes.length, integrity: artifactHashes(packedBytes).integrity };
        return JSON.stringify(mutation === 'npm12' ? { [`${identity.name}@${identity.version}`]: result } : [result]);
      }
      if (args[0].endsWith('package-smoke-test.mjs')) {
        calls.push([command, ...args]);
        expect(args[1]).toBe('--tarball');
        expect(fs.readFileSync(args[2])).toEqual(packedBytes);
        expect(env.TMPDIR).toBe(path.join(path.dirname(args[2]), 'local-checks', 'runtime'));
        expect(env.TMP).toBe(env.TMPDIR);
        expect(env.TEMP).toBe(env.TMPDIR);
        expect(env.NODE_DISABLE_COMPILE_CACHE).toBe('1');
        expect(env.LIFTOFF_TELEMETRY).toBe('0');
        if (mutation === 'smoke-status' || mutation === 'bad-smoke-status') {
          fs.writeFileSync(env.LIFTOFF_PACKAGE_SMOKE_STATUS!, JSON.stringify({
            schemaVersion: 1, stage: 'installation', commandIndex: 1, operation: 'install',
            exit: 1, failure: mutation === 'smoke-status' ? 'subprocess' : 'NONFUNCTIONAL_SECRET_SMOKE_SENTINEL'
          }));
          throw new Error('NONFUNCTIONAL_SECRET_SMOKE_SENTINEL');
        }
        if (mutation === 'old-smoke') {
          const rejected = spawnSync(process.execPath, [env.npm_execpath!, 'pack'], { encoding: 'utf8', env });
          expect(rejected.status).toBe(1);
          expect(rejected.stderr).toContain('forbids npm pack and publication');
          throw new Error('Legacy implicit repack rejected');
        }
        if (mutation === 'artifact') fs.writeFileSync(args[2], 'substitution');
        if (mutation === 'source') fs.appendFileSync(path.join(root, 'package.json'), '\n');
        return 'fixture smoke only';
      }
      return execute(command, args, cwd, env);
    };
    return { root, calls, run };
  }
  it.each(['npm10', 'npm12'])('packs once with %s output, passes exactly those bytes to existing smoke, and records dirty source honestly', async format => {
    const value = await harness(format);
    const result = await packNpmCandidate({ packageRoot: value.root, npmCliPath: path.join(value.root, 'npm.cjs') }, { run: value.run });
    cleanups.push(result.root);
    expect(value.calls.filter(call => call.includes('pack'))).toHaveLength(1);
    expect(value.calls.some(call => call.includes('publish'))).toBe(false);
    expect(result.descriptor.source.dirty).toBe(true);
    expect(JSON.parse(await readFile(result.descriptorPath, 'utf8'))).toEqual(result.descriptor);
    expect(path.relative(value.root, result.root).startsWith('..')).toBe(true);
    const sbom = JSON.parse(await readFile(path.join(result.root, 'packed-files.cdx.json'), 'utf8'));
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.components.map((item: { name: string }) => item.name)).toEqual(['package.json']);
    expect(sbom.compositions[0].aggregate).toBe('incomplete');
    const record = JSON.parse(await readFile(path.join(result.root, 'unsigned-build-record.json'), 'utf8'));
    expect(record).toMatchObject({
      kind: 'unsigned-local-build-record', buildExecution: 'not-observed-by-this-record',
      verifiableProvenance: false, attestation: false, securityAssessment: false, signing: false
    });
  });
  it.each(['source', 'artifact'])('rejects %s substitution during checking', async mutation => {
    const value = await harness(mutation);
    await expect(packNpmCandidate({ packageRoot: value.root, npmCliPath: path.join(value.root, 'npm.cjs') }, { run: value.run })).rejects.toThrow(/changed|substitution/);
  });
  it('refuses a legacy smoke runner that attempts an implicit second pack', async () => {
    const value = await harness('old-smoke');
    await expect(packNpmCandidate({ packageRoot: value.root, npmCliPath: path.join(value.root, 'npm.cjs') }, { run: value.run })).rejects.toThrow(/implicit repack/);
    expect(value.calls.filter(call => call.includes('pack'))).toHaveLength(1);
  });
  it.each(['smoke-status', 'bad-smoke-status'])('reports only bounded %s diagnostics without subprocess errors', async mode => {
    const value = await harness(mode);
    let failure: unknown;
    try { await packNpmCandidate({ packageRoot: value.root, npmCliPath: path.join(value.root, 'npm.cjs') }, { run: value.run }); }
    catch (error) { failure = error; }
    expect(String(failure)).not.toContain('NONFUNCTIONAL_SECRET_SMOKE_SENTINEL');
    expect(String(failure)).toContain(mode === 'smoke-status'
      ? 'installation, command 1, operation install, subprocess' : 'invalid bounded diagnostics');
    expect(value.calls.filter(call => call.includes('pack'))).toHaveLength(1);
  });
  it('rejects a candidate output parent inside the selected checkout without excluding inputs', async () => {
    const value = await harness();
    await expect(packNpmCandidate({
      packageRoot: value.root, npmCliPath: path.join(value.root, 'npm.cjs'), outputParent: value.root
    }, { run: value.run })).rejects.toThrow('outside the source checkout');
    expect(value.calls).toEqual([]);
  });
  it('isolates Git object/index/config overrides and rejects a different source checkout', async () => {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS']) vi.stubEnv(name, 'nonfunctional-outside-checkout');
    const value = await harness();
    const result = await packNpmCandidate({ packageRoot: value.root, npmCliPath: path.join(value.root, 'npm.cjs') }, { run: value.run });
    cleanups.push(result.root);
    const wrong = await harness('wrong-root');
    await expect(packNpmCandidate({ packageRoot: wrong.root, npmCliPath: path.join(wrong.root, 'npm.cjs') },
      { run: wrong.run })).rejects.toThrow('does not belong to the selected checkout');
    expect(wrong.calls.filter(call => call.includes('pack'))).toHaveLength(0);
  });
});

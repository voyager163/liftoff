import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import {
  capturePinnedFixtureGitleaks, capturePrivateFixtureProcess, createPrivateSourceWorkspace,
  fixtureGitEnvironment, fixtureGitOptions, installPinnedFixtureGitleaks, FixtureError,
  type PinnedFixtureTool
} from './gitleaks.ts';
import {
  declaredSourceMetadataTemplate, parseDeclaredSourceOutput, fetchPinnedDerivedProfileSource,
  DERIVED_FIXTURE_PROFILE, type DerivedMetadataRegistry
} from './gitleaks-derived.ts';
import { prepareSecretProfile, validateSecretDetectorRegistration } from './secret-profile.ts';
import { parseIdentity, portableParts, sha, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';
import { readOsvSource } from './osv-driver.ts';
import { canonicalDigest, type TreeEntry } from './admission.ts';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 64 * 1024 * 1024;
function fail(code: string): never { throw new SecurityEvidenceError(`gitleaks-source-${code}`); }
class SourceExecutionError extends SecurityEvidenceError {
  readonly stage: string;
  readonly operation: string;
  readonly failure: string;
  constructor(stage: string, operation: string, failure: string) {
    super('gitleaks-source-execution-failed');
    this.stage = stage; this.operation = operation; this.failure = failure;
  }
}

export interface DeclaredSecretSource {
  sourceCommit: string;
  refs: Record<string, string>;
}

export interface SecretSourceOccurrence {
  kind: 'current-tree' | 'reachable-history' | 'introduced-history';
  rule: string;
  pathParts: string[];
  blob: string;
  commit: string;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
}

interface IssuedSourceMetadata {
  repositoryRoot: string;
  tree: TreeEntry[];
  rules: string[];
  commits: string[];
  introducedCommits: string[] | null;
  occurrences: SecretSourceOccurrence[];
}
const issuedSourceAssessments = new WeakMap<object, { digest: string; metadata: IssuedSourceMetadata }>();
export type DeclaredSecretAssessment = Awaited<ReturnType<typeof assessDeclaredSecretSource>>;

/** An in-process receipt, not authentication of serialized or hosted scanner data. */
export function readIssuedSecretSource(result: DeclaredSecretAssessment) {
  const issued = issuedSourceAssessments.get(result);
  if (!issued || canonicalDigest(result) !== issued.digest) fail('unissued-or-mutated-assessment');
  return { reportDigest: issued.digest, ...structuredClone(issued.metadata) };
}

export function parseDeclaredSecretSource(value: unknown): DeclaredSecretSource {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 ||
      !('sourceCommit' in value) || !('refs' in value)) fail('invalid-scope');
  const sourceCommit = sha(value.sourceCommit), refs = value.refs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) fail('invalid-scope');
  const entries = Object.entries(refs);
  if (entries.length < 1 || entries.length > 256 ||
      entries.some(([name]) => !/^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,149}$/.test(name) ||
        name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) ||
      !entries.some(([, revision]) => revision === sourceCommit)) fail('invalid-scope');
  return { sourceCommit, refs: Object.fromEntries(entries.sort().map(([name, revision]) => [name, sha(revision)])) };
}

export function parseSecretTree(source: string) {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024 || !source.endsWith('\0')) fail('invalid-tree');
  const entries = source.slice(0, -1).split('\0').map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if (!match) fail('unsupported-tree-entry');
    const pathParts = portableParts(match[3]!.split('/'));
    if (pathParts.some(part => part.toLowerCase() === '.gitleaksignore')) fail('candidate-suppression');
    return { pathParts, object: match[2]!, mode: match[1]! };
  });
  if (!entries.length || entries.length > 5000 ||
      new Set(entries.map(entry => entry.pathParts.join('/').toLowerCase())).size !== entries.length) fail('invalid-tree');
  return entries.sort((a, b) => a.pathParts.join('/') < b.pathParts.join('/') ? -1 : 1);
}

export function parseSecretDiffPaths(source: string): string[][] {
  if (Buffer.byteLength(source) > 8 * 1024 * 1024) fail('invalid-diff-inventory');
  const tokens = source.split('\0'), paths: string[][] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++]!;
    if (header === '') continue;
    if (!/^\n?:[0-7]{6} [0-7]{6} [a-f0-9]{40} [a-f0-9]{40} [AMDT]$/.test(header)) fail('invalid-diff-inventory');
    const name = tokens[index++];
    if (!name) fail('invalid-diff-inventory');
    paths.push(portableParts(name.split('/')));
  }
  return paths;
}

export function parseSecretBlobBatch(bytes: Uint8Array, expected: readonly string[]): Uint8Array[] {
  if (bytes.byteLength > MAX_BYTES || !expected.length || expected.length > 5000) fail('invalid-blob-batch');
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), values: Uint8Array[] = [];
  let offset = 0;
  for (const object of expected) {
    sha(object);
    const end = input.indexOf(10, offset);
    if (end < offset || end - offset > 100) fail('invalid-blob-batch');
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(input.subarray(offset, end).toString('ascii'));
    const size = Number(match?.[2]);
    if (!match || match[1] !== object || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 ||
        end + size + 1 >= input.length || input[end + size + 1] !== 10) fail('invalid-blob-batch');
    const value = input.subarray(end + 1, end + size + 1);
    if (createHash('sha1').update(`blob ${size}\0`).update(value).digest('hex') !== object) fail('blob-identity-mismatch');
    values.push(value);
    offset = end + size + 2;
  }
  if (offset !== input.length) fail('invalid-blob-batch');
  return values;
}

function revisions(source: string) {
  const values = source.trim().split('\n').map(sha).sort();
  if (!values.length || values.length > 10_000 || new Set(values).size !== values.length) fail('invalid-object-inventory');
  return values;
}

async function sealedSnapshot(root: string): Promise<string> {
  const files: [string, number, number, string][] = [];
  let bytes = 0;
  async function visit(parts: string[]) {
    const target = path.join(root, ...parts), status = await lstat(target);
    if (parts.at(-1)?.toLowerCase() === '.gitleaksignore') fail('candidate-suppression');
    if (status.isSymbolicLink() || await realpath(target) !== target || parts.length > 40) fail('unsafe-workspace');
    if (status.isDirectory()) {
      for (const name of (await readdir(target)).sort()) await visit([...parts, name]);
    } else {
      if (!status.isFile() || status.nlink !== 1 || files.length > 20_000 || status.size > MAX_BYTES) fail('unsafe-workspace');
      bytes += status.size;
      if (bytes > 256 * 1024 * 1024) fail('unsafe-workspace');
      const contents = await readFile(target);
      try { files.push([parts.join('/'), status.ino, status.mode, hash(contents)]); } finally { contents.fill(0); }
    }
  }
  await visit([]);
  return hash(JSON.stringify(files));
}

/** Exports selected reachable objects only; never copies a checkout's .git/config/hooks or creates source refs. */
export async function assessDeclaredSecretSource(options: {
  repository: string; scope: DeclaredSecretSource; workspaceParent: string;
  tool: PinnedFixtureTool; upstreamProfile: string;
  introducedBase?: string;
  executionIdentity?: EvidenceIdentity;
}) {
  const repository = await realpath(options.repository), scope = parseDeclaredSecretSource(options.scope);
  const executionIdentity = options.executionIdentity === undefined ? null : parseIdentity(options.executionIdentity);
  if (executionIdentity !== null && executionIdentity.sourceSha !== scope.sourceCommit) fail('execution-source-mismatch');
  const owned = await createPrivateSourceWorkspace(process.cwd(), options.workspaceParent);
  const env = {
    ...fixtureGitEnvironment(owned.root, path.join(owned.root, 'bin')),
    GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: path.join(owned.root, 'no-grafts')
  };
  let stage = 'source-identity';
  let objectStoreMetadata: { garbageEntries: number; garbageWarnings: number; alternateObjectStores: boolean } | undefined;
  const invoke = async (cwd: string, args: string[], input?: Uint8Array, maximum = 8 * 1024 * 1024) => {
    try {
      const result = await capturePrivateFixtureProcess('/usr/bin/git', [...fixtureGitOptions(owned.root), ...args], owned,
        {
          cwd, environment: env, input, maxBytes: maximum, timeoutMs: 120_000,
          ...(JSON.stringify(args) === JSON.stringify(['count-objects', '-v']) ? { objectStoreMetadata: true as const } : {})
        });
      if (result.exitCode !== 0) { result.stdout.fill(0); fail('git-failed'); }
      if (result.objectStoreMetadata) objectStoreMetadata = result.objectStoreMetadata;
      return result.stdout;
    } catch (error) {
      if (error instanceof FixtureError) throw new SourceExecutionError(stage, args[0]!, error.code);
      throw error;
    } finally { await owned.register(); }
  };
  const text = async (cwd: string, args: string[], input?: Uint8Array) => {
    const bytes = await invoke(cwd, args, input);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return fail('invalid-git-metadata'); }
    finally { bytes.fill(0); }
  };
  try {
    const verifySource = async () => {
      if ((await text(repository, ['rev-parse', '--show-toplevel'])).trim() !== repository) fail('source-root-mismatch');
      if ((await text(repository, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false') fail('shallow-history');
      if ((await text(repository, ['rev-parse', 'HEAD'])).trim() !== scope.sourceCommit) fail('source-revision-drift');
      if ((await text(repository, ['count-objects', '-v'])).split('\n').some(line => line.startsWith('alternate:'))) fail('alternate-object-store');
      for (const [ref, revision] of Object.entries(scope.refs)) {
        if ((await text(repository, ['rev-parse', '--verify', `${ref}^{commit}`])).trim() !== revision) fail('ref-drift');
      }
    };
    await verifySource();
    stage = 'source-object-inventory';
    const tips = [...new Set(Object.values(scope.refs))].sort();
    const commits = revisions(await text(repository, ['rev-list', ...tips]));
    const objects = revisions(await text(repository, ['rev-list', '--objects', '--no-object-names', '--missing=error', ...tips]));
    const history = await owned.directory('history');
    const wrapper = ['#!/bin/sh', `exec /usr/bin/git ${fixtureGitOptions(owned.root).map(value =>
      `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ')} "$@"`, ''].join('\n');
    await writeFile(path.join(owned.root, 'bin', 'git'), wrapper, { flag: 'wx', mode: 0o700 });
    await owned.register();
    await text(history, ['init', '--bare', '--quiet', '--object-format=sha1', '--initial-branch=source-assessment',
      `--template=${path.join(owned.root, 'empty-directory')}`]);
    stage = 'selected-object-export';
    const packed = await invoke(repository, [
      'pack-objects', '--stdout', '--revs', '--threads=1', '--no-reuse-delta', '--no-reuse-object', '--window=0', '--depth=0'
    ], Buffer.from(`${tips.join('\n')}\n`), MAX_BYTES);
    const packDigest = hash(packed);
    stage = 'selected-object-import';
    try { await text(history, ['index-pack', '--stdin', '--strict'], packed); } finally { packed.fill(0); }
    stage = 'exported-object-reconciliation';
    const exported = revisions(await text(history, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']));
    if (JSON.stringify(exported) !== JSON.stringify(objects) ||
        JSON.stringify(revisions(await text(history, ['rev-list', ...tips]))) !== JSON.stringify(commits)) fail('exported-object-mismatch');
    const pathsFor = async (selection: string[]) => parseSecretDiffPaths(await text(history, [
      'log', '--format=', '--raw', '--no-abbrev', '-z', '--root', '--full-history', '--diff-merges=first-parent',
      '--no-ext-diff', '--no-textconv', '--no-renames', ...selection, '--'
    ]));
    const uniquePaths = (entries: string[][]) => [...new Map(entries.map(parts => [parts.join('/'), parts])).values()]
      .sort((a, b) => a.join('/') < b.join('/') ? -1 : 1);
    const locations = uniquePaths(await pathsFor(tips));
    let introduced: { base: string; selection: string[]; commits: string[]; paths: string[][] } | undefined;
    if (options.introducedBase !== undefined) {
      const base = sha(options.introducedBase);
      if (base === scope.sourceCommit || !commits.includes(base)) fail('invalid-introduced-base');
      await text(history, ['merge-base', '--is-ancestor', base, scope.sourceCommit]);
      const selection = [`${base}..${scope.sourceCommit}`];
      introduced = {
        base, selection, commits: revisions(await text(history, ['rev-list', ...selection])),
        paths: uniquePaths(await pathsFor(selection))
      };
    }
    const tree = parseSecretTree(await text(history, ['ls-tree', '-r', '-z', '--full-tree', scope.sourceCommit]));
    if (tree.some(entry => !locations.some(parts => parts.join('/') === entry.pathParts.join('/')))) fail('history-path-coverage');
    const current = await owned.directory('current');
    stage = 'current-tree-materialization';
    const batch = await invoke(history, ['cat-file', '--batch'], Buffer.from(`${tree.map(entry => entry.object).join('\n')}\n`), MAX_BYTES);
    try {
      const blobs = parseSecretBlobBatch(batch, tree.map(entry => entry.object));
      for (const [index, entry] of tree.entries()) {
        const target = path.join(current, ...entry.pathParts);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, blobs[index]!, { flag: 'wx', mode: 0o600 });
      }
    } finally { batch.fill(0); await owned.register(); }
    const profile = prepareSecretProfile(options.upstreamProfile, DERIVED_FIXTURE_PROFILE);
    const parsedRules = parse(profile.config).rules;
    if (!Array.isArray(parsedRules)) fail('invalid-profile');
    const rules = parsedRules.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value) || typeof value.id !== 'string') fail('invalid-profile');
      return { id: value.id, kind: 'regex' in value ? 'content' as const : 'path-only' as const };
    });
    const config = await owned.write('detector.toml', profile.config);
    const observedAt = new Date().toISOString(), scans = [];
    const occurrences: SecretSourceOccurrence[] = [];
    const observedBlobs = new Map<string, string>();
    const modes: ('current-tree' | 'history' | 'introduced-history')[] = ['current-tree', 'history'];
    if (introduced) modes.push('introduced-history');
    for (const mode of modes) {
      stage = `scanner-${mode}`;
      const paths = mode === 'current-tree' ? tree.map(entry => entry.pathParts)
        : mode === 'introduced-history' ? introduced!.paths : locations;
      const registry: DerivedMetadataRegistry = {
        rules, commits: mode === 'current-tree' ? [scope.sourceCommit]
          : mode === 'introduced-history' ? introduced!.commits : commits,
        files: paths.map(pathParts => ({
          pathParts, aliases: mode === 'current-tree'
            ? [pathParts.join('/'), path.join(current, ...pathParts), path.join('current', ...pathParts)]
            : [pathParts.join('/')]
        }))
      };
      const template = await owned.write(`${mode}.tmpl`, declaredSourceMetadataTemplate(registry,
        mode === 'current-tree' ? 'current-tree' : 'history'));
      const before = await sealedSnapshot(owned.root);
      const logSelection = mode === 'introduced-history' ? introduced!.selection : tips;
      const selection = mode === 'current-tree' ? ['dir', current]
        : ['git', '--platform=none', `--log-opts=${logSelection.join(' ')} --full-history --root --diff-merges=first-parent --no-ext-diff --no-textconv --no-renames`, history];
      const output = await capturePinnedFixtureGitleaks(options.tool, [
        ...selection, '--config', config, '--report-template', template, '--report-format', 'template',
        '--report-path', '-', '--redact=100', '--no-banner', '--no-color', '--log-level=error', '--exit-code=42',
        '--ignore-gitleaks-allow', '--max-decode-depth=0', '--max-archive-depth=0', '--max-target-megabytes=0',
        '--timeout=90', '--gitleaks-ignore-path', path.join(owned.root, 'empty-directory')
      ], owned, { maxBytes: 4_194_304, timeoutMs: 120_000 });
      try {
        if (await sealedSnapshot(owned.root) !== before) fail('scan-input-drift');
        const findings = parseDeclaredSourceOutput(output.stdout, output.exitCode, registry);
        for (const item of findings) {
          const pathParts = [...registry.files[item.fileIndex]!.pathParts];
          const commit = registry.commits[item.commitIndex]!;
          const key = JSON.stringify([commit, pathParts]);
          let blob = observedBlobs.get(key);
          if (!blob) {
            const entries = parseSecretTree(await text(history, [
              'ls-tree', '-z', '--full-tree', commit, '--', pathParts.join('/')
            ]));
            if (entries.length !== 1 || JSON.stringify(entries[0]!.pathParts) !== JSON.stringify(pathParts)) {
              fail('finding-blob-identity');
            }
            blob = entries[0]!.object;
            observedBlobs.set(key, blob);
          }
          occurrences.push({
            kind: mode === 'history' ? 'reachable-history' : mode, rule: rules[item.ruleIndex]!.id,
            pathParts, blob, commit, line: item.line, column: item.column,
            endLine: item.endLine, endColumn: item.endColumn
          });
        }
        scans.push({
          kind: mode === 'history' ? 'reachable-history' : mode,
          baseCommit: mode === 'introduced-history' ? introduced!.base : null,
          files: registry.files.length, commits: registry.commits.length,
          registryDigest: hash(JSON.stringify({ rules, files: registry.files.map(file => file.pathParts), commits: registry.commits })),
          templateDigest: hash(await readFile(template)), assessmentComplete: true,
          findingCount: findings.length, findings: findings.map(item => ({
            ...item, id: hash(JSON.stringify([
              rules[item.ruleIndex]!.id, registry.files[item.fileIndex]!.pathParts,
              registry.commits[item.commitIndex], item.line, item.column, item.endLine, item.endColumn
            ])),
            rule: rules[item.ruleIndex]!.id, commit: registry.commits[item.commitIndex],
            disposition: 'unresolved', blocking: true
          })), findingsPassed: findings.length === 0
        });
      } finally { output.stdout.fill(0); }
    }
    stage = 'source-drift-verification';
    await verifySource();
    const result = {
      schemaVersion: 1, kind: 'declared-committed-source-secret-assessment', scope, executionIdentity,
      observedAt, completedAt: new Date().toISOString(), selectedCommits: commits.length,
      selectedObjects: objects.length, objectInventoryDigest: hash(objects.join('\n')), packDigest,
      introducedBase: introduced?.base ?? null,
      objectStoreMetadata,
      tool: { version: options.tool.version, platform: options.tool.platform,
        archiveDigest: options.tool.archiveDigest, binaryDigest: options.tool.binaryDigest },
      profile: { kind: profile.kind, behaviorChanged: profile.behaviorChanged,
        sourceDigest: profile.sourceDigest, configDigest: profile.configDigest },
      scans, cleanup: 'completed', adoptedPolicyAuthority: false, hostedQualification: false, publicationQualified: false,
      limitations: ['Only exact declared committed source and reachable file diffs; dirty working-tree changes are not included.',
        'No claim for commit/annotated-tag messages, opaque binary payloads, archive decoding, unreachable objects or other forks.',
        'Detector pattern coverage is not proof of absence of every secret. No issuer validation or credential action performed.']
    };
    issuedSourceAssessments.set(result, {
      digest: canonicalDigest(result),
      metadata: {
        repositoryRoot: repository, tree: tree.map(entry => ({ ...entry, mode: entry.mode === '100755' ? '100755' : '100644' })),
        rules: rules.map(rule => rule.id), commits,
        introducedCommits: introduced?.commits ?? null, occurrences
      }
    });
    return result;
  } catch (error) {
    if (error instanceof FixtureError) throw new SourceExecutionError(stage, 'gitleaks', error.code);
    throw error;
  } finally { await owned.register(); await owned.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let tool: PinnedFixtureTool | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--workspace-parent') fail('usage');
    const root = await realpath(process.cwd()), workspaceParent = path.resolve(args[1]!);
    const baselineSource = await readOsvSource(root, ['security', 'hardening-baseline.json']);
    const registration = await readOsvSource(root, ['security', 'secret-detector.json']);
    const baseline = JSON.parse(baselineSource);
    if (typeof baseline.observedAt !== 'string' || !Number.isFinite(Date.parse(baseline.observedAt)) ||
        !Array.isArray(baseline.controls)) fail('native-metadata-snapshot');
    const nativeControls = ['secret-scanning', 'secret-push-protection'].map(id => {
      const entry = baseline.controls.find((entry: unknown) =>
        entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === id);
      if (!entry || typeof entry.configured !== 'boolean') fail('native-metadata-snapshot');
      return { id, configuredAtObservation: entry.configured };
    });
    const identity = validateSecretDetectorRegistration(JSON.parse(registration));
    const upstreamProfile = await fetchPinnedDerivedProfileSource();
    prepareSecretProfile(upstreamProfile, identity);
    tool = await installPinnedFixtureGitleaks(root, workspaceParent);
    const result = await assessDeclaredSecretSource({
      repository: root, workspaceParent, tool, upstreamProfile,
      scope: { sourceCommit: baseline.sourceCommit, refs: baseline.secretsScope.publishedRefCommits }
    });
    if (await readOsvSource(root, ['security', 'hardening-baseline.json']) !== baselineSource ||
        await readOsvSource(root, ['security', 'secret-detector.json']) !== registration) fail('declared-policy-drift');
    await tool.cleanup();
    tool = undefined;
    console.log(JSON.stringify({
      ...result,
      nativeMetadata: {
        kind: 'dated-read-only-settings-snapshot', observedAt: new Date(baseline.observedAt).toISOString(),
        snapshotDigest: `sha256:${hash(baselineSource)}`, controls: nativeControls,
        currentHostedStateAsserted: false, scanCompletionEstablished: false,
        pushOrMergeProtectionEstablished: false, rawHostedFindingsRetrieved: false
      }
    }));
    process.exitCode = result.scans.every(scan => scan.findingsPassed) ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ kind: 'declared-committed-source-secret-assessment', assessmentComplete: false,
      code: error instanceof SecurityEvidenceError ? error.code : error instanceof FixtureError ? error.code : 'source-assessment-failed',
      ...(error instanceof SourceExecutionError ? { stage: error.stage, operation: error.operation, failure: error.failure } : {}) }));
    process.exitCode = 2;
  } finally { await tool?.cleanup(); }
}

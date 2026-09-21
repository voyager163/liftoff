import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { prepareSecretProfile } from './secret-profile.ts';
import { portableParts } from './evidence.ts';
import {
  capturePinnedFixtureGitleaks, capturePrivateFixtureProcess, captureSuppressionFreeFixtureGitleaks, createPrivateFixtureGit,
  createPrivateFixtureWorkspace, FixtureError, type PinnedFixtureTool
} from './gitleaks.ts';

/**
 * Explicit opt-in fixture qualification of a DERIVED profile, never unchanged
 * upstream behavior, adopted policy, repository coverage or issuer validation.
 * No repository target or unpinned configuration override is accepted.
 */
export const DERIVED_FIXTURE_PROFILE = Object.freeze({
  version: '8.30.1',
  commit: '83d9cd684c87d95d656c1458ef04895a7f1cbd8e',
  sha256: 'e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf',
  ruleCount: 222,
  removedAllowlistGroups: 14,
  preparedConfigSha256: 'd468a8e4dc13fb18c09603e3455f85af7f8044df30132d8e3391554b29357598'
});
const SOURCE_URL = 'https://raw.githubusercontent.com/gitleaks/gitleaks/83d9cd684c87d95d656c1458ef04895a7f1cbd8e/config/gitleaks.toml';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Failure = 'source-unavailable' | 'profile-mismatch' | 'invalid-registry' | 'invalid-report'
  | 'unknown-identity' | 'unredacted-output' | 'unsupported-path-only-shape' | 'duplicate-finding'
  | 'scope-incomplete' | 'unexpected-findings' | 'required-flags-unavailable' | 'fixture-process-failed';
class DerivedFixtureError extends Error {
  readonly fixtureFailure: FixtureError['code'] | undefined;
  constructor(code: Failure, fixtureFailure?: FixtureError['code']) {
    super(`Derived Gitleaks fixture rejected: ${code}.`);
    this.name = 'DerivedGitleaksFixtureError';
    this.fixtureFailure = fixtureFailure;
  }
}
function fail(code: Failure): never { throw new DerivedFixtureError(code); }
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error: unknown) {
    if (error instanceof DerivedFixtureError) throw error;
    if (error instanceof FixtureError) throw new DerivedFixtureError('fixture-process-failed', error.code);
    return fail('fixture-process-failed');
  }
}
function sha(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) fail('invalid-registry');
  return value;
}

/** Fetches only the exact named public config; not called by ordinary tests. */
export async function fetchPinnedDerivedProfileSource(): Promise<string> {
  try {
    const response = await fetch(SOURCE_URL, {
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok || !response.body) fail('source-unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 524_288) fail('source-unavailable');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== DERIVED_FIXTURE_PROFILE.sha256) fail('profile-mismatch');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return fail('source-unavailable'); }
}

export interface DerivedMetadataRegistry {
  readonly rules: readonly { readonly id: string; readonly kind: 'content' | 'path-only' }[];
  readonly files: readonly { readonly pathParts: readonly string[]; readonly aliases: readonly string[] }[];
  readonly commits: readonly string[];
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

type RegistryScope = 'fixture' | 'declared-source';
function validateRegistry(registry: DerivedMetadataRegistry, scope: RegistryScope = 'fixture'): void {
  if (!exactKeys(registry, ['rules', 'files', 'commits'])
    || !Array.isArray(registry.rules) || registry.rules.length === 0 || registry.rules.length > 256
    || !Array.isArray(registry.files) || registry.files.length === 0 || registry.files.length > (scope === 'fixture' ? 16 : 5000)
    || !Array.isArray(registry.commits) || registry.commits.length === 0 || registry.commits.length > (scope === 'fixture' ? 4 : 2000)) fail('invalid-registry');
  if (registry.rules.some(rule => !exactKeys(rule, ['id', 'kind']) || typeof rule.id !== 'string'
    || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(rule.id)
    || (rule.kind !== 'content' && rule.kind !== 'path-only'))) fail('invalid-registry');
  const aliases: string[] = [];
  for (const file of registry.files) {
    if (!exactKeys(file, ['pathParts', 'aliases']) || !Array.isArray(file.pathParts) || file.pathParts.length < 1 ||
      file.pathParts.length > (scope === 'fixture' ? 8 : 40)
      || scope === 'fixture' && file.pathParts.some((part: unknown) => typeof part !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === '.' || part === '..')
      || !Array.isArray(file.aliases) || file.aliases.length < 1 || file.aliases.length > 4) fail('invalid-registry');
    if (scope === 'declared-source') {
      try { portableParts([...file.pathParts]); } catch { fail('invalid-registry'); }
    }
    for (const alias of file.aliases) {
      if (typeof alias !== 'string' || alias.length === 0 || alias.length > (scope === 'fixture' ? 512 : 4096) || /[\u0000-\u001f\u007f]/u.test(alias)
        || alias.split(/[\\/]/).some(part => part === '..' || part === '.')) fail('invalid-registry');
      aliases.push(alias);
    }
  }
  registry.commits.forEach(sha);
  for (const keys of [
    registry.rules.map(rule => rule.id), registry.files.map(file => file.pathParts.join('/').toLowerCase()),
    aliases.map(alias => alias.toLowerCase()), registry.commits
  ]) if (new Set(keys).size !== keys.length) fail('invalid-registry');
}

function ordinal(expressions: readonly string[], variable?: string): string {
  if (variable) return `{{$${variable} := -1}}` +
    expressions.map((expression, index) => `{{if ${expression}}}{{$${variable} = ${index}}}{{end}}`).join('') +
    `{{$${variable}}}`;
  return expressions.map((expression, index) => `{{if ${expression}}}${index}{{else}}`).join('')
    + '-1' + '{{end}}'.repeat(expressions.length);
}

/** No scanner string is interpolated, including names that appear to be metadata. */
function metadataTemplate(registry: DerivedMetadataRegistry, mode: 'history' | 'current-tree', scope: RegistryScope): string {
  validateRegistry(registry, scope);
  if (mode === 'current-tree' && registry.commits.length !== 1) fail('invalid-registry');
  const rules = ordinal(registry.rules.map(rule => `eq .RuleID ${JSON.stringify(rule.id)}`), scope === 'declared-source' ? 'ruleIndex' : undefined);
  const files = ordinal(registry.files.map(file => file.aliases.length === 1
    ? `eq .File ${JSON.stringify(file.aliases[0])}`
    : `or ${file.aliases.map(alias => `(eq .File ${JSON.stringify(alias)})`).join(' ')}`), scope === 'declared-source' ? 'fileIndex' : undefined);
  const commits = mode === 'current-tree' ? '{{if eq .Commit ""}}0{{else}}-1{{end}}'
    : ordinal(registry.commits.map(commit => `eq .Commit "${commit}"`), scope === 'declared-source' ? 'commitIndex' : undefined);
  return `[{{range $index, $finding := .}}{{if $index}},{{end}}[` +
    `${rules},${files},${commits},{{.StartLine}},{{.StartColumn}},{{.EndLine}},{{.EndColumn}},` +
    `{{if eq .Secret "REDACTED"}}1{{else}}{{if eq .Secret ""}}2{{else}}0{{end}}{{end}}]{{end}}]\n`;
}

export function derivedMetadataTemplate(registry: DerivedMetadataRegistry, mode: 'history' | 'current-tree' = 'history'): string {
  return metadataTemplate(registry, mode, 'fixture');
}

export function declaredSourceMetadataTemplate(registry: DerivedMetadataRegistry, mode: 'history' | 'current-tree'): string {
  return metadataTemplate(registry, mode, 'declared-source');
}

export interface DerivedMetadataFinding {
  readonly ruleIndex: number;
  readonly fileIndex: number;
  readonly commitIndex: number;
  readonly kind: 'content' | 'path-only';
  readonly line: number | null;
  readonly column: number | null;
  readonly endLine: number | null;
  readonly endColumn: number | null;
}

function parseMetadataOutput(
  bytes: Uint8Array, exitCode: number, registry: DerivedMetadataRegistry, scope: RegistryScope
): readonly DerivedMetadataFinding[] {
  validateRegistry(registry, scope);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
      bytes.byteLength > (scope === 'fixture' ? 65_536 : 4_194_304)) fail('invalid-report');
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('invalid-report'); }
  if (!Array.isArray(decoded) || decoded.length > (scope === 'fixture' ? 64 : 50_000) || ![0, 42].includes(exitCode)
    || (exitCode === 0) !== (decoded.length === 0)) fail('invalid-report');
  const seen = new Set<string>();
  const results = decoded.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 8 || !row.every((n: unknown) => typeof n === 'number'
      && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000)) fail('invalid-report');
    const [ruleIndex, fileIndex, commitIndex, line, column, endLine, endColumn, redacted]: unknown[] = row;
    if (typeof ruleIndex !== 'number' || typeof fileIndex !== 'number' || typeof commitIndex !== 'number'
      || !registry.rules[ruleIndex] || !registry.files[fileIndex] || !registry.commits[commitIndex]) fail('unknown-identity');
    const rule = registry.rules[ruleIndex];
    if (!rule || typeof line !== 'number' || typeof column !== 'number'
      || typeof endLine !== 'number' || typeof endColumn !== 'number') fail('invalid-report');
    if (rule.kind === 'path-only') {
      if (line !== 0 || column !== 0 || endLine !== 0 || endColumn !== 0) fail('unsupported-path-only-shape');
      if (redacted !== 1 && redacted !== 2) fail('unredacted-output');
    } else {
      if (line < 1 || column < 1 || endLine < line || endColumn < 1
        || (endLine === line && endColumn < column)) fail('invalid-report');
      if (redacted !== 1) fail('unredacted-output');
    }
    const key = JSON.stringify(row.slice(0, 7));
    if (seen.has(key)) fail('duplicate-finding');
    seen.add(key);
    return Object.freeze({
      ruleIndex, fileIndex, commitIndex, kind: rule.kind,
      line: rule.kind === 'path-only' ? null : line, column: rule.kind === 'path-only' ? null : column,
      endLine: rule.kind === 'path-only' ? null : endLine, endColumn: rule.kind === 'path-only' ? null : endColumn
    });
  });
  results.sort((a, b) => a.commitIndex - b.commitIndex || a.fileIndex - b.fileIndex || a.ruleIndex - b.ruleIndex
    || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)
    || (a.endLine ?? 0) - (b.endLine ?? 0) || (a.endColumn ?? 0) - (b.endColumn ?? 0));
  return Object.freeze(results);
}

export function parseDerivedFixtureOutput(bytes: Uint8Array, exitCode: number, registry: DerivedMetadataRegistry) {
  return parseMetadataOutput(bytes, exitCode, registry, 'fixture');
}

export function parseDeclaredSourceOutput(bytes: Uint8Array, exitCode: number, registry: DerivedMetadataRegistry) {
  return parseMetadataOutput(bytes, exitCode, registry, 'declared-source');
}

export async function qualifyDerivedOutputProbe(worktree: string, kind: 'stdout' | 'stderr' | 'parser' | 'oversize'): Promise<void> {
  return guarded(async () => {
    const owned = await createPrivateFixtureWorkspace(worktree);
    const scripts = {
      stdout: 'process.stdout.write("NONFUNCTIONAL_DERIVED_OUTPUT_SENTINEL")',
      stderr: 'process.stderr.write("NONFUNCTIONAL_DERIVED_OUTPUT_SENTINEL")',
      parser: 'process.stdout.write(\'{"Secret":"NONFUNCTIONAL_DERIVED_OUTPUT_SENTINEL\')',
      oversize: 'process.stdout.write("x".repeat(70000))'
    };
    try {
      const output = await capturePrivateFixtureProcess(process.execPath, ['-e', scripts[kind]], owned);
      try {
        parseDerivedFixtureOutput(output.stdout, output.exitCode, {
          rules: [{ id: 'fixture-rule', kind: 'content' }],
          files: [{ pathParts: ['fixture.txt'], aliases: ['fixture.txt'] }], commits: ['a'.repeat(40)]
        });
      } finally { output.stdout.fill(0); }
    } finally { await owned.register(); await owned.cleanup(); }
  });
}

const FILES = ['package-lock.json', 'go.sum', 'fixture.svg', 'history.txt', 'not-a-container.p12',
  '.gitleaksignore', '.gitleaks.toml'] as const;
const CANDIDATE_CONFIG = `title = "Untrusted candidate suppression"
[allowlist]
paths = ['''.*''']
[[rules]]
id = "candidate-noop"
regex = '''CANDIDATE_NONFUNCTIONAL_PATTERN_NOT_IN_FIXTURES'''
`;
const benign = [
  '{"name":"nonfunctional-fixture","lockfileVersion":3,"packages":{}}\n',
  'example.invalid/nonfunctional v0.0.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n',
  '<svg xmlns="http://www.w3.org/2000/svg"><desc>nonfunctional fixture</desc></svg>\n',
  'Nonfunctional fixture removed from current source.\n'
] as const;

function introducedContents(): readonly string[] {
  // AWS's published documentation example, not an issued credential. Fixture
  // inputs are deliberate; matching bytes are never copied into output/report.
  const example = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  return [
    `{"name":"nonfunctional-fixture","lockfileVersion":3,"packages":{},"documented_example":"${example}"}\n`,
    `example.invalid/${example} v0.0.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n`,
    `<svg xmlns="http://www.w3.org/2000/svg"><desc>Nonfunctional documented example ${example}</desc></svg>\n`,
    `Nonfunctional documented example ${example} # gitleaks:allow\n`,
    'Nonfunctional plain text: not a PKCS12 container, private key, or certificate.\n'
  ];
}

export interface DerivedFixtureObservation {
  readonly rule: 'aws-access-token' | 'pkcs12-file';
  readonly pathParts: readonly string[];
  readonly commit: string;
  readonly kind: 'content' | 'path-only';
  readonly line: number | null;
  readonly column: number | null;
  readonly endLine: number | null;
  readonly endColumn: number | null;
  readonly disposition: 'unresolved';
  readonly proposedDisposition: 'nonfunctional-fixture' | 'false-positive';
  readonly rationale: 'provider-documented-nonfunctional-example' | 'extension-only-plain-text-not-a-container';
  readonly proposalAuthority: 'none';
}

export interface DerivedProfileFixtureEvidence {
  readonly scope: 'new-private-derived-profile-fixtures-only';
  readonly fixtureQualification: 'passed';
  readonly securityGate: 'blocked';
  readonly profile: 'derived-configuration';
  readonly behaviorChanged: true;
  readonly unchangedUpstreamBehaviorClaim: false;
  readonly entireProfileQualified: false;
  readonly operationalRepositoryScanned: false;
  readonly nativePushOrHostedForkProof: false;
  readonly policyAdoption: 'not-performed';
  readonly scannerVersion: '8.30.1';
  readonly platform: 'darwin-arm64' | 'linux-x64';
  readonly archiveDigest: string;
  readonly binaryDigest: string;
  readonly sourceCommit: string;
  readonly sourceDigest: string;
  readonly preparedConfigDigest: string;
  readonly ruleCount: 222;
  readonly removedAllowlistGroups: 14;
  readonly templateDigest: string;
  readonly executionLimits: Readonly<{
    processTimeoutMs: 20000; scannerTimeoutSeconds: 15; reportBytes: 65536;
    maxDecodeDepth: 0; maxArchiveDepth: 0;
  }>;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly fixtureCommits: readonly string[];
  readonly currentTree: Readonly<{ expectedFiles: 6; inspectedFiles: 6; findings: 0 }>;
  readonly introducedHistory: Readonly<{ expectedCommits: 2; inspectedCommits: 2; findings: 5 }>;
  readonly currentTreeControls: Readonly<{
    positiveFiles: 6; positiveFindings: 5; cleanFiles: 5; cleanFindings: 0;
    sourceIgnore: 'rejected-before-scanning'; cwdIgnore: 'rejected-before-scanning';
    candidateConfig: 'scanned-as-data-not-authority'; nativeSuppressedNegativeControl: 0;
    inputCapture: 'checked-at-invocation-and-after-exit';
  }>;
  readonly controls: Readonly<{
    inlineAllowFlagListedAndEffective: true;
    ignorePathFlagListed: true;
    inlineSuppressionControlFindings: 4;
    candidateIgnoreControlFindings: 0;
    acceptedHistorySource: 'synthetic-git-object-directory';
    candidateIgnoreFilesDisabledByFlagAlone: false;
    negativeControlsAuthorizeAcceptance: false;
  }>;
  readonly observations: readonly DerivedFixtureObservation[];
  readonly cleanup: 'completed';
}

/** Pins come from the bounded task, not candidate policy or untrusted overrides. */
export async function qualifyDerivedProfileFixtures(
  tool: PinnedFixtureTool, worktree: string, gitExecutable: string, pinnedUpstreamSource: string
): Promise<DerivedProfileFixtureEvidence> {
  return guarded(async () => {
    const profile = prepareSecretProfile(pinnedUpstreamSource, DERIVED_FIXTURE_PROFILE);
    if (profile.rules.length !== 222 || profile.removedAllowlistGroups !== 14 || !profile.behaviorChanged
      || profile.configDigest !== `sha256:${DERIVED_FIXTURE_PROFILE.preparedConfigSha256}`) fail('profile-mismatch');
    const tables = parse(profile.config).rules;
    if (!Array.isArray(tables)) fail('profile-mismatch');
    const rules = tables.map(value => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('profile-mismatch');
      const fields = new Map(Object.entries(value));
      const id = fields.get('id');
      if (typeof id !== 'string') return fail('profile-mismatch');
      const kind: 'content' | 'path-only' = typeof fields.get('regex') === 'string' ? 'content' : 'path-only';
      return Object.freeze({ id, kind });
    });
    const owned = await createPrivateFixtureWorkspace(worktree);
    try {
      const help = await capturePinnedFixtureGitleaks(tool, ['git', '--help'], owned);
      try {
        const text = help.stdout.toString('utf8');
        if (help.exitCode !== 0 || !/--ignore-gitleaks-allow\b/.test(text) || !/--gitleaks-ignore-path\b/.test(text)) {
          fail('required-flags-unavailable');
        }
      } finally { help.stdout.fill(0); }
      const { root: repo, git } = await createPrivateFixtureGit(owned, gitExecutable);
      const tree = await owned.directory('tree');
      const positiveTree = await owned.directory('positive-tree');
      const config = await owned.write('derived.toml', profile.config);
      const put = async (index: number, content: string) => {
        const file = FILES[index];
        if (!file) fail('invalid-registry');
        await writeFile(path.join(repo, file), content, { mode: 0o600 });
        await owned.register();
      };
      const makeCommit = async (message: string) => {
        await git(['add', '--all', '--', '.']);
        await git(['commit', '--quiet', '--no-gpg-sign', '-m', message]);
        return sha((await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim());
      };
      for (const [index, content] of benign.entries()) await put(index, content);
      await put(6, CANDIDATE_CONFIG);
      const base = await makeCommit('derived-fixture-base');
      for (const [index, content] of introducedContents().entries()) await put(index, content);
      const introduced = await makeCommit('derived-fixture-introduced');
      const files = FILES.map(file => ({
        pathParts: [file], aliases: [file, path.join(repo, file), path.join(tree, file), path.join(positiveTree, file)]
      }));
      const introRegistry: DerivedMetadataRegistry = { rules, files, commits: [introduced] };
      const introTemplate = derivedMetadataTemplate(introRegistry);
      const introTemplatePath = await owned.write('introduced.tmpl', introTemplate);
      const objectDirectory = path.join(repo, '.git');
      const scan = async (
        registry: DerivedMetadataRegistry, templatePath: string, template: string,
        source: readonly string[], ignoreInline = true
      ) => {
        if (await readFile(config, 'utf8') !== profile.config || await readFile(templatePath, 'utf8') !== template) fail('profile-mismatch');
        const output = await capturePinnedFixtureGitleaks(tool, [...source,
          '--config', config, '--report-format', 'template', '--report-template', templatePath,
          '--report-path', '-', '--redact=100', '--no-banner', '--no-color', '--log-level=error',
          '--exit-code=42', '--max-decode-depth=0', '--max-archive-depth=0', '--timeout=15',
          '--gitleaks-ignore-path', path.join(owned.root, 'empty-directory'),
          ...(ignoreInline ? ['--ignore-gitleaks-allow'] : [])
        ], owned);
        try { return parseDerivedFixtureOutput(output.stdout, output.exitCode, registry); } finally { output.stdout.fill(0); }
      };
      const selection = (head: string, source = objectDirectory) => [
        'git', '--platform=none', `--log-opts=${base}..${head} --no-ext-diff --no-textconv --no-renames`, source
      ];
      const assertFindings = (findings: readonly DerivedMetadataFinding[], expectedFiles: readonly number[]) => {
        if (findings.length !== expectedFiles.length || findings.some(item => item.commitIndex !== 0)) fail('unexpected-findings');
        const observed = findings.map(item => item.fileIndex).sort((a, b) => a - b);
        if (JSON.stringify(observed) !== JSON.stringify(expectedFiles)) fail('unexpected-findings');
        for (const item of findings) {
          const expectedRule = item.fileIndex === 4 ? 'pkcs12-file' : 'aws-access-token';
          if (rules[item.ruleIndex]?.id !== expectedRule) fail('unexpected-findings');
          if (item.fileIndex < 4 && (item.line !== 1 || item.endLine !== 1)) fail('unexpected-findings');
        }
      };
      const observedAt = new Date().toISOString();
      const initial = await scan(introRegistry, introTemplatePath, introTemplate, selection(introduced));
      assertFindings(initial, [0, 1, 2, 3, 4]);
      const ignoreEntries = initial.map(item => {
        const file = FILES[item.fileIndex];
        const rule = rules[item.ruleIndex];
        if (!file || !rule) return fail('invalid-registry');
        return `${introduced}:${file}:${rule.id}:${item.line ?? 0}`;
      }).sort().join('\n') + '\n';
      for (const [index, content] of introducedContents().entries()) {
        if (await git(['show', `${introduced}:${FILES[index]}`]) !== content) fail('scope-incomplete');
        await writeFile(path.join(positiveTree, FILES[index]!), content, { flag: 'wx', mode: 0o600 });
        await owned.register();
      }
      await writeFile(path.join(positiveTree, FILES[6]), CANDIDATE_CONFIG, { flag: 'wx', mode: 0o600 });
      await owned.register();
      const treeTemplate = derivedMetadataTemplate(introRegistry, 'current-tree');
      const treeTemplatePath = await owned.write('tree.tmpl', treeTemplate);
      const guardedTreeScan = () => captureSuppressionFreeFixtureGitleaks(tool, owned, {
        source: positiveTree, configuration: { path: config, contents: profile.config },
        template: { path: treeTemplatePath, contents: treeTemplate }
      });
      const treeFindings = async () => {
        const output = await guardedTreeScan();
        try { return parseDerivedFixtureOutput(output.stdout, output.exitCode, introRegistry); }
        finally { output.stdout.fill(0); }
      };
      const rejectIgnore = async () => {
        try {
          const output = await guardedTreeScan();
          output.stdout.fill(0);
        } catch (error) {
          if (error instanceof FixtureError && error.code === 'candidate-suppression') return;
          throw error;
        }
        fail('unexpected-findings');
      };
      const positive = await treeFindings();
      assertFindings(positive, [0, 1, 2, 3, 4]);
      const treeIgnores = positive.flatMap(item => {
        const file = FILES[item.fileIndex]!, rule = rules[item.ruleIndex]!;
        return [file, path.join(positiveTree, file)].map(alias => `${alias}:${rule.id}:${item.line ?? 0}`);
      }).join('\n') + '\n';
      const sourceIgnore = path.join(positiveTree, '.gitleaksignore');
      await writeFile(sourceIgnore, treeIgnores, { flag: 'wx', mode: 0o600 });
      await owned.register();
      // The raw pinned invocation is a negative control, never accepted evidence.
      if ((await scan(introRegistry, treeTemplatePath, treeTemplate, ['dir', positiveTree])).length !== 0) fail('unexpected-findings');
      await rejectIgnore();
      await unlink(sourceIgnore);
      await owned.register();
      const cwdIgnore = path.join(owned.root, '.gitleaksignore');
      await writeFile(cwdIgnore, treeIgnores, { flag: 'wx', mode: 0o600 });
      await owned.register();
      await rejectIgnore();
      await unlink(cwdIgnore);
      await owned.register();
      assertFindings(await treeFindings(), [0, 1, 2, 3, 4]);
      for (const [index, content] of benign.entries()) await writeFile(path.join(positiveTree, FILES[index]!), content);
      await unlink(path.join(positiveTree, FILES[4]));
      await owned.register();
      if ((await treeFindings()).length !== 0) fail('unexpected-findings');
      for (const [index, content] of benign.entries()) await put(index, content);
      await unlink(path.join(repo, FILES[4]));
      await owned.register();
      await put(5, ignoreEntries);
      const head = await makeCommit('derived-fixture-removed-with-candidate-ignores');
      const currentFiles = [0, 1, 2, 3, 5, 6] as const;
      const names = currentFiles.map(index => FILES[index]).sort();
      if (await git(['rev-parse', '--is-shallow-repository']) !== 'false\n' || await git(['remote']) !== ''
        || await git(['rev-parse', '--show-toplevel']) !== `${repo}\n`
        || await git(['ls-files', '-z']) !== `${names.join('\0')}\0`
        || await git(['rev-list', '--reverse', `${base}..${head}`]) !== `${introduced}\n${head}\n`) fail('scope-incomplete');
      await git(['fsck', '--strict', '--no-progress']);
      const registry: DerivedMetadataRegistry = { rules, files, commits: [introduced, head] };
      const template = derivedMetadataTemplate(registry);
      const templatePath = await owned.write('history.tmpl', template);
      for (const index of currentFiles) {
        const content = await git(['show', `${head}:${FILES[index]}`]);
        const expected = index === 5 ? ignoreEntries : index === 6 ? CANDIDATE_CONFIG : benign[index];
        if (content !== expected) fail('scope-incomplete');
        const file = path.join(tree, FILES[index]);
        await writeFile(file, content, { flag: 'wx', mode: 0o600 });
        await owned.register();
        if ((await scan(registry, templatePath, template, ['dir', file])).length !== 0) fail('unexpected-findings');
      }
      const historyOutput = await captureSuppressionFreeFixtureGitleaks(tool, owned, {
        source: objectDirectory, history: { base, head },
        configuration: { path: config, contents: profile.config }, template: { path: templatePath, contents: template }
      });
      let history: readonly DerivedMetadataFinding[];
      try { history = parseDerivedFixtureOutput(historyOutput.stdout, historyOutput.exitCode, registry); }
      finally { historyOutput.stdout.fill(0); }
      assertFindings(history, [0, 1, 2, 3, 4]);
      const inlineControl = await scan(registry, templatePath, template, selection(head), false);
      assertFindings(inlineControl, [0, 1, 2, 4]);
      // Native v8.30.1 also loads source/.gitleaksignore. A flag pointing at an
      // empty ignore directory alone is NOT protection against candidate files.
      const ignoreControl = await scan(registry, templatePath, template, selection(head, repo));
      if (ignoreControl.length !== 0) fail('unexpected-findings');
      const observations = history.map((item): DerivedFixtureObservation => ({
        rule: item.fileIndex === 4 ? 'pkcs12-file' : 'aws-access-token',
        pathParts: Object.freeze([FILES[item.fileIndex] ?? fail('invalid-registry')]),
        commit: introduced, kind: item.kind, line: item.line, column: item.column,
        endLine: item.endLine, endColumn: item.endColumn, disposition: 'unresolved',
        proposedDisposition: item.fileIndex === 4 ? 'false-positive' : 'nonfunctional-fixture',
        rationale: item.fileIndex === 4 ? 'extension-only-plain-text-not-a-container' : 'provider-documented-nonfunctional-example',
        proposalAuthority: 'none'
      }));
      return Object.freeze({
        scope: 'new-private-derived-profile-fixtures-only', fixtureQualification: 'passed', securityGate: 'blocked',
        profile: 'derived-configuration', behaviorChanged: true, unchangedUpstreamBehaviorClaim: false,
        entireProfileQualified: false, operationalRepositoryScanned: false, nativePushOrHostedForkProof: false,
        policyAdoption: 'not-performed', scannerVersion: tool.version, platform: tool.platform,
        archiveDigest: tool.archiveDigest, binaryDigest: tool.binaryDigest,
        sourceCommit: DERIVED_FIXTURE_PROFILE.commit, sourceDigest: profile.sourceDigest,
        preparedConfigDigest: profile.configDigest, ruleCount: 222, removedAllowlistGroups: 14,
        templateDigest: hash(template),
        executionLimits: Object.freeze({
          processTimeoutMs: 20000, scannerTimeoutSeconds: 15, reportBytes: 65536,
          maxDecodeDepth: 0, maxArchiveDepth: 0
        }),
        observedAt, completedAt: new Date().toISOString(),
        fixtureCommits: Object.freeze([base, introduced, head]),
        currentTree: Object.freeze({ expectedFiles: 6, inspectedFiles: 6, findings: 0 }),
        introducedHistory: Object.freeze({ expectedCommits: 2, inspectedCommits: 2, findings: 5 }),
        currentTreeControls: Object.freeze({
          positiveFiles: 6, positiveFindings: 5, cleanFiles: 5, cleanFindings: 0,
          sourceIgnore: 'rejected-before-scanning', cwdIgnore: 'rejected-before-scanning',
          candidateConfig: 'scanned-as-data-not-authority', nativeSuppressedNegativeControl: 0,
          inputCapture: 'checked-at-invocation-and-after-exit'
        }),
        controls: Object.freeze({
          inlineAllowFlagListedAndEffective: true, ignorePathFlagListed: true,
          inlineSuppressionControlFindings: 4, candidateIgnoreControlFindings: 0,
          acceptedHistorySource: 'synthetic-git-object-directory',
          candidateIgnoreFilesDisabledByFlagAlone: false, negativeControlsAuthorizeAcceptance: false
        }),
        observations: Object.freeze(observations.map(item => Object.freeze(item))), cleanup: 'completed'
      });
    } finally { await owned.register(); await owned.cleanup(); }
  });
}

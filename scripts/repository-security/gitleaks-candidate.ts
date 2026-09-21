import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { canonicalDigest } from './admission.ts';
import { portableParts, sha, SecurityEvidenceError } from './evidence.ts';
import {
  capturePinnedFixtureGitleaks, capturePrivateFixtureProcess, createPrivateSourceWorkspace,
  fixtureGitEnvironment, fixtureGitOptions, type PinnedFixtureTool
} from './gitleaks.ts';
import {
  declaredSourceMetadataTemplate, DERIVED_FIXTURE_PROFILE, parseDeclaredSourceOutput,
  type DerivedMetadataRegistry
} from './gitleaks-derived.ts';
import { prepareSecretProfile } from './secret-profile.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new SecurityEvidenceError(`gitleaks-candidate-${code}`); }

async function fileBytes(root: string, parts: string[]) {
  const target = path.join(root, ...portableParts(parts));
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || await realpath(target) !== target) fail('unsafe-file');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 16_777_216n) fail('unsafe-file');
    bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(target, { bigint: true });
    if (BigInt(length) !== before.size || before.size !== after.size || before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs || named.isSymbolicLink() ||
        named.ino !== before.ino || named.dev !== before.dev) fail('file-drift');
    return { bytes: Buffer.from(bytes.subarray(0, length)), mode: Number(before.mode & 0o111n) };
  } finally { bytes?.fill(0); await handle.close(); }
}

/**
 * Current uncommitted candidate content only, never a Git commit/history claim.
 * The frozen base .gitignore selects untracked source; tracked ignored files
 * remain included. Candidate ignore-file edits cannot narrow this inventory.
 */
export async function assessCandidateSecrets(options: {
  repository: string; expectedHead: string; workspaceParent: string;
  tool: PinnedFixtureTool; upstreamProfile: string;
}) {
  const root = await realpath(options.repository), head = sha(options.expectedHead);
  const owned = await createPrivateSourceWorkspace(process.cwd(), options.workspaceParent);
  try {
    const env = fixtureGitEnvironment(owned.root, path.join(owned.root, 'bin'));
    const git = async (args: string[]) => {
      const result = await capturePrivateFixtureProcess('/usr/bin/git', [
        ...fixtureGitOptions(owned.root), '-c', `core.excludesFile=${path.join(owned.root, 'empty')}`, ...args
      ], owned, { cwd: root, environment: env, maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 });
      try {
        if (result.exitCode !== 0) fail('git-scope');
        return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      } finally { result.stdout.fill(0); await owned.register(); }
    };
    if ((await git(['rev-parse', '--show-toplevel'])).trim() !== root ||
        (await git(['rev-parse', 'HEAD'])).trim() !== head) fail('source-identity');
    const ignore = await git(['show', `${head}:.gitignore`]);
    const liveIgnore = await fileBytes(root, ['.gitignore']);
    try { if (!liveIgnore.bytes.equals(Buffer.from(ignore))) fail('candidate-ignore-policy-change'); }
    finally { liveIgnore.bytes.fill(0); }
    const policyPath = await owned.write('base-gitignore', ignore);
    const names = async () => {
      const tracked = (await git(['ls-files', '--cached', '-z'])).split('\0').filter(Boolean);
      // Do not use --exclude-standard: candidate nested ignores and private
      // Git excludes must not substitute for the captured base selection.
      const untracked = (await git(['ls-files', '--others', `--exclude-from=${policyPath}`, '-z'])).split('\0').filter(Boolean);
      const all = [...new Set([...tracked, ...untracked])].sort();
      if (!all.length || all.length > 5000 || new Set(all.map(value => value.toLowerCase())).size !== all.length) fail('inventory');
      const parts = all.map(value => portableParts(value.split('/')));
      if (parts.some(value => value.some(part => part.toLowerCase() === '.gitleaksignore'))) fail('candidate-suppression');
      return { parts, tracked: new Set(tracked) };
    };
    const selection = await names(), current = await owned.directory('candidate');
    const entries: { pathParts: string[]; digest: string; mode: number; size: number; deleted: boolean }[] = [];
    let total = 0;
    for (const parts of selection.parts) {
      let value;
      try { value = await fileBytes(root, parts); }
      catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && selection.tracked.has(parts.join('/'))) {
          entries.push({ pathParts: parts, digest: hash('deleted-tracked-file'), mode: 0, size: 0, deleted: true });
          continue;
        }
        throw error;
      }
      try {
        total += value.bytes.length;
        if (total > 256 * 1024 * 1024) fail('size');
        const target = path.join(current, ...parts);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, value.bytes, { flag: 'wx', mode: 0o600 });
        entries.push({ pathParts: parts, digest: hash(value.bytes), mode: value.mode, size: value.bytes.length, deleted: false });
      } finally { value.bytes.fill(0); }
    }
    await owned.register();
    const present = entries.filter(entry => !entry.deleted);
    if (!present.length) fail('empty-candidate');
    const profile = prepareSecretProfile(options.upstreamProfile, DERIVED_FIXTURE_PROFILE);
    const rules = parse(profile.config).rules;
    if (!Array.isArray(rules)) fail('rules');
    const registry: DerivedMetadataRegistry = {
      rules: rules.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !('id' in value) || typeof value.id !== 'string') fail('rules');
        return { id: value.id, kind: 'regex' in value ? 'content' : 'path-only' };
      }),
      // Numeric framing for a directory scan needs one slot. This remains the
      // real HEAD anchor internally; it is never emitted as a finding commit.
      commits: [head], files: present.map(entry => ({
        pathParts: entry.pathParts, aliases: [entry.pathParts.join('/'), path.join(current, ...entry.pathParts),
          path.join('candidate', ...entry.pathParts)]
      }))
    };
    const configuration = await owned.write('detector.toml', profile.config);
    const template = await owned.write('candidate.tmpl', declaredSourceMetadataTemplate(registry, 'current-tree'));
    const observedAt = new Date().toISOString(), snapshotDigest = canonicalDigest({ head, selection: entries, ignoreDigest: hash(ignore) });
    const output = await capturePinnedFixtureGitleaks(options.tool, [
      'dir', current, '--config', configuration, '--report-template', template, '--report-format', 'template',
      '--report-path', '-', '--redact=100', '--no-banner', '--no-color', '--log-level=error', '--exit-code=42',
      '--ignore-gitleaks-allow', '--max-decode-depth=0', '--max-archive-depth=0', '--max-target-megabytes=0',
      '--timeout=90', '--gitleaks-ignore-path', path.join(owned.root, 'empty-directory')
    ], owned, { maxBytes: 4 * 1024 * 1024, timeoutMs: 120_000 });
    try {
      const findings = parseDeclaredSourceOutput(output.stdout, output.exitCode, registry);
      if (!sameSelection((await names()).parts, selection.parts)) fail('source-membership-drift');
      if ((await git(['rev-parse', 'HEAD'])).trim() !== head) fail('source-head-drift');
      for (const entry of entries) {
        if (entry.deleted) {
          try { await lstat(path.join(root, ...entry.pathParts)); fail('deleted-source-restored'); }
          catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
          continue;
        }
        const currentValue = await fileBytes(root, entry.pathParts);
        const copied = await fileBytes(current, entry.pathParts);
        try {
          if (currentValue.mode !== entry.mode) fail('source-mode-drift');
          if (hash(currentValue.bytes) !== entry.digest) fail('source-content-drift');
          if (hash(copied.bytes) !== entry.digest) fail('private-copy-drift');
        } finally { currentValue.bytes.fill(0); copied.bytes.fill(0); }
      }
      return {
        kind: 'uncommitted-candidate-secrets-assessment', identityKind: 'stable-content-snapshot-not-git-commit',
        headAnchor: head, snapshotDigest, observedAt, completedAt: new Date().toISOString(),
        inputFiles: present.length, deletedTrackedFiles: entries.length - present.length, inputBytes: total,
        selectionPolicy: 'tracked-plus-untracked-under-exact-base-gitignore',
        selectionPolicyDigest: hash(ignore), configurationDigest: profile.configDigest,
        tool: { version: options.tool.version, binaryDigest: options.tool.binaryDigest },
        assessmentComplete: true, findingsPassed: findings.length === 0,
        findings: findings.map(item => ({
          id: canonicalDigest({ snapshotDigest, fileDigest: present[item.fileIndex]!.digest, ...item }),
          rule: registry.rules[item.ruleIndex]!.id, locationIndex: item.fileIndex,
          fileDigest: present[item.fileIndex]!.digest,
          line: item.line, column: item.column, endLine: item.endLine, endColumn: item.endColumn,
          kind: item.kind, state: 'unresolved', blocking: true
        })),
        cleanup: 'completed', historyAssessed: false, dispositionAuthority: false,
        hostedQualification: false, publicationQualified: false,
        limitations: ['Ignored untracked developer/runtime files excluded by exact base selection; tracked ignored files remain included.',
          'No history/message-body, archive-decoding or opaque-binary completeness claim.',
          'Potential detections are not confirmed exposures or distinct credentials; no issuer validation or remediation occurred.']
      };
    } finally { output.stdout.fill(0); }
  } finally { await owned.register(); await owned.cleanup(); }
}

function sameSelection(left: string[][], right: string[][]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

import { GitHubActivationError } from '../adapters/github/activation-rest.js';
import { modernLocalInputExclusion } from '../domain/governance/activation/modern-local-exclusions.js';
import { FileSystemError } from '../domain/project/errors.js';
import { manifestPathAliasKey, validateManifestPathParts } from '../domain/project/manifest/layout.js';

export const applicationContextBounds = Object.freeze({
  files: 512, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024, inventoryBytes: 1024 * 1024
});
export const applicationContextDirectory = '${{ steps.liftoff-context.outputs.path }}';

export function applicationContextPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > applicationContextBounds.files ||
    Object.keys(value).length !== value.length) {
    throw new GitHubActivationError('application-context-inventory', 'Root build context requires a nonempty bounded positive file inventory.');
  }
  const paths = value.map((entry: unknown) => {
    if (typeof entry !== 'string') {
      throw new GitHubActivationError('application-context-inventory', 'Every approved context entry must name one exact project-relative file.');
    }
    let parts: readonly string[];
    try { parts = validateManifestPathParts(entry.split('/'), 'Application context file'); }
    catch (error) {
      if (!(error instanceof FileSystemError)) throw error;
      throw new GitHubActivationError('application-context-inventory', 'Every context file must have one bounded portable project-relative path.');
    }
    if (modernLocalInputExclusion(parts) || parts.some(part => part.toLowerCase() === '.liftoff') ||
      ['.github', 'governance', 'openspec', '.specify', 'specs'].includes(parts[0]!.toLowerCase()) ||
      /^(?:liftoff\.(?:manifest|config)\.json|runtime\.config\.json)$/iu.test(entry) ||
      /\.log$/iu.test(entry)) {
      throw new GitHubActivationError('application-context-sensitive', 'Application context cannot include private metadata, credentials, state, framework history or build output.');
    }
    return parts.join('/');
  }).sort();
  const aliases = paths.map(entry => manifestPathAliasKey(entry.split('/')));
  if (new Set(aliases).size !== paths.length || aliases.some((entry, index) =>
    aliases.some((other, otherIndex) => otherIndex !== index && other.startsWith(`${entry}/`)))) {
    throw new GitHubActivationError('application-context-inventory', 'Application context requires unique nonoverlapping exact file paths, not directory sweeps or aliases.');
  }
  return Object.freeze(paths);
}

export function applicationArtifactContextStep(paths: readonly string[]) {
  paths = applicationContextPaths(paths);
  return {
    id: 'liftoff-context',
    name: 'Prepare exact application context',
    shell: 'bash',
    'working-directory': '${{ github.workspace }}',
    env: {
      LIFTOFF_SOURCE_SHA: '${{ inputs.source_sha }}',
      LIFTOFF_CONTEXT_PATHS: JSON.stringify(paths).replaceAll('$', '\\u0024')
    },
    run: `node --input-type=module <<'LIFTOFF_APPLICATION_CONTEXT'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const bounds = ${JSON.stringify(applicationContextBounds)};
const deadline = Date.now() + 120_000;
const sha = process.env.LIFTOFF_SOURCE_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/u, 'Exact source SHA is required.');
const files = JSON.parse(process.env.LIFTOFF_CONTEXT_PATHS ?? 'null');
assert(Array.isArray(files) && files.length > 0 && files.length <= bounds.files, 'Exact context files are required.');
const selected = new Set(files);
assert.equal(selected.size, files.length, 'Context files must be unique.');
function git(args, maximum) {
  const remaining = deadline - Date.now();
  assert(remaining > 0, 'Application context projection exceeded its two-minute deadline.');
  const result = spawnSync('git', args, { timeout: Math.min(30_000, remaining), maxBuffer: maximum,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  assert(!result.error && result.status === 0 && result.signal === null, 'Bounded Git object observation failed.');
  return result.stdout;
}
assert.equal(git(['rev-parse', '--verify', 'HEAD'], 128).toString('utf8').trim(), sha, 'Checkout source changed.');
const entries = git(['--literal-pathspecs', 'ls-tree', '-l', '-z', sha, '--', ...files], bounds.inventoryBytes)
  .toString('utf8').split('\\0').filter(Boolean).map(entry => {
    const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\\t(.+)$/u);
    assert(match && selected.has(match[4]), 'Context inventory changed or contains a directory, symlink or submodule.');
    return { mode: match[1], object: match[2], bytes: Number(match[3]), path: match[4] };
  });
assert.equal(entries.length, files.length, 'A selected context file is absent.');
assert.equal(new Set(entries.map(entry => entry.path)).size, files.length, 'Context inventory is ambiguous.');
assert(entries.every(entry => entry.bytes <= bounds.fileBytes) &&
  entries.reduce((total, entry) => total + entry.bytes, 0) <= bounds.totalBytes, 'Context exceeds reviewed projection bounds.');
const temporary = process.env.RUNNER_TEMP;
const output = process.env.GITHUB_OUTPUT;
assert(temporary && output && !/[\\r\\n]/u.test(temporary + output), 'Qualified workflow output paths are required.');
assert.equal(fs.realpathSync(temporary), temporary, 'Runner temporary root must be canonical.');
const relativeOutput = path.relative(temporary, output);
assert(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), 'Workflow output escaped runner temporary scope.');
assert(fs.lstatSync(output).isFile() && !fs.lstatSync(output).isSymbolicLink(), 'Workflow output must be a regular file.');
assert.equal(fs.realpathSync(output), output, 'Workflow output must not traverse linked parents.');
const directory = fs.mkdtempSync(path.join(temporary, 'liftoff-application-context-'));
for (const entry of entries) {
  const parts = entry.path.split('/');
  assert(parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\\\\') &&
    !/[\\u0000-\\u001f\\u007f]/u.test(part)), 'Context file escaped its projection.');
  const bytes = git(['cat-file', 'blob', entry.object], bounds.fileBytes + 1);
  assert.equal(bytes.length, entry.bytes, 'Source object size changed.');
  assert.equal(createHash('sha1').update('blob ' + bytes.length + '\\0').update(bytes).digest('hex'), entry.object,
    'Source object bytes changed.');
  const target = path.join(directory, ...parts);
  assert(!path.relative(directory, target).startsWith('..'), 'Context file escaped its projection.');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644);
}
assert(Date.now() < deadline, 'Application context projection exceeded its two-minute deadline.');
fs.appendFileSync(output, 'path=' + directory + '\\n');
LIFTOFF_APPLICATION_CONTEXT`
  };
}

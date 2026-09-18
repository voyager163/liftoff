import { createHash } from 'node:crypto';
import { GitHubActivationError, object } from './activation-rest.js';
import { sourceSha } from '../../governance-activation/github-config.js';

export interface GitTreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000' | '120000' | '160000';
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export function gitObjectSha(type: 'blob' | 'tree' | 'commit', content: Buffer | string): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

export function readGitTree(value: Record<string, unknown>, expectedSha: string): GitTreeEntry[] {
  if (value.sha !== expectedSha || value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 4096) {
    throw new GitHubActivationError('source-tree', 'Publication requires one complete bounded immutable Git tree; truncated inventories cannot preserve foreign files.');
  }
  const entries = value.tree.map((entry) => {
    const e = object(entry);
    if (typeof e.path !== 'string' || e.path.length > 500 || /[\u0000-\u001f\u007f\\]/u.test(e.path) ||
      e.path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') ||
      !['100644', '100755', '040000', '120000', '160000'].includes(String(e.mode)) ||
      e.type !== (e.mode === '040000' ? 'tree' : e.mode === '160000' ? 'commit' : 'blob')) {
      throw new GitHubActivationError('source-tree', 'The immutable source tree contains unsupported or ambiguous path identities.');
    }
    return { path: e.path, mode: e.mode, type: e.type, sha: sourceSha(e.sha, 'Git object SHA') } as GitTreeEntry;
  });
  if (new Set(entries.map((entry) => entry.path.toLowerCase())).size !== entries.length) {
    throw new GitHubActivationError('source-tree', 'Case-colliding Git entries cannot establish exact publication ownership.');
  }
  if (treeWithFiles(entries, []).sha !== expectedSha) {
    throw new GitHubActivationError('source-tree', 'The actual Git tree entries do not match their immutable tree SHA.');
  }
  return entries;
}

export function treeWithFiles(entries: readonly GitTreeEntry[], files: readonly { path: string; blobSha: string }[]): {
  sha: string; entries: GitTreeEntry[];
} {
  const result = new Map(entries.map((entry) => [entry.path, { ...entry }]));
  for (const file of files) {
    if (entries.some((entry) => entry.path.toLowerCase() === file.path.toLowerCase() && entry.path !== file.path)) {
      throw new GitHubActivationError('source-alias', 'A reviewed source destination aliases an existing differently cased Git path.');
    }
    const old = result.get(file.path);
    if (old && old.mode !== '100644') throw new GitHubActivationError('source-mode', 'Workflow publication cannot replace executable, linked, directory or submodule content.');
    result.set(file.path, { path: file.path, mode: '100644', type: 'blob', sha: sourceSha(file.blobSha) });
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const name = parts.slice(0, i).join('/');
      const prior = result.get(name);
      if (prior && prior.type !== 'tree') throw new GitHubActivationError('source-mode', 'A reviewed path traverses a non-directory Git entry.');
      if (!prior) result.set(name, { path: name, mode: '040000', type: 'tree', sha: '0'.repeat(40) });
    }
  }
  const directories = ['', ...[...result.values()].filter((entry) => entry.type === 'tree').map((entry) => entry.path)]
    .sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);
  let root = '';
  for (const directory of directories) {
    const children = [...result.values()].filter((entry) =>
      (entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '') === directory);
    children.sort((a, b) => Buffer.compare(
      Buffer.from(a.path.split('/').at(-1)! + (a.type === 'tree' ? '/' : '')),
      Buffer.from(b.path.split('/').at(-1)! + (b.type === 'tree' ? '/' : ''))
    ));
    const bytes = Buffer.concat(children.map((entry) => Buffer.concat([
      Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.path.split('/').at(-1)!}\0`),
      Buffer.from(entry.sha, 'hex')
    ])));
    const sha = gitObjectSha('tree', bytes);
    if (directory === '') root = sha;
    else result.get(directory)!.sha = sha;
  }
  return { sha: root, entries: [...result.values()] };
}

export function workflowCommitSha(input: {
  treeSha: string; parentSha: string; message: string; actorLogin: string; actorId: number; commitTime: string;
}): { sha: string; author: { name: string; email: string; date: string } } {
  const author = { name: input.actorLogin, email: `${input.actorId}+${input.actorLogin}@users.noreply.github.com`, date: input.commitTime };
  const signature = `${author.name} <${author.email}> ${Date.parse(author.date) / 1000} +0000`;
  return { author, sha: gitObjectSha('commit',
    `tree ${input.treeSha}\nparent ${input.parentSha}\nauthor ${signature}\ncommitter ${signature}\n\n${input.message}\n`) };
}

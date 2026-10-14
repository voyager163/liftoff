import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compiledPackageFiles } from '../scripts/package-smoke-contract.mjs';

function headings(markdown: string): Array<{ title: string; line: number }> {
  const result: Array<{ title: string; line: number }> = [];
  const visible = markdown.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\r\n]/g, ''));
  let fence: { character: string; length: number } | undefined;
  for (const [index, line] of visible.split(/\r?\n/).entries()) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^ {0,3}#{1,6} +(.+?) *(?: +#+ *)?$/);
    if (match) result.push({ title: match[1], line: index + 1 });
  }
  return result;
}

function plainAnchor(title: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 .,_-]*$/.test(title)) {
    throw new Error(`Unsupported plain ASCII heading: ${title}`);
  }
  return title.toLowerCase().replace(/[.,]/g, '').replace(/ /g, '-');
}

function requirePlainFragment(markdown: string, fragment: string): void {
  const entries = headings(markdown);
  const matches = entries.filter(entry => /^[A-Za-z0-9][A-Za-z0-9 .,_-]*$/.test(entry.title))
    .filter(entry => plainAnchor(entry.title) === fragment);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous plain heading: ${fragment}`);
  const earlierCollision = entries.filter(entry => entry.line < matches[0].line)
    .some(entry => entry.title.replace(/[`*]/g, '').toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-') === fragment);
  if (earlierCollision) throw new Error(`Earlier formatted heading may change anchor: ${fragment}`);
}

async function markdownFiles(relative: string): Promise<string[]> {
  const absolute = path.join(process.cwd(), relative);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Packaged documentation inventory contains a link: ${relative}`);
  if (info.isFile()) return relative.endsWith('.md') ? [relative] : [];
  if (!info.isDirectory()) throw new Error(`Unsupported packaged entry: ${relative}`);
  const files: string[] = [];
  for (const entry of await readdir(absolute)) {
    files.push(...await markdownFiles(path.posix.join(relative, entry)));
  }
  return files;
}

describe('packaged documentation plain-heading fragments', () => {
  it('preserves digits and hyphens while removing qualified punctuation', () => {
    expect(plainAnchor('1. Install the CLI')).toBe('1-install-the-cli');
    expect(plainAnchor('Read-only governance assessment')).toBe('read-only-governance-assessment');
    expect(plainAnchor('Native setup, repair and assessment')).toBe('native-setup-repair-and-assessment');
  });

  it('does not treat fenced examples or comments as headings', () => {
    const markdown = '# Real\n```bash\n## Example\n```\n~~~\n## Another example\n~~~\n<!--\n## Comment\n-->\n## Next';
    expect(headings(markdown).map(entry => entry.title)).toEqual(['Real', 'Next']);
    expect(() => requirePlainFragment(markdown, 'example')).toThrow('Missing or ambiguous plain heading');
  });

  it('refuses missing and duplicate headings instead of accepting a file-only match', () => {
    expect(() => requirePlainFragment('# Other', 'missing')).toThrow('Missing or ambiguous plain heading');
    expect(() => requirePlainFragment('# Setup\n## Setup', 'setup')).toThrow('Missing or ambiguous plain heading');
    expect(() => requirePlainFragment('# **Setup**\n## Setup', 'setup')).toThrow('Earlier formatted heading may change anchor');
  });

  it('does not claim general Unicode or formatted-heading rendering', () => {
    expect(() => plainAnchor('A **formatted** heading')).toThrow('Unsupported plain ASCII heading');
    expect(() => plainAnchor('Résumé')).toThrow('Unsupported plain ASCII heading');
  });

  it('resolves every declared packaged Markdown fragment, including same-page navigation', async () => {
    const packageJson: unknown = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    if (!packageJson || typeof packageJson !== 'object' || !('files' in packageJson) ||
        !Array.isArray(packageJson.files) || !packageJson.files.every(entry => typeof entry === 'string')) {
      throw new Error('Package files must be an explicit string inventory.');
    }
    const files = new Set<string>();
    for (const entry of packageJson.files) {
      if (compiledPackageFiles.includes(entry)) continue;
      if (/[\\*?{}]/.test(entry) || path.posix.isAbsolute(entry) || entry.split('/').includes('..')) {
        throw new Error(`Unsupported nonliteral package inventory entry: ${entry}`);
      }
      for (const file of await markdownFiles(entry)) files.add(file);
    }
    let checked = 0;
    for (const file of files) {
      const markdown = await readFile(path.join(process.cwd(), file), 'utf8');
      for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
        const link = match[1];
        if (!link.includes('#') || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
        const [rawTarget, rawFragment, extra] = link.split('#');
        if (!rawFragment || extra !== undefined) throw new Error(`Unsupported fragment syntax: ${file} -> ${link}`);
        const fragment = decodeURIComponent(rawFragment);
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(fragment)) throw new Error(`Unsupported fragment: ${file} -> ${link}`);
        const target = rawTarget
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(rawTarget.split('?')[0])))
          : file;
        if (!files.has(target)) throw new Error(`Fragment target is not declared packaged Markdown: ${file} -> ${link}`);
        const content = await readFile(path.join(process.cwd(), target), 'utf8');
        try {
          requirePlainFragment(content, fragment);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          throw new Error(`${file} -> ${link}: ${error.message}`, { cause: error });
        }
        checked++;
      }
    }
    expect(files.has('README.md')).toBe(true);
    expect(checked).toBeGreaterThan(0);
  });
});

import { glob, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compiledPackageFiles } from '../src/plugins/builtin/assets.js';
import { commandDefinitions } from '../src/cli/args/definitions.js';
import { parseArgs, UsageError } from '../src/cli/args/parser.js';

interface Example {
  file: string;
  line: number;
  kind: 'inline' | 'fenced';
  text: string;
  context: string;
}

function examples(file: string, markdown: string): Example[] {
  const result: Example[] = [];
  const lines = markdown.split(/\r?\n/);
  const add = (line: number, kind: Example['kind'], text: string) => {
    result.push({ file, line, kind, text, context: lines.slice(Math.max(0, line - 9), line + 4).join('\n') });
  };
  for (const match of markdown.matchAll(/^```(?:bash|sh|shell|console|powershell)\r?\n([\s\S]*?)^```[ \t]*$/gm)) {
    const start = markdown.slice(0, match.index).split('\n').length + 1;
    const commands = match[1].split(/\r?\n/);
    for (let index = 0; index < commands.length; index++) {
      let text = commands[index].trim().replace(/^\$\s+/, '');
      const line = start + index;
      while (text.endsWith('\\')) {
        if (++index >= commands.length || !commands[index].trim()) throw new Error(`${file}:${line}: unfinished continuation`);
        text = `${text.slice(0, -1).trimEnd()} ${commands[index].trim()}`;
      }
      if (/^(?:liftoff(?:\s|$)|npx\s+(?:--yes\s+)?@msn-control\/liftoff(?:@\S+)?(?:\s|$))/.test(text)) {
        add(line, 'fenced', text);
      }
    }
  }
  const prose = markdown.replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g,
    fence => fence.replace(/[^\r\n]/g, ' '));
  for (const match of prose.matchAll(/(?<!`)`(liftoff(?: [^`\n]+)?)`(?!`)/g)) {
    add(prose.slice(0, match.index).split('\n').length, 'inline', match[1]);
  }
  return result;
}

function literalArguments(text: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else {
        if (quote === '"' && /[$`\\]/.test(character)) throw new Error('Unsupported quoted shell expansion or escape.');
        token += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else if (character === '#' && !started) {
      break;
    } else {
      if (/[$`\\;&|<>]/.test(character)) throw new Error('Unsupported shell expansion, escape or operator.');
      token += character;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quoted argument.');
  if (started) tokens.push(token);
  if (tokens[0] === 'liftoff') return tokens.slice(1);
  if (tokens[0] === 'npx') {
    const packageIndex = tokens[1] === '--yes' ? 2 : 1;
    if (/^@msn-control\/liftoff(?:@[A-Za-z0-9.+_-]+)?$/.test(tokens[packageIndex] ?? '')) {
      return tokens.slice(packageIndex + 1);
    }
  }
  throw new Error('Unsupported command wrapper.');
}

function checkNotationVocabulary(text: string): void {
  const body = text.replace(/^npx\s+(?:--yes\s+)?@msn-control\/liftoff(?:@\S+)?\s+/, 'liftoff ')
    .replace(/^liftoff\s+/, '');
  const [command, subcommand] = body.split(/\s+/);
  if (command === '<command>') return;
  const definition = commandDefinitions[command];
  if (!definition) throw new Error(`Unknown notation command: ${command}`);
  if (definition.subcommands && subcommand && !/^[<[-]/.test(subcommand) &&
      !definition.subcommands.includes(subcommand)) {
    throw new Error(`Unknown notation subcommand: ${subcommand}`);
  }
  for (const match of body.matchAll(/--([a-z][a-z0-9-]*)/g)) {
    const rawName = match[1];
    const negated = rawName.startsWith('no-');
    const flag = definition.flags[negated ? rawName.slice(3) : rawName];
    if (!flag || (negated && !flag.negatable)) throw new Error(`Unknown notation flag: --${rawName}`);
  }
}

function disposition(example: Example): 'literal' | 'notation' | 'partial' | 'negative' | 'alternation' | 'redirect' {
  const negative = new Map([
    ['liftoff setup', /not a `liftoff setup`/],
    ['liftoff create', /(?:intentionally rejected|`liftoff create` is rejected)/],
    ['liftoff -repair', /not a `liftoff setup`[\s\S]*?`liftoff -repair`/],
    ['liftoff update --apply', /historical 0\.6\.x commands,[\s\S]*?not current syntax/],
    ['liftoff update --apply --force', /historical 0\.6\.x commands,[\s\S]*?not current syntax/]
  ]).get(example.text);
  if (negative) {
    if (example.kind !== 'inline' || !negative.test(example.context)) {
      throw new Error('Unsupported command is not explicitly contextualized as negative or historical.');
    }
    expect(() => parseArgs(literalArguments(example.text))).toThrow(UsageError);
    return 'negative';
  }
  if (example.kind === 'inline' && [
    'liftoff governance approve', 'liftoff workflow set', 'liftoff repair --agents'
  ].includes(example.text)) {
    expect(() => parseArgs(literalArguments(example.text))).toThrow(UsageError);
    return 'partial';
  }
  const alternation = example.text.match(/^liftoff governance ([a-z-]+(?:\|[a-z-]+)+)$/);
  if (alternation && example.kind === 'inline') {
    for (const subcommand of alternation[1].split('|')) {
      expect(commandDefinitions.governance.subcommands).toContain(subcommand);
      expect(parseArgs(['governance', subcommand]).subcommand).toBe(subcommand);
    }
    return 'alternation';
  }
  if (/<[^>]+>|\.\.\.|\$|[\[\]]|--[a-z-]+\/--[a-z-]+/.test(example.text)) {
    checkNotationVocabulary(example.text);
    return 'notation';
  }
  const redirect = example.text.match(/^(.+?) > ([A-Za-z0-9._/-]+)$/);
  if (redirect) {
    parseArgs(literalArguments(redirect[1]));
    return 'redirect';
  }
  parseArgs(literalArguments(example.text));
  return 'literal';
}

describe('packaged documented command examples', () => {
  it('preserves quoted paths, inline flag values and comments without running a shell', () => {
    const argv = literalArguments('liftoff assess --project="./existing application" --json # explanation');
    expect(argv).toEqual(['assess', '--project=./existing application', '--json']);
    expect(parseArgs(argv).flags.project).toBe('./existing application');
    expect(literalArguments("liftoff assess './existing application'")).toEqual(['assess', './existing application']);
  });

  it('recognizes only the declared npx wrappers as current argument syntax, not published-version qualification', () => {
    expect(literalArguments('npx --yes @msn-control/liftoff@latest doctor')).toEqual(['doctor']);
    expect(literalArguments('npx @msn-control/liftoff@0.12.0 capabilities --json')).toEqual(['capabilities', '--json']);
    expect(() => literalArguments('npx --package other liftoff doctor')).toThrow('Unsupported command wrapper');
  });

  it('extracts continued fenced commands and inline prose once with exact locations', () => {
    const markdown = '# Example\n```bash\n$ liftoff assess \\\n  --project "./existing application" --json\n```\nUse `liftoff doctor`.\n';
    const found = examples('example.md', markdown);
    expect(found.map(({ line, kind, text }) => ({ line, kind, text }))).toEqual([
      { line: 3, kind: 'fenced', text: 'liftoff assess --project "./existing application" --json' },
      { line: 6, kind: 'inline', text: 'liftoff doctor' }
    ]);
    expect(parseArgs(literalArguments(found[0].text)).flags.project).toBe('./existing application');
    expect(() => examples('example.md', '```bash\nliftoff assess \\\n```')).toThrow('unfinished continuation');
  });

  it.each([
    'liftoff doctor; echo success', 'liftoff doctor && echo success', 'liftoff doctor | cat',
    'liftoff doctor > report.json', 'liftoff assess $(pwd)', 'liftoff assess "$PROJECT"',
    'liftoff assess "unclosed', 'liftoff assess path\\ with\\ spaces'
  ])('refuses unsupported literal shell syntax: %s', text => {
    expect(() => literalArguments(text)).toThrow();
  });

  it('does not accept unknown commands or flags hidden behind notation', () => {
    expect(() => checkNotationVocabulary('liftoff invented <project>')).toThrow('Unknown notation command');
    expect(() => checkNotationVocabulary('liftoff governance invented [project]')).toThrow('Unknown notation subcommand');
    expect(() => checkNotationVocabulary('liftoff assess <project> [--invented-option]')).toThrow('Unknown notation flag');
    expect(() => checkNotationVocabulary('liftoff assess <project> [--no-json]')).toThrow('Unknown notation flag');
  });

  it('does not turn a partial command family or unsupported fenced command into a passing literal example', () => {
    const example: Example = { file: 'example.md', line: 1, kind: 'fenced', text: 'liftoff workflow set', context: '' };
    expect(() => disposition(example)).toThrow(UsageError);
    expect(() => disposition({ ...example, text: 'liftoff setup' })).toThrow('not explicitly contextualized');
    expect(() => disposition({ ...example, text: 'liftoff doctor project' })).toThrow(UsageError);
    expect(() => disposition({ ...example, kind: 'inline', text: 'liftoff setup' })).toThrow('not explicitly contextualized');
  });

  it('checks only the argument prefix of a closed output-redirection example without claiming a file write', () => {
    const example: Example = { file: 'example.md', line: 1, kind: 'inline', text: 'liftoff doctor > readiness.txt', context: '' };
    expect(disposition(example)).toBe('redirect');
    expect(() => disposition({ ...example, text: 'liftoff doctor --invented-option > readiness.txt' })).toThrow(UsageError);
    expect(() => disposition({ ...example, text: 'liftoff doctor > readiness.txt && echo success' })).toThrow();
  });

  it('checks every selected packaged inline or fenced example, keeping notation and contextual refusals distinct', async () => {
    const root = process.cwd();
    const packageJson: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (!packageJson || typeof packageJson !== 'object' || !('files' in packageJson) ||
        !Array.isArray(packageJson.files) || !packageJson.files.every(entry => typeof entry === 'string')) {
      throw new Error('Package files must be an explicit string inventory.');
    }
    const patterns = packageJson.files.flatMap(entry => {
      if (compiledPackageFiles.includes(entry)) return [];
      if (/[\\*?{}]/.test(entry) || path.posix.isAbsolute(entry) || entry.split('/').includes('..')) {
        throw new Error(`Unsupported nonliteral package inventory entry: ${entry}`);
      }
      return [entry.endsWith('.md') ? entry : `${entry}/**/*.md`];
    });
    const files = new Set<string>();
    for await (const file of glob(patterns, { cwd: root })) files.add(file);
    const counts = { literal: 0, notation: 0, partial: 0, negative: 0, alternation: 0, redirect: 0 };
    for (const file of files) {
      if ((await lstat(path.join(root, file))).isSymbolicLink()) throw new Error(`Linked packaged Markdown: ${file}`);
      const markdown = await readFile(path.join(root, file), 'utf8');
      for (const example of examples(file, markdown)) {
        try {
          counts[disposition(example)]++;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          throw new Error(`${example.file}:${example.line}: ${example.text}: ${error.message}`, { cause: error });
        }
      }
    }
    expect(files.has('README.md')).toBe(true);
    expect(files.has('docs/cli-reference.md')).toBe(true);
    expect(counts.literal).toBeGreaterThan(0);
    expect(counts.notation).toBeGreaterThan(0);
    expect(counts.partial).toBeGreaterThan(0);
    expect(counts.negative).toBeGreaterThan(0);
    expect(counts.alternation).toBeGreaterThan(0);
    expect(counts.redirect).toBeGreaterThan(0);
  });
});

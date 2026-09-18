import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { parseStrictManifestJson } from '../../../domain/project/manifest/json.js';
import type { AssessmentInventory, AssessmentTarget, FileObservation } from '../../../domain/standards-assessment/types.js';
import { assessmentEvidenceBounds, type ExtractedEvidence, type DependencyObservation, type StaticRouteObservation } from '../../../domain/standards-assessment/evaluation.js';
import { containsSensitiveText } from '../../../domain/standards-assessment/sanitizer.js';

type Framework = 'fastapi' | 'fastify' | 'go-huma' | 'vue' | 'genai' | 'express' | 'flask' | 'django' | 'unknown';
type Language = 'javascript' | 'python' | 'go';
interface Token { kind: 'word' | 'string' | 'symbol' | 'newline'; text: string; value?: string; line: number; start: number; end: number }
interface SourceAnalysis {
  file: FileObservation;
  tokens: Token[];
  matching: Map<number, number>;
  imports: Map<string, { module: string; member?: string; typeOnly?: boolean }>;
  receivers: Map<string, { framework: Framework | 'chi'; prefix: string; router: boolean }>;
  frameworks: Set<Framework>;
  routes: StaticRouteObservation[];
  limitations: string[];
  vueComponent: boolean;
  vueMount: boolean;
  mountedComponents: string[];
  viteConfig: boolean;
  tailwindConfig: boolean;
  omittedRoutes: number;
}
interface Declaration {
  file: FileObservation;
  root: string;
  ecosystem: 'npm' | 'python' | 'go';
  dependencies: Map<string, string>;
  parsed?: Record<string, unknown>;
  issue?: string;
}

export interface FrameworkDetectionResult {
  detectedFramework: Framework;
  isSupported: boolean;
  profileId: string | null;
  componentRoot?: string;
  status?: 'observed' | 'unobserved' | 'conflicting';
  evidence: { declarationFile?: string; sourceFile?: string; details: string };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const beneath = (file: string, root: string) => root === '.' || file === root || file.startsWith(`${root}/`);
const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, '-');
const npmIntegrity = /^(?:sha512-[A-Za-z0-9+/]{86}==|sha384-[A-Za-z0-9+/]{64}|sha256-[A-Za-z0-9+/]{43}=|sha1-[A-Za-z0-9+/]{27}=)$/u;
const sourceLanguage = (file: string): Language | undefined => file.endsWith('.py') ? 'python' :
  file.endsWith('.go') ? 'go' : /\.(?:[cm]?[jt]sx?)$/u.test(file) ? 'javascript' : undefined;

function capturedFiles(inventory: AssessmentInventory): FileObservation[] {
  return [...inventory.files].filter((file) => !file.unstable && inventory.contentMap?.has(file.path)).sort((a, b) => ordered(a.path, b.path));
}

function goLiteral(raw: string, quote: string): string | undefined {
  if (quote === '`') return raw.replaceAll('\r', '');
  if (quote !== '"' || /[\n\u0000]/u.test(raw)) return undefined;
  if (!raw.includes('\\')) return raw;
  const escapes: Readonly<Record<string, number>> = {
    a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34
  };
  const bytes = Buffer.alloc(Buffer.byteLength(raw));
  let length = 0, start = 0, cursor = 0;
  while (cursor < raw.length) {
    if (raw[cursor] !== '\\') { cursor++; continue; }
    length += bytes.write(raw.slice(start, cursor), length, 'utf8');
    const escaped = raw[cursor + 1];
    if (escaped === undefined) return undefined;
    const simple = escapes[escaped];
    if (simple !== undefined) {
      bytes[length++] = simple;
      cursor += 2;
    } else {
      const octal = /^[0-7]$/u.test(escaped);
      const width = octal ? 3 : escaped === 'x' ? 2 : escaped === 'u' ? 4 : escaped === 'U' ? 8 : 0;
      if (!width) return undefined;
      const offset = cursor + (octal ? 1 : 2);
      const digits = raw.slice(offset, offset + width);
      if (digits.length !== width || !(octal ? /^[0-7]+$/u : /^[a-fA-F0-9]+$/u).test(digits)) return undefined;
      const value = Number.parseInt(digits, octal ? 8 : 16);
      if (octal || escaped === 'x') {
        if (value > 255) return undefined;
        bytes[length++] = value;
      } else {
        if (value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) return undefined;
        length += bytes.write(String.fromCodePoint(value), length, 'utf8');
      }
      cursor = offset + width;
    }
    start = cursor;
  }
  length += bytes.write(raw.slice(start), length, 'utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
  catch { return undefined; }
}

function literal(raw: string, quote: string, language: Language): string | undefined {
  if (language === 'go') return goLiteral(raw, quote);
  if (!raw.includes('\\')) return raw;
  try {
    if (quote === '"') return JSON.parse(`"${raw}"`);
  } catch { return undefined; }
  if (/\\(?![\\'"nrt])/u.test(raw)) return undefined;
  return raw.replace(/\\([\\'"nrt])/gu, (_, value: string) => ({ n: '\n', r: '\r', t: '\t' }[value] ?? value));
}

function tokenize(source: string, language: Language): Token[] {
  const tokens: Token[] = [];
  let cursor = 0, line = 1;
  const advance = (end: number) => {
    for (; cursor < end; cursor++) if (source[cursor] === '\n') line++;
  };
  const quotedEnd = (start: number, delimiter: string, raw: boolean): number => {
    let index = start + delimiter.length;
    while (index < source.length) {
      if (!raw && source[index] === '\\') { index += 2; continue; }
      if (source.startsWith(delimiter, index)) return index + delimiter.length;
      index++;
    }
    throw new Error('Unterminated source literal');
  };
  const templateEnd = (start: number, nesting = 0): number => {
    if (nesting >= 128) throw new Error('Template nesting budget exceeded');
    for (let index = start + 1; index < source.length; index++) {
      if (source[index] === '\\') { index++; continue; }
      if (source[index] === '`') return index + 1;
      if (!source.startsWith('${', index)) continue;
      let depth = 1;
      index += 2;
      for (; index < source.length && depth; index++) {
        const char = source[index]!;
        if (char === '"' || char === "'") { index = quotedEnd(index, char, false) - 1; continue; }
        if (char === '`') { index = templateEnd(index, nesting + 1) - 1; continue; }
        if (source.startsWith('/*', index)) {
          const end = source.indexOf('*/', index + 2);
          if (end < 0) throw new Error('Unterminated template comment');
          index = end + 1;
          continue;
        }
        if (source.startsWith('//', index)) {
          const end = source.indexOf('\n', index + 2);
          if (end < 0) throw new Error('Unterminated template expression');
          index = end;
          continue;
        }
        if (char === '{') depth++;
        if (char === '}') depth--;
        if (char === '/') throw new Error('Unsupported template expression syntax');
      }
      if (depth) throw new Error('Unterminated template expression');
      index--;
    }
    throw new Error('Unterminated template');
  };
  while (cursor < source.length) {
    if (tokens.length >= 200_000) throw new Error('Source token budget exceeded');
    const start = cursor, first = source[cursor]!, startLine = line;
    if (/[ \t\r\f]/u.test(first)) { cursor++; continue; }
    if (first === '\n') { tokens.push({ kind: 'newline', text: '\n', start, end: ++cursor, line: line++ }); continue; }
    if (language === 'python' && first === '#' || language !== 'python' && source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor);
      advance(end < 0 ? source.length : end);
      continue;
    }
    if (language !== 'python' && source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) throw new Error('Unterminated source comment');
      advance(end + 2);
      continue;
    }
    if (language === 'javascript' && first === '`') {
      const end = templateEnd(cursor);
      tokens.push({ kind: 'string', text: source.slice(start, end), start, end, line: startLine });
      advance(end);
      continue;
    }
    if (language === 'javascript' && first === '/' && !source.startsWith('/=', cursor)) {
      let previous: Token | undefined;
      for (let index = tokens.length - 1; index >= 0; index--) if (tokens[index]!.kind !== 'newline') { previous = tokens[index]; break; }
      if (previous?.text === '}' || previous?.text === ')') throw new Error('Ambiguous slash expression requires unsupported syntax analysis');
      if (!previous || ['=', '(', '[', '{', ',', ':', ';', 'return', '=>', '!', '?', '&&', '||'].includes(previous.text)) {
        let end = cursor + 1, characterClass = false;
        for (; end < source.length; end++) {
          if (source[end] === '\\') { end++; continue; }
          if (source[end] === '[') characterClass = true;
          if (source[end] === ']') characterClass = false;
          if (source[end] === '/' && !characterClass) break;
          if (source[end] === '\n') throw new Error('Unsupported regular-expression source');
        }
        if (end === source.length) throw new Error('Unterminated regular expression');
        while (/[A-Za-z]/u.test(source[end + 1] ?? '')) end++;
        tokens.push({ kind: 'string', text: source.slice(start, end + 1), start, end: end + 1, line: startLine });
        advance(end + 1);
        continue;
      }
    }
    if (first === '"' || first === "'" || language === 'go' && first === '`') {
      const triple = language === 'python' && source.startsWith(first.repeat(3), cursor);
      const delimiter = triple ? first.repeat(3) : first;
      const end = quotedEnd(cursor, delimiter, first === '`');
      const raw = source.slice(cursor + delimiter.length, end - delimiter.length);
      tokens.push({
        kind: 'string', text: source.slice(cursor, end), start, end, line: startLine,
        ...(!triple && !(language === 'go' && first === "'") ? { value: literal(raw, first, language) } : {})
      });
      advance(end);
      continue;
    }
    if (/[A-Za-z_$]/u.test(first)) {
      cursor++;
      while (/[A-Za-z0-9_$]/u.test(source[cursor] ?? '')) cursor++;
      tokens.push({ kind: 'word', text: source.slice(start, cursor), start, end: cursor, line: startLine });
      continue;
    }
    const double = source.slice(cursor, cursor + 2);
    const text = [':=', '=>', '==', '!=', '>=', '<=', '&&', '||', '?.'].includes(double) ? double : first;
    cursor += text.length;
    tokens.push({ kind: 'symbol', text, start, end: cursor, line: startLine });
  }
  return tokens;
}

function pairs(tokens: readonly Token[]): Map<number, number> {
  const stack: number[] = [], matched = new Map<number, number>();
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'symbol') continue;
    if ('([{'.includes(token.text)) {
      if (stack.length >= 128) throw new Error('Source nesting budget exceeded');
      stack.push(index);
    } else if (')]}'.includes(token.text)) {
      const open = stack.pop();
      if (open === undefined || '([{'.indexOf(tokens[open]!.text) !== ')]}'.indexOf(token.text)) throw new Error('Unbalanced source syntax');
      matched.set(open, index);
    }
  }
  if (stack.length) throw new Error('Unbalanced source syntax');
  return matched;
}

function moduleFramework(module: string): Framework | 'chi' | undefined {
  if (module === 'fastify') return 'fastify';
  if (module === 'express') return 'express';
  if (module === 'vue') return 'vue';
  if (module === 'fastapi') return 'fastapi';
  if (module === 'flask') return 'flask';
  if (module === 'django' || module.startsWith('django.')) return 'django';
  if (module === 'pydantic_ai') return 'genai';
  if (module === 'github.com/danielgtaylor/huma/v2' ||
      module === 'github.com/danielgtaylor/huma/v2/adapters/humachi') return 'go-huma';
  if (module === 'github.com/go-chi/chi/v5') return 'chi';
  return undefined;
}

const goKeywords = new Set([
  'break', 'default', 'func', 'interface', 'select', 'case', 'defer', 'go', 'map', 'struct',
  'chan', 'else', 'goto', 'package', 'switch', 'const', 'fallthrough', 'if', 'range', 'type',
  'continue', 'for', 'import', 'return', 'var'
]);

function goImports(tokens: readonly Token[], matching: ReadonlyMap<number, number>): SourceAnalysis['imports'] {
  const found: SourceAnalysis['imports'] = new Map();
  let cursor = 0;
  const skipNewlines = () => { while (tokens[cursor]?.kind === 'newline') cursor++; };
  const identifier = (token: Token | undefined): token is Token =>
    token?.kind === 'word' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token.text) && !goKeywords.has(token.text);
  const separator = (last: Token, closing = false) => {
    const next = tokens[cursor];
    if (next?.kind === 'symbol' && next.text === ';') { cursor++; skipNewlines(); return; }
    if (!next || closing && next.kind === 'symbol' && next.text === ')') return;
    // A newline inside a block comment also inserts a Go semicolon here.
    if (next.kind === 'newline' || next.line > last.line) { skipNewlines(); return; }
    throw new Error('Missing Go declaration separator');
  };
  const specification = (): Token => {
    let alias: string | undefined;
    const first = tokens[cursor];
    if (first?.kind !== 'string') {
      if (first?.kind === 'symbol' && first.text === '.') {
        alias = first.text;
        cursor++;
        skipNewlines();
      } else {
        if (!identifier(first)) throw new Error('Malformed Go import alias');
        alias = first.text;
        cursor++;
        if (tokens[cursor]?.kind === 'newline' || (tokens[cursor]?.line ?? first.line) > first.line) {
          throw new Error('Go import alias is separated from its path');
        }
      }
    }
    const imported = tokens[cursor++];
    if (imported?.kind !== 'string' || !imported.value || /[\s\\\u0000-\u001f\u007f]/u.test(imported.value)) {
      throw new Error('Malformed Go import path');
    }
    const module = imported.value;
    const name = alias ?? (module === 'github.com/danielgtaylor/huma/v2' ? 'huma' :
      module === 'github.com/go-chi/chi/v5' ? 'chi' : path.posix.basename(module));
    if (name !== '_' && name !== '.') {
      if (found.has(name)) throw new Error('Conflicting Go import bindings');
      found.set(name, { module });
    }
    return imported;
  };
  skipNewlines();
  if (tokens[cursor]?.kind !== 'word' || tokens[cursor++]?.text !== 'package' || !identifier(tokens[cursor])) {
    throw new Error('Missing Go package declaration');
  }
  separator(tokens[cursor++]!);
  while (tokens[cursor]?.kind === 'word' && tokens[cursor]?.text === 'import') {
    cursor++;
    skipNewlines();
    if (tokens[cursor]?.kind === 'symbol' && tokens[cursor]?.text === '(') {
      const end = matching.get(cursor);
      if (end === undefined) throw new Error('Incomplete Go import block');
      cursor++;
      skipNewlines();
      while (cursor < end) separator(specification(), true);
      if (cursor !== end) throw new Error('Malformed Go import block');
      separator(tokens[cursor++]!);
    } else {
      separator(specification());
    }
  }
  if (tokens.slice(cursor).some((token) => token.kind === 'word' && token.text === 'import')) {
    throw new Error('Go import declarations must precede other declarations');
  }
  return found;
}

function imports(tokens: Token[], language: Language, matching: Map<number, number>): SourceAnalysis['imports'] {
  if (language === 'go') return goImports(tokens, matching);
  const found: SourceAnalysis['imports'] = new Map();
  const add = (alias: string | undefined, module: string | undefined, member?: string, typeOnly = false) => {
    if (alias && module && alias !== '_' && alias !== '.') found.set(alias, { module, member, typeOnly });
  };
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === 'symbol' && token.text === '{') depth++;
    if (token.kind === 'symbol' && token.text === '}') depth--;
    if (language === 'javascript' && token.text === 'import' && token.kind === 'word' && depth === 0 && tokens[index + 1]?.text !== '(') {
      let cursor = index + 1, typeOnly = false;
      if (tokens[cursor]?.text === 'type') { typeOnly = true; cursor++; }
      const from = tokens.findIndex((entry, pos) => pos >= cursor && entry.kind === 'word' && entry.text === 'from');
      if (from < 0 || tokens[from + 1]?.kind !== 'string' || tokens.slice(cursor, from).some((entry) => entry.text === ';')) continue;
      const module = tokens[from + 1]!.value;
      if (tokens[cursor]?.kind === 'word') add(tokens[cursor]!.text, module, 'default', typeOnly);
      if (tokens[cursor]?.text === '*' && tokens[cursor + 1]?.text === 'as') add(tokens[cursor + 2]?.text, module, undefined, typeOnly);
      const open = tokens.findIndex((entry, pos) => pos >= cursor && pos < from && entry.text === '{');
      if (open >= 0) {
        for (let item = open + 1; item < from && tokens[item]?.text !== '}'; item++) {
          if (tokens[item]?.kind !== 'word' || tokens[item]?.text === 'type') continue;
          const member = tokens[item]!.text;
          const alias = tokens[item + 1]?.text === 'as' ? tokens[item + 2]?.text : member;
          add(alias, module, member, typeOnly || tokens[item - 1]?.text === 'type');
          if (tokens[item + 1]?.text === 'as') item += 2;
        }
      }
      index = from + 1;
    }
    if (language === 'javascript' && ['const', 'let', 'var'].includes(token.text) &&
        tokens[index + 1]?.kind === 'word' && tokens[index + 2]?.text === '=' &&
        tokens[index + 3]?.text === 'require' && tokens[index + 4]?.text === '(' && tokens[index + 5]?.kind === 'string') {
      add(tokens[index + 1]!.text, tokens[index + 5]!.value, 'default');
    }
    if (language === 'python' && (index === 0 || tokens[index - 1]?.kind === 'newline' || tokens[index - 1]?.text === ';')) {
      if (token.text === 'from') {
        let cursor = index + 1, module = '';
        while (cursor < tokens.length && tokens[cursor]!.text !== 'import' && tokens[cursor]!.kind !== 'newline') module += tokens[cursor++]!.text;
        if (tokens[cursor]?.text !== 'import') continue;
        cursor++;
        const parenthesized = tokens[cursor]?.text === '(';
        const end = parenthesized ? matching.get(cursor)! : tokens.findIndex((entry, pos) => pos >= cursor && entry.kind === 'newline');
        if (parenthesized) cursor++;
        for (; cursor < (end < 0 ? tokens.length : end); cursor++) {
          if (tokens[cursor]?.kind !== 'word') continue;
          const member = tokens[cursor]!.text;
          const alias = tokens[cursor + 1]?.text === 'as' ? tokens[cursor + 2]?.text : member;
          add(alias, module, member);
          if (tokens[cursor + 1]?.text === 'as') cursor += 2;
        }
      } else if (token.text === 'import') {
        for (let cursor = index + 1; cursor < tokens.length && tokens[cursor]?.kind !== 'newline'; cursor++) {
          if (tokens[cursor]?.kind !== 'word') continue;
          let module = tokens[cursor]!.text;
          while (tokens[cursor + 1]?.text === '.' && tokens[cursor + 2]?.kind === 'word') { module += `.${tokens[cursor + 2]!.text}`; cursor += 2; }
          const alias = tokens[cursor + 1]?.text === 'as' ? tokens[cursor + 2]?.text : module.split('.')[0];
          add(alias, module);
          if (tokens[cursor + 1]?.text === 'as') cursor += 2;
        }
      }
    }
  }
  return found;
}

function argumentsAt(tokens: Token[], matching: Map<number, number>, open: number): Token[][] {
  const end = matching.get(open);
  if (end === undefined) return [];
  const values: Token[][] = [];
  let start = open + 1;
  for (let index = start; index < end; index++) {
    if (matching.has(index)) { index = matching.get(index)!; continue; }
    if (tokens[index]!.text === ',') { values.push(tokens.slice(start, index).filter((token) => token.kind !== 'newline')); start = index + 1; }
  }
  values.push(tokens.slice(start, end).filter((token) => token.kind !== 'newline'));
  return values;
}

function literalProperty(tokens: readonly Token[], key: string, separator: ':' | '='): string | undefined {
  const open = tokens.findIndex((token) => token.kind === 'symbol' && token.text === '{');
  const baseDepth = open >= 0 && open <= 3 ? 1 : 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === 'symbol' && '([{'.includes(token.text)) depth++;
    if (token.kind === 'symbol' && ')]}'.includes(token.text)) depth--;
    if (depth > baseDepth) continue;
    if ((token.kind === 'word' && token.text === key || token.kind === 'string' && token.value === key) &&
        tokens[index + 1]?.text === separator && tokens[index + 2]?.kind === 'string') return tokens[index + 2]!.value;
  }
  return undefined;
}

function objectProperty(tokens: Token[], key: string): Token[] {
  if (tokens[0]?.text !== '{') return [];
  const matching = pairs(tokens);
  for (let index = 1; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    if ((token.kind === 'word' && token.text === key || token.kind === 'string' && token.value === key) &&
        tokens[index + 1]?.text === ':') {
      const start = index + 2;
      if (matching.has(start)) return tokens.slice(start, matching.get(start)! + 1);
      let end = start;
      while (end < tokens.length - 1 && tokens[end]?.text !== ',') end++;
      return tokens.slice(start, end);
    }
    if (matching.has(index)) index = matching.get(index)!;
  }
  return [];
}

function assignmentTarget(tokens: readonly Token[], expression: number): string | undefined {
  if (!['=', ':='].includes(tokens[expression - 1]?.text ?? '')) return undefined;
  let start = expression - 2;
  const line = tokens[start]?.line;
  while (start > 0 && tokens[start - 1]!.line === line && ![';', '{', '}'].includes(tokens[start - 1]!.text)) start--;
  if (['export', 'const', 'let', 'var'].includes(tokens[start]?.text ?? '')) {
    while (['export', 'const', 'let', 'var'].includes(tokens[start]?.text ?? '')) start++;
  }
  return tokens[start]?.kind === 'word' && tokens[start + 1]?.text !== '.' ? tokens[start]!.text : undefined;
}

function removeShadowedImports(analysis: SourceAnalysis, tokens: Token[]): void {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const binding = token.kind === 'word' ? analysis.imports.get(token.text) : undefined;
    if (binding && ['=', ':='].includes(tokens[index + 1]?.text ?? '')) {
      const actualRequire = tokens[index + 2]?.text === 'require' && tokens[index + 3]?.text === '(' &&
        tokens[index + 4]?.kind === 'string' && tokens[index + 4]?.value === binding.module;
      if (!actualRequire) analysis.imports.delete(token.text);
    }
    if (!['func', 'function', 'def'].includes(token.text)) continue;
    if (tokens[index + 1]?.kind === 'word') analysis.imports.delete(tokens[index + 1]!.text);
    let open = index + 1;
    while (open < tokens.length && !['(', '{', ';', ':'].includes(tokens[open]!.text)) open++;
    if (tokens[open]?.text !== '(') continue;
    for (const parameter of argumentsAt(tokens, analysis.matching, open)) {
      const name = parameter[0]?.kind === 'word' ? parameter[0].text : undefined;
      if (name) analysis.imports.delete(name);
      const type = parameter[1]?.text === ':' ? parameter[2]?.text : undefined;
      if (name && type && analysis.imports.get(type)?.module === 'fastify' && analysis.imports.get(type)?.member === 'FastifyInstance') {
        analysis.receivers.set(name, { framework: 'fastify', prefix: '', router: false });
      }
    }
  }
}

function responseParameter(handler: Token[]): string | undefined {
  let open = 0;
  if (handler[open]?.text === 'async') open++;
  if (handler[open]?.text === 'function') {
    open++;
    if (handler[open]?.kind === 'word') open++;
  }
  if (handler[open]?.text !== '(') return undefined;
  const args = argumentsAt(handler, pairs(handler), open);
  return args[1]?.[0]?.kind === 'word' ? args[1][0].text : undefined;
}

function isVueComponent(content: string): boolean {
  let remaining = content.trim().replace(/^\uFEFF/u, ''), template = false;
  while (remaining) {
    if (remaining.startsWith('<!--')) {
      const end = remaining.indexOf('-->');
      if (end < 0) return false;
      remaining = remaining.slice(end + 3).trim();
      continue;
    }
    const open = /^<(template|script|style)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/u.exec(remaining);
    if (!open) return false;
    const end = remaining.indexOf(`</${open[1]}>`, open[0].length);
    if (end < 0) return false;
    if (open[1] === 'template') template = true;
    remaining = remaining.slice(end + open[1]!.length + 3).trim();
  }
  return template;
}

function analyzeSource(file: FileObservation, content: string): SourceAnalysis {
  const analysis: SourceAnalysis = {
    file, tokens: [], matching: new Map(), imports: new Map(), receivers: new Map(), frameworks: new Set(),
    routes: [], limitations: [], vueComponent: false, vueMount: false, mountedComponents: [], viteConfig: false, tailwindConfig: false,
    omittedRoutes: 0
  };
  const addRoute = (route: StaticRouteObservation) => {
    if (route.path.length > assessmentEvidenceBounds.factStringCharacters || containsSensitiveText(route.path) ||
        /[\u0000-\u001f\u007f-\u009f\\]/u.test(route.path) || analysis.routes.length >= assessmentEvidenceBounds.routesPerSource) {
      analysis.omittedRoutes++;
      return;
    }
    analysis.routes.push(route);
  };
  if (file.path.endsWith('.vue')) { analysis.vueComponent = isVueComponent(content); return analysis; }
  const language = sourceLanguage(file.path);
  if (!language) return analysis;
  try {
    if (/\.[jt]sx$/u.test(file.path)) throw new Error('JSX source requires an unsupported structural parser');
    const stream = tokenize(content, language);
    analysis.matching = pairs(stream);
    const importTokens = language === 'javascript' ? stream.filter((token) => token.kind !== 'newline') : stream;
    analysis.imports = imports(importTokens, language, pairs(importTokens));
    // Newlines delimit Python/Go imports; expression matching otherwise treats whitespace uniformly.
    const tokens = stream.filter((token) => token.kind !== 'newline');
    if (language === 'go' && (tokens[0]?.text !== 'package' || tokens[1]?.kind !== 'word')) throw new Error('Missing Go package declaration');
    analysis.tokens = tokens;
    const matching = pairs(tokens);
    analysis.matching = matching;
    removeShadowedImports(analysis, tokens);
    const vueInstances = new Map<string, string>();
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.kind !== 'word') continue;
      const binding = analysis.imports.get(token.text);
      const selector = tokens[index + 1]?.text === '.' ? tokens[index + 2]?.text : binding?.member;
      let open = index + (tokens[index + 1]?.text === '.' ? 3 : 1);
      if (tokens[open]?.text === '[') open = (matching.get(open) ?? open) + 1;
      if (tokens[open]?.text !== '(' || !binding || binding.typeOnly) continue;
      const framework = moduleFramework(binding.module);
      const factory = framework === 'fastify' && ['default', 'fastify', 'Fastify'].includes(selector ?? 'default') ||
        framework === 'express' && ['default', 'Router'].includes(selector ?? '') ||
        framework === 'fastapi' && ['FastAPI', 'APIRouter'].includes(selector ?? '') ||
        framework === 'flask' && selector === 'Flask' ||
        framework === 'django' && ['setup', 'get_wsgi_application', 'get_asgi_application'].includes(selector ?? '') ||
        framework === 'genai' && selector === 'Agent' ||
        framework === 'vue' && selector === 'createApp' ||
        framework === 'chi' && selector === 'NewRouter' ||
        framework === 'go-huma' && ['New', 'Register', 'AutoRegister', 'DefaultConfig', 'NewContext', 'Get', 'Post', 'Put', 'Patch', 'Delete'].includes(selector ?? '');
      if (factory && framework && framework !== 'chi') analysis.frameworks.add(framework);
      if (binding.module === 'vite' && selector === 'defineConfig') {
        const configuration = argumentsAt(tokens, matching, open)[0] ?? [];
        analysis.viteConfig ||= configuration[0]?.text === '{';
        const plugins = objectProperty(configuration, 'plugins');
        analysis.tailwindConfig ||= plugins.some((plugin, offset) => plugin.kind === 'word' &&
          analysis.imports.get(plugin.text)?.module === '@tailwindcss/vite' && plugins[offset + 1]?.text === '(');
      }
      if (!factory || !framework) continue;
      const assigned = assignmentTarget(tokens, index);
      if (assigned) analysis.receivers.set(assigned, {
        framework, prefix: literalProperty(argumentsAt(tokens, matching, open).flat(), 'prefix', '=') ?? '',
        router: selector === 'APIRouter' || framework === 'chi'
      });
      if (framework === 'vue') {
        const component = argumentsAt(tokens, matching, open)[0];
        const imported = component?.length === 1 ? analysis.imports.get(component[0]!.text)?.module : undefined;
        const componentPath = imported?.startsWith('.') && imported.endsWith('.vue')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file.path), imported)) : undefined;
        if (assigned && componentPath) vueInstances.set(assigned, componentPath);
        const end = matching.get(open);
        if (componentPath && end !== undefined && tokens[end + 1]?.text === '.' && tokens[end + 2]?.text === 'mount' && tokens[end + 3]?.text === '(') {
          analysis.vueMount = true;
          analysis.mountedComponents.push(componentPath);
        }
      }
    }
    for (let index = 0; index < tokens.length; index++) {
      const receiver = tokens[index]!;
      if (receiver.kind !== 'word' || tokens[index + 1]?.text !== '.' || tokens[index + 3]?.text !== '(') continue;
      const name = tokens[index + 2]!.text, args = argumentsAt(tokens, matching, index + 3);
      if (name === 'mount' && vueInstances.has(receiver.text)) {
        analysis.vueMount = true;
        analysis.mountedComponents.push(vueInstances.get(receiver.text)!);
      }
      const instance = analysis.receivers.get(receiver.text);
      let route: string | undefined;
      if (instance && ['get', 'head', 'post', 'put', 'delete', 'patch', 'api_route', 'add_api_route', 'Get', 'Head', 'Post'].includes(name)) {
        route = args[0]?.length === 1 && args[0][0]?.kind === 'string' ? args[0][0].value : undefined;
      } else if (instance && name === 'route') route = literalProperty(args[0] ?? [], 'url', ':');
      else {
        const imported = analysis.imports.get(receiver.text);
        if (imported?.module === 'github.com/danielgtaylor/huma/v2' && name === 'Register') {
          route = literalProperty(args[1] ?? [], 'Path', ':');
        }
      }
      if (route === undefined) continue;
      if (instance?.prefix) route = `${instance.prefix.replace(/\/$/u, '')}${route}`;
      if (!route.startsWith('/')) continue;
      const handler = args.at(-1) ?? [];
      const reply = responseParameter(handler);
      const literalHtmlSchema = route.endsWith('.json') && handler.some((token, offset) =>
        reply !== undefined && token.kind === 'word' && token.text === 'type' &&
        handler[offset - 1]?.text === '.' && handler[offset - 2]?.text === reply && handler[offset + 1]?.text === '(' &&
        handler[offset + 2]?.value?.startsWith('text/html'));
      addRoute({
        path: route, sourceFile: file.path, digest: file.digest, line: receiver.line,
        method: ['route', 'Register'].includes(name) ? literalProperty(args[0] ?? [], 'method', ':') ?? 'unobserved' : name.toUpperCase(),
        isSpaHtml: literalHtmlSchema, evidenceKind: 'static-registration'
      });
    }
    if (language === 'python') {
      for (const [name, instance] of analysis.receivers) {
        if (instance.framework !== 'fastapi' || instance.router) continue;
        const assigned = tokens.findIndex((token, index) => token.text === name && tokens[index + 1]?.text === '=');
        if (assigned < 0) continue;
        const open = tokens.findIndex((token, index) => index > assigned && token.text === '(');
        const args = argumentsAt(tokens, matching, open).flat();
        for (const key of ['docs_url', 'openapi_url', 'redoc_url']) {
          const configured = literalProperty(args, key, '=');
          if (configured) addRoute({
            path: configured, sourceFile: file.path, digest: file.digest, line: tokens[assigned]!.line,
            method: 'GET', evidenceKind: 'static-configuration'
          });
        }
      }
    }
  } catch {
    analysis.tokens = []; analysis.imports.clear(); analysis.receivers.clear(); analysis.frameworks.clear(); analysis.routes = [];
    analysis.vueMount = false; analysis.mountedComponents = []; analysis.viteConfig = false; analysis.tailwindConfig = false;
    analysis.limitations.push('Unsupported or incomplete source syntax; no executable source fact was inferred from literal text.');
  }
  return analysis;
}

export function isActualGoHumaImportAndUsage(content: string): boolean {
  const analyzed = analyzeSource({ path: 'source.go', category: 'source', digest: '', size: Buffer.byteLength(content), modifiedTime: '' }, content);
  return analyzed.frameworks.has('go-huma');
}

function dependencyMaps(parsed: Record<string, unknown>): Map<string, string> {
  const dependencies = new Map<string, string>();
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const values = parsed[key];
    if (values === undefined) continue;
    if (!record(values)) throw new Error('Malformed dependency map');
    for (const [name, specifier] of Object.entries(values)) {
      if (typeof specifier !== 'string' || !specifier.trim()) throw new Error('Malformed dependency specifier');
      if (dependencies.has(name) && dependencies.get(name) !== specifier) throw new Error('Conflicting dependency specifiers');
      if (!/^[~^<>=*|\s\d.v+-]+$/u.test(specifier)) throw new Error('Unsupported registry dependency source');
      dependencies.set(name, specifier);
    }
  }
  return dependencies;
}

function pythonDependency(value: unknown): [string, string] {
  if (typeof value !== 'string') throw new Error('Malformed Python dependency');
  const found = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?\s*((?:[<>=!~].*)?)$/u.exec(value.trim());
  if (!found || /@|https?:/u.test(value)) throw new Error('Unsupported Python dependency source');
  return [pythonName(found[1]!), found[2]!.trim()];
}

function declaration(file: FileObservation, content: string): Declaration {
  const name = path.posix.basename(file.path);
  const result: Declaration = { file, root: path.posix.dirname(file.path), ecosystem: name === 'package.json' ? 'npm' : name === 'go.mod' ? 'go' : 'python', dependencies: new Map() };
  try {
    if (name === 'package.json') {
      const parsed = parseStrictManifestJson(content, 'Captured package declaration');
      if (!record(parsed)) throw new Error('Malformed package declaration');
      result.parsed = parsed;
      result.dependencies = dependencyMaps(parsed);
    } else if (name === 'pyproject.toml') {
      const parsed = parseToml(content);
      if (!record(parsed.project)) throw new Error('Missing Python project table');
      const project = parsed.project;
      if (project.dynamic !== undefined) throw new Error('Dynamic Python metadata');
      result.parsed = project;
      if (project.dependencies !== undefined && !Array.isArray(project.dependencies)) throw new Error('Malformed Python dependencies');
      for (const entry of project.dependencies ?? []) result.dependencies.set(...pythonDependency(entry));
    } else if (name.endsWith('requirements.txt')) {
      for (const raw of content.split(/\r?\n/u)) {
        const line = raw.replace(/\s+#.*$/u, '').trim();
        if (!line || line.startsWith('#')) continue;
        result.dependencies.set(...pythonDependency(line));
      }
    } else {
      const stream = tokenize(content, 'go');
      const lines = new Map<number, Token[]>();
      for (const token of stream) {
        if (token.kind === 'newline') continue;
        const values = lines.get(token.line) ?? [];
        values.push(token); lines.set(token.line, values);
      }
      let requiring = false;
      for (const line of lines.values()) {
        if (!line.length) continue;
        if (line.some((token) => token.kind === 'string')) throw new Error('Unsupported quoted module declaration');
        const values: string[] = [];
        for (const [index, token] of line.entries()) {
          const previous = line[index - 1];
          if (previous && previous.end === token.start && values.length) values[values.length - 1] += token.text;
          else values.push(token.text);
        }
        if (values[0] === 'replace' || values[0] === 'exclude') throw new Error('Unsupported Go replacement or exclusion');
        if (values[0] === 'require' && values[1] === '(') { requiring = true; continue; }
        if (values[0] === ')') { requiring = false; continue; }
        const entry = values[0] === 'require' ? values.slice(1) : requiring ? values : [];
        if (entry.length) {
          if (entry.length !== 2 || !/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(entry[1]!)) throw new Error('Malformed Go requirement');
          result.dependencies.set(entry[0]!, entry[1]!);
        }
      }
      if (requiring) throw new Error('Unclosed Go requirements');
    }
  } catch {
    result.issue = 'Malformed or unsupported dependency declaration; comments, metadata and unresolved sources are not dependency evidence.';
    result.dependencies.clear();
  }
  return result;
}

function collect(inventory: AssessmentInventory) {
  const files = capturedFiles(inventory);
  const declarations = files.filter((file) => file.category === 'declarations').map((file) => declaration(file, inventory.contentMap!.get(file.path)!));
  const boundaries = [
    ...inventory.files.filter((file) => file.category === 'declarations').map((file) => path.posix.dirname(file.path)),
    ...inventory.unobserved.filter((entry) => ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod'].includes(path.posix.basename(entry.path)))
      .map((entry) => path.posix.dirname(entry.path))
  ];
  const roots = [...new Set(boundaries)].sort((a, b) => b.length - a.length || ordered(a, b));
  const owner = (file: string) => roots.find((root) => beneath(file, root));
  const sources = files.filter((file) => file.category === 'source' || file.category === 'build' || file.category === 'tests')
    .map((file) => analyzeSource(file, inventory.contentMap!.get(file.path)!));
  return { files, declarations, roots, owner, sources };
}

const genaiRoutes: Readonly<Record<string, string>> = {
  '/api/ai/run': 'genai-generic', '/api/rag/query': 'genai-rag', '/api/chat/run': 'genai-chatbot',
  '/api/agent/run': 'genai-agent', '/api/invoke/run': 'genai-prompt', '/api/multi-agent/run': 'genai-multi-agent',
  '/api/fine-tuned/run': 'genai-fine-tuned', '/api/stream': 'genai-streaming', '/api/workflows/run': 'genai-workflow'
};

function componentDetections(target: AssessmentTarget, data: ReturnType<typeof collect>): FrameworkDetectionResult[] {
  const results: FrameworkDetectionResult[] = [];
  for (const root of [...data.roots].sort(ordered)) {
    const declarations = data.declarations.filter((entry) => entry.root === root);
    const sources = data.sources.filter((entry) => entry.file.category === 'source' && data.owner(entry.file.path) === root);
    // Profile roots are project-relative logical paths; "." denotes the project root.
    const scanRoot = path.relative(target.projectRoot, target.scanRoot).split(path.sep).join('/') || '.';
    const componentRoot = path.posix.join(scanRoot, root);
    if (!declarations.length) {
      results.push({ componentRoot, detectedFramework: 'unknown', isSupported: false, profileId: null, status: 'unobserved',
        evidence: { details: 'The component declaration was not captured stably; no framework was inferred.' } });
      continue;
    }
    const declared = new Set<Framework>();
    for (const entry of declarations) {
      for (const name of entry.dependencies.keys()) {
        const framework = name === 'fastapi' ? 'fastapi' : name === 'fastify' ? 'fastify' :
          name === 'vue' ? 'vue' : name === 'express' ? 'express' : name === 'flask' ? 'flask' :
            name === 'django' ? 'django' : name === 'github.com/danielgtaylor/huma/v2' ? 'go-huma' : undefined;
        if (framework) declared.add(framework);
      }
    }
    const base = { componentRoot, evidence: { declarationFile: declarations[0]!.file.path, details: '' } };
    if (declarations.some((entry) => entry.issue)) {
      results.push({ ...base, detectedFramework: 'unknown', isSupported: false, profileId: null, status: 'unobserved', evidence: { ...base.evidence, details: 'Malformed or unsupported component declarations require explicit review.' } });
      continue;
    }
    if (declared.size > 1) {
      results.push({ ...base, detectedFramework: 'unknown', isSupported: false, profileId: null, status: 'conflicting',
        evidence: { ...base.evidence, details: `Conflicting framework declarations in one component: ${[...declared].sort(ordered).join(', ')}.` } });
      continue;
    }
    const framework = [...declared][0];
    if (!framework) continue;
    const dependencyName = framework === 'go-huma' ? 'github.com/danielgtaylor/huma/v2' : framework;
    const declarationFile = declarations.find((entry) => entry.dependencies.has(dependencyName))!.file.path;
    const source = sources.find((entry) => framework === 'vue' ? entry.vueComponent : entry.frameworks.has(framework));
    if (!source) {
      results.push({ ...base, detectedFramework: 'unknown', isSupported: false, profileId: null, status: 'unobserved',
        evidence: { declarationFile, details: `The ${framework} declaration has no supported same-component application import/use evidence.` } });
      continue;
    }
    let observed: Framework = framework;
    let profileId: string | null = framework === 'fastapi' ? 'python-fastapi' : framework === 'fastify' ? 'node-fastify' : framework === 'vue' ? 'vue-component' : framework === 'go-huma' ? 'go-huma' : null;
    let status: 'observed' | 'unobserved' = 'observed';
    if (framework === 'vue' && !declarations.every((entry) => !entry.dependencies.has('vue') || /^[~^]?3(?:\.\d+){0,2}$/u.test(entry.dependencies.get('vue')!))) {
      profileId = null;
      const versions = declarations.map((entry) => entry.dependencies.get('vue')).filter((value): value is string => value !== undefined);
      status = versions.every((value) => /^[~^]?[0-9]+(?:\.\d+){0,2}$/u.test(value)) ? 'observed' : 'unobserved';
    }
    const modelDeclared = declarations.some((entry) => entry.dependencies.has('pydantic-ai') || entry.dependencies.has('pydantic-ai-slim'));
    const modelUsed = sources.some((entry) => entry.frameworks.has('genai'));
    if (framework === 'fastapi' && (modelDeclared || modelUsed)) {
      observed = 'genai';
      const patterns = [...new Set(sources.flatMap((entry) => entry.routes.map((route) => genaiRoutes[route.path]).filter((id): id is string => id !== undefined)))];
      profileId = modelDeclared && modelUsed && patterns.length === 1 ? patterns[0]! : null;
      if (!profileId) status = 'unobserved';
    }
    results.push({
      ...base, detectedFramework: observed, profileId, isSupported: profileId !== null, status,
      evidence: { declarationFile, sourceFile: source.file.path, details: observed === 'genai' && !profileId
        ? 'GenAI declaration, same-component model implementation and one canonical pattern must agree; uncaptured, unused or conflicting evidence remains unresolved.'
        : `Captured dependency declarations and same-component ${observed} source usage are observed; runtime behavior is not verified.` }
    });
  }
  return results;
}

export function detectProjectComponents(target: AssessmentTarget, inventory: AssessmentInventory): FrameworkDetectionResult[] {
  return componentDetections(target, collect(inventory));
}

export function detectProjectFramework(target: AssessmentTarget, inventory: AssessmentInventory): FrameworkDetectionResult {
  const detections = detectProjectComponents(target, inventory);
  if (detections.length === 1) return detections[0]!;
  return {
    detectedFramework: 'unknown', isSupported: false, profileId: null, status: detections.length ? 'conflicting' : 'unobserved',
    evidence: { details: detections.length ? 'Multiple component roots require explicit scope selection.' : 'No captured framework declaration and matching application source was established.' }
  };
}

function dependencyObservation(entry: Declaration, inventory: AssessmentInventory): DependencyObservation {
  const allowedLocks = entry.ecosystem === 'npm' ? ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] :
    entry.ecosystem === 'python' ? ['uv.lock', 'poetry.lock'] : ['go.sum'];
  const lockFiles = inventory.files.filter((file) => path.posix.dirname(file.path) === entry.root && allowedLocks.includes(path.posix.basename(file.path))).sort((a, b) => ordered(a.path, b.path));
  const base = { root: entry.root, declaration: { path: entry.file.path, digest: entry.file.digest, type: path.posix.basename(entry.file.path) },
    locks: lockFiles.map((file) => ({ path: file.path, digest: file.digest, type: path.posix.basename(file.path) })),
    integrityVerified: false as const };
  if (entry.issue) return { ...base, status: 'unknown', reason: entry.issue };
  if (!lockFiles.length) return { ...base, status: 'missing', reason: 'No same-component lockfile was captured.' };
  if (lockFiles.length !== 1) return { ...base, status: 'unknown', reason: 'Multiple competing component lockfiles require explicit selection.' };
  const lock = lockFiles[0]!, text = inventory.contentMap?.get(lock.path);
  if (text === undefined || lock.unstable) return { ...base, status: 'unknown', reason: 'Component lock content was not captured stably.' };
  try {
    if (entry.ecosystem === 'npm' && path.posix.basename(lock.path) === 'package-lock.json') {
      const parsed = parseStrictManifestJson(text, 'Captured npm lock');
      if (!record(parsed) || parsed.lockfileVersion !== 3 || !record(parsed.packages) || !record(parsed.packages[''])) throw new Error('Unsupported npm lock');
      const root = parsed.packages[''];
      if (root.name !== entry.parsed?.name || root.version !== entry.parsed?.version ||
          JSON.stringify([...dependencyMaps(root)].sort()) !== JSON.stringify([...entry.dependencies].sort())) {
        return { ...base, status: 'mismatched', reason: 'The component lock root differs from its actual package identity or dependency declarations.' };
      }
      for (const [location, item] of Object.entries(parsed.packages)) {
        if (!location) continue;
        if (!location.startsWith('node_modules/') || !record(item) || item.link === true || typeof item.version !== 'string' ||
            !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(item.version)) {
          return { ...base, status: 'unknown', reason: 'Incomplete or unsupported lock package metadata cannot establish locked dependencies.' };
        }
        if (typeof item.integrity !== 'string' || !npmIntegrity.test(item.integrity)) {
          const nested = location.lastIndexOf('/node_modules/');
          const parent = nested < 0 ? undefined : parsed.packages[location.slice(0, nested)];
          const name = nested < 0 ? '' : location.slice(nested + '/node_modules/'.length);
          if (item.inBundle !== true || item.resolved !== undefined || !record(parent) || typeof parent.integrity !== 'string' || !npmIntegrity.test(parent.integrity) ||
              !Array.isArray(parent.bundleDependencies) || !parent.bundleDependencies.includes(name)) {
            return { ...base, status: 'unknown', reason: 'A dependency lacks either its own integrity declaration or an explicit integrity-bound bundle parent.' };
          }
        }
      }
      for (const [name, specifier] of entry.dependencies) {
        const resolved = parsed.packages[`node_modules/${name}`];
        if (!record(resolved) || typeof resolved.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(resolved.version) ||
            typeof resolved.integrity !== 'string' || !npmIntegrity.test(resolved.integrity)) {
          return { ...base, status: 'unknown', reason: 'Locked dependency versions or SRI declarations are incomplete; package integrity is unverified.' };
        }
        const range = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/u.exec(specifier);
        if (!range || /[-+]/u.test(resolved.version)) return { ...base, status: 'unknown', reason: 'Dependency range evaluation is unsupported for this captured lock.' };
        const version = resolved.version.split('.').map(Number), minimum = range.slice(2).map(Number);
        const above = version[0]! > minimum[0]! || version[0] === minimum[0] && (version[1]! > minimum[1]! || version[1] === minimum[1] && version[2]! >= minimum[2]!);
        const allowed = range[1] === '^' ? version[0] === minimum[0] && (minimum[0] !== 0 || version[1] === minimum[1] && (minimum[1] !== 0 || version[2] === minimum[2])) :
          range[1] === '~' ? version[0] === minimum[0] && version[1] === minimum[1] : resolved.version === specifier;
        if (!above || !allowed) return { ...base, status: 'mismatched', reason: 'A locked dependency version does not satisfy its component declaration.' };
      }
      return { ...base, status: 'consistent', reason: 'Captured npm lock metadata agrees with component declarations; downloaded or installed artifact integrity was not checked.' };
    }
    if (entry.ecosystem === 'go') {
      const sums = text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => line.trim().split(/\s+/u));
      if (sums.some((line) => line.length !== 3 || !/^h1:[A-Za-z0-9+/]{43}=$/u.test(line[2]!))) throw new Error('Malformed Go sums');
      if (![...entry.dependencies].every(([name, version]) => sums.some((line) => line[0] === name && line[1] === version))) {
        return { ...base, status: 'mismatched', reason: 'Go checksums do not cover the exact component requirements.' };
      }
      return { ...base, status: 'consistent', reason: 'Go requirement/checksum metadata is present; module bytes and their integrity were not verified.' };
    }
    if (entry.ecosystem === 'python' && path.posix.basename(lock.path) === 'uv.lock') {
      const parsed = parseToml(text);
      if (parsed.version !== 1 || !Array.isArray(parsed.package)) throw new Error('Unsupported uv lock');
      for (const [name, specifier] of entry.dependencies) {
        const exact = /^==([0-9][A-Za-z0-9.!+-]*)$/u.exec(specifier);
        if (!exact) return { ...base, status: 'unknown', reason: 'Only exact captured Python pins can be compared without a dependency resolver.' };
        if (!parsed.package.some((item) => record(item) && item.name === name && item.version === exact[1])) {
          return { ...base, status: 'mismatched', reason: 'The uv lock does not contain the exact component dependency pins.' };
        }
      }
      if (entry.parsed?.name && !parsed.package.some((item) => record(item) && item.name === entry.parsed!.name && item.version === entry.parsed!.version)) {
        return { ...base, status: 'mismatched', reason: 'The uv lock lacks matching root project identity.' };
      }
      const root = parsed.package.find((item) => record(item) && item.name === entry.parsed?.name);
      if (!record(root) || !record(root.metadata) || !Array.isArray(root.metadata['requires-dist'])) {
        return { ...base, status: 'unknown', reason: 'The uv lock lacks root dependency metadata; package-name presence alone cannot establish agreement.' };
      }
      const requirements = root.metadata['requires-dist'].filter((item) => record(item) && item.marker === undefined);
      if (requirements.length !== entry.dependencies.size || requirements.some((item) =>
        !record(item) || typeof item.name !== 'string' || entry.dependencies.get(pythonName(item.name)) !== item.specifier)) {
        return { ...base, status: 'mismatched', reason: 'The uv lock root dependency declarations differ from the captured project.' };
      }
      return { ...base, status: 'consistent', reason: 'Captured Python pin metadata agrees; archive integrity and private installation are unobserved.' };
    }
  } catch {
    return { ...base, status: 'unknown', reason: 'Malformed or unsupported lock content; filename presence is not integrity evidence.' };
  }
  return { ...base, status: 'unknown', reason: 'This lock format has no qualified static consistency evaluator.' };
}

function capturedManifestEvidence(target: AssessmentTarget, files: FileObservation[]): NonNullable<ExtractedEvidence['manifest']> {
  const expectedPath = path.join(target.projectRoot, 'liftoff.manifest.json');
  const captured = files.find((file) => path.resolve(target.scanRoot, file.path) === expectedPath);
  const guarded = target.hasManifest === true && target.manifestPath === expectedPath &&
    path.isAbsolute(target.manifestPath) && typeof target.manifestDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(target.manifestDigest) && Number.isSafeInteger(target.manifestVersion) &&
    target.manifestVersion !== null && target.manifestVersion > 0;
  if (guarded) {
    if (captured && `sha256:${captured.digest.replace(/^sha256:/u, '')}` !== target.manifestDigest) {
      return { present: null, source: 'unobserved', issue: 'Guarded root-manifest identity conflicts with the captured inventory; no combined proof was inferred.' };
    }
    return {
      present: true, path: 'liftoff.manifest.json', digest: target.manifestDigest,
      version: target.manifestVersion!, source: 'guarded-project-root',
      schemaValidated: true, contentCapturedInInventory: captured !== undefined
    };
  }
  if (target.manifestPath !== undefined || target.manifestDigest !== undefined) {
    return { present: null, source: 'unobserved', issue: 'Root-manifest metadata is incomplete or belongs to a different project boundary.' };
  }
  if (captured) return {
    present: true, path: 'liftoff.manifest.json', digest: captured.digest,
    source: 'inventory', schemaValidated: false, contentCapturedInInventory: true
  };
  if (target.hasManifest === true || path.resolve(target.scanRoot) !== path.resolve(target.projectRoot)) {
    return { present: null, source: 'unobserved', issue: 'Root-manifest identity is outside the selected capture and no matching guarded identity was supplied.' };
  }
  return { present: false, source: 'inventory', contentCapturedInInventory: false };
}

export function extractEvidence(target: AssessmentTarget, inventory: AssessmentInventory): ExtractedEvidence {
  const data = collect(inventory), components = componentDetections(target, data);
  const dependencyComponents = data.declarations.map((entry) => dependencyObservation(entry, inventory));
  const routes = data.sources.filter((source) => source.file.category === 'source').flatMap((source) => source.routes);
  const testFiles = data.files.filter((file) => file.category === 'tests');
  const declaredTests = data.sources.filter((source) => source.file.category === 'tests' &&
    source.tokens.some((token, index) => {
      if (token.kind !== 'word') return false;
      if (source.file.path.endsWith('.py')) return token.text === 'def' && source.tokens[index + 1]?.text.startsWith('test_');
      if (source.file.path.endsWith('.go')) return token.text === 'func' && /^Test[A-Z_]/u.test(source.tokens[index + 1]?.text ?? '');
      const binding = source.imports.get(token.text);
      return binding !== undefined && ['vitest', 'node:test'].includes(binding.module) &&
        ['it', 'test', 'default'].includes(binding.member ?? '') && source.tokens[index + 1]?.text === '(';
    }));
  const docker = data.files.find((file) => path.posix.basename(file.path) === 'Dockerfile' && /^\s*FROM\s+\S+/mu.test(inventory.contentMap!.get(file.path)!));
  const composeFile = data.files.find((file) => ['docker-compose.yml', 'docker-compose.yaml'].includes(path.posix.basename(file.path)));
  let compose: { path: string; digest: string; serviceCount?: number; valid?: boolean; issue?: string } | undefined;
  if (composeFile) {
    try {
      const document = parseDocument(inventory.contentMap!.get(composeFile.path)!);
      if (document.errors.length) throw new Error('Unsupported Compose syntax');
      const parsed: unknown = document.toJS();
      const services = record(parsed) && record(parsed.services) ? parsed.services : undefined;
      compose = { path: composeFile.path, digest: composeFile.digest, valid: services !== undefined &&
        Object.values(services).every((service) => record(service) && (typeof service.image === 'string' || typeof service.build === 'string' || record(service.build))),
      ...(services ? { serviceCount: Object.keys(services).length } : {}) };
    } catch {
      compose = { path: composeFile.path, digest: composeFile.digest, valid: false, issue: 'Captured Compose content is malformed or uses unsupported YAML references.' };
    }
  }
  const mounted = (source: SourceAnalysis) => source.mountedComponents.some((component) =>
    data.owner(component) === data.owner(source.file.path) && data.sources.some((entry) => entry.file.path === component && entry.vueComponent));
  const entrypoints = data.sources.filter((source) => source.file.category === 'source' && source.vueMount && mounted(source)).map((source) => ({ path: source.file.path, digest: source.file.digest }));
  const vueComponents = data.sources.filter((source) => source.file.category === 'source' && source.vueComponent).map((source) => ({ path: source.file.path, digest: source.file.digest }));
  const viteConfigs = data.sources.filter((source) => source.file.category === 'build' && source.viteConfig)
    .map((source) => ({ path: source.file.path, digest: source.file.digest }));
  const tailwindConfigs = data.sources.filter((source) => source.file.category === 'build' && source.viteConfig && source.tailwindConfig)
    .map((source) => ({ path: source.file.path, digest: source.file.digest }));
  return {
    manifest: capturedManifestEvidence(target, data.files),
    dependencies: {
      declarations: data.declarations.map((entry) => ({ path: entry.file.path, digest: entry.file.digest, type: path.posix.basename(entry.file.path) })),
      locks: data.files.filter((file) => file.category === 'locks').map((file) => ({ path: file.path, digest: file.digest, type: path.posix.basename(file.path) })),
      matching: dependencyComponents.length > 0 && dependencyComponents.every((entry) => entry.status === 'consistent'),
      components: dependencyComponents,
      malformedDeclarations: data.declarations.filter((entry) => entry.issue).map((entry) => entry.file.path)
    },
    components,
    uncapturedFiles: inventory.files.filter((file) => file.unstable || !inventory.contentMap?.has(file.path)).map((file) => file.path).sort(ordered),
    sourceLimitations: data.sources.filter((source) => source.limitations.length).map((source) => ({ path: source.file.path, reason: source.limitations.join(' ') })),
    sourceEvidenceOmissions: data.sources.filter((source) => source.omittedRoutes > 0).map((source) => ({ path: source.file.path, count: source.omittedRoutes })),
    endpoints: {
      healthRoutes: routes.filter((route) => /\/(?:health|healthz|livez)$/u.test(route.path)),
      docsRoutes: routes.filter((route) => /\/(?:docs|scalar|redoc|openapi\.json)$/u.test(route.path))
    },
    tests: {
      declared: declaredTests.length > 0, testFiles: testFiles.map((file) => ({ path: file.path, digest: file.digest })),
      declaredFiles: declaredTests.map((source) => ({ path: source.file.path, digest: source.file.digest }))
    },
    containers: { ...(docker ? { dockerfile: { path: docker.path, digest: docker.digest } } : {}), ...(compose ? { compose } : {}) },
    frameworks: {
      ...data.files.find((file) => file.path === 'openspec/config.yaml') ? { openspec: { path: 'openspec/config.yaml', digest: data.files.find((file) => file.path === 'openspec/config.yaml')!.digest } } : {},
      ...data.files.find((file) => file.path.startsWith('.specify/')) ? { specKit: { path: data.files.find((file) => file.path.startsWith('.specify/'))!.path, digest: data.files.find((file) => file.path.startsWith('.specify/'))!.digest } } : {}
    },
    infrastructure: { terraformFiles: data.files.filter((file) => file.path.endsWith('.tf')).map((file) => ({ path: file.path, digest: file.digest })) },
    frontend: { entrypoints, components: vueComponents, viteConfigs, tailwindConfigs }
  };
}

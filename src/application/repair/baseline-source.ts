import { unsupported } from '../../adapters/hcl/semantic.js';

interface Token {
  kind: 'word' | 'string' | 'heredoc' | 'symbol' | 'newline';
  text: string;
  start: number;
  end: number;
}

export interface BaselineResourceSource {
  type: string;
  name: string;
  open: number;
  close: number;
  attributes: Map<string, readonly Token[]>;
  blocks: Set<string>;
}

function tokens(source: string): Token[] {
  const result: Token[] = [];
  const lineEnd = (offset: number) => {
    const end = source.indexOf('\n', offset);
    return end === -1 ? source.length : end;
  };
  const commentEnd = (offset: number) => {
    const end = source.indexOf('*/', offset + 2);
    if (end === -1) unsupported('Baseline HCL contains an unterminated comment.');
    return end + 2;
  };
  const heredocEnd = (offset: number) => {
    const header = /^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/u.exec(source.slice(offset));
    if (!header) unsupported('Baseline HCL uses an unsupported heredoc delimiter.');
    let cursor = offset + header[0].length;
    while (cursor < source.length) {
      const end = lineEnd(cursor);
      const line = source.slice(cursor, end).replace(/\r$/u, '');
      if ((header[1] ? line.trimStart() : line).trimEnd() === header[2]) return end;
      cursor = end + 1;
    }
    return unsupported('Baseline HCL contains an unterminated heredoc.');
  };
  const stringEnd = (offset: number, nesting = 0): number => {
    if (nesting > 64) unsupported('Baseline HCL template nesting exceeds its bound.');
    let cursor = offset + 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') { cursor += 2; continue; }
      if (source[cursor] === '"') return cursor + 1;
      if (source.startsWith('$${', cursor) || source.startsWith('%%{', cursor)) { cursor += 3; continue; }
      if (source.startsWith('${', cursor) || source.startsWith('%{', cursor)) {
        let depth = 1;
        cursor += 2;
        while (cursor < source.length && depth) {
          if (source[cursor] === '"') cursor = stringEnd(cursor, nesting + 1);
          else if (source.startsWith('/*', cursor)) cursor = commentEnd(cursor);
          else if (source[cursor] === '#' || source.startsWith('//', cursor)) cursor = lineEnd(cursor);
          else if (source.startsWith('<<', cursor)) cursor = heredocEnd(cursor);
          else {
            if (source[cursor] === '{') depth++;
            if (source[cursor] === '}') depth--;
            cursor++;
          }
        }
        if (depth) unsupported('Baseline HCL contains an unterminated template expression.');
        continue;
      }
      cursor++;
    }
    return unsupported('Baseline HCL contains an unterminated string.');
  };
  let cursor = 0;
  while (cursor < source.length) {
    const start = cursor, ch = source[cursor]!;
    if (/[ \t\r]/u.test(ch)) { cursor++; continue; }
    if (ch === '#' || source.startsWith('//', cursor)) { cursor = lineEnd(cursor); continue; }
    if (source.startsWith('/*', cursor)) { cursor = commentEnd(cursor); continue; }
    let kind: Token['kind'] = 'symbol';
    if (ch === '\n') { kind = 'newline'; cursor++; }
    else if (ch === '"') { kind = 'string'; cursor = stringEnd(cursor); }
    else if (source.startsWith('<<', cursor)) { kind = 'heredoc'; cursor = heredocEnd(cursor); }
    else if (/[A-Za-z_]/u.test(ch)) {
      kind = 'word';
      while (cursor < source.length && /[A-Za-z0-9_-]/u.test(source[cursor]!)) cursor++;
    } else cursor++;
    result.push({ kind, text: source.slice(start, cursor), start, end: cursor });
    if (result.length > 100_000) unsupported('Baseline HCL token count exceeds its bound.');
  }
  return result;
}

export function baselineResourceSources(source: string): Map<string, BaselineResourceSource> {
  const stream = tokens(source), matching = new Map<number, number>(), stack: number[] = [];
  for (const [index, token] of stream.entries()) {
    if (token.kind !== 'symbol') continue;
    if ('{[('.includes(token.text)) {
      if (stack.length >= 64) unsupported('Baseline HCL nesting exceeds its bound.');
      stack.push(index);
    } else if ('}])'.includes(token.text)) {
      const start = stack.pop();
      if (start === undefined || '{[('.indexOf(stream[start]!.text) !== '}])'.indexOf(token.text)) {
        unsupported('Baseline HCL has unbalanced delimiters.');
      }
      matching.set(start, index);
    }
  }
  if (stack.length) unsupported('Baseline HCL has unbalanced delimiters.');
  const next = (index: number) => {
    while (stream[index]?.kind === 'newline') index++;
    return index;
  };
  const label = (token: Token | undefined) => {
    if (token?.kind !== 'string' || !/^"[A-Za-z_][A-Za-z0-9_-]*"$/u.test(token.text)) {
      return unsupported('Baseline HCL resource labels must be unambiguous literal identifiers.');
    }
    return token.text.slice(1, -1);
  };
  const resources = new Map<string, BaselineResourceSource>();
  for (let cursor = 0; cursor < stream.length; cursor++) {
    const token = stream[cursor]!;
    if (token.kind === 'word' && token.text === 'resource') {
      const typeIndex = next(cursor + 1), nameIndex = next(typeIndex + 1), openIndex = next(nameIndex + 1);
      const type = label(stream[typeIndex]), name = label(stream[nameIndex]);
      if (stream[openIndex]?.text !== '{') unsupported('Baseline HCL resource header is unsupported.');
      const closeIndex = matching.get(openIndex);
      if (closeIndex === undefined) unsupported('Baseline HCL resource body is missing.');
      const key = `${type}.${name}`;
      if (resources.has(key)) unsupported(`${key}: missing or duplicate block.`);
      const attributes = new Map<string, readonly Token[]>(), blocks = new Set<string>();
      let item = next(openIndex + 1);
      while (item < closeIndex) {
        const keyToken = stream[item]!;
        if (keyToken.kind !== 'word') unsupported(`${key}: unsupported direct attribute or block syntax.`);
        let value = next(item + 1);
        if (stream[value]?.text === '=') {
          if (attributes.has(keyToken.text)) unsupported(`${key}.${keyToken.text}: duplicate setting.`);
          const start = next(value + 1);
          value = start;
          while (value < closeIndex && stream[value]!.kind !== 'newline') {
            value = matching.has(value) ? matching.get(value)! + 1 : value + 1;
          }
          if (start === value) unsupported(`${key}.${keyToken.text}: missing attribute value.`);
          attributes.set(keyToken.text, stream.slice(start, value));
          item = next(value);
        } else {
          blocks.add(keyToken.text);
          while (value < closeIndex && stream[value]!.text !== '{') {
            if (!['word', 'string', 'newline'].includes(stream[value]!.kind)) unsupported(`${key}: unsupported nested block header.`);
            if (keyToken.text === 'dynamic' && stream[value]!.kind === 'string') {
              blocks.add(stream[value]!.text.slice(1, -1));
            }
            value++;
          }
          const end = matching.get(value);
          if (end === undefined) unsupported(`${key}: missing nested block.`);
          item = next(end + 1);
        }
      }
      resources.set(key, {
        type, name, open: stream[openIndex]!.start, close: stream[closeIndex]!.start, attributes, blocks
      });
      cursor = closeIndex;
    } else if (matching.has(cursor)) cursor = matching.get(cursor)!;
  }
  return resources;
}

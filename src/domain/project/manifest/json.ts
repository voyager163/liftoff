import { FileSystemError } from '../errors.js';

export function parseStrictManifestJson(text: string, label = 'Manifest'): unknown {
  let result: unknown;
  try { result = JSON.parse(text) as unknown; }
  catch { throw new FileSystemError(`${label} must contain valid JSON.`); }
  let cursor = 0;
  const whitespace = () => { while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') { cursor += 2; continue; }
      if (text[cursor++] === '"') return JSON.parse(text.slice(start, cursor)) as string;
    }
    throw new FileSystemError(`${label} contains an unterminated JSON string.`);
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new FileSystemError(`${label} exceeds the bounded JSON nesting depth.`);
    whitespace();
    if (text[cursor] === '"') { string(); return; }
    if (text[cursor] === '{') {
      cursor++; whitespace();
      const names = new Set<string>();
      if (text[cursor] === '}') { cursor++; return; }
      while (cursor < text.length) {
        whitespace();
        const name = string();
        if (names.has(name)) throw new FileSystemError(`${label} contains duplicate JSON object field ${JSON.stringify(name)}.`);
        names.add(name);
        whitespace(); cursor++;
        value(depth + 1); whitespace();
        if (text[cursor++] === '}') return;
      }
    } else if (text[cursor] === '[') {
      cursor++; whitespace();
      if (text[cursor] === ']') { cursor++; return; }
      while (cursor < text.length) {
        value(depth + 1); whitespace();
        if (text[cursor++] === ']') return;
      }
    } else {
      while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor]!)) cursor++;
    }
  };
  value(0);
  return result;
}

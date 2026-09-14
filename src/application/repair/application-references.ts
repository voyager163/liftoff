import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { ApplicationInspectionError, applicationPathKey } from './application-files.js';
import {
  applicationBounds, type ApplicationDirectoryObservation, type ApplicationReference
} from './application-types.js';

export function applicationText(content: Buffer): string | null {
  const text = content.toString('utf8');
  return !content.includes(0) && Buffer.from(text, 'utf8').equals(content) ? text : null;
}

export function inspectApplicationReferences(
  snapshots: readonly ProjectFileSnapshot[],
  directories: readonly ApplicationDirectoryObservation[],
  additionalKnownFiles: readonly string[][] = []
): ApplicationReference[] {
  const known = new Map<string, 'file' | 'directory'>();
  for (const directory of directories) {
    if (directory.exists && directory.pathParts.length) known.set(applicationPathKey(directory.pathParts), 'directory');
  }
  for (const snapshot of snapshots) {
    if (snapshot.content === undefined) continue;
    known.set(applicationPathKey(snapshot.pathParts), 'file');
    for (let index = 1; index < snapshot.pathParts.length; index++) {
      known.set(applicationPathKey(snapshot.pathParts.slice(0, index)), 'directory');
    }
  }
  for (const parts of additionalKnownFiles) {
    known.set(applicationPathKey(parts), 'file');
    for (let index = 1; index < parts.length; index++) known.set(applicationPathKey(parts.slice(0, index)), 'directory');
  }
  const references = new Map<string, ApplicationReference>();
  let tokens = 0;
  const files = [...snapshots].sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
  for (const snapshot of files) {
    if (snapshot.content === undefined) continue;
    const text = applicationText(snapshot.content);
    if (text === null) continue;
    const source = applicationPathKey(snapshot.pathParts);
    const parent = path.posix.dirname(source);
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineStarts.push(index + 1);
    const add = (literal: string, offset: number, kind: ApplicationReference['kind']) => {
      if (++tokens > applicationBounds.referenceTokens) {
        throw new ApplicationInspectionError('Application reference token bound exceeded; coverage is incomplete.');
      }
      if (literal.length > applicationBounds.pathBytes || /[\u0000-\u001f\\:$%{}*?<>|]/u.test(literal) ||
          literal.startsWith('/') || literal.endsWith('/..')) return;
      const bases = literal.startsWith('.')
        ? [path.posix.join(parent, literal)]
        : [literal, path.posix.join(parent, literal)];
      const matches = new Set<string>();
      for (const base of bases) {
        const normalized = path.posix.normalize(base).replace(/\/$/u, '');
        if (normalized === '..' || normalized.startsWith('../') || normalized === '.') continue;
        if (known.has(normalized)) {
          matches.add(normalized);
          continue;
        }
        const extensions = [
          ...(!path.posix.extname(normalized) ? [
            `${normalized}.ts`, `${normalized}.tsx`, `${normalized}.js`, `${normalized}.mjs`,
            `${normalized}.cjs`, `${normalized}.py`, `${normalized}.json`,
            `${normalized}/index.ts`, `${normalized}/index.js`, `${normalized}/__init__.py`
          ] : []),
          ...(normalized.endsWith('.js') ? [`${normalized.slice(0, -3)}.ts`, `${normalized.slice(0, -3)}.tsx`] : [])
        ];
        for (const candidate of extensions) if (known.has(candidate)) matches.add(candidate);
      }
      for (const target of matches) {
        if (target === source) continue;
        let low = 0, high = lineStarts.length;
        while (low + 1 < high) {
          const middle = Math.floor((low + high) / 2);
          if (lineStarts[middle]! <= offset) low = middle;
          else high = middle;
        }
        const location = {
          sourcePathParts: [...snapshot.pathParts], line: low + 1, column: offset - lineStarts[low]! + 1,
          kind, targetPathParts: target.split('/'), targetKind: known.get(target)!
        };
        const id = canonicalSha256(location);
        references.set(id, { id, ...location });
        if (references.size > applicationBounds.references) {
          throw new ApplicationInspectionError('Application literal reference bound exceeded; coverage is incomplete.');
        }
      }
    };
    // Quoted paths with spaces and bare directory names need a whole-token pass.
    for (const match of text.matchAll(/(["'`])([^"'`\r\n]+)\1/gu)) {
      add(match[2]!, match.index! + 1, match[2]!.startsWith('.') ? 'relative-literal' : 'path-literal');
    }
    for (const match of text.matchAll(/(?:\.\.?\/)?[\p{L}\p{N}_@.-]+(?:\/[\p{L}\p{N}_@.-]+)*\/?/gu)) {
      if (!/[/.]/u.test(match[0]) && known.get(match[0]) !== 'file' &&
          !/(?:COPY|ADD|WORKDIR|working-directory:|context:|dockerfile:)\s*$/iu.test(text.slice(Math.max(0, match.index! - 64), match.index!))) continue;
      add(match[0], match.index!, match[0].startsWith('.') ? 'relative-literal' : 'path-literal');
    }
    if (source.endsWith('.py')) {
      for (const match of text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_.]*)/gmu)) {
        const literal = match[1]!;
        add(literal.replaceAll('.', '/'), match.index! + match[0].indexOf(literal), 'python-import');
      }
    }
  }
  return [...references.values()].sort((a, b) => {
    const source = applicationPathKey(a.sourcePathParts).localeCompare(applicationPathKey(b.sourcePathParts), 'en');
    return source || a.line - b.line || a.column - b.column || a.id.localeCompare(b.id, 'en');
  });
}

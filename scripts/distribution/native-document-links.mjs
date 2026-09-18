import path from 'node:path';

export const OPERATOR_DOCUMENTS = Object.freeze([
  'infrastructure/opentofu/bootstrap/README.md',
  'infrastructure/opentofu/telemetry/README.md'
]);
export const REQUIRED_PUBLIC_DOCUMENTS = Object.freeze([
  'README.md', 'DEVELOPER.md', 'CONTRIBUTING.md', 'SECURITY.md', ...OPERATOR_DOCUMENTS
]);
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_MARKDOWN_TOTAL_BYTES = 8 * 1024 * 1024;

export class DocumentationClosureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DocumentationClosureError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function isPublicDocumentationFile(name) {
  return name.startsWith('docs/') || OPERATOR_DOCUMENTS.includes(name) ||
    (!name.includes('/') && /\.md$/i.test(name));
}

export function validateDocumentShippingEntries(entries) {
  if (!Array.isArray(entries) || !entries.includes('docs') ||
      !REQUIRED_PUBLIC_DOCUMENTS.every((name) => entries.includes(name))) {
    throw new DocumentationClosureError('missing-shipping-document', 'Source shipping inventory omits required public documentation');
  }
  for (const name of entries) {
    if (typeof name !== 'string') throw new DocumentationClosureError('invalid-shipping-path', 'Documentation shipping paths must be strings');
    if ((name.toLowerCase() === 'infrastructure' || name.toLowerCase().startsWith('infrastructure/')) &&
        !OPERATOR_DOCUMENTS.includes(name)) {
      throw new DocumentationClosureError('unregistered-infrastructure', `Only exact public operator README files may ship: ${name}`);
    }
  }
}

function unescapeTarget(value) {
  return value.replace(/\\([\s\S])/g, (match, character) => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 47 || code >= 58 && code <= 64 ||
      code >= 91 && code <= 96 || code >= 123 && code <= 126 ? character : match;
  }).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    const key = entity.toLowerCase();
    if (named[key]) return named[key];
    const hex = key.startsWith('&#x');
    return String.fromCodePoint(Number.parseInt(key.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
  });
}

function prose(markdown) {
  let fence;
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          line.slice(marker[0].length).trim() === '') fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  });
  const text = lines.join('\n');
  if (/`{65}/.test(text)) throw new DocumentationClosureError('syntax-bound', 'Markdown code delimiters exceed the inspection bound');
  return text.replace(/(?<!`)(`{1,64})(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');
}

function closingBracket(text, start) {
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (index - start > 4096) throw new DocumentationClosureError('syntax-bound', 'Markdown link label exceeds the inspection bound');
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '[') depth++;
    if (text[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function destination(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? '') && index < text.length) index++;
  const beginning = index;
  if (text[index] === '<') {
    for (index++; index < text.length; index++) {
      if (index - beginning > 8192) throw new DocumentationClosureError('syntax-bound', 'Markdown destination exceeds the inspection bound');
      if (text[index] === '\\') { index++; continue; }
      if (text[index] === '>') return { target: text.slice(beginning + 1, index), end: index + 1 };
      if (text[index] === '\n') break;
    }
    return undefined;
  }
  let depth = 0;
  for (; index < text.length; index++) {
    if (index - beginning > 8192) throw new DocumentationClosureError('syntax-bound', 'Markdown destination exceeds the inspection bound');
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (/\s/.test(character)) break;
    if (character === '(') depth++;
    if (character === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  return depth === 0 ? { target: text.slice(beginning, index), end: index } : undefined;
}

export function localMarkdownTargets(markdown, inheritedReferences = new Map(), nesting = 0) {
  if (nesting > 16) throw new DocumentationClosureError('syntax-bound', 'Markdown link nesting exceeds the inspection bound');
  const references = new Map(inheritedReferences);
  const label = (value) => unescapeTarget(value).trim().replace(/\s+/g, ' ').toLowerCase();
  const text = prose(markdown).replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?([^\n]*)$/gm, (line, name, rest) => {
    if (name.startsWith('^')) return '';
    const parsed = destination(rest, 0);
    if (parsed && !references.has(label(name))) references.set(label(name), parsed.target);
    return '';
  });
  const targets = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] !== '[') continue;
    const end = closingBracket(text, index);
    if (end < 0) continue;
    const name = text.slice(index + 1, end);
    if (name.includes('[')) targets.push(...localMarkdownTargets(name, references, nesting + 1));
    if (text[end + 1] === '(') {
      const parsed = destination(text, end + 2);
      if (!parsed) continue;
      let tail = parsed.end;
      while (tail < text.length && /\s/.test(text[tail])) tail++;
      if (text[tail] === '"' || text[tail] === "'" || text[tail] === '(') {
        const quote = text[tail] === '(' ? ')' : text[tail];
        const start = tail++;
        while (tail < text.length && text[tail] !== quote) {
          if (tail - start > 8192) throw new DocumentationClosureError('syntax-bound', 'Markdown link title exceeds the inspection bound');
          if (text[tail] === '\\') tail++;
          tail++;
        }
        tail++;
        while (tail < text.length && /\s/.test(text[tail])) tail++;
      }
      if (text[tail] === ')') { targets.push(unescapeTarget(parsed.target)); index = tail; }
      continue;
    }
    let next = end + 1;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (text[next] === '[') {
      const referenceEnd = closingBracket(text, next);
      if (referenceEnd >= 0) {
        const key = label(text.slice(next + 1, referenceEnd) || name);
        if (references.has(key)) {
          targets.push(unescapeTarget(references.get(key)));
          index = referenceEnd;
          continue;
        }
      }
    }
    if (references.has(label(name))) targets.push(unescapeTarget(references.get(label(name))));
    index = end;
  }
  for (const tag of text.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      targets.push(unescapeTarget(attribute[1] ?? attribute[2] ?? attribute[3]));
    }
    for (const link of text.matchAll(/<([a-z][a-z0-9+.-]*:[^\s<>]+)>/gi)) targets.push(unescapeTarget(link[1]));
  }
  return targets.filter((target) => target !== '' && !target.startsWith('#') && !target.startsWith('//') &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(target) || /^file:|^[a-z]:[\\/]/i.test(target)));
}

export function verifyPublicMarkdownLinks(documents, inventory) {
  const paths = inventory.map((entry) => typeof entry === 'string' ? entry : entry.path);
  if (paths.some((name) => typeof name !== 'string' || !name || path.posix.isAbsolute(name) ||
      /[\\:\u0000-\u001f]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new DocumentationClosureError('invalid-inventory', 'Documentation needs an exact relative payload-file inventory');
  }
  const files = new Set(paths);
  if (files.size !== paths.length) throw new DocumentationClosureError('invalid-inventory', 'Duplicate documentation payload paths');
  const directories = new Set(['.']);
  for (const name of paths) {
    for (let directory = path.posix.dirname(name); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
  }
  for (const name of paths) {
    const folded = name.normalize('NFC').toLowerCase();
    if (folded === 'assets/qualification' || folded.startsWith('assets/qualification/') ||
        (folded === 'infrastructure' || folded.startsWith('infrastructure/')) && !OPERATOR_DOCUMENTS.includes(name)) {
      throw new DocumentationClosureError('unregistered-payload', `Unregistered infrastructure/qualification payload file: ${name}`);
    }
  }
  for (const target of REQUIRED_PUBLIC_DOCUMENTS) {
    if (!files.has(target)) throw new DocumentationClosureError('missing-document', `Missing required packaged document: ${target}`, { target });
  }
  const queue = paths.filter((name) => isPublicDocumentationFile(name) && /\.md$/i.test(name));
  const visited = new Set();
  const links = [];
  let bytes = 0;
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    if (visited.has(from)) continue;
    visited.add(from);
    const content = typeof documents === 'function' ? documents(from) : documents[from];
    if (typeof content !== 'string') throw new DocumentationClosureError('missing-content', `Missing actual packaged Markdown bytes: ${from}`, { target: from });
    const size = Buffer.byteLength(content, 'utf8');
    bytes += size;
    if (size > MAX_MARKDOWN_BYTES || bytes > MAX_MARKDOWN_TOTAL_BYTES) {
      throw new DocumentationClosureError('document-bound', `Packaged Markdown exceeds its byte bound: ${from}`, { target: from });
    }
    for (const target of localMarkdownTargets(content)) {
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]); }
      catch (error) {
        if (!(error instanceof URIError)) throw error;
        throw new DocumentationClosureError('invalid-link', `Invalid packaged Markdown link encoding: ${from} -> ${target}`, { from, target });
      }
      if (!decoded) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded)).replace(/\/$/, '');
      if (/^[a-z]:|^file:|[\\\u0000-\u001f]/i.test(decoded) || path.posix.isAbsolute(decoded) ||
          resolved === '..' || resolved.startsWith('../')) {
        throw new DocumentationClosureError('escaping-link', `Packaged Markdown link escapes its bundle: ${from} -> ${target}`, { from, target });
      }
      const directory = directories.has(resolved);
      if (!files.has(resolved) && !directory) {
        throw new DocumentationClosureError('broken-link', `Broken packaged Markdown link: ${from} -> ${target} (${resolved})`, { from, target, resolved });
      }
      links.push({ from, target, resolved });
      if (links.length > 20000) throw new DocumentationClosureError('link-bound', 'Packaged Markdown links exceed the inspection bound');
      if (/\.md$/i.test(resolved) && files.has(resolved)) queue.push(resolved);
      if (directory) {
        const readme = resolved === '.' ? 'README.md' : `${resolved}/README.md`;
        if (files.has(readme)) queue.push(readme);
      }
    }
  }
  return { schemaVersion: 1, kind: 'packaged-public-document-closure', documents: [...visited].sort(), links };
}

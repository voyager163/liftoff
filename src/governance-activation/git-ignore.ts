export interface GitIgnoreRule {
  root: string;
  pattern: string;
  negate: boolean;
  directoriesOnly: boolean;
  anchored: boolean;
}

export function parseGitIgnore(text: string, root: string): GitIgnoreRule[] {
  return text.split(/\r?\n/).flatMap((raw): GitIgnoreRule[] => {
    const line = raw.replace(/(?<!\\) +$/, '');
    if (!line || line.startsWith('#')) return [];
    const negate = line.startsWith('!');
    let pattern = negate ? line.slice(1) : line;
    const directoriesOnly = pattern.endsWith('/');
    if (directoriesOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith('/') || pattern.includes('/');
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    pattern = pattern.replace(/\\([#! ])/g, '$1');
    if (!pattern) throw new Error('Empty Git ignore pattern cannot define a reviewed initial staging inventory.');
    return [{ root, pattern, negate, directoriesOnly, anchored }];
  });
}

export function ignoredByRules(relative: string, directory: boolean, rules: readonly GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.root && !relative.startsWith(`${rule.root}/`)) continue;
    if (rule.directoriesOnly && !directory) continue;
    const local = rule.root ? relative.slice(rule.root.length + 1) : relative;
    const target = rule.anchored ? local : local.split('/').at(-1)!;
    if (gitWildmatch(target, rule.pattern)) ignored = !rule.negate;
  }
  return ignored;
}

function gitWildmatch(target: string, pattern: string): boolean {
  const escape = (character: string) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regex = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '\\') {
      if (++index >= pattern.length) throw new Error('Trailing Git ignore escape is not a resolvable staging rule.');
      regex += escape(pattern[index]!);
    } else if (character === '*') {
      const start = index;
      while (pattern[index + 1] === '*') index += 1;
      const globstar = index > start && (start === 0 || pattern[start - 1] === '/') &&
        (index === pattern.length - 1 || pattern[index + 1] === '/');
      if (globstar && pattern[index + 1] === '/') {
        regex += '(?:.*/)?';
        index += 1;
      } else regex += globstar ? '.*' : '[^/]*';
    } else if (character === '?') {
      regex += '[^/]';
    } else if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) throw new Error('Unclosed Git ignore character class cannot define a reviewed staging inventory.');
      const contents = pattern.slice(index + 1, end);
      if (!contents || contents.includes('[')) throw new Error('Unsupported Git ignore character class; staging remains blocked rather than guessed.');
      regex += `[${contents.startsWith('!') ? `^${contents.slice(1)}` : contents}]`;
      index = end;
    } else regex += escape(character);
  }
  // Unlike generic filesystem globs, Git wildmatch includes leading dot files.
  return new RegExp(`${regex}$`).test(target);
}

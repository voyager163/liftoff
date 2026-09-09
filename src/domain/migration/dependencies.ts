import { parse as parseToml, TomlError } from 'smol-toml';

export interface DependencyNames {
  names: string[];
  diagnostic?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function packageName(value: string): string | undefined {
  const name = value.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s*(?:\[|[<=>!~;@]|$))/)?.[1];
  return name?.toLowerCase().replace(/[._]+/g, '-');
}

function requirementNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const name = typeof value === 'string' ? packageName(value) : undefined;
    return name ? [name] : [];
  });
}

export function pythonDependencyNames(filename: string, content: string): DependencyNames {
  if (filename === 'requirements.txt') {
    return {
      names: requirementNames(content.split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('#'))
        .map((line) => line.replace(/\s+#.*$/, '')))
    };
  }
  if (filename === 'setup.py') {
    return { names: [], diagnostic: 'Python setup code is not executed; reconcile its dependency declarations explicitly.' };
  }
  if (filename === 'setup.cfg') {
    let section = '';
    let collecting = false;
    const values: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      if (trimmed.startsWith('[')) {
        section = trimmed.toLowerCase();
        collecting = false;
        continue;
      }
      const property = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=(?!=)(.*)$/);
      if (property) {
        collecting = section === '[options]' && property[1].toLowerCase() === 'install_requires' ||
          section === '[options.extras_require]';
        if (collecting) values.push(property[2]);
      } else if (collecting && /^\s/.test(line)) {
        values.push(trimmed);
      } else {
        collecting = false;
      }
    }
    return { names: requirementNames(values) };
  }

  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    return { names: [], diagnostic: 'Invalid TOML dependency metadata requires explicit target selection and reconciliation.' };
  }
  if (!isRecord(parsed)) return { names: [] };
  const project = isRecord(parsed.project) ? parsed.project : {};
  const names = requirementNames(project.dependencies);
  if (isRecord(project['optional-dependencies'])) {
    for (const group of Object.values(project['optional-dependencies'])) names.push(...requirementNames(group));
  }
  if (isRecord(parsed['dependency-groups'])) {
    for (const group of Object.values(parsed['dependency-groups'])) names.push(...requirementNames(group));
  }
  const tool = isRecord(parsed.tool) ? parsed.tool : {};
  const poetry = isRecord(tool.poetry) ? tool.poetry : {};
  for (const group of [poetry.dependencies, poetry['dev-dependencies']]) {
    if (isRecord(group)) names.push(...Object.keys(group).filter((name) => name !== 'python'));
  }
  if (isRecord(poetry.group)) {
    for (const group of Object.values(poetry.group)) {
      if (isRecord(group) && isRecord(group.dependencies)) names.push(...Object.keys(group.dependencies));
    }
  }
  return { names: [...new Set(names.map((name) => name.toLowerCase().replace(/[._]+/g, '-')))] };
}

export function nodeDependencyNames(content: string): DependencyNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { names: [], diagnostic: 'Invalid package.json dependency metadata requires explicit target selection and reconciliation.' };
  }
  if (!isRecord(parsed)) return { names: [], diagnostic: 'package.json must describe an object; no dependency evidence was inferred.' };
  const names: string[] = [];
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const group = parsed[key];
    if (group === undefined) continue;
    if (!isRecord(group) || Object.values(group).some((value) => typeof value !== 'string')) {
      return { names: [], diagnostic: 'Uninterpretable package.json dependency declarations require explicit reconciliation.' };
    }
    names.push(...Object.keys(group));
  }
  return { names: [...new Set(names)] };
}

interface GoToken {
  kind: 'word' | 'string' | 'symbol' | 'newline';
  value: string;
}

function goTokens(content: string): GoToken[] {
  const tokens: GoToken[] = [];
  let index = 0;
  while (index < content.length) {
    const current = content[index];
    if (current === '\n') {
      tokens.push({ kind: 'newline', value: '\n' });
      index += 1;
    } else if (/\s/.test(current)) {
      index += 1;
    } else if (content.startsWith('//', index)) {
      const end = content.indexOf('\n', index + 2);
      index = end < 0 ? content.length : end;
    } else if (content.startsWith('/*', index)) {
      const end = content.indexOf('*/', index + 2);
      if (end < 0) break;
      if (content.slice(index, end).includes('\n')) tokens.push({ kind: 'newline', value: '\n' });
      index = end + 2;
    } else if (current === '"' || current === '`') {
      const start = index++;
      while (index < content.length) {
        if (current === '"' && content[index] === '\\') {
          index += 2;
          continue;
        }
        if (content[index++] === current) break;
      }
      const literal = content.slice(start, index);
      let value: string;
      if (current === '`') {
        value = literal.endsWith('`') ? literal.slice(1, -1) : '';
      } else {
        try {
          value = JSON.parse(literal);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          value = '';
        }
      }
      tokens.push({ kind: 'string', value });
    } else if ('(){}[];,='.includes(current)) {
      tokens.push({ kind: 'symbol', value: current });
      index += 1;
    } else {
      const start = index++;
      while (index < content.length && !/[\s"`(){}\[\];,=]/.test(content[index]) &&
          !content.startsWith('//', index) && !content.startsWith('/*', index)) index += 1;
      tokens.push({ kind: 'word', value: content.slice(start, index) });
    }
  }
  return tokens;
}

export function goDependencyNames(content: string, sourceFile = false): string[] {
  const tokens = goTokens(content);
  const names: string[] = [];
  const keyword = sourceFile ? 'import' : 'require';
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== 'word' || tokens[index].value !== keyword) continue;
    while (tokens[index + 1]?.kind === 'newline') index += 1;
    if (tokens[index + 1]?.value === '(') {
      index += 2;
      let firstInLine = true;
      for (; index < tokens.length && tokens[index].value !== ')'; index += 1) {
        const token = tokens[index];
        if (token.kind === 'newline') {
          firstInLine = true;
        } else if (sourceFile && token.kind === 'string') {
          names.push(token.value);
        } else if (!sourceFile && firstInLine && (token.kind === 'word' || token.kind === 'string')) {
          names.push(token.value);
          firstInLine = false;
        }
      }
    } else {
      const next = tokens[index + 1];
      if (sourceFile) {
        const imported = next?.kind === 'string' ? next : tokens[index + 2];
        if (imported?.kind === 'string') names.push(imported.value);
      } else if (next?.kind === 'word' || next?.kind === 'string') {
        names.push(next.value);
      }
    }
  }
  return [...new Set(names.filter(Boolean))];
}

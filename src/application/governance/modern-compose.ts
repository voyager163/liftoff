import { isAlias, isScalar, parseDocument, visit } from 'yaml';
import { isRecord } from '../../domain/project/manifest/fields.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  modernComposeInputPolicy, protectedComposeEnvironmentName, validateModernComposeInputs, type ModernComposeInputs
} from '../../domain/governance/activation/modern-compose.js';
import {
  copyModernLocalData, localInputFailure, rawLocalDigest
} from '../../domain/governance/activation/modern-local-inputs.js';

export function inspectModernComposeInputs(source: string): {
  document: Record<string, unknown>;
  inputs: ModernComposeInputs;
} {
  if (typeof source !== 'string' || source.includes('\0') || Buffer.from(source).toString('utf8') !== source ||
      Buffer.byteLength(source) > modernComposeInputPolicy.sourceBytes) {
    localInputFailure('Compose requires bounded UTF-8 source without NUL bytes.');
  }

  const yaml = parseDocument(source, { uniqueKeys: true, strict: true, merge: true });
  if (yaml.errors.length || yaml.warnings.length) {
    localInputFailure('Compose contains invalid or unsupported YAML; source values were omitted.');
  }
  let nodes = 0, aliases = 0;
  const anchors = new Set<string>();
  visit(yaml, {
    Node(_key, node, parents) {
      if (++nodes > modernComposeInputPolicy.nodes || parents.length > modernComposeInputPolicy.depth) {
        localInputFailure('Compose exceeds its node or depth bound.');
      }
      if (isAlias(node)) {
        if (++aliases > modernComposeInputPolicy.aliases || !anchors.has(node.source)) {
          localInputFailure('Compose aliases must be bounded references to preceding unique anchors.');
        }
      } else if (node.anchor) {
        if (anchors.has(node.anchor)) localInputFailure('Compose contains a duplicate YAML anchor.');
        anchors.add(node.anchor);
      }
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' &&
          !(pair.key.source === '<<' && typeof pair.key.value === 'symbol')) {
        localInputFailure('Compose mapping keys must be literal strings or explicit YAML merge keys.');
      }
    }
  });
  let parsed: unknown;
  try { parsed = yaml.toJS({ maxAliasCount: modernComposeInputPolicy.aliasExpansion }); }
  catch { localInputFailure('Compose aliases could not be expanded within the declared bound.'); }
  const document = copyModernLocalData(parsed);
  if (!isRecord(document) || !isRecord(document.services)) {
    localInputFailure('Compose requires an explicit services object.');
  }
  const names = new Map<string, string>();
  function variable(name: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
        Buffer.byteLength(name) > modernComposeInputPolicy.variableBytes || protectedComposeEnvironmentName(name)) {
      localInputFailure('Compose interpolation overlaps execution controls or exceeds the variable-name bound.');
    }
    const folded = name.toUpperCase();
    if (names.has(folded) && names.get(folded) !== name) {
      localInputFailure('Compose interpolation contains environment names that alias on Windows.');
    }
    names.set(folded, name);
    if (names.size > modernComposeInputPolicy.variables) localInputFailure('Compose exceeds the environment-variable bound.');
  }
  function interpolation(value: string): void {
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== '$') continue;
      if (value[index + 1] === '$') { index++; continue; }
      if (value[index + 1] === '{') {
        const closing = value.indexOf('}', index + 2);
        const expression = closing < 0 ? '' : value.slice(index + 2, closing);
        const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(?::?[-+])([^${}]*))?$/u.exec(expression);
        if (!match) localInputFailure('Compose requires simple optional interpolation with literal defaults; required or nested values are unsupported.');
        variable(match[1]!);
        index = closing;
      } else {
        const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(value.slice(index + 1));
        if (match) { variable(match[0]); index += match[0].length; }
      }
    }
  }
  const inspectedStrings = new Set<string>();
  function values(value: unknown): void {
    if (typeof value === 'string') {
      if (!inspectedStrings.has(value)) {
        interpolation(value);
        inspectedStrings.add(value);
      }
    }
    else if (Array.isArray(value)) value.forEach(values);
    else if (isRecord(value)) Object.values(value).forEach(values);
  }
  values(document);
  function implicitEnvironment(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== 'string') localInputFailure('Compose environment lists require literal string entries.');
        if (!entry.includes('=')) variable(entry);
      }
    } else if (isRecord(value)) {
      for (const [name, entry] of Object.entries(value)) if (entry === null) variable(name);
    }
  }
  for (const service of Object.values(document.services)) {
    if (!isRecord(service)) localInputFailure('Compose service must be an object.');
    implicitEnvironment(service.environment);
    if (isRecord(service.build)) implicitEnvironment(service.build.args);
  }
  return {
    document,
    inputs: {
      kind: 'liftoff-closed-compose-inputs', schemaVersion: 1,
      policyDigest: canonicalSha256(modernComposeInputPolicy), sourceDigest: rawLocalDigest(source),
      unsetEnvironment: [...names.values()].sort()
    }
  };
}

export function modernComposeEnvironment(base: NodeJS.ProcessEnv, input: ModernComposeInputs): NodeJS.ProcessEnv {
  const inputs = validateModernComposeInputs(input);
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.keys(process.env).map(name => [name, undefined])), ...base,
    COMPOSE_DISABLE_ENV_FILE: '1', COMPOSE_ENV_FILES: ''
  };
  const names = new Set(inputs.unsetEnvironment.map(name => name.toUpperCase()));
  for (const name of Object.keys(environment)) if (names.has(name.toUpperCase())) environment[name] = undefined;
  for (const name of inputs.unsetEnvironment) environment[name] = undefined;
  return environment;
}

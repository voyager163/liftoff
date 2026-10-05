import { canonicalSha256 } from './canonical-json.js';
import { copyModernLocalData, localInputFailure, modernLocalBounds } from './modern-local-inputs.js';
import { exactRecord } from '../../project/manifest/fields.js';

const protectedNames = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LANGUAGE',
  'TZ', 'CI', 'TERM', 'NO_COLOR', 'ENV', 'BASH_ENV', 'ZDOTDIR', 'SHELLOPTS',
  'GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOTOOLCHAIN', 'GOWORK', 'GOENV',
  'GOFLAGS', 'GOVCS', 'GOPROXY', 'GOSUMDB', 'GODEBUG', 'GOGC', 'GOMEMLIMIT',
  'DO_NOT_TRACK'
]);
export const modernComposeInputPolicy = Object.freeze({
  kind: 'liftoff-closed-compose-inputs',
  version: 1,
  sourceBytes: 1024 * 1024,
  nodes: 100_000,
  depth: 24,
  aliases: 32,
  // yaml counts the anchored value itself as the first expansion.
  aliasExpansion: 33,
  variables: 64,
  variableBytes: 128,
  expandedNodes: modernLocalBounds.dataNodes,
  expandedDepth: modernLocalBounds.dataDepth,
  protectedNames,
  protectedPrefixes: '^(?:LC_|XDG_|LD_|DYLD_|NODE_|NPM_|PYTHON|PIP_|UV_|GIT_|CGO_|DOCKER_|COMPOSE_|LIFTOFF_)',
  environment: 'explicitly-unset-project-variables-without-dotenv-or-ambient-values',
  references: 'requires-separate-captured-reference-check',
  rootBuildContext: 'captured-root-directory-only-no-recursion-or-build-authority',
  standaloneDockerfiles: 'exact-active-dockerfile-artifact-bindings-only',
  requiredValues: 'unsupported',
  execution: 'not-authorized'
} as const);

export interface ModernComposeInputs {
  readonly kind: 'liftoff-closed-compose-inputs';
  readonly schemaVersion: 1;
  readonly policyDigest: string;
  readonly sourceDigest: string;
  readonly unsetEnvironment: readonly string[];
}

const protectedEnvironmentNames = new Set(modernComposeInputPolicy.protectedNames);
const protectedEnvironmentPrefixes = new RegExp(modernComposeInputPolicy.protectedPrefixes, 'u');

export function protectedComposeEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return protectedEnvironmentNames.has(upper) || protectedEnvironmentPrefixes.test(upper);
}

export function validateModernComposeInputs(input: ModernComposeInputs): ModernComposeInputs {
  const value = copyModernLocalData(input);
  exactRecord(value, ['kind', 'schemaVersion', 'policyDigest', 'sourceDigest', 'unsetEnvironment'], 'Closed Compose inputs');
  if (value.kind !== modernComposeInputPolicy.kind || value.schemaVersion !== 1 ||
      value.policyDigest !== canonicalSha256(modernComposeInputPolicy) ||
      typeof value.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sourceDigest) ||
      !Array.isArray(value.unsetEnvironment) || value.unsetEnvironment.length > modernComposeInputPolicy.variables) {
    localInputFailure('Compose input identity or environment inventory does not match its closed policy.');
  }
  const names = new Set<string>();
  let previous = '';
  for (const name of value.unsetEnvironment) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
        Buffer.byteLength(name) > modernComposeInputPolicy.variableBytes ||
        protectedComposeEnvironmentName(name) || names.has(name.toUpperCase()) || name <= previous) {
      localInputFailure('Compose environment names must be bounded, ordered, unique and independent of execution controls.');
    }
    names.add(name.toUpperCase());
    previous = name;
  }
  return value;
}

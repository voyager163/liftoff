import path from 'node:path';
import {
  assertNoSecretValues,
  canonicalizePathBoundary,
  formatNativeSafeCommandLine,
  resolveGovernanceScope
} from '../domain/execution/continuation.js';
import {
  assertSchemaVersion,
  assertStrictKeys,
  assertStrictObject,
  ProtocolValidationError,
  publicProtocolSchemaVersion,
  protocolArguments,
  protocolChoice,
  protocolNativePath,
  protocolString,
  protocolStringArray
} from './schema.js';
import {
  parseCommandTokens,
  UsageError,
  validateCommandPositionals
} from '../domain/execution/command-line.js';

export interface StructuredContinuationV1 {
  schemaVersion: 1;
  executable: string;
  args: readonly string[];
  cwd: string;
  scope?: string;
  project?: string;
  userInstallTarget?: string;
  targetScope?: 'project' | 'user' | 'installation';
  configPath?: string;
  configDigest?: string;
  requiredAuthority?: readonly string[];
  compatibilityIdentity?: string;
  displayCommand: string;
}

export interface CreateStructuredContinuationInput {
  executable?: string;
  args: readonly string[];
  cwd: string;
  scope?: string;
  project?: string;
  userInstallTarget?: string;
  targetScope?: 'project' | 'user' | 'installation';
  configPath?: string;
  configDigest?: string;
  requiredAuthority?: readonly string[];
  compatibilityIdentity?: string;
  platform?: NodeJS.Platform;
}

const continuationAllowedKeys = [
  'schemaVersion',
  'executable',
  'args',
  'cwd',
  'scope',
  'project',
  'userInstallTarget',
  'targetScope',
  'configPath',
  'configDigest',
  'requiredAuthority',
  'compatibilityIdentity',
  'displayCommand'
] as const;

function isWindowsPath(value: string): boolean {
  return /^[a-z]:/iu.test(value) || value.startsWith('\\');
}

function continuationData(
  record: Record<string, unknown>, creating: boolean, platform?: NodeJS.Platform
): StructuredContinuationV1 {
  const executable = protocolString(creating ? record.executable ?? 'liftoff' : record.executable, 'StructuredContinuation.executable', 4096);
  const args = protocolArguments(record.args, 'StructuredContinuation.args');
  if (args.length === 0) throw new ProtocolValidationError('StructuredContinuation requires a command argument.');
  assertNoSecretValues([executable, ...args]);
  const tokens = (() => {
    try {
      const result = parseCommandTokens(args);
      validateCommandPositionals(result.parsed);
      if (args[0]!.startsWith('--') && args.length !== 1) {
        throw new UsageError('Global help/version continuations accept no additional arguments.');
      }
      return result;
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      throw new ProtocolValidationError(`Continuation arguments are invalid: ${error.message}`);
    }
  })();
  const argumentValue = (flag: string): string | undefined => {
    const value = tokens.parsed.flags[flag.slice(2)];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new ProtocolValidationError(`Continuation ${flag} requires an explicit literal value.`);
    }
    return value;
  };
  const addedOptions: string[] = [];
  const replaceArgumentValue = (flag: string, value: string): void => {
    const location = tokens.flagLocations[flag.slice(2)];
    if (!location) {
      addedOptions.push(flag, value);
    } else if (location.valueIndex !== undefined) {
      args[location.valueIndex] = value;
    } else {
      args[location.tokenIndex] = `${flag}=${value}`;
    }
  };
  const preparePath = (value: unknown, label: string) => protocolNativePath(
    creating ? canonicalizePathBoundary(protocolString(value, label, 4096)) : value, label
  );
  const cwd = preparePath(record.cwd, 'StructuredContinuation.cwd');
  const nativePath = isWindowsPath(cwd) ? path.win32 : path.posix;
  const selectedPlatform = platform ?? (isWindowsPath(cwd) ? 'win32' : 'linux');
  if ((selectedPlatform === 'win32') !== isWindowsPath(cwd)) {
    throw new ProtocolValidationError('Continuation presentation platform and native cwd identify different hosts.');
  }
  const resolveArgument = (value: string) => {
    canonicalizePathBoundary(value);
    if (isWindowsPath(value) !== isWindowsPath(cwd) && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))) {
      throw new ProtocolValidationError('Continuation mixes native path formats.');
    }
    return preparePath(nativePath.resolve(cwd, value), 'StructuredContinuation argument target');
  };
  let scope = record.scope === undefined ? undefined : protocolString(record.scope, 'StructuredContinuation.scope', 128);
  const governance = args[0] === 'governance';
  const assessment = governance && args[1] === 'assess';
  if (governance) {
    const argumentScope = argumentValue('--scope');
    if (assessment && argumentScope !== undefined) {
      throw new ProtocolValidationError('Governance assessment does not accept an enforcement --scope flag.');
    }
    if (scope !== undefined && argumentScope !== undefined && scope !== argumentScope) {
      throw new ProtocolValidationError('Continuation scope disagrees with its literal arguments.');
    }
    scope = resolveGovernanceScope(assessment ? 'governance assess' : 'governance', scope ?? argumentScope);
    if (!assessment && argumentScope === undefined && scope !== 'activation') {
      if (!creating) throw new ProtocolValidationError('Continuation omits its explicitly selected governance scope from the arguments.');
      addedOptions.push('--scope', scope!);
    }
  }

  const projectCommand = ['adopt', 'assess', 'repair', 'update', 'validate', 'governance'].includes(args[0]!);
  const projectFlag = argumentValue('--project');
  const projectPositional = projectCommand ? tokens.parsed.positional[0] : undefined;
  if (projectPositional !== undefined && projectFlag !== undefined) {
    throw new ProtocolValidationError('Continuation must select its project either positionally or with --project, not both.');
  }
  const projectArgument = projectFlag ?? projectPositional;
  let project = record.project === undefined ? undefined : preparePath(record.project, 'StructuredContinuation.project');
  if (projectCommand) {
    const selected = projectArgument === undefined ? cwd : resolveArgument(projectArgument);
    if (project && project !== selected) {
      if (!creating || projectArgument !== undefined) throw new ProtocolValidationError('Continuation project differs from the actual argument/cwd target.');
    }
    project ??= selected;
    if (creating) {
      if (projectPositional !== undefined) args[tokens.positionalIndices[0]!] = project;
      else replaceArgumentValue('--project', project);
    } else if (args[0] === 'adopt' && projectArgument === undefined) {
      throw new ProtocolValidationError('Adoption continuation is missing its explicit project target.');
    }
  }
  if (args[0] === 'doctor') {
    if (projectArgument !== undefined || project !== undefined && project !== cwd) {
      throw new ProtocolValidationError('Doctor continuation must inspect its exact cwd; it does not support a project option.');
    }
    project ??= cwd;
  }
  const userInstallTarget = record.userInstallTarget === undefined ? undefined :
    preparePath(record.userInstallTarget, 'StructuredContinuation.userInstallTarget');
  const targetScope = record.targetScope === undefined ? project ? 'project' : undefined :
    protocolChoice(record.targetScope, ['project', 'user', 'installation'] as const, 'StructuredContinuation.targetScope');
  if (project && userInstallTarget || targetScope === 'project' && !project ||
      targetScope !== undefined && targetScope !== 'project' && project) {
    throw new ProtocolValidationError('Continuation has conflicting or missing target boundaries.');
  }
  if (tokens.parsed.command === 'skills') {
    const skillScope = argumentValue('--scope') ?? (projectFlag === undefined ? 'user' : 'project');
    if ((skillScope === 'project' || projectFlag !== undefined || targetScope === 'project') &&
        (skillScope !== 'project' || targetScope !== 'project' || project !== resolveArgument(projectFlag ?? '.'))) {
      throw new ProtocolValidationError('Skills continuation project differs from its literal argument/cwd target.');
    }
  }
  if (tokens.parsed.command === 'installation' && tokens.parsed.subcommand === 'migrate') {
    const destination = argumentValue('--destination');
    if (destination !== undefined &&
        (targetScope !== 'installation' || userInstallTarget !== resolveArgument(destination))) {
      throw new ProtocolValidationError('Installation continuation target differs from its literal destination argument.');
    }
  }

  const configPath = record.configPath === undefined ? undefined : preparePath(record.configPath, 'StructuredContinuation.configPath');
  const configDigest = record.configDigest === undefined ? undefined :
    protocolString(record.configDigest, 'StructuredContinuation.configDigest', 64);
  if ((configPath === undefined) !== (configDigest === undefined) ||
      configDigest !== undefined && !/^[a-f0-9]{64}$/u.test(configDigest)) {
    throw new ProtocolValidationError('Continuation configuration requires an exact reference and complete lowercase SHA-256 digest together.');
  }
  const configFlag = governance && !assessment || args[0] === 'assess' ? '--inputs' :
    args[0] === 'adopt' ? '--proposal' : args[0] === 'repair' ? '--application-patch' : undefined;
  const configurationArguments = ['--inputs', '--proposal', '--application-patch']
    .map((flag) => ({ flag, value: argumentValue(flag) }))
    .filter((entry) => entry.value !== undefined);
  if (configurationArguments.length > 1 || configurationArguments.some((entry) => entry.flag !== configFlag)) {
    throw new ProtocolValidationError('Continuation uses a configuration option that this command does not support.');
  }
  const declaredConfig = configurationArguments[0]?.value;
  if (configPath) {
    if (!configFlag) throw new ProtocolValidationError('This continuation command cannot consume a configuration binding.');
    if (declaredConfig === undefined) {
      if (!creating) throw new ProtocolValidationError('Continuation drops its configuration reference from the arguments.');
      addedOptions.push(configFlag, configPath);
    } else if (resolveArgument(declaredConfig) !== configPath) {
      throw new ProtocolValidationError('Continuation configuration differs from its literal argument.');
    } else if (creating) {
      replaceArgumentValue(configFlag, configPath);
    }
  } else if (declaredConfig !== undefined) {
    throw new ProtocolValidationError('A configuration-bearing continuation requires the captured reference and digest.');
  }
  const requiredAuthority = record.requiredAuthority === undefined ? [] :
    protocolStringArray(record.requiredAuthority, 'StructuredContinuation.requiredAuthority', 64);
  const compatibilityIdentity = record.compatibilityIdentity === undefined ? undefined :
    protocolString(record.compatibilityIdentity, 'StructuredContinuation.compatibilityIdentity', 256);
  if (addedOptions.length) {
    const delimiter = args.indexOf('--');
    args.splice(delimiter === -1 ? args.length : delimiter, 0, ...addedOptions);
  }
  if ([project, userInstallTarget, configPath].some((value) => value !== undefined && isWindowsPath(value) !== isWindowsPath(cwd))) {
    throw new ProtocolValidationError('Continuation target/configuration paths must use the same native host format as cwd.');
  }
  assertNoSecretValues([cwd, ...(project ? [project] : []), ...(userInstallTarget ? [userInstallTarget] : []),
    ...(configPath ? [configPath] : []), ...args]);
  const displayCommand = formatNativeSafeCommandLine(executable, args, selectedPlatform);
  if (!creating && protocolString(record.displayCommand, 'StructuredContinuation.displayCommand', 65_536) !== displayCommand) {
    throw new ProtocolValidationError('Continuation display command does not render its exact native executable and literal arguments.');
  }
  return {
    schemaVersion: 1, executable, args, cwd, displayCommand, requiredAuthority,
    ...(scope !== undefined ? { scope } : {}), ...(project ? { project } : {}),
    ...(userInstallTarget ? { userInstallTarget } : {}), ...(targetScope ? { targetScope } : {}),
    ...(configPath ? { configPath, configDigest } : {}),
    ...(compatibilityIdentity ? { compatibilityIdentity } : {})
  };
}

export function createStructuredContinuation(
  input: CreateStructuredContinuationInput,
  platform?: NodeJS.Platform
): StructuredContinuationV1 {
  const record = assertStrictObject(input, 'CreateStructuredContinuation');
  assertStrictKeys(record, [...continuationAllowedKeys.filter((key) => key !== 'schemaVersion' && key !== 'displayCommand'), 'platform'], 'CreateStructuredContinuation');
  if (record.platform !== undefined && platform !== undefined && record.platform !== platform) {
    throw new ProtocolValidationError('Continuation declares conflicting presentation platforms.');
  }
  const requested = record.platform ?? platform;
  const selected = requested === undefined ? undefined :
    protocolChoice(requested, ['darwin', 'linux', 'win32'] as const, 'CreateStructuredContinuation.platform');
  return continuationData(record, true, selected);
}

export function validateStructuredContinuation(value: unknown): StructuredContinuationV1 {
  const record = assertStrictObject(value, 'StructuredContinuation');
  assertSchemaVersion(record, publicProtocolSchemaVersion, 'StructuredContinuation');
  assertStrictKeys(record, continuationAllowedKeys, 'StructuredContinuation');

  return continuationData(record, false);
}

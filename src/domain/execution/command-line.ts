import type { ParsedArgs } from '../project/contracts.js';
import { commandDefinitions } from './command-definitions.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface FlagLocation {
  tokenIndex: number;
  valueIndex?: number;
}

export interface ParsedCommandTokens {
  parsed: ParsedArgs;
  positionalIndices: readonly number[];
  flagLocations: Readonly<Record<string, FlagLocation>>;
}

function assignFlag(flags: ParsedArgs['flags'], name: string, value: string | boolean): void {
  if (Object.hasOwn(flags, name)) {
    throw new UsageError(`Flag --${name} may be provided only once.`);
  }
  flags[name] = value;
}

function parseBooleanValue(name: string, value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new UsageError(`Flag --${name} expects true or false.`);
}

export function parseCommandTokens(argv: readonly string[]): ParsedCommandTokens {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '--version') {
    return {
      parsed: {
        ...(argv[0] ? { command: argv[0] === '--help' ? 'help' : 'version' } : {}),
        positional: [], flags: {}
      },
      positionalIndices: [], flagLocations: {}
    };
  }
  const command = argv[0];
  if (command.startsWith('-')) {
    throw new UsageError(`Unknown option: ${command}. Run \`liftoff help\` for usage.`);
  }
  if (command === 'create') {
    throw new UsageError('The `liftoff create` command was replaced by `liftoff init`. Run `liftoff init --help` for usage.');
  }
  const definition = commandDefinitions[command];
  if (!definition) {
    throw new UsageError(`Unknown command: ${command}. Run \`liftoff help\` for usage.`);
  }
  const tokens = argv.slice(1);
  let subcommand: string | undefined;
  if (definition.subcommands && tokens[0] && !tokens[0].startsWith('-')) {
    const candidate = tokens.shift()!;
    if (!definition.subcommands.includes(candidate)) {
      throw new UsageError(
        `Unsupported ${command} subcommand: ${candidate}. Use one of: ${definition.subcommands.join(', ')}.`
      );
    }
    subcommand = candidate;
  }
  const tokenOffset = subcommand ? 2 : 1;
  const positional: string[] = [];
  const positionalIndices: number[] = [];
  const flags: ParsedArgs['flags'] = {};
  const flagLocations: Record<string, FlagLocation> = {};
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!positionalOnly && token === '--') {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith('-')) {
      positional.push(token);
      positionalIndices.push(tokenOffset + index);
      continue;
    }
    if (!token.startsWith('--')) {
      throw new UsageError(`Unknown option: ${token}. Liftoff options use --long-name syntax.`);
    }
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const rawName = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    const inlineValue = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : undefined;
    const negated = rawName.startsWith('no-');
    const name = negated ? rawName.slice(3) : rawName;
    const flagDefinition = definition.flags[name];
    if (!flagDefinition) {
      if (name === 'code-apps-plugin') {
        throw new UsageError(`Flag --${rawName} was removed because Power Apps code apps are retired and unsupported.`);
      }
      if (command === 'update' && name === 'apply') {
        const legacyForceRequested = flags.force === true ||
          tokens.slice(index + 1).some((candidate) => candidate === '--force' || candidate === '--force=true');
        throw new UsageError(
          legacyForceRequested
            ? 'Flag --apply was removed. Run `liftoff update --check` first to review the separate ' +
              'forced plan and save its external receipt, then explicitly approve it with ' +
              '`liftoff update --force`. Force does not bypass preview or approval.'
            : 'Flag --apply was removed. Run `liftoff update --check` first to preview changes and ' +
              'save an external receipt, then run `liftoff update` to explicitly approve the matching plan.'
        );
      }
      throw new UsageError(`Unknown flag for ${command}: --${rawName}.`);
    }
    flagLocations[name] = { tokenIndex: tokenOffset + index };
    if (negated) {
      if (inlineValue !== undefined || flagDefinition.kind !== 'boolean' || !flagDefinition.negatable) {
        throw new UsageError(`Flag --${name} does not support the --no-${name} form.`);
      }
      assignFlag(flags, name, false);
      continue;
    }
    if (flagDefinition.kind === 'boolean') {
      assignFlag(flags, name, inlineValue === undefined ? true : parseBooleanValue(name, inlineValue));
      continue;
    }
    if (inlineValue !== undefined) {
      if (inlineValue.length === 0) throw new UsageError(`Missing value for --${name}.`);
      assignFlag(flags, name, inlineValue);
      continue;
    }
    const next = tokens[index + 1];
    if (!next || next.startsWith('-')) throw new UsageError(`Missing value for --${name}.`);
    assignFlag(flags, name, next);
    flagLocations[name]!.valueIndex = tokenOffset + index + 1;
    index += 1;
  }
  return { parsed: { command, subcommand, positional, flags }, positionalIndices, flagLocations };
}

export function validateCommandPositionals(parsed: ParsedArgs): void {
  const { command, subcommand, positional } = parsed;
  if (!command) return;
  const definition = commandDefinitions[command];
  if (!definition) throw new UsageError(`Unknown command: ${command}.`);
  const maximum = subcommand
    ? definition.subcommandMaxPositionals?.[subcommand] ?? 0
    : definition.defaultMaxPositionals;
  if (positional.length > maximum) {
    throw new UsageError(
      `Too many positional arguments for ${command}${subcommand ? ` ${subcommand}` : ''}. ` +
      `Usage: liftoff ${command}${definition.usage ? ` ${definition.usage}` : ''}`
    );
  }
  if (command === 'help' && positional[0] && !commandDefinitions[positional[0]]) {
    throw new UsageError(`Unknown command for help: ${positional[0]}.`);
  }
}

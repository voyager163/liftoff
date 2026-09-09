import type { ParsedArgs } from '../../domain/project/contracts.js';
import { commandDefinitions } from './definitions.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function assignFlag(
  flags: ParsedArgs['flags'],
  name: string,
  value: string | boolean
): void {
  if (Object.hasOwn(flags, name)) {
    throw new UsageError(`Flag --${name} may be provided only once.`);
  }
  flags[name] = value;
}

function parseBooleanValue(name: string, value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new UsageError(`Flag --${name} expects true or false.`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { positional: [], flags: {} };
  }
  if (argv[0] === '--help') {
    return { command: 'help', positional: [], flags: {} };
  }
  if (argv[0] === '--version') {
    return { command: 'version', positional: [], flags: {} };
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

  const positional: string[] = [];
  const flags: ParsedArgs['flags'] = {};
  let positionalOnly = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith('-')) {
      positional.push(token);
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
        throw new UsageError(
          `Flag --${rawName} was removed because Power Apps code apps are retired and unsupported.`
        );
      }
      if (command === 'update' && name === 'apply') {
        const legacyForceRequested =
          flags.force === true ||
          tokens.slice(index + 1).some((candidate) =>
            candidate === '--force' || candidate === '--force=true'
          );
        throw new UsageError(
          legacyForceRequested
            ? 'Flag --apply was removed. Replace this command with `liftoff update --force`, ' +
              'or use `liftoff update --check` for a read-only managed-core check.'
            : 'Flag --apply was removed. Run `liftoff update` to apply safe managed-core changes or ' +
              '`liftoff update --check` for a read-only managed-core check.'
        );
      }
      throw new UsageError(`Unknown flag for ${command}: --${rawName}.`);
    }

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
      if (inlineValue.length === 0) {
        throw new UsageError(`Missing value for --${name}.`);
      }
      assignFlag(flags, name, inlineValue);
      continue;
    }

    const next = tokens[index + 1];
    if (!next || next.startsWith('-')) {
      throw new UsageError(`Missing value for --${name}.`);
    }
    assignFlag(flags, name, next);
    index += 1;
  }

  if (command === 'update' && flags.check === true && flags.force === true) {
    throw new UsageError(
      'Flags --check and --force cannot be combined. Run `liftoff update --check` ' +
        'to inspect managed-core drift or `liftoff update --force` to overwrite core conflicts.'
    );
  }

  if (command === 'governance') {
    if (Object.hasOwn(flags, 'live') && subcommand !== 'assess') {
      throw new UsageError('Flag --live is allowed only for `liftoff governance assess`.');
    }
    if (subcommand === 'assess') {
      if (Object.hasOwn(flags, 'execute')) {
        throw new UsageError('Flag --execute is not allowed for read-only `liftoff governance assess`.');
      }
      if (positional.length > 0 && Object.hasOwn(flags, 'project')) {
        throw new UsageError('Provide the assessment project either positionally or with --project, not both.');
      }
    }
  }

  const maxPositionals = subcommand
    ? definition.subcommandMaxPositionals?.[subcommand] ?? 0
    : definition.defaultMaxPositionals;
  if (positional.length > maxPositionals) {
    throw new UsageError(
      `Too many positional arguments for ${command}${subcommand ? ` ${subcommand}` : ''}. ` +
        `Usage: liftoff ${command}${definition.usage ? ` ${definition.usage}` : ''}`
    );
  }
  if (command === 'help' && positional[0] && !commandDefinitions[positional[0]]) {
    throw new UsageError(`Unknown command for help: ${positional[0]}.`);
  }

  return { command, subcommand, positional, flags };
}

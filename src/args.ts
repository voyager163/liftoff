import type { ParsedArgs } from './types.js';

type FlagKind = 'boolean' | 'value';

interface FlagDefinition {
  kind: FlagKind;
  negatable?: boolean;
}

export interface CommandDefinition {
  description: string;
  usage: string;
  flags: Readonly<Record<string, FlagDefinition>>;
  subcommands?: readonly string[];
  defaultMaxPositionals: number;
  subcommandMaxPositionals?: Readonly<Record<string, number>>;
}

const booleanFlag = (negatable = false): FlagDefinition => ({ kind: 'boolean', negatable });
const valueFlag = (): FlagDefinition => ({ kind: 'value' });
const helpFlag = { help: booleanFlag() };

const projectFlags = {
  project: valueFlag(),
  genai: booleanFlag(true),
  api: valueFlag(),
  pattern: valueFlag(),
  cloud: valueFlag(),
  region: valueFlag(),
  frontend: booleanFlag(true),
  environments: valueFlag(),
  spec: valueFlag(),
  config: valueFlag()
} as const;

export const commandDefinitions: Readonly<Record<string, CommandDefinition>> = {
  help: {
    description: 'Show general or command-specific help',
    usage: '[command]',
    flags: helpFlag,
    defaultMaxPositionals: 1
  },
  create: {
    description: 'Generate a new project',
    usage: '[project-name]',
    flags: { ...projectFlags, yes: booleanFlag(), ...helpFlag },
    defaultMaxPositionals: 1
  },
  plan: {
    description: 'Preview generated artifacts',
    usage: '',
    flags: { ...projectFlags, ...helpFlag },
    defaultMaxPositionals: 0
  },
  patterns: {
    description: 'List GenAI patterns',
    usage: '',
    flags: helpFlag,
    defaultMaxPositionals: 0
  },
  providers: {
    description: 'List cloud providers',
    usage: '',
    flags: helpFlag,
    defaultMaxPositionals: 0
  },
  regions: {
    description: 'List or search provider regions',
    usage: '[search <query>]',
    flags: { cloud: valueFlag(), region: valueFlag(), ...helpFlag },
    subcommands: ['search'],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { search: 1 }
  },
  validate: {
    description: 'Validate a generated project manifest',
    usage: '[project-path]',
    flags: { project: valueFlag(), ...helpFlag },
    defaultMaxPositionals: 1
  },
  update: {
    description: 'Reconcile a project with current templates',
    usage: '[project-path]',
    flags: {
      project: valueFlag(),
      apply: booleanFlag(),
      force: booleanFlag(),
      json: booleanFlag(),
      ...helpFlag
    },
    defaultMaxPositionals: 1
  },
  migrate: {
    description: 'Adopt an existing project',
    usage: '<source-path>',
    flags: { ...projectFlags, yes: booleanFlag(), ...helpFlag },
    defaultMaxPositionals: 1
  },
  doctor: {
    description: 'Check local and project readiness',
    usage: '',
    flags: { cloud: valueFlag(), json: booleanFlag(), ...helpFlag },
    defaultMaxPositionals: 0
  },
  dev: {
    description: 'Print Docker Compose helper commands',
    usage: '[up|down|logs|reset]',
    flags: { profile: valueFlag(), ...helpFlag },
    subcommands: ['up', 'down', 'logs', 'reset'],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { up: 0, down: 0, logs: 0, reset: 0 }
  },
  infra: {
    description: 'Print OpenTofu helper commands',
    usage: '[init|plan|apply|output]',
    flags: { env: valueFlag(), ...helpFlag },
    subcommands: ['init', 'plan', 'apply', 'output'],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { init: 0, plan: 0, apply: 0, output: 0 }
  }
};

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

  const command = argv[0];
  if (command.startsWith('-')) {
    throw new UsageError(`Unknown option: ${command}. Run \`liftoff help\` for usage.`);
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

export function formatCommandHelp(command: string): string {
  const definition = commandDefinitions[command];
  if (!definition) {
    throw new UsageError(`Unknown command for help: ${command}.`);
  }
  const lines = [
    `${command} - ${definition.description}`,
    '',
    `Usage: liftoff ${command}${definition.usage ? ` ${definition.usage}` : ''}`
  ];
  if (definition.subcommands) {
    lines.push('', `Subcommands: ${definition.subcommands.join(', ')}`);
  }
  const flagNames = Object.entries(definition.flags).map(([name, flag]) => {
    const value = flag.kind === 'value' ? ' <value>' : '';
    const negated = flag.negatable ? ` / --no-${name}` : '';
    return `  --${name}${value}${negated}`;
  });
  if (flagNames.length > 0) {
    lines.push('', 'Options:', ...flagNames);
  }
  return `${lines.join('\n')}\n`;
}

export function readStringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function readBooleanFlag(flags: ParsedArgs['flags'], name: string): boolean | undefined {
  const value = flags[name];
  return typeof value === 'boolean' ? value : undefined;
}

export function readListFlag(flags: ParsedArgs['flags'], name: string): string[] | undefined {
  const value = flags[name];
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value;
  }
  return undefined;
}

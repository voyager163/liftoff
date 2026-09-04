import type { ParsedArgs } from './types.js';
import { canonicalDefaultEnvironmentIds } from './catalogs.js';

type FlagKind = 'boolean' | 'value';
export type CommandGroup = 'Onboarding' | 'Maintenance' | 'Reference' | 'Operations';
export type FlagGroup = 'Project' | 'Framework' | 'Consent' | 'Output' | 'General' | 'Command';

export interface FlagDefinition {
  kind: FlagKind;
  negatable?: boolean;
  description: string;
  metavar?: string;
  defaultValue?: string;
  group: FlagGroup;
}

export interface CommandDefinition {
  description: string;
  usage: string;
  group: CommandGroup;
  flags: Readonly<Record<string, FlagDefinition>>;
  arguments?: readonly ArgumentDefinition[];
  subcommands?: readonly string[];
  defaultMaxPositionals: number;
  subcommandMaxPositionals?: Readonly<Record<string, number>>;
}

export interface ArgumentDefinition {
  syntax: string;
  description: string;
}

export interface HelpEntry {
  syntax: string;
  description: string;
  defaultValue?: string;
}

export interface HelpGroup {
  title: string;
  entries: HelpEntry[];
}

export interface GeneralHelpModel {
  version: string;
  title: string;
  subtitle: string;
  usage: string;
  globalOptions: HelpEntry[];
  commandGroups: HelpGroup[];
  hint: string;
}

export interface CommandHelpModel {
  command: string;
  description: string;
  usage: string;
  arguments: HelpEntry[];
  subcommands: string[];
  optionGroups: HelpGroup[];
}

const booleanFlag = (
  description: string,
  group: FlagGroup,
  negatable = false,
  defaultValue?: string
): FlagDefinition => ({ kind: 'boolean', description, group, negatable, ...(defaultValue ? { defaultValue } : {}) });
const valueFlag = (
  description: string,
  group: FlagGroup,
  metavar = 'value',
  defaultValue?: string
): FlagDefinition => ({ kind: 'value', description, group, metavar, ...(defaultValue ? { defaultValue } : {}) });
const helpFlag = { help: booleanFlag('Show command-specific help', 'General') };

const projectFlags = {
  project: valueFlag('Project name or project path', 'Project', 'path'),
  type: valueFlag('Project workload type', 'Project', 'workload'),
  genai: booleanFlag('Create a GenAI project; use --no-genai for a standard API', 'Project', true),
  api: valueFlag('Backend API stack', 'Project', 'stack'),
  pattern: valueFlag('GenAI application pattern', 'Project', 'pattern'),
  cloud: valueFlag('Cloud provider', 'Project', 'provider', 'azure'),
  region: valueFlag('Cloud deployment region', 'Project', 'region', 'eastus'),
  frontend: booleanFlag('Include the Vue frontend starter', 'Project', true, 'false'),
  environments: valueFlag('Comma-separated environments', 'Project', 'list', canonicalDefaultEnvironmentIds.join(',')),
  spec: valueFlag('Spec-driven framework', 'Framework', 'framework', 'openspec'),
  agents: valueFlag('Comma-separated AI coding agents', 'Framework', 'list', 'copilot'),
  'default-agent': valueFlag('Primary agent for Spec Kit when multiple agents are selected', 'Framework', 'agent'),
  governance: valueFlag(
    'Repository-governance profile',
    'Framework',
    'profile',
    'single-maintainer-gitflow'
  ),
  'code-apps-plugin': booleanFlag('Request the Microsoft Code Apps agent plugin (Preview)', 'Framework', true, 'false'),
  'copilot-cloud': booleanFlag(
    'Set up the GitHub-hosted Copilot coding agent for OpenSpec',
    'Framework',
    true,
    'false'
  ),
  'configure-openspec-profile': booleanFlag(
    'Authorize the required global OpenSpec workflow profile',
    'Consent'
  ),
  config: valueFlag('Load deterministic project options from JSON', 'Project', 'file')
} as const;

export const commandDefinitions: Readonly<Record<string, CommandDefinition>> = {
  help: {
    description: 'Show general or command-specific help',
    usage: '[command]',
    group: 'Reference',
    flags: helpFlag,
    arguments: [{ syntax: 'command', description: 'Command to describe' }],
    defaultMaxPositionals: 1
  },
  init: {
    description: 'Initialize a project and prepare its workstation',
    usage: '[project-name]',
    group: 'Onboarding',
    flags: {
      ...projectFlags,
      yes: booleanFlag('Accept project defaults and plan confirmation', 'Consent'),
      force: booleanFlag('Authorize replacement of listed regular-file conflicts', 'Consent'),
      'install-tools': booleanFlag('Authorize allowlisted workstation tool installation', 'Consent'),
      'install-dependencies': booleanFlag('Authorize project-local dependency installation', 'Consent'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-name', description: 'Project identity or child directory name' }],
    defaultMaxPositionals: 1
  },
  plan: {
    description: 'Preview generated artifacts',
    usage: '',
    group: 'Onboarding',
    flags: { ...projectFlags, ...helpFlag },
    defaultMaxPositionals: 0
  },
  patterns: {
    description: 'List GenAI patterns',
    usage: '',
    group: 'Reference',
    flags: helpFlag,
    defaultMaxPositionals: 0
  },
  providers: {
    description: 'List cloud providers',
    usage: '',
    group: 'Reference',
    flags: helpFlag,
    defaultMaxPositionals: 0
  },
  regions: {
    description: 'List or search provider regions',
    usage: '[search <query>]',
    group: 'Reference',
    flags: {
      cloud: valueFlag('Cloud provider', 'Project', 'provider', 'azure'),
      region: valueFlag('Exact region identifier', 'Project', 'region'),
      ...helpFlag
    },
    subcommands: ['search'],
    arguments: [{ syntax: 'query', description: 'Region name, slug, geography, or alias to search' }],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { search: 1 }
  },
  validate: {
    description: 'Validate a generated project manifest',
    usage: '[project-path]',
    group: 'Maintenance',
    flags: {
      project: valueFlag('Project path', 'Project', 'path'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Generated project to validate' }],
    defaultMaxPositionals: 1
  },
  update: {
    description: 'Reconcile Liftoff-managed core files in a project',
    usage: '[project-path]',
    group: 'Maintenance',
    flags: {
      project: valueFlag('Project path', 'Project', 'path'),
      check: booleanFlag('Report drift without changing project files', 'Command'),
      force: booleanFlag('Replace modified managed files', 'Consent'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Generated project to reconcile' }],
    defaultMaxPositionals: 1
  },
  upgrade: {
    description: 'Replace the supported global npm Liftoff CLI; project templates use update separately',
    usage: '',
    group: 'Maintenance',
    flags: {
      check: booleanFlag('Check for an installable stable CLI update without changing anything', 'Command'),
      json: booleanFlag('Emit one machine-readable result object', 'Output'),
      ...helpFlag
    },
    defaultMaxPositionals: 0
  },
  migrate: {
    description: 'Adopt an existing project',
    usage: '<source-path>',
    group: 'Onboarding',
    flags: {
      ...projectFlags,
      yes: booleanFlag('Accept project defaults and plan confirmation', 'Consent'),
      force: booleanFlag('Retained for parity; never overrides the fresh migration target guard', 'Consent'),
      'install-tools': booleanFlag('Authorize allowlisted workstation tool installation', 'Consent'),
      'install-dependencies': booleanFlag('Authorize project-local dependency installation', 'Consent'),
      ...helpFlag
    },
    arguments: [{ syntax: 'source-path', description: 'Existing application to migrate without modifying it' }],
    defaultMaxPositionals: 1
  },
  doctor: {
    description: 'Check local and project readiness',
    usage: '',
    group: 'Maintenance',
    flags: {
      cloud: valueFlag('Cloud provider to inspect', 'Project', 'provider', 'azure'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    defaultMaxPositionals: 0
  },
  governance: {
    description: 'Inspect deterministic governance activation',
    usage: '<status|plan|apply-next|resume|verify> [project-path]',
    group: 'Operations',
    flags: {
      project: valueFlag('Liftoff project path', 'Project', 'path'),
      execute: booleanFlag('Execute the reviewed governance apply-next plan; required for any mutation', 'Consent'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    subcommands: ['status', 'plan', 'apply-next', 'resume', 'verify'],
    arguments: [{ syntax: 'project-path', description: 'Liftoff project to inspect' }],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: {
      status: 1,
      plan: 1,
      'apply-next': 1,
      resume: 1,
      verify: 1
    }
  },
  dev: {
    description: 'Print Docker Compose helper commands',
    usage: '[up|down|logs|reset]',
    group: 'Operations',
    flags: { profile: valueFlag('Docker Compose profile', 'Command', 'name'), ...helpFlag },
    subcommands: ['up', 'down', 'logs', 'reset'],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { up: 0, down: 0, logs: 0, reset: 0 }
  },
  infra: {
    description: 'Print OpenTofu helper commands',
    usage: '[init|plan|apply|output]',
    group: 'Operations',
    flags: { env: valueFlag('Target environment', 'Command', 'environment', 'dev'), ...helpFlag },
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

function flagSyntax(name: string, flag: FlagDefinition): string {
  const value = flag.kind === 'value' ? ` <${flag.metavar ?? 'value'}>` : '';
  const negated = flag.negatable ? ` / --no-${name}` : '';
  return `--${name}${value}${negated}`;
}

export function getCommandHelp(command: string): CommandHelpModel {
  const definition = commandDefinitions[command];
  if (!definition) {
    throw new UsageError(`Unknown command for help: ${command}.`);
  }
  const groupedFlags = Object.entries(definition.flags).reduce((groups, entry) => {
    const group = entry[1].group;
    const entries = groups.get(group) ?? [];
    entries.push(entry);
    groups.set(group, entries);
    return groups;
  }, new Map<FlagGroup, Array<[string, FlagDefinition]>>());
  return {
    command,
    description: definition.description,
    usage: `liftoff ${command}${definition.usage ? ` ${definition.usage}` : ''}`,
    arguments: (definition.arguments ?? []).map((argument) => ({
      syntax: argument.syntax,
      description: argument.description
    })),
    subcommands: [...(definition.subcommands ?? [])],
    optionGroups: [...groupedFlags].map(([group, entries]) => ({
      title: `${group} options`,
      entries: entries.map(([name, flag]) => ({
        syntax: flagSyntax(name, flag),
        description: flag.description,
        ...(flag.defaultValue ? { defaultValue: flag.defaultValue } : {})
      }))
    }))
  };
}

export function formatCommandHelp(command: string): string {
  const help = getCommandHelp(command);
  const lines = [
    `${help.command} - ${help.description}`,
    '',
    `Usage: ${help.usage}`
  ];
  if (help.arguments.length > 0) {
    lines.push('', 'Arguments:');
    const width = Math.max(...help.arguments.map((argument) => argument.syntax.length));
    for (const argument of help.arguments) {
      lines.push(`  ${argument.syntax.padEnd(width)}  ${argument.description}`);
    }
  }
  if (help.subcommands.length > 0) {
    lines.push('', `Subcommands: ${help.subcommands.join(', ')}`);
  }
  for (const group of help.optionGroups) {
    lines.push('', `${group.title}:`);
    const width = Math.max(...group.entries.map((entry) => entry.syntax.length));
    for (const entry of group.entries) {
      const defaultValue = entry.defaultValue ? ` (default: ${entry.defaultValue})` : '';
      lines.push(`  ${entry.syntax.padEnd(width)}  ${entry.description}${defaultValue}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const commandGroupOrder: CommandGroup[] = ['Onboarding', 'Maintenance', 'Reference', 'Operations'];

export function getGeneralHelp(version: string): GeneralHelpModel {
  const commandGroups = commandGroupOrder.flatMap((group): HelpGroup[] => {
    const entries = Object.entries(commandDefinitions)
      .filter(([, definition]) => definition.group === group)
      .map(([command, definition]) => ({
        syntax: command,
        description: definition.description
      }));
    return entries.length > 0 ? [{ title: group, entries }] : [];
  });
  return {
    version,
    title: `Mission Control Liftoff ${version}`,
    subtitle: 'Initialize a governed application and prepare its local workstation.',
    usage: 'liftoff <command> [options]',
    globalOptions: [
      { syntax: '--version', description: 'Show the installed Liftoff version' },
      { syntax: '--help', description: 'Show general help' }
    ],
    commandGroups,
    hint: 'Run `liftoff help <command>` for command-specific usage.'
  };
}

export function formatGeneralHelp(version: string): string {
  const help = getGeneralHelp(version);
  const lines = [
    help.title,
    help.subtitle,
    '',
    `Usage: ${help.usage}`,
    '',
    'Global options:'
  ];
  const globalWidth = Math.max(...help.globalOptions.map((option) => option.syntax.length));
  for (const option of help.globalOptions) {
    lines.push(`  ${option.syntax.padEnd(globalWidth)}  ${option.description}`);
  }
  for (const group of help.commandGroups) {
    const width = Math.max(...group.entries.map((entry) => entry.syntax.length));
    lines.push('', `${group.title}:`);
    for (const entry of group.entries) {
      lines.push(`  ${entry.syntax.padEnd(width)}  ${entry.description}`);
    }
  }
  lines.push('', help.hint);
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

import { booleanFlag, commandDefinitions, helpFlag } from './definitions.js';
import { UsageError } from './parser.js';
import type { CommandDefinition, CommandGroup, CommandHelpModel, FlagDefinition, FlagGroup, GeneralHelpModel, HelpGroup } from './contracts.js';

function flagSyntax(name: string, flag: FlagDefinition): string {
  const value = flag.kind === 'value' ? ` <${flag.metavar ?? 'value'}>` : '';
  const negated = flag.negatable ? ` / --no-${name}` : '';
  return `--${name}${value}${negated}`;
}

export function getCommandHelp(command: string, subcommand?: string): CommandHelpModel {
  const assessment = command === 'governance' && subcommand === 'assess';
  const definition: CommandDefinition | undefined = assessment
    ? {
        description: 'Read-only comparison against the installed CLI policy, activation identity, and control catalog. Local-only by default: no network or credentials required. Exit 0: aligned or explicitly disabled (not-applicable); 2: partial coverage or differences, including approved exceptions; 1: invalid or unsafe input. This is not setup, an upgrade, or permission to remediate.',
        usage: '[project-path] [--json] [--live]',
        group: 'Operations',
        flags: {
          project: commandDefinitions.governance.flags.project,
          live: booleanFlag('Opt into bounded repository/resource-scoped GitHub/Azure reads using existing permissions; denied or unavailable proof stays not-observed', 'Consent'),
          json: booleanFlag('Emit the schema-v1 report with pinned target, findings, provenance, and coverage to stdout; never write state or evidence', 'Output'),
          ...helpFlag
        },
        arguments: commandDefinitions.governance.arguments,
        defaultMaxPositionals: 1
      }
    : command === 'update'
      ? {
          ...commandDefinitions.update,
          description:
            'Start with `liftoff update --check`, then run `liftoff update` to approve the matching ' +
            'effective plan (default: no). Check leaves project bytes unchanged and saves a project-bound ' +
            'receipt in user-local liftoff/update-previews storage outside the repository; the receipt ' +
            'is not approval. Apply needs the same checkout and receipt store. Noninteractive apply ' +
            'requires --approve-plan; force and JSON are not consent. Production files, history, and ' +
            'provisioning collisions remain protected; force cannot bypass compatibility. ' +
            'Current updates target manifest v8 and bind captured configuration without changing recorded ' +
            'workload, workflow, agents, profile or layout. Pending updates never recover implicitly: ' +
            'use `liftoff update <project> --recover --approve-plan <saved-fingerprint>`. ' +
            'Exit 0: clean or approved scope completed; 2: drift or committed migration with incomplete ' +
            'revalidation; 1: rejected or failed operation.'
        }
      : command === 'governance'
        ? {
            ...commandDefinitions.governance,
            description:
              'Historical projects retain schema-2 planning and execution. V8 projects retain ' +
              'schema-3 status, resume and verify inspection; recorded phases are not current proof. ' +
              'An exact --revalidation-publication selects existing successor proof, never approval ' +
              'or execution. Verify exits 0 for complete or inapplicable selected scope, 2 for ' +
              'consistent incomplete work, and 1 for inspection failure. ' +
              'For separate schema-4 v8 verification, select --scope local --local-operation verify: ' +
              'plan --inputs <request.json>, approve --plan <fingerprint> --inputs <consent.json>, ' +
              'then apply-next --plan <fingerprint> --execute. Planning probes installed tools and saves ' +
              'an external preview; approval separately saves consent. Without --execute, apply-next ' +
              'only inspects saved progress. Keep public request and consent files outside the project. ' +
              'Initialized OpenSpec requires explicit generated-baseline scope attestation; it is not ' +
              'domain verification; the private workspace is not a sandbox. Separate schema-5 completion ' +
              'uses --local-operation finalize for admitted Manual/Spec Kit verification, then ' +
              '--local-operation publish for exact target review, independent approval and execution. ' +
              'Both require their own closed --inputs for plan/approve and exact --plan for apply-next. ' +
              'For publication, governance recover --plan <fingerprint> --execute recovers only that attributed transaction; ' +
              'without --execute it only inspects saved progress. Failure does not imply rollback. ' +
              'Separate schema-6 --local-operation revalidate-successor constructs or reviews exact records ' +
              'from completed verification of an existing supported successor; it requires independent ' +
              'publication approval and explicit execution/recovery. Committed incomplete revalidation ' +
              'stays active and exits 2. No successor creation, OpenSpec finalization, provider or ' +
              'whole-directory rollback authority is granted. Local operations otherwise exit 0 for a ' +
              'completed requested operation or nonexecuting inspection, and 1 for refusal, failure, or uncertainty.'
          }
        : commandDefinitions[command];
  if (!definition) {
    throw new UsageError(`Unknown command for help: ${command}.`);
  }
  const helpCommand = assessment ? 'governance assess' : command;
  const groupedFlags = Object.entries(definition.flags).reduce((groups, entry) => {
    const group = entry[1].group;
    const entries = groups.get(group) ?? [];
    entries.push(entry);
    groups.set(group, entries);
    return groups;
  }, new Map<FlagGroup, Array<[string, FlagDefinition]>>());
  return {
    command: helpCommand,
    description: definition.description,
    usage: `liftoff ${helpCommand}${definition.usage ? ` ${definition.usage}` : ''}`,
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

export function formatCommandHelp(command: string, subcommand?: string): string {
  const help = getCommandHelp(command, subcommand);
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

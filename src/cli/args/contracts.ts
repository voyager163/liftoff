export type FlagKind = 'boolean' | 'value';
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

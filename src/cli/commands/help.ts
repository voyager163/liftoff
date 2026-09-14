import {
  getCommandHelp,
  getGeneralHelp
} from '../args/help.js';
import {
  PresentationSession
} from '../../terminal.js';
import {
  liftoffVersion
} from '../../version.js';

export function renderGeneralHelp(presentation: PresentationSession): void {
  const help = getGeneralHelp(liftoffVersion);
  presentation.identity(`${help.title} - ${help.subtitle}`);
  presentation.section('Usage', [help.usage]);
  presentation.table(
    'Global options',
    ['Option', 'Description'],
    help.globalOptions.map((option) => [option.syntax, option.description])
  );
  for (const group of help.commandGroups) {
    presentation.table(
      group.title,
      ['Command', 'Description'],
      group.entries.map((entry) => [entry.syntax, entry.description])
    );
  }
  presentation.status('info', 'Tip', help.hint);
}

export function renderCommandHelp(
  command: string,
  presentation: PresentationSession,
  subcommand?: string
): void {
  const help = getCommandHelp(command, subcommand);
  presentation.commandIdentity(help.command, help.description);
  presentation.section('Usage', [
    presentation.stdout.layout === 'plain' ? `Usage: ${help.usage}` : help.usage
  ]);
  if (help.arguments.length > 0) {
    presentation.table(
      'Arguments',
      ['Argument', 'Description'],
      help.arguments.map((argument) => [argument.syntax, argument.description])
    );
  }
  if (help.subcommands.length > 0) {
    presentation.bullets('Subcommands', help.subcommands);
  }
  for (const group of help.optionGroups) {
    presentation.table(
      group.title,
      ['Option', 'Description'],
      group.entries.map((entry) => [
        entry.syntax,
        `${entry.description}${entry.defaultValue ? ` (default: ${entry.defaultValue})` : ''}`
      ])
    );
  }
  if (command === 'repair') {
    presentation.bullets('Repair approval and native help', [
      'Ordinary liftoff repair displays exact proposed effects, then asks Yes/No with default No on genuine interactive terminals. No fingerprint entry is needed.',
      '--check only previews. Bare JSON/non-TTY repair never prompts or executes. Exact execution flags are optional automation interfaces; --yes and --force cannot authorize repair.',
      'Application patches separately request consent for exact project checks, locked private dependency preparation, declared network effects, and file commit. Lifecycle hooks stay suppressed; unsupported enabling blocks. Staging is not an OS or network sandbox.',
      'Preparation uses existing compatible tools and exact candidate locks, never global installation/configuration or live dependency trees. Only explicit preparation previews probe installed tool identities; capabilities and layout inventory do not.',
      'Recovery cleans only authenticated CLI-created disposable workspace identities with safely established ownership; never patch staging, live projects, global caches or original-byte backups. Earlier approved effects remain visible after later cancellation.',
      'Open the selected project in Copilot or Claude and invoke /liftoff-repair; in Codex use $liftoff-repair or its skill picker. These are coding-agent integrations, not shell commands.',
      'If the native integration is missing, run liftoff update --check for that project and review its separate managed update. See docs/cli-reference.md#repair-modes.'
    ]);
  }
}

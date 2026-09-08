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
}

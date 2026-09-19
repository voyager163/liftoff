import {
  readBooleanFlag
} from '../args/readers.js';
import {
  patterns
} from '../../application/project/catalog.js';
import {
  InteractiveCancelledError
} from '../../interactive.js';
import {
  PlanValidationError
} from '../../domain/project/planning.js';
import {
  PresentationSession
} from '../../terminal.js';
import type {
  CommandContext,
  ExecutionContext
} from '../../application/context.js';
import {
  patternsCommand,
  providersCommand,
  regionsCommand
} from '../../cli/commands/reference.js';
import {
  governanceCommand
} from '../../governance-activation/commands.js';
import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import {
  liftoffVersion
} from '../../version.js';
import {
  doctorCommand,
  validateCommand
} from './diagnose.js';
import {
  helperCommand
} from './helpers.js';
import {
  renderCommandHelp,
  renderGeneralHelp
} from './help.js';
import {
  initializeCommand
} from './initialize.js';
import {
  migrateCommand
} from './migrate.js';
import {
  planCommand
} from './plan.js';
import {
  updateCommand
} from './update.js';
import {
  upgradeCommand
} from './upgrade.js';
import {
  installationCommand
} from './installation.js';
import { repairCommand } from './repair.js';
import { skillsCommand } from './skills.js';
import { adoptCommand } from './adopt.js';
import { assessCommand } from './assess.js';
import { capabilitiesCommand } from './capabilities.js';
import { commandDefinitions } from '../args/definitions.js';
import { composeExecutionContext } from '../../application/engine-composition.js';

export async function runCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const helpRequested = parsed.command !== undefined && readBooleanFlag(parsed.flags, 'help') === true;
  const jsonMode = !helpRequested && parsed.command !== undefined &&
    Object.hasOwn(commandDefinitions[parsed.command]?.flags ?? {}, 'json') &&
    readBooleanFlag(parsed.flags, 'json') === true;
  const presentation = new PresentationSession({
    stdout: context.stdout,
    stderr: context.stderr,
    ...context.terminal,
    json: jsonMode
  });
  const executionContext: ExecutionContext = { ...context, presentation };
  let runtime: Promise<ExecutionContext> | undefined;
  const runtimeContext = () => runtime ??= composeExecutionContext(context, presentation);
  try {
    if (parsed.command && readBooleanFlag(parsed.flags, 'help')) {
      renderCommandHelp(parsed.command, presentation, parsed.subcommand);
      return 0;
    }
    switch (parsed.command) {
      case undefined:
      case 'help':
      case '--help':
        if (parsed.positional[0]) {
          renderCommandHelp(parsed.positional[0], presentation);
        } else {
          renderGeneralHelp(presentation);
        }
        return 0;
      case 'version':
        presentation.rawStdout(`Liftoff ${liftoffVersion}\n`);
        return 0;
      case 'capabilities':
        return await capabilitiesCommand(parsed, executionContext);
      case 'init':
        return await initializeCommand(parsed, await runtimeContext());
      case 'plan':
        return await planCommand(parsed, await runtimeContext());
      case 'patterns':
        return patternsCommand(executionContext);
      case 'providers':
        return providersCommand(executionContext);
      case 'regions':
        return regionsCommand(parsed, executionContext);
      case 'validate':
        return await validateCommand(parsed, await runtimeContext());
      case 'update':
        return await updateCommand(parsed, await runtimeContext());
      case 'repair':
        return await repairCommand(parsed, await runtimeContext());
      case 'upgrade':
        return await upgradeCommand(parsed, await runtimeContext());
      case 'installation':
        return await installationCommand(parsed, await runtimeContext());
      case 'skills':
        return await skillsCommand(parsed, await runtimeContext());
      case 'adopt':
        return await adoptCommand(parsed, await runtimeContext());
      case 'assess':
        return await assessCommand(parsed, await runtimeContext());
      case 'migrate':
        return await migrateCommand(parsed, await runtimeContext());
      case 'doctor':
        return await doctorCommand(parsed, await runtimeContext());
      case 'governance':
        return await governanceCommand(parsed, await runtimeContext());
      case 'dev':
        return await helperCommand(parsed, executionContext, 'docker compose');
      case 'infra':
        return await helperCommand(parsed, executionContext, 'tofu');
      default:
        presentation.error(
          `Unknown command: ${parsed.command}`,
          'Run `liftoff help` to list available commands.'
        );
        return 1;
    }
  } catch (error) {
    if (error instanceof InteractiveCancelledError) {
      presentation.cancellation('Interactive operation stopped.');
      return 0;
    }
    if (error instanceof PlanValidationError) {
      presentation.error(
        error.issues.join('\n'),
        parsed.command ? `Run \`liftoff ${parsed.command} --help\` to review accepted values.` : undefined
      );
      return 1;
    }
    presentation.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

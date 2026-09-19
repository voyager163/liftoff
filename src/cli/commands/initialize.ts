import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import { optionsFromParsedArgs } from '../project-options.js';

export async function initializeCommand(
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> {
  context.presentation.identity('Initialize the project and prepare its workstation');
  const engines = await getApplicationEngines(context);
  return engines['project-generation'].initializeProject(await optionsFromParsedArgs(parsed, context.cwd, true), context);
}

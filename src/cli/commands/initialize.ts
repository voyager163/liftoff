import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import {
  initializeProject
} from '../../application/initialize/use-case.js';
import { optionsFromParsedArgs } from '../project-options.js';

export async function initializeCommand(
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> {
  context.presentation.identity('Initialize the project and prepare its workstation');
  return initializeProject(await optionsFromParsedArgs(parsed, context.cwd, true), context);
}

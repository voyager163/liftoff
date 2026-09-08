import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import {
  migrateProject
} from '../../application/migrate/use-case.js';
import { optionsFromParsedArgs } from '../project-options.js';

export async function migrateCommand(
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> {
  const source = parsed.positional[0];
  const options = source ? await optionsFromParsedArgs(parsed, context.cwd, false) : {};
  return migrateProject({ source, options }, context);
}

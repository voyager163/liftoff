import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

export const doctorCommand = async (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => (await getApplicationEngines(context))['standards-assessment'].diagnoseProject({
  json: readBooleanFlag(parsed.flags, 'json') ?? false,
  cloud: readStringFlag(parsed.flags, 'cloud')
}, context);

export const validateCommand = async (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => (await getApplicationEngines(context))['standards-assessment'].validateProject({
  json: readBooleanFlag(parsed.flags, 'json') ?? false,
  project: parsed.positional[0] ?? readStringFlag(parsed.flags, 'project')
}, context);

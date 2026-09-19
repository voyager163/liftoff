import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

export const updateCommand = async (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => (await getApplicationEngines(context))['project-evolution'].updateProject({
  check: readBooleanFlag(parsed.flags, 'check') ?? false,
  approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
  force: readBooleanFlag(parsed.flags, 'force') ?? false,
  jsonMode: readBooleanFlag(parsed.flags, 'json') ?? false,
  project: parsed.positional[0] ?? readStringFlag(parsed.flags, 'project')
}, context);

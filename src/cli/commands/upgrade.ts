import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import { readBooleanFlag } from '../args/readers.js';

export const upgradeCommand = async (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => (await getApplicationEngines(context)).distribution.upgradeLiftoff({
  mode: readBooleanFlag(parsed.flags, 'check') === true ? 'check' : 'apply',
  json: readBooleanFlag(parsed.flags, 'json') === true
}, context);

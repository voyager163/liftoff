import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import {
  upgradeLiftoff
} from '../../application/upgrade/use-case.js';
import { readBooleanFlag } from '../args/readers.js';

export const upgradeCommand = (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => upgradeLiftoff({
  mode: readBooleanFlag(parsed.flags, 'check') === true ? 'check' : 'apply',
  json: readBooleanFlag(parsed.flags, 'json') === true
}, context);

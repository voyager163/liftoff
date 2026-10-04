import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import {
  updateCurrentProject
} from '../../application/update/current-use-case.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

export const updateCommand = (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => updateCurrentProject({
  check: readBooleanFlag(parsed.flags, 'check') ?? false,
  recover: readBooleanFlag(parsed.flags, 'recover') ?? false,
  approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
  force: readBooleanFlag(parsed.flags, 'force') ?? false,
  jsonMode: readBooleanFlag(parsed.flags, 'json') ?? false,
  project: parsed.positional[0] ?? readStringFlag(parsed.flags, 'project')
}, context);

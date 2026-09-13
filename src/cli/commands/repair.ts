import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import { repairProject } from '../../application/repair/use-case.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

export async function repairCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  return repairProject({
    project: readStringFlag(parsed.flags, 'project') ?? parsed.positional[0],
    check: readBooleanFlag(parsed.flags, 'check') === true,
    live: readBooleanFlag(parsed.flags, 'live') === true,
    subscription: readStringFlag(parsed.flags, 'subscription'),
    approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
    recover: readBooleanFlag(parsed.flags, 'recover') === true,
    json: readBooleanFlag(parsed.flags, 'json') === true
  }, context);
}

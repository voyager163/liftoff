import type { ExecutionContext } from '../../application/context.js';
import { setProjectWorkflow } from '../../application/workflow-transition/use-case.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import {
  readBooleanFlag,
  readListFlag,
  readStringFlag
} from '../args/readers.js';

export function workflowCommand(
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> {
  return setProjectWorkflow({
    subcommand: parsed.subcommand,
    target: parsed.positional[0],
    project: readStringFlag(parsed.flags, 'project') ?? parsed.positional[1],
    agents: readListFlag(parsed.flags, 'agents'),
    defaultAgent: readStringFlag(parsed.flags, 'default-agent'),
    check: readBooleanFlag(parsed.flags, 'check') === true,
    approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
    recover: readBooleanFlag(parsed.flags, 'recover') === true,
    installTools:
      readBooleanFlag(parsed.flags, 'install-tools') === true,
    configureOpenSpecProfile:
      readBooleanFlag(
        parsed.flags,
        'configure-openspec-profile'
      ) === true,
    json: readBooleanFlag(parsed.flags, 'json') === true
  }, context);
}

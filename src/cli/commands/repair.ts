import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import { repairProject } from '../../application/repair/use-case.js';
import {
  readBooleanFlag,
  readListFlag,
  readStringFlag
} from '../args/readers.js';

export async function repairCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  return repairProject({
    project: readStringFlag(parsed.flags, 'project') ?? parsed.positional[0],
    check: readBooleanFlag(parsed.flags, 'check') === true,
    live: readBooleanFlag(parsed.flags, 'live') === true,
    subscription: readStringFlag(parsed.flags, 'subscription'),
    approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
    capabilities: readBooleanFlag(parsed.flags, 'capabilities') === true,
    inspectLayout: readBooleanFlag(parsed.flags, 'inspect-layout') === true,
    applicationPatch: readStringFlag(parsed.flags, 'application-patch'),
    verifyPlan: readStringFlag(parsed.flags, 'verify-plan'),
    allowNetwork: readBooleanFlag(parsed.flags, 'allow-network') === true,
    allowDependencyPreparation: readBooleanFlag(parsed.flags, 'allow-dependency-preparation') === true,
    agents: readListFlag(parsed.flags, 'agents'),
    defaultAgent: readStringFlag(parsed.flags, 'default-agent'),
    installTools: readBooleanFlag(parsed.flags, 'install-tools') === true,
    configureOpenSpecProfile:
      readBooleanFlag(
        parsed.flags,
        'configure-openspec-profile'
      ) === true,
    recover: readBooleanFlag(parsed.flags, 'recover') === true,
    json: readBooleanFlag(parsed.flags, 'json') === true
  }, context);
}

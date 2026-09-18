import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

export async function repairCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  return (await getApplicationEngines(context))['project-evolution'].repairProject({
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
    recover: readBooleanFlag(parsed.flags, 'recover') === true,
    recipe: readStringFlag(parsed.flags, 'recipe'),
    json: readBooleanFlag(parsed.flags, 'json') === true
  }, context);
}

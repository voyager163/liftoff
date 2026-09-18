import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';
import { getApplicationEngines } from '../../application/engine-composition.js';

export async function adoptCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const allowed = new Set(['project', 'profile', 'component', 'proposal', 'check', 'approve-plan', 'verify-plan', 'allow-dependency-preparation', 'allow-network', 'recover', 'json']);
  if (Object.keys(parsed.flags).some((flag) => !allowed.has(flag)) ||
    parsed.positional.length > 1 || parsed.positional.length > 0 && parsed.flags.project !== undefined) {
    throw new Error('Adoption accepts one explicit project boundary and only its documented exact-plan flags; force, generic Yes and other operation permissions are not supported.');
  }
  return (await getApplicationEngines(context))['project-evolution'].adoptProject({
    project: readStringFlag(parsed.flags, 'project') ?? parsed.positional[0],
    profile: readStringFlag(parsed.flags, 'profile'),
    component: readStringFlag(parsed.flags, 'component'),
    proposal: readStringFlag(parsed.flags, 'proposal'),
    check: readBooleanFlag(parsed.flags, 'check') === true,
    approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
    verifyPlan: readStringFlag(parsed.flags, 'verify-plan'),
    allowDependencyPreparation: readBooleanFlag(parsed.flags, 'allow-dependency-preparation') === true,
    allowNetwork: readBooleanFlag(parsed.flags, 'allow-network') === true,
    recover: readBooleanFlag(parsed.flags, 'recover') === true,
    json: readBooleanFlag(parsed.flags, 'json') === true
  }, context);
}

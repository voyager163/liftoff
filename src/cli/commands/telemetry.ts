import type { ExecutionContext } from '../../application/context.js';
import { runProjectTelemetry } from '../../application/telemetry/project-reporting.js';
import { runHeartbeat } from '../../application/telemetry/heartbeat.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

export async function telemetryCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const operation = parsed.subcommand;
  if (operation === 'heartbeat') {
    const action = parsed.positional[0];
    if (action !== 'status' && action !== 'enable' && action !== 'disable') throw new Error('Select heartbeat status, enable, or disable.');
    return runHeartbeat({
      operation: action, project: parsed.positional[1] ?? readStringFlag(parsed.flags, 'project'),
      repository: readStringFlag(parsed.flags, 'repository'),
      check: readBooleanFlag(parsed.flags, 'check') === true,
      approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
      json: readBooleanFlag(parsed.flags, 'json') === true
    }, context);
  }
  if (operation !== 'status' && operation !== 'enroll' && operation !== 'disable' && operation !== 'report') {
    throw new Error('Select telemetry status, enroll, disable, report, or heartbeat.');
  }
  return runProjectTelemetry({
    operation, project: parsed.positional[0] ?? readStringFlag(parsed.flags, 'project'),
    repository: readStringFlag(parsed.flags, 'repository'),
    check: readBooleanFlag(parsed.flags, 'check') === true,
    approvePlan: readStringFlag(parsed.flags, 'approve-plan'),
    preserveIdentity: readBooleanFlag(parsed.flags, 'preserve-identity') === true,
    newIdentity: readBooleanFlag(parsed.flags, 'new-identity') === true,
    heartbeat: readBooleanFlag(parsed.flags, 'heartbeat') === true,
    json: readBooleanFlag(parsed.flags, 'json') === true
  }, context);
}

import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import { sanitizeAssessmentText } from '../../domain/governance/assessment/sanitize.js';

export async function capabilitiesCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const json = parsed.flags.json === true;
  try {
    const { buildPublicCapabilitiesEnvelope } = await import('../../application/engine-composition.js');
    const capabilities = buildPublicCapabilitiesEnvelope();
    if (json) {
      context.presentation.rawStdout(`${JSON.stringify(capabilities, null, 2)}\n`);
    } else {
      context.presentation.commandIdentity('capabilities', 'Installed capability and command-contract declarations');
      context.presentation.table(
        'Capability owners',
        ['Capability', 'Engine', 'Availability'],
        capabilities.capabilities.map((capability) => [
          capability.id, capability.owner, capability.qualificationState
        ])
      );
      context.presentation.status(
        'info', 'Authority',
        'Discovery performs no operation and supplies no approval. Capability availability does not establish coordinated release qualification.'
      );
    }
    return 0;
  } catch (error) {
    const message = sanitizeAssessmentText(error instanceof Error ? error.message : String(error), 1024);
    if (json) {
      context.presentation.rawStdout(`${JSON.stringify({
        schemaVersion: 1, kind: 'liftoff-capabilities-error', ok: false,
        code: 'capability-discovery-failed', message
      })}\n`);
    } else {
      context.presentation.error(message, 'Use an intact supported Liftoff installation; discovery does not repair or replace it.');
    }
    return 1;
  }
}

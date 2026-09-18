import type { ParsedArgs } from '../../domain/project/contracts.js';
import type { ExecutionContext } from '../../application/context.js';
import {
  type SkillsCommandFailure,
  type SkillsCommandResult,
  type SkillsUseCaseDependencies
} from '../../application/skills/use-case.js';
import { getApplicationEngines } from '../../application/engine-composition.js';
import { validateSkillsCommandRequest } from '../../application/skills/request.js';
import { formatSkillsPlan, formatSkillsRecovery, formatRegisteredSkillMigrationPlan, formatSkillsFollowUps } from '../../application/skills/output.js';
import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';

function renderResult(result: SkillsCommandResult): string {
  switch (result.outcome) {
    case 'listed':
      return [
        `Canonical Liftoff Skills (${result.result.skills.length} workflows):`,
        ...result.result.skills.map((skill) => `  ${skill.id.padEnd(20)} [${skill.owningEngine}] ${skill.description}`),
        '',
        'Select delivery hosts explicitly: liftoff skills plan --host <copilot,claude,codex>',
        ''
      ].join('\n');
    case 'planned':
    case 'blocked-plan':
      return formatSkillsPlan(result.result) + (result.outcome === 'planned' && result.authorization === 'required'
        ? 'Preview only. No writes occurred; use genuine terminal approval or --approve-plan with this complete fingerprint.\n' : '');
    case 'inspected':
      return [
        `Inspected ${result.result.managedCount} managed skills at ${result.result.targetRoot}:`,
        ...result.result.projections.map(({ record, status }) => `  ${record.relativeDestination}: ${status} [${record.consumers.join(', ')}]`),
        ...result.result.legacyIntegrations.map((entry) => `  Preserved ${entry.relativeDestination}: ${entry.ownership} (${entry.logicalName})`),
        ...(result.result.transaction.status === 'absent' ? [] : [formatSkillsRecovery(result.result.transaction)]),
        ''
      ].join('\n');
    case 'executed':
    case 'migration-executed':
      return [
        result.result.message,
        `Committed files changed: ${result.result.fileChangeCount}; ownership entries changed: ${result.result.ownershipChangeCount}.`,
        `Committed: ${result.result.committed}; verified: ${result.result.verified}; uncertain: ${result.result.uncertain}.`,
        `Fingerprint: ${result.result.planFingerprint}`,
        ...(result.result.recovery.status === 'not-required' ? [] : [
          `Recovery: ${result.result.recovery.status}; journal: ${result.result.recovery.journalPath}`,
          ...result.result.recovery.rollbackFailures, ...result.result.recovery.cleanupFailures,
          ...result.result.recovery.destinations.map((entry) =>
            `  ${entry.pathParts.join('/')}: ${entry.attempted ? 'attempted' : 'not attempted'}, currently ${entry.disposition}`)
        ]),
        ''
      ].join('\n');
    case 'migration-planned':
      return formatRegisteredSkillMigrationPlan(result.result) + (result.authorization === 'required'
        ? 'Preview only; approve this exact registered migration before any writes.\n' : '');
    case 'migration-blocked':
    case 'migration-not-required':
    case 'migration-update-required':
      return [
        result.outcome === 'migration-blocked'
          ? 'Project skill transport inspection is blocked; no files or manifest identities were changed.'
          : result.outcome === 'migration-update-required'
            ? 'A registered historical integration transition requires managed update and its separate approval. No skills migration effects occurred.'
            : 'No project skill transport move is required. Native paths, logical identities, and invocations were retained without writes.',
        result.result.transportPolicy,
        ...(result.outcome === 'migration-update-required' && result.reason ? [result.reason] : []),
        ...result.result.blockers,
        ...result.result.items.map((item) => `  ${item.oldLogicalId} at ${item.oldPath}: ${item.action}. ${item.reason}`),
        ...result.result.registeredTransitions.map((transition) =>
          `  ${transition.sourceLogicalId} (${transition.sourcePath}) → ${transition.targetLogicalId} (${transition.targetPath}): ${transition.status}. ${transition.reason}`),
        ...result.result.nextActions.map((next) =>
          `Separate managed-update preview (not authorized by skills migration): ${formatShellCommand({
            executable: next.executable, args: [...next.args]
          }, commandShellForPlatform(process.platform))}`),
        ''
      ].join('\n');
    case 'recovery-required':
      return formatSkillsRecovery(result.result);
    case 'recovered':
      return [
        `Original skills transaction recovery: ${result.result.status}. Committed: ${result.result.committed}.`,
        `Verified: ${result.result.verified}; uncertain: ${result.result.uncertain}.`,
        ...result.result.rollbackFailures, ...result.result.cleanupFailures,
        'No new operation was started. Review a fresh plan for any remaining requested work.',
        ''
      ].join('\n');
  }
}

export async function skillsCommand(
  parsed: ParsedArgs,
  context: ExecutionContext,
  dependencies: SkillsUseCaseDependencies = {}
): Promise<number> {
  const json = parsed.flags.json === true;
  try {
    const options = validateSkillsCommandRequest(parsed);
    const result = await (await getApplicationEngines(context)).distribution.executeSkillsUseCase(options, context, dependencies);
    context.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderResult(result) + formatSkillsFollowUps(result));
    return result.exitCode;
  } catch (error) {
    const result: SkillsCommandFailure = {
      schemaVersion: 1, command: 'skills',
      ...(parsed.subcommand === undefined ? {} : { requestedSubcommand: parsed.subcommand }),
      outcome: 'invalid', ok: false, exitCode: 1,
      result: { message: error instanceof Error ? error.message : String(error) }
    };
    if (json) context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else context.stderr.write(`Error: ${result.result.message}\n`);
    return result.exitCode;
  }
}

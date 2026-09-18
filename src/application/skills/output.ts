import type { SkillDeliveryPlan } from '../../domain/skills/contracts.js';
import type { ReviewedUpdateTransactionInspection } from '../../adapters/filesystem/reviewed-update-transaction.js';
import type { RegisteredSkillMigrationPlan } from './registered-migration.js';
import type { SkillsFollowUps } from './continuations.js';

export function formatSkillsFollowUps(result: Partial<SkillsFollowUps>): string {
  const lines = [
    ...(result.nextActions ?? []).flatMap((action) => [
      `Separate next action${action.requiredAuthority?.length ? ` (requires ${action.requiredAuthority.join(', ')})` : ' (read-only)'}`,
      action.displayCommand
    ]),
    ...(result.nextActionGuidance ?? []).flatMap((guidance) => [
      `Nonexecuting guidance: ${guidance.message}`,
      ...(guidance.context?.userInstallTarget ? [`Observed user target: ${guidance.context.userInstallTarget}`] : [])
    ])
  ];
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

export function formatSkillsPlan(plan: SkillDeliveryPlan): string {
  return [
    `Skills ${plan.intent} Plan (${plan.scope}) for ${plan.targetRoot}`,
    `Plan Fingerprint: ${plan.fingerprint}`,
    `Review expires: ${plan.expiresAt}`,
    '',
    ...plan.overlappingDiscoveryDisclosures.map((disclosure) => `Note: ${disclosure}`),
    ...plan.blockers.map((blocker) => `BLOCKED: ${blocker}`),
    ...plan.actions.map((action) =>
      `  [${action.action}] ${action.relativeDestination} [${action.consumers.join(', ') || 'no remaining consumers'}]${action.reason ? ` — ${action.reason}` : ''}`),
    '',
    'Only exact file/ownership effects are reviewed. Host discovery and provider qualification are separate.',
    ''
  ].join('\n');
}

export function formatSkillsRecovery(pending: ReviewedUpdateTransactionInspection): string {
  return [
    `Skills transaction recovery: ${pending.status}`,
    `Journal: ${pending.journalPath}`,
    ...(pending.planFingerprint ? [`Original plan: ${pending.planFingerprint}`] : []),
    ...pending.destinations.map((destination) => `  ${destination.pathParts.join('/')}: ${destination.disposition}`),
    ...(pending.reason ? [pending.reason] : []),
    'Recovery handles only the original sealed transaction; it does not start a new plan.',
    ''
  ].join('\n');
}

export function formatRegisteredSkillMigrationPlan(plan: RegisteredSkillMigrationPlan): string {
  return [
    `Registered project skill alias retirement for ${plan.projectRoot}`,
    `Plan Fingerprint: ${plan.fingerprint}`,
    `Review expires: ${plan.expiresAt}`,
    'Existing native integrations will not move or be overwritten.',
    ...plan.sources.map((source) =>
      `  Retire ${source.logicalName} (${source.pathParts.join('/')}); retain ${source.replacementLogicalName} (${source.replacementPathParts.join('/')}).`),
    'Exact effects, including immutable original history and the reader-validated manifest:',
    ...plan.effects.map((effect) => `  [${effect.type}] ${effect.pathParts.join('/')} (${effect.afterHash ?? 'absence'})`),
    'Approval covers only this registered local inventory, not project code, Git, providers, or host qualification.',
    ''
  ].join('\n');
}

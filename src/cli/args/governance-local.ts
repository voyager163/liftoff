import type { ParsedArgs } from '../../domain/project/contracts.js';
import { isUpdatePlanFingerprint } from '../../application/update/approval.js';

export function modernLocalOperationIssue({ subcommand, flags }: Pick<ParsedArgs, 'subcommand' | 'flags'>): string | undefined {
  if (!Object.hasOwn(flags, 'local-operation')) return undefined;
  const operation = flags['local-operation'];
  if (operation !== 'verify' && operation !== 'finalize' && operation !== 'publish' && operation !== 'revalidate-successor') {
    return 'Flag --local-operation accepts only verify, finalize, publish, or revalidate-successor.';
  }
  const commands = operation === 'publish' || operation === 'revalidate-successor'
    ? ['plan', 'approve', 'apply-next', 'recover'] : ['plan', 'approve', 'apply-next'];
  if (!commands.includes(subcommand ?? '')) {
    return `Flag --local-operation ${operation} requires governance ${commands.join(', ')}.`;
  }
  if (['revalidation-publication', 'recover-phase', 'protected-stdin', 'live'].some(flag => Object.hasOwn(flags, flag))) {
    return 'Local operations accept no activation, inspection-only publication, credential, live, or implicit recovery selectors.';
  }
  if (flags.help === true) return undefined;
  if (flags.scope !== 'local') return `Flag --local-operation ${operation} requires explicit --scope local.`;
  if (subcommand !== 'apply-next' && subcommand !== 'recover' && Object.hasOwn(flags, 'execute')) {
    return 'Local execution requires apply-next or explicit publication recovery, never plan or approve.';
  }
  if (subcommand === 'plan' && Object.hasOwn(flags, 'plan')) return 'Local plan creates a new request; it does not accept --plan.';
  if (subcommand === 'approve' && !isUpdatePlanFingerprint(flags.plan)) return 'Local approve requires the exact --plan fingerprint.';
  if (subcommand === 'apply-next' || subcommand === 'recover') {
    if (Object.hasOwn(flags, 'inputs')) return `Local ${subcommand} uses the saved request and consent; do not supply --inputs.`;
    if (!isUpdatePlanFingerprint(flags.plan)) return `Local ${subcommand} requires --plan with the exact reviewed fingerprint.`;
  } else if (typeof flags.inputs !== 'string' || !flags.inputs.trim()) {
    return 'Local plan and approve require --inputs with an explicit public request or consent JSON file.';
  }
  return undefined;
}

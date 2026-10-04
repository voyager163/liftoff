import type { ParsedArgs } from '../../domain/project/contracts.js';
import { isUpdatePlanFingerprint } from '../../application/update/approval.js';

export function modernLocalOperationIssue({ subcommand, flags }: Pick<ParsedArgs, 'subcommand' | 'flags'>): string | undefined {
  if (!Object.hasOwn(flags, 'local-operation')) return undefined;
  if (flags['local-operation'] !== 'verify') return 'Flag --local-operation accepts only verify.';
  if (!['plan', 'approve', 'apply-next'].includes(subcommand ?? '')) {
    return 'Flag --local-operation verify requires governance plan, approve, or apply-next.';
  }
  if (['revalidation-publication', 'recover-phase', 'protected-stdin', 'live'].some(flag => Object.hasOwn(flags, flag))) {
    return 'Local verification accepts no activation, recovery, credential, live, or publication selectors.';
  }
  if (flags.help === true) return undefined;
  if (flags.scope !== 'local') return 'Flag --local-operation verify requires explicit --scope local.';
  if (subcommand !== 'apply-next' && Object.hasOwn(flags, 'execute')) return 'Local execution requires apply-next, never plan or approve.';
  if (subcommand === 'plan' && Object.hasOwn(flags, 'plan')) return 'Local plan creates a new request; it does not accept --plan.';
  if (subcommand === 'approve' && !isUpdatePlanFingerprint(flags.plan)) return 'Local approve requires the exact --plan fingerprint.';
  if (subcommand === 'apply-next') {
    if (Object.hasOwn(flags, 'inputs')) return 'Local apply-next uses the saved request and consent; do not supply --inputs.';
    if (!isUpdatePlanFingerprint(flags.plan)) return 'Local apply-next requires --plan with the exact reviewed preview fingerprint.';
  } else if (typeof flags.inputs !== 'string' || !flags.inputs.trim()) {
    return 'Local plan and approve require --inputs with an explicit public request or consent JSON file.';
  }
  return undefined;
}

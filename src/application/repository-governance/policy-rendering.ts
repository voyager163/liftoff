import { validateGovernancePolicy, assertGovernanceContentSafe } from '../../domain/governance/policy/content-validation.js';
import { suppliedPolicy } from '../../adapters/packaged-assets/governance-policy.js';

export function renderCanonicalGovernancePolicy(): string {
  const rendered = suppliedPolicy;
  validateGovernancePolicy(rendered);
  assertGovernanceContentSafe(rendered);
  return `${rendered.trimEnd()}\n`;
}

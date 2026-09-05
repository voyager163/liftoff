import { readFileSync } from 'node:fs';
import { canonicalSha256, sha256Hex } from '../governance-activation/canonical-json.js';
import { canonicalPhaseGraphHash, currentActivationIdentity } from '../governance-activation/graph.js';
import { phaseIds } from '../governance-activation/types.js';
import { liftoffVersion } from '../version.js';
import { renderCanonicalGovernancePolicy, governancePolicyVersion } from '../repository-governance.js';
import { isRecord, jsonValue } from './sanitize.js';
import type { AssessmentCatalog, AssessmentTarget, ControlDefinition, Layer, Ownership, Severity } from './types.js';

export const evaluatorIds = [
  'identity', 'managed-core', 'default-branch', 'protected-refs', 'single-maintainer', 'no-codeowners',
  'tag-controls', 'required-contexts', 'push-protection', 'workflow-permissions', 'action-pinning',
  'fail-open-flags', 'pipeline', 'environments', 'runner', 'providers', 'storage', 'network',
  'evidence', 'documentation', 'unsupported'
] as const;
export const policyFamilies = [
  'azure', 'deployment', 'documentation', 'dora', 'environments', 'evidence', 'gitflow',
  'governance', 'health', 'identity', 'monitoring', 'promotion', 'release', 'retention', 'rollback',
  'runner', 'security'
] as const;

function keys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label} has missing or unknown fields.`);
  }
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const found = values.find((entry) => entry === value);
  if (!found) throw new Error(`${label} is unsupported.`);
  return found;
}
function list<T extends string>(value: unknown, values: readonly T[], label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result = value.map((entry) => choice(entry, values, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate entries.`);
  return result;
}

export function validateAssessmentCatalog(value: unknown, policyDigest = sha256Hex(renderCanonicalGovernancePolicy())): AssessmentCatalog {
  if (!isRecord(value)) throw new Error('Assessment catalog must be an object.');
  keys(value, ['schemaVersion', 'profile', 'policyVersion', 'policyDigest', 'families', 'controls'], 'Assessment catalog');
  if (value.schemaVersion !== 1 || value.profile !== 'single-maintainer-gitflow' ||
      value.policyVersion !== governancePolicyVersion || value.policyDigest !== policyDigest) {
    throw new Error('Assessment catalog does not match the installed policy identity/digest.');
  }
  const families = list(value.families, policyFamilies, 'Assessment catalog families');
  if (families.length !== policyFamilies.length || !Array.isArray(value.controls) || value.controls.length === 0) {
    throw new Error('Assessment catalog coverage is empty or missing policy families.');
  }
  const controls: ControlDefinition[] = value.controls.map((entry) => {
    if (!isRecord(entry)) throw new Error('Assessment control must be an object.');
    keys(entry, ['id', 'title', 'policySection', 'severity', 'applicability', 'evaluator', 'proofLayers',
      'expected', 'phaseIds', 'supported', 'exceptionAllowed', 'ownership', 'recommendation'], 'Assessment control');
    const id = text(entry.id, 'Control id');
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/u.test(id) || !families.some((family) => family === id.split('.')[0])) {
      throw new Error(`Invalid assessment control id ${id}.`);
    }
    const evaluator = choice(entry.evaluator, evaluatorIds, 'Control evaluator');
    const proofLayers = list<Layer>(entry.proofLayers, ['recorded', 'declared', 'live', 'evidence'], 'Control proof layers');
    if (!proofLayers.length || typeof entry.supported !== 'boolean' || typeof entry.exceptionAllowed !== 'boolean' ||
        entry.supported === (evaluator === 'unsupported')) {
      throw new Error(`Control ${id} must explicitly declare valid proof and evaluator coverage.`);
    }
    return {
      id, title: text(entry.title, 'Control title'), policySection: text(entry.policySection, 'Policy section'),
      severity: choice<Severity>(entry.severity, ['info', 'warning', 'error'], 'Severity'),
      applicability: choice(entry.applicability, ['always', 'api', 'private-dast', 'state-path'] as const, 'Applicability'),
      evaluator, proofLayers, expected: jsonValue(entry.expected),
      phaseIds: list(entry.phaseIds, phaseIds, 'Phase references'),
      supported: entry.supported, exceptionAllowed: entry.exceptionAllowed,
      ownership: choice<Ownership>(entry.ownership, ['managed-core', 'project-owned', 'remote', 'external-authority'], 'Ownership'),
      recommendation: text(entry.recommendation, 'Recommendation')
    };
  });
  if (new Set(controls.map((control) => control.id)).size !== controls.length ||
      families.some((family) => !controls.some((control) => control.id.startsWith(`${family}.`)))) {
    throw new Error('Assessment catalog has duplicate control IDs or uncovered policy families.');
  }
  return { schemaVersion: 1, profile: 'single-maintainer-gitflow', policyVersion: governancePolicyVersion, policyDigest, families, controls };
}

export function loadAssessmentCatalog(): { catalog: AssessmentCatalog; target: AssessmentTarget } {
  const catalog = validateAssessmentCatalog(JSON.parse(readFileSync(
    new URL('../../assets/governance/single-maintainer-gitflow/assessment-controls.json', import.meta.url), 'utf8'
  )));
  return {
    catalog,
    target: {
      cliVersion: liftoffVersion, profile: catalog.profile, policyVersion: catalog.policyVersion,
      policyDigest: catalog.policyDigest, activationIdentity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash, catalogSchemaVersion: 1, catalogDigest: canonicalSha256(catalog)
    }
  };
}

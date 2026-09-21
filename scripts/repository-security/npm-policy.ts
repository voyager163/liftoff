import {
  evaluateTemplateDependencyAudits, normalizeNpmAuditReport, parseTemplateDependencyPolicy,
  templateDependencyInventory
} from '../template-dependency-security.mjs';
import { canonicalDigest, type PolicyAdapter, type RawFinding } from './admission.ts';
import { SecurityEvidenceError } from './evidence.ts';

export interface NpmAuditInput {
  entry: { id: string; label: string; pathParts: string[] };
  auditReport: unknown;
}

interface NpmFinding {
  advisoryId: string;
  package: string;
  manifestPathParts: string[];
  severity: string;
  dependencyChains: string[][];
  vulnerableRange?: string;
  affectedNodes: string[];
}

interface NpmException {
  advisoryId: string;
  package: string;
  manifestPathParts: string[];
  dependencyChains: string[][];
  disposition: string;
  rationale: string;
  mitigation: string;
  owner: string;
  reviewedAt: string;
  reviewBy: string;
  upstreamReference?: string;
}

function orderedChains(chains: readonly string[][]): string[][] {
  return chains.map(chain => [...chain]).sort((left, right) => {
    const a = JSON.stringify(left), b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function exceptionIdentity(value: {
  advisoryId: string; package: string; manifestPathParts: readonly string[];
}) {
  return canonicalDigest({
    advisoryId: value.advisoryId.toUpperCase(), package: value.package,
    manifestPathParts: value.manifestPathParts
  });
}

export function npmRawFindings(inputs: readonly NpmAuditInput[]): RawFinding[] {
  try {
    const findings: NpmFinding[] = inputs.flatMap(({ entry, auditReport }) => normalizeNpmAuditReport(entry, auditReport));
    if (findings.some(finding => !['info', 'low', 'moderate', 'high', 'critical'].includes(finding.severity))) {
      throw new SecurityEvidenceError('unknown-npm-severity');
    }
    return findings.map(finding => ({
      key: canonicalDigest({
        advisoryId: finding.advisoryId, package: finding.package,
        manifestPathParts: finding.manifestPathParts, severity: finding.severity,
        dependencyChains: orderedChains(finding.dependencyChains),
        range: finding.vulnerableRange ?? null, affectedNodes: [...finding.affectedNodes].sort()
      }),
      kind: 'vulnerability' as const, confirmedUnremediated: false
    }));
  } catch {
    throw new SecurityEvidenceError('invalid-npm-observation');
  }
}

export function npmPolicyAdapter(inputs: readonly NpmAuditInput[]): PolicyAdapter {
  const raw = npmRawFindings(inputs);
  const normalized: NpmFinding[] = inputs.flatMap(({ entry, auditReport }) => normalizeNpmAuditReport(entry, auditReport));
  const keys = new Map(normalized.map((finding, index) => [exceptionIdentity(finding), raw[index]!.key]));
  return {
    parse(source, observed, now) {
      try {
        const policy: { schemaVersion: number; exceptions: NpmException[] } = parseTemplateDependencyPolicy(source, templateDependencyInventory);
        const result = evaluateTemplateDependencyAudits({
          auditResults: inputs, policy, today: now, resolvedAdvisories: []
        });
        const observedKeys = new Set(observed.map(finding => finding.key));
        const records = policy.exceptions.map(exception => {
          const identity = exceptionIdentity(exception);
          const findingKey = keys.get(identity) ?? canonicalDigest({ stale: identity });
          const reviewed = result.reviewed.some(item => exceptionIdentity(item.exception) === identity);
          return {
            findingKey,
            permissionDigest: canonicalDigest({
              ...exception, dependencyChains: orderedChains(exception.dependencyChains)
            }),
            kind: 'vulnerability' as const, valid: reviewed && observedKeys.has(findingKey),
            allowsFinding: reviewed && observedKeys.has(findingKey),
            incident: 'none' as const, incidentHistory: []
          };
        });
        const diagnostics = result.issues.filter(issue => issue.code !== 'unreviewed-finding').map(issue => issue.code);
        if (records.some(record => !observedKeys.has(record.findingKey)) && !diagnostics.includes('stale-exception')) {
          diagnostics.push('stale-exception');
        }
        return { records, diagnostics };
      } catch {
        throw new SecurityEvidenceError('invalid-npm-policy-data');
      }
    }
  };
}

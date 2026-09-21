import {
  adoptedBaseIdentity, canonicalDigest, readAdoptedPolicyData,
  type AdoptedBaseHandle, type ParsedPolicyData, type PolicyAdapter, type RawFinding
} from './admission.ts';
import {
  digest, findingDigest, identifier, parseVulnerabilityException, record,
  requireExceptionWindow, SecurityEvidenceError, type SecurityFinding
} from './evidence.ts';

export function vulnerabilityPolicyAdapter(findings: readonly SecurityFinding[]): PolicyAdapter {
  const known = new Map(findings.map(finding => [findingDigest(finding), finding]));
  return {
    parse(source: string, observed: readonly RawFinding[], now: Date): ParsedPolicyData {
      let parsed: unknown;
      try { parsed = JSON.parse(source); } catch { throw new SecurityEvidenceError('invalid-vulnerability-policy-json'); }
      const data = record(parsed, ['schemaVersion', 'exceptions'], 'invalid-vulnerability-policy');
      if (data.schemaVersion !== 1 || !Array.isArray(data.exceptions) || data.exceptions.length > 10_000) {
        throw new SecurityEvidenceError('invalid-vulnerability-policy');
      }
      const diagnostics: string[] = [];
      const observedKeys = new Set(observed.filter(item => item.kind !== 'secret').map(item => item.key));
      const records = data.exceptions.map(value => {
        const exception = parseVulnerabilityException(value);
        const finding = known.get(exception.findingDigest);
        const present = finding !== undefined && observedKeys.has(exception.findingDigest);
        let valid = present;
        if (finding) {
          try { requireExceptionWindow(exception, finding.severity, now); }
          catch (error) {
            if (!(error instanceof SecurityEvidenceError) || error.code !== 'invalid-exception-window') throw error;
            valid = false;
          }
        }
        if (!present) diagnostics.push('stale-exception');
        else if (!valid) diagnostics.push('invalid-exception-window');
        return {
          findingKey: exception.findingDigest, permissionDigest: canonicalDigest(exception),
          kind: 'vulnerability' as const, valid, allowsFinding: valid, incident: 'none' as const, incidentHistory: []
        };
      });
      return { records, diagnostics };
    }
  };
}

export interface KnownSecretFact {
  key: string;
  confirmedUnremediated: boolean;
  evidenceDigests: readonly string[];
  verifiedRemediationDigests: readonly string[];
}

const secretReasons = {
  unresolved: 'awaiting-triage',
  'confirmed-awaiting-remediation': 'credential-exposure-confirmed',
  'false-positive': 'pattern-is-not-a-credential',
  'nonfunctional-fixture': 'documented-nonfunctional-fixture',
  remediated: 'owner-verified-invalidation'
} as const;

export function secretDispositionAdapter(facts: readonly KnownSecretFact[]): PolicyAdapter {
  const known = new Map(facts.map(fact => {
    record(fact, ['key', 'confirmedUnremediated', 'evidenceDigests', 'verifiedRemediationDigests'], 'invalid-secret-fact');
    if (typeof fact.confirmedUnremediated !== 'boolean' || !Array.isArray(fact.evidenceDigests) ||
        !Array.isArray(fact.verifiedRemediationDigests) || fact.evidenceDigests.length > 1000 ||
        fact.verifiedRemediationDigests.length > 1000) throw new SecurityEvidenceError('invalid-secret-fact');
    const evidenceDigests = fact.evidenceDigests.map(digest);
    const verifiedRemediationDigests = fact.verifiedRemediationDigests.map(digest);
    if (verifiedRemediationDigests.some(value => !evidenceDigests.includes(value))) throw new SecurityEvidenceError('unbound-remediation-evidence');
    return [digest(fact.key), { ...fact, evidenceDigests, verifiedRemediationDigests }] as const;
  }));
  if (known.size !== facts.length) throw new SecurityEvidenceError('duplicate-secret-fact');
  return {
    parse(source, observed): ParsedPolicyData {
      let parsed: unknown;
      try { parsed = JSON.parse(source); } catch { throw new SecurityEvidenceError('invalid-secret-disposition-json'); }
      const data = record(parsed, ['schemaVersion', 'dispositions'], 'invalid-secret-disposition-data');
      if (data.schemaVersion !== 1 || !Array.isArray(data.dispositions) || data.dispositions.length > 1000) {
        throw new SecurityEvidenceError('invalid-secret-disposition-data');
      }
      const diagnostics: string[] = [];
      const observedKeys = new Set(observed.filter(item => item.kind === 'secret').map(item => item.key));
      const records = data.dispositions.map(value => {
        const item = record(value, ['findingKey', 'state', 'owner', 'rationale', 'evidenceDigests', 'incidentHistory'],
          'invalid-secret-disposition-record');
        const findingKey = digest(item.findingKey);
        const state = Object.keys(secretReasons).find(state => state === item.state) as keyof typeof secretReasons | undefined;
        if (!state || item.rationale !== secretReasons[state]) throw new SecurityEvidenceError('invalid-secret-disposition-state');
        identifier(item.owner, 'invalid-disposition-owner');
        if (!Array.isArray(item.evidenceDigests) || item.evidenceDigests.length === 0 || item.evidenceDigests.length > 100 ||
            !Array.isArray(item.incidentHistory) || item.incidentHistory.length > 1000) {
          throw new SecurityEvidenceError('invalid-disposition-evidence');
        }
        const evidence = item.evidenceDigests.map(digest), incidentHistory = item.incidentHistory.map(digest);
        if (new Set(evidence).size !== evidence.length || new Set(incidentHistory).size !== incidentHistory.length) {
          throw new SecurityEvidenceError('duplicate-disposition-evidence');
        }
        const fact = known.get(findingKey);
        const currentlyObserved = observedKeys.has(findingKey);
        const verifiedHistoricalRemediation = state === 'remediated' && fact?.confirmedUnremediated === false &&
          evidence.some(value => fact.verifiedRemediationDigests.includes(value)) && incidentHistory.length > 0;
        let valid = fact !== undefined && (currentlyObserved || verifiedHistoricalRemediation) &&
          evidence.every(value => fact.evidenceDigests.includes(value)) &&
          incidentHistory.every(value => fact.evidenceDigests.includes(value));
        if (state === 'false-positive' || state === 'nonfunctional-fixture') valid &&= fact?.confirmedUnremediated === false;
        if (state === 'confirmed-awaiting-remediation') valid &&= fact?.confirmedUnremediated === true;
        if (state === 'remediated') valid &&= fact?.confirmedUnremediated === false &&
          evidence.some(value => fact.verifiedRemediationDigests.includes(value)) && incidentHistory.length > 0;
        if (!valid) diagnostics.push('unverified-secret-disposition');
        const incident = state === 'confirmed-awaiting-remediation' ? 'confirmed' as const
          : state === 'remediated' ? 'remediated' as const : 'none' as const;
        const allowsFinding = valid && currentlyObserved && ['false-positive', 'nonfunctional-fixture', 'remediated'].includes(state);
        return { findingKey, permissionDigest: canonicalDigest(item), kind: 'secret' as const, valid, allowsFinding, incident, incidentHistory };
      });
      return { records, diagnostics };
    }
  };
}

export function adoptedSecretDispositionVerdict(
  base: AdoptedBaseHandle, policyId: string, facts: readonly KnownSecretFact[], observed: readonly RawFinding[], now: Date
) {
  const identity = adoptedBaseIdentity(base);
  const secretFindings = observed.filter(finding => finding.kind === 'secret');
  const known = new Map(facts.map(fact => [fact.key, fact]));
  if (known.size !== facts.length || new Set(secretFindings.map(finding => finding.key)).size !== secretFindings.length ||
      secretFindings.some(finding => known.get(finding.key)?.confirmedUnremediated !== finding.confirmedUnremediated)) {
    throw new SecurityEvidenceError('secret-fact-observation-mismatch');
  }
  const policy = secretDispositionAdapter(facts).parse(readAdoptedPolicyData(base, policyId), observed, now);
  const records = new Map(policy.records.map(record => [record.findingKey, record]));
  for (const fact of facts) {
    if (secretFindings.some(finding => finding.key === fact.key)) continue;
    const historical = records.get(fact.key);
    if (!historical?.valid || historical.incident !== 'remediated' || historical.allowsFinding) {
      throw new SecurityEvidenceError('secret-fact-observation-mismatch');
    }
  }
  const blocked = observed.filter(finding => finding.kind === 'secret' &&
    (finding.confirmedUnremediated || records.get(finding.key)?.allowsFinding !== true));
  return Object.freeze({
    kind: 'adopted-secret-policy-result' as const,
    authorityCommit: identity.baseCommit,
    authorityPolicyDigest: identity.policyDigest,
    passed: blocked.length === 0 && policy.diagnostics.length === 0,
    blocked: blocked.length,
    policyDiagnostics: policy.diagnostics.length,
    coverageQualified: false as const,
    publicationQualified: false as const
  });
}

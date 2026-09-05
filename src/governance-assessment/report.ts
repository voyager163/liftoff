import { canonicalJson, canonicalSha256 } from '../governance-activation/canonical-json.js';
import { phaseIds } from '../governance-activation/types.js';
import { validateActivationIdentity } from '../governance-activation/validators.js';
import { classifications } from './types.js';
import type {
  AssessmentDiagnostic, AssessmentFinding, AssessmentProjectIdentity, AssessmentReport,
  AssessmentTarget, Classification, ControlDefinition, FindingScope, JsonValue, Layer, Observation
} from './types.js';
import { containsSensitiveText, isRecord, jsonValue, notObserved, sanitizeAssessmentText } from './sanitize.js';

export function classifyFinding(input: {
  control: ControlDefinition;
  scope: FindingScope;
  expected?: JsonValue;
  applicability: AssessmentFinding['applicability'];
  observations: Partial<Record<Layer, Observation>>;
  difference?: 'outdated' | 'conflicting' | 'missing';
  exception?: AssessmentFinding['exception'];
}): AssessmentFinding {
  const { control } = input;
  const expected = input.expected ?? control.expected;
  const observations = { ...input.observations };
  for (const layer of control.proofLayers) {
    if (!observations[layer]) observations[layer] = notObserved(`No ${layer} proof was collected.`);
  }
  const missingProof = control.proofLayers.filter((layer) => observations[layer]?.availability === 'not-observed');
  const reasons = control.proofLayers.flatMap((layer) =>
    observations[layer]?.reason ? [`${layer}: ${observations[layer]!.reason}`] : []
  );
  let classification: Classification;
  let exception: AssessmentFinding['exception'] = null;
  if (input.applicability === 'inapplicable') {
    classification = 'inapplicable';
  } else if (input.applicability === 'unknown' || !control.supported) {
    classification = 'not-observed';
    reasons.push(input.applicability === 'unknown'
      ? 'Applicability has not been established from authoritative workload facts.'
      : 'This control has no supported assessment evaluator; required proof is not being inferred.');
  } else {
    const required = control.proofLayers.map((layer) => observations[layer]!);
    const absent = required.some((observation) => observation.availability === 'missing');
    const differs = required.some((observation) =>
      observation.availability === 'observed' && canonicalJson(observation.value) !== canonicalJson(expected)
    );
    classification = input.difference ?? (absent ? 'missing' : differs ? 'conflicting' : missingProof.length ? 'not-observed' : 'aligned');
    if (classification !== 'aligned' && classification !== 'not-observed' && missingProof.length === 0 &&
        input.exception && control.exceptionAllowed) {
      classification = 'approved-exception';
      exception = input.exception;
      reasons.push('The observed difference has an exact, current, scoped exception; it is not an exact target match.');
    } else if (classification === 'aligned') {
      reasons.push('All required observations match the installed target.');
    }
  }
  if (input.applicability === 'inapplicable') reasons.push('Validated workload facts exclude this control.');
  return {
    controlId: control.id, title: control.title, policySection: control.policySection, severity: control.severity,
    scope: input.scope, expected, applicability: input.applicability, classification, observations,
    requiredProof: [...control.proofLayers],
    missingProof: input.applicability === 'inapplicable' ? [] : missingProof,
    unsupported: !control.supported, reasons, affectedPhases: [...control.phaseIds], exception,
    recommendation: {
      ownership: control.ownership,
      approvalRequired: control.ownership !== 'managed-core',
      action: control.recommendation
    }
  };
}

export function reportCoverage(findings: readonly AssessmentFinding[]): AssessmentReport['coverage'] {
  const applicable = findings.filter((finding) => finding.applicability === 'applicable');
  return {
    total: findings.length,
    applicable: applicable.length,
    inapplicable: findings.filter((finding) => finding.applicability === 'inapplicable').length,
    unknownApplicability: findings.filter((finding) => finding.applicability === 'unknown').length,
    fullyObserved: applicable.filter((finding) => !finding.unsupported && finding.missingProof.length === 0 && finding.classification !== 'not-observed').length,
    unobserved: findings.filter((finding) => finding.applicability !== 'inapplicable' &&
      (finding.classification === 'not-observed' || finding.missingProof.length > 0)).length,
    unsupported: findings.filter((finding) => finding.applicability !== 'inapplicable' && finding.unsupported).length,
    differences: findings.filter((finding) => ['outdated', 'missing', 'conflicting', 'approved-exception'].includes(finding.classification)).length,
    approvedExceptions: findings.filter((finding) => finding.classification === 'approved-exception').length
  };
}

export function assembleAssessmentReport(input: {
  projectRoot: string;
  mode: 'local' | 'live';
  target: AssessmentTarget | null;
  projectIdentity: AssessmentProjectIdentity;
  snapshot: AssessmentReport['snapshot'];
  findings: AssessmentFinding[];
  diagnostics: AssessmentDiagnostic[];
  disabled?: boolean;
  failed?: boolean;
}): AssessmentReport {
  const findings = [...input.findings].sort((left, right) =>
    `${left.controlId}\0${canonicalJson(left.scope)}`.localeCompare(`${right.controlId}\0${canonicalJson(right.scope)}`, 'en')
  );
  const diagnostics = [...input.diagnostics].sort((a, b) =>
    `${a.code}\0${a.source ?? ''}\0${a.message}`.localeCompare(`${b.code}\0${b.source ?? ''}\0${b.message}`, 'en')
  );
  const coverage = reportCoverage(findings);
  const failed = input.failed || diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const outcome = failed ? 'error' : input.disabled ? 'not-applicable'
    : !input.snapshot.inputsStable || coverage.unknownApplicability > 0 || coverage.unobserved > 0 || coverage.unsupported > 0 ? 'partial'
    : coverage.differences > 0 ? 'differences' : findings.length === 0 ? 'error' : 'aligned';
  const report: AssessmentReport = {
    schemaVersion: 1, command: 'governance assess', readOnly: true, mode: input.mode,
    projectRoot: sanitizeAssessmentText(input.projectRoot), target: input.target,
    projectIdentity: input.projectIdentity, snapshot: input.snapshot, outcome,
    exitCode: outcome === 'error' ? 1 : outcome === 'aligned' || outcome === 'not-applicable' ? 0 : 2,
    coverage, findings, diagnostics, resultDigest: ''
  };
  report.resultDigest = canonicalSha256({ ...report, resultDigest: '' });
  return validateAssessmentReport(report);
}

function exact(value: unknown, fields: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value) || fields.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !fields.includes(key) && !optional.includes(key))) throw new Error(`${label} has invalid fields.`);
  return value;
}
function enumeration(value: unknown, options: readonly string[], label: string): void {
  if (typeof value !== 'string' || !options.includes(value)) throw new Error(`${label} is invalid.`);
}
function string(value: unknown, label: string, nullable = false): void {
  if ((nullable && value === null) || typeof value === 'string') return;
  throw new Error(`${label} must be a string${nullable ? ' or null' : ''}.`);
}
function strings(value: unknown, label: string, allowed?: readonly string[]): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || (allowed && !allowed.includes(entry)))) {
    throw new Error(`${label} must contain valid strings.`);
  }
}
function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
}
function digest(value: unknown, label: string, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
}
function timestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}
function validateObservation(value: unknown): void {
  const observation = exact(value, ['availability', 'value', 'source', 'reason'], 'Observation', ['facts']);
  enumeration(observation.availability, ['observed', 'missing', 'not-observed'], 'Observation availability');
  jsonValue(observation.value);
  if (observation.facts !== undefined) jsonValue(observation.facts);
  string(observation.reason, 'Observation reason', true);
  if (observation.source !== null) {
    const source = exact(observation.source, ['kind', 'location', 'digest', 'capturedAt', 'revision', 'line'], 'Observation source');
    enumeration(source.kind, ['package', 'file', 'git', 'evidence', 'github', 'azure'], 'Source kind');
    string(source.location, 'Source location');
    digest(source.digest, 'Source digest', true);
    timestamp(source.capturedAt, 'Source capture time');
    string(source.revision, 'Source revision', true);
    if (source.line !== null && (!Number.isInteger(source.line) || Number(source.line) < 1)) throw new Error('Source line is invalid.');
  } else if (observation.availability !== 'not-observed') {
    throw new Error('Observed facts or absence require provenance.');
  }
}

function assertAssessmentReport(value: unknown): asserts value is AssessmentReport {
  const report = exact(value, ['schemaVersion', 'command', 'readOnly', 'mode', 'projectRoot', 'target',
    'projectIdentity', 'snapshot', 'outcome', 'exitCode', 'coverage', 'findings', 'diagnostics', 'resultDigest'], 'Assessment report');
  if (report.schemaVersion !== 1 || report.command !== 'governance assess' || report.readOnly !== true) throw new Error('Assessment report identity is invalid.');
  enumeration(report.mode, ['local', 'live'], 'Assessment mode');
  enumeration(report.outcome, ['aligned', 'differences', 'partial', 'not-applicable', 'error'], 'Assessment outcome');
  string(report.projectRoot, 'Project root');
  if (report.target !== null) {
    const target = exact(report.target, ['cliVersion', 'profile', 'policyVersion', 'policyDigest', 'activationIdentity',
      'phaseGraphHash', 'catalogSchemaVersion', 'catalogDigest'], 'Target');
    if (target.profile !== 'single-maintainer-gitflow' || target.catalogSchemaVersion !== 1) throw new Error('Target identity is invalid.');
    for (const key of ['cliVersion', 'policyVersion']) string(target[key], `Target ${key}`);
    for (const key of ['policyDigest', 'phaseGraphHash', 'catalogDigest']) digest(target[key], `Target ${key}`);
    const identity = validateActivationIdentity(target.activationIdentity);
    if (identity.policyVersion !== target.policyVersion || identity.phaseGraphHash !== target.phaseGraphHash) throw new Error('Target version fields disagree.');
  }
  const identity = exact(report.projectIdentity, ['availability', 'manifestVersion', 'cliVersion', 'profile', 'policyVersion', 'recordedActivationIdentity', 'stateSource'], 'Project identity');
  enumeration(identity.availability, ['known', 'unsupported', 'unavailable'], 'Identity availability');
  enumeration(identity.stateSource, ['not-started', 'user', 'unsupported', 'unavailable'], 'State source');
  if (identity.manifestVersion !== null && !Number.isInteger(identity.manifestVersion)) throw new Error('Manifest version is invalid.');
  string(identity.cliVersion, 'Recorded CLI version', true);
  string(identity.profile, 'Recorded profile', true);
  string(identity.policyVersion, 'Recorded policy version', true);
  jsonValue(identity.recordedActivationIdentity);
  const snapshot = exact(report.snapshot, ['capturedAt', 'repository', 'localHead', 'worktreeDigest', 'inputsStable'], 'Snapshot');
  timestamp(snapshot.capturedAt, 'Snapshot capture time');
  digest(snapshot.worktreeDigest, 'Snapshot digest');
  for (const key of ['repository', 'localHead']) string(snapshot[key], `Snapshot ${key}`, true);
  boolean(snapshot.inputsStable, 'Snapshot stability');
  const counts = ['total', 'applicable', 'inapplicable', 'unknownApplicability', 'fullyObserved', 'unobserved', 'unsupported', 'differences', 'approvedExceptions'];
  const coverage = exact(report.coverage, counts, 'Coverage');
  for (const key of counts) if (!Number.isInteger(coverage[key]) || Number(coverage[key]) < 0) throw new Error(`Coverage ${key} is invalid.`);
  if (!Array.isArray(report.findings) || !Array.isArray(report.diagnostics)) throw new Error('Findings and diagnostics must be arrays.');
  for (const value of report.findings) {
    const finding = exact(value, ['controlId', 'title', 'policySection', 'severity', 'scope', 'expected', 'applicability',
      'classification', 'observations', 'requiredProof', 'missingProof', 'unsupported', 'reasons', 'affectedPhases', 'exception', 'recommendation'], 'Finding');
    for (const key of ['controlId', 'title', 'policySection']) string(finding[key], `Finding ${key}`);
    enumeration(finding.severity, ['info', 'warning', 'error'], 'Finding severity');
    enumeration(finding.applicability, ['applicable', 'inapplicable', 'unknown'], 'Finding applicability');
    enumeration(finding.classification, classifications, 'Finding classification');
    boolean(finding.unsupported, 'Finding support');
    jsonValue(finding.expected);
    strings(finding.requiredProof, 'Required proof', ['recorded', 'declared', 'live', 'evidence']);
    strings(finding.missingProof, 'Missing proof', ['recorded', 'declared', 'live', 'evidence']);
    strings(finding.reasons, 'Finding reasons');
    strings(finding.affectedPhases, 'Phase references', phaseIds);
    const scope = exact(finding.scope, ['repository', 'environment', 'resource'], 'Finding scope');
    for (const key of Object.keys(scope)) string(scope[key], `Scope ${key}`, true);
    if (!isRecord(finding.observations) || Object.keys(finding.observations).some((key) => !['recorded', 'declared', 'live', 'evidence'].includes(key))) {
      throw new Error('Finding observations are invalid.');
    }
    for (const observation of Object.values(finding.observations)) validateObservation(observation);
    if (finding.exception !== null) {
      const exception = exact(finding.exception, ['id', 'expiresAt', 'envelopeDigest'], 'Exception');
      for (const key of Object.keys(exception)) string(exception[key], `Exception ${key}`);
    }
    const recommendation = exact(finding.recommendation, ['ownership', 'approvalRequired', 'action'], 'Recommendation');
    enumeration(recommendation.ownership, ['managed-core', 'project-owned', 'remote', 'external-authority'], 'Recommendation ownership');
    boolean(recommendation.approvalRequired, 'Recommendation approval');
    string(recommendation.action, 'Recommendation action');
  }
  for (const value of report.diagnostics) {
    const diagnostic = exact(value, ['code', 'severity', 'message', 'source'], 'Diagnostic');
    string(diagnostic.code, 'Diagnostic code'); string(diagnostic.message, 'Diagnostic message');
    string(diagnostic.source, 'Diagnostic source', true);
    enumeration(diagnostic.severity, ['info', 'warning', 'error'], 'Diagnostic severity');
  }
  digest(report.resultDigest, 'Result digest');
}

export function validateAssessmentReport(value: unknown): AssessmentReport {
  assertAssessmentReport(value);
  if (canonicalJson(reportCoverage(value.findings)) !== canonicalJson(value.coverage)) throw new Error('Assessment coverage does not match findings.');
  for (const finding of value.findings) {
    const missing = finding.applicability === 'inapplicable' ? [] : finding.requiredProof.filter((layer) =>
      !finding.observations[layer] || finding.observations[layer]!.availability === 'not-observed'
    );
    if (canonicalJson(missing) !== canonicalJson(finding.missingProof)) throw new Error('Finding missing-proof inventory is inconsistent.');
    if (finding.classification === 'aligned' && (finding.applicability !== 'applicable' || finding.unsupported ||
        missing.length > 0 || finding.requiredProof.some((layer) => {
          const observation = finding.observations[layer];
          return observation?.availability !== 'observed' || canonicalJson(observation.value) !== canonicalJson(finding.expected);
        }))) throw new Error('Finding claims alignment without matching required proof.');
    if (finding.classification === 'inapplicable' && finding.applicability !== 'inapplicable') throw new Error('Finding invents inapplicability.');
    if (finding.classification === 'approved-exception' && (!finding.exception || missing.length ||
        !Number.isFinite(Date.parse(finding.exception.expiresAt)) || Date.parse(finding.exception.expiresAt) <= Date.parse(value.snapshot.capturedAt))) {
      throw new Error('Finding has no current, fully observed exception.');
    }
  }
  const expectedExit = value.outcome === 'error' ? 1 : ['aligned', 'not-applicable'].includes(value.outcome) ? 0 : 2;
  if (value.exitCode !== expectedExit) throw new Error('Assessment exit code does not match outcome.');
  if (value.outcome === 'aligned' && (value.findings.length === 0 || !value.snapshot.inputsStable ||
      value.coverage.unobserved || value.coverage.unsupported || value.coverage.unknownApplicability || value.coverage.differences)) {
    throw new Error('Assessment cannot claim alignment with missing coverage or differences.');
  }
  if (value.outcome === 'not-applicable' && (value.projectIdentity.profile !== 'none' || value.findings.length !== 0)) {
    throw new Error('Disabled assessment outcome does not match project profile.');
  }
  if (value.resultDigest !== canonicalSha256({ ...value, resultDigest: '' })) throw new Error('Assessment result digest does not match report.');
  if (containsSensitiveText(JSON.stringify(value))) throw new Error('Assessment report contains sensitive data and was withheld.');
  return value;
}

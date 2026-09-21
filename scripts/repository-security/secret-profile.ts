import { createHash } from 'node:crypto';
import { parse, stringify, type TomlTable } from 'smol-toml';
import { identifier, record, sha, text, SecurityEvidenceError } from './evidence.ts';
import { adoptedBaseIdentity, readAdoptedControl, type AdoptedBaseHandle } from './admission.ts';

interface DefaultConfigIdentity {
  commit: string;
  sha256: string;
  ruleCount: number;
  preparedConfigSha256?: string;
}

export interface PreparedSecretProfile {
  kind: 'derived-configuration';
  behaviorChanged: boolean;
  sourceCommit: string;
  sourceDigest: string;
  configDigest: string;
  config: string;
  rules: readonly string[];
  removedAllowlistGroups: number;
  qualified: false;
}

function table(value: unknown): TomlTable {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SecurityEvidenceError('invalid-secret-rule-table');
  return value as TomlTable;
}

export function prepareSecretProfile(source: string, identity: DefaultConfigIdentity): PreparedSecretProfile {
  sha(identity.commit);
  if (!/^[a-f0-9]{64}$/.test(identity.sha256) || !Number.isSafeInteger(identity.ruleCount) ||
      identity.ruleCount < 1 || identity.ruleCount > 1000 || Buffer.byteLength(source) > 512 * 1024) {
    throw new SecurityEvidenceError('invalid-secret-profile-identity');
  }
  const sourceHash = createHash('sha256').update(source).digest('hex');
  if (sourceHash !== identity.sha256) throw new SecurityEvidenceError('secret-rule-source-drift');
  let config: TomlTable;
  try { config = parse(source); } catch { throw new SecurityEvidenceError('invalid-secret-profile-toml'); }
  if (config.extend !== undefined || !Array.isArray(config.rules) || config.rules.length !== identity.ruleCount) {
    throw new SecurityEvidenceError('incomplete-secret-rule-inventory');
  }
  let removed = 0;
  function removeSuppressions(item: TomlTable) {
    if (item.allowlist !== undefined) { removed++; delete item.allowlist; }
    if (item.allowlists !== undefined) {
      if (!Array.isArray(item.allowlists)) throw new SecurityEvidenceError('invalid-secret-allowlists');
      removed += item.allowlists.length;
      delete item.allowlists;
    }
  }
  removeSuppressions(config);
  const rules = config.rules.map(value => {
    const rule = table(value);
    const id = identifier(rule.id, 'invalid-secret-rule-id');
    const contentRule = typeof rule.regex === 'string' && rule.regex.length > 0;
    const pathRule = rule.regex === undefined && typeof rule.path === 'string' && rule.path.length > 0;
    if ((!contentRule && !pathRule) || rule.disabled !== undefined ||
        rule.extend !== undefined) throw new SecurityEvidenceError('unsupported-secret-rule-shape');
    removeSuppressions(rule);
    return id;
  });
  if (new Set(rules).size !== rules.length) throw new SecurityEvidenceError('duplicate-secret-rule');
  let encoded: string;
  try { encoded = stringify(config); } catch { throw new SecurityEvidenceError('secret-profile-serialization-failed'); }
  const roundTrip = parse(encoded);
  if (!Array.isArray(roundTrip.rules) || roundTrip.rules.length !== rules.length ||
      roundTrip.allowlist !== undefined || roundTrip.allowlists !== undefined ||
      roundTrip.rules.some(value => table(value).allowlist !== undefined || table(value).allowlists !== undefined)) {
    throw new SecurityEvidenceError('secret-profile-roundtrip-failed');
  }
  const configHash = createHash('sha256').update(encoded).digest('hex');
  if (identity.preparedConfigSha256 !== undefined && identity.preparedConfigSha256 !== configHash) {
    throw new SecurityEvidenceError('secret-prepared-profile-drift');
  }
  return Object.freeze({
    kind: 'derived-configuration', behaviorChanged: removed > 0,
    sourceCommit: identity.commit, sourceDigest: `sha256:${sourceHash}`,
    configDigest: `sha256:${configHash}`,
    config: encoded, rules: Object.freeze(rules), removedAllowlistGroups: removed, qualified: false
  });
}

export function validateSecretDetectorRegistration(value: unknown) {
  const item = record(value, [
    'schemaVersion', 'status', 'name', 'version', 'defaultConfig', 'profile', 'derivation',
    'preparedConfigSha256', 'candidateInlineAllowComments', 'candidateIgnoreFiles', 'findingsExitCode', 'redactionPercent', 'limitations'
  ], 'invalid-secret-detector-registration');
  if (item.schemaVersion !== 1 || item.status !== 'configured-not-qualified' || item.name !== 'gitleaks' ||
      item.version !== '8.30.1' || item.profile !== 'explicit-inputs-without-inherited-suppressions' ||
      item.candidateInlineAllowComments !== false || item.candidateIgnoreFiles !== false ||
      item.findingsExitCode !== 42 || item.redactionPercent !== 100) {
    throw new SecurityEvidenceError('unapproved-secret-detector-policy');
  }
  const derivation = record(item.derivation, ['kind', 'behaviorChanged', 'changes'], 'invalid-secret-derivation');
  const categories = ['global-path-exclusions', 'global-value-suppressions', 'per-rule-suppressions'];
  if (derivation.kind !== 'derived-configuration' || derivation.behaviorChanged !== true ||
      !Array.isArray(derivation.changes) || derivation.changes.length !== categories.length) {
    throw new SecurityEvidenceError('invalid-secret-derivation');
  }
  const changes = derivation.changes.map(value => {
    const change = record(value, ['category', 'reason'], 'invalid-secret-derivation-change');
    text(change.reason, 'missing-secret-derivation-reason');
    return identifier(change.category, 'invalid-secret-derivation-category');
  });
  if (new Set(changes).size !== categories.length || changes.some(category => !categories.includes(category))) {
    throw new SecurityEvidenceError('invalid-secret-derivation-categories');
  }

  const source = record(item.defaultConfig, ['repository', 'commit', 'pathParts', 'gitBlob', 'sha256', 'ruleCount'],
    'invalid-secret-default-config');
  if (source.repository !== 'gitleaks/gitleaks' ||
      JSON.stringify(source.pathParts) !== JSON.stringify(['config', 'gitleaks.toml'])) {
    throw new SecurityEvidenceError('unapproved-secret-default-source');
  }
  const commit = sha(source.commit);
  sha(source.gitBlob);
  if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      typeof source.ruleCount !== 'number' || !Number.isSafeInteger(source.ruleCount) || source.ruleCount < 1 ||
      typeof item.preparedConfigSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.preparedConfigSha256) ||
      !Array.isArray(item.limitations) || item.limitations.length === 0) {
    throw new SecurityEvidenceError('incomplete-secret-registration');
  }
  return { commit, sha256: source.sha256, ruleCount: source.ruleCount, preparedConfigSha256: item.preparedConfigSha256 };
}

export async function prepareAdoptedSecretProfile(base: AdoptedBaseHandle, pinnedUpstreamSource: string) {
  const raw = await readAdoptedControl(base, ['security', 'secret-detector.json']);
  let registration: unknown;
  try { registration = JSON.parse(raw); } catch { throw new SecurityEvidenceError('invalid-adopted-secret-registration'); }
  const profile = prepareSecretProfile(pinnedUpstreamSource, validateSecretDetectorRegistration(registration));
  return Object.freeze({ ...profile, authority: adoptedBaseIdentity(base) });
}

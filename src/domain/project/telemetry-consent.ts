import { createHash } from 'node:crypto';
import { canonicalJson } from '../governance/activation/canonical-json.js';
import { FileSystemError } from './errors.js';
import { exactRecord, isRecord } from './manifest/fields.js';
import { isProjectTelemetryId } from '../../telemetry/contract.js';

export const projectTelemetryDisclosureVersion = 1 as const;
export const projectTelemetryRecordPath = ['.liftoff', 'telemetry', 'project.json'];
export const projectTelemetryDisclosure =
  'Project reporting is optional and pseudonymous, not anonymous. It sends only a random project UUID, ' +
  'invoked CLI version, selected policy profile/version, installed release-wide template registry digest, ' +
  'and source (cli or separately approved ci-heartbeat), with server ingestion time. No names, paths, ' +
  'remotes, code, credentials, user/device identity or client timestamp. Records are retained for 180 days. ' +
  'Disablement stops future delivery, not historical deletion. A public project ID is not authentication ' +
  'or write approval. Monthly CI reporting requires separate repository-level approval and qualified published pins.';

export interface ProjectTelemetryRecord {
  schemaVersion: 1;
  disclosureVersion: typeof projectTelemetryDisclosureVersion;
  projectId: string;
  enabled: boolean;
}

export interface LocalProjectConsent {
  projectRoot: string;
  projectId: string;
  disclosureVersion: typeof projectTelemetryDisclosureVersion;
}

export function parseProjectTelemetryRecord(value: unknown): ProjectTelemetryRecord {
  const record = exactRecord(value, ['schemaVersion', 'disclosureVersion', 'projectId', 'enabled'], 'Project telemetry record');
  if (record.schemaVersion !== 1 || record.disclosureVersion !== projectTelemetryDisclosureVersion ||
      !isProjectTelemetryId(record.projectId) || typeof record.enabled !== 'boolean') {
    throw new FileSystemError('Unsupported project telemetry record or disclosure version; no reporting is authorized.');
  }
  return { schemaVersion: 1, disclosureVersion: projectTelemetryDisclosureVersion, projectId: record.projectId, enabled: record.enabled };
}

export function projectConsentBindings(config: Record<string, unknown>): LocalProjectConsent[] {
  if (config.telemetry === undefined) return [];
  if (!isRecord(config.telemetry)) throw new FileSystemError('Invalid telemetry configuration; consent is unavailable.');
  if (config.telemetry.noticeVersion !== undefined &&
      (!Number.isSafeInteger(config.telemetry.noticeVersion) || Number(config.telemetry.noticeVersion) < 0)) {
    throw new FileSystemError('Invalid telemetry notice configuration; existing contents were preserved.');
  }
  const bindings = config.telemetry.projectConsents;
  if (bindings === undefined) return [];
  if (!Array.isArray(bindings) || bindings.length > 1024) {
    throw new FileSystemError('Invalid or oversized project consent configuration.');
  }
  const roots = new Set<string>();
  return bindings.map(value => {
    const binding = exactRecord(value, ['projectRoot', 'projectId', 'disclosureVersion'], 'Local project consent');
    if (typeof binding.projectRoot !== 'string' || !binding.projectRoot ||
        /[\u0000-\u001f\u007f]/u.test(binding.projectRoot) ||
        !isProjectTelemetryId(binding.projectId) || binding.disclosureVersion !== projectTelemetryDisclosureVersion ||
        roots.has(binding.projectRoot)) throw new FileSystemError('Invalid or duplicate local project consent binding.');
    roots.add(binding.projectRoot);
    return { projectRoot: binding.projectRoot, projectId: binding.projectId, disclosureVersion: projectTelemetryDisclosureVersion };
  });
}

export function updateProjectConsent(
  config: Record<string, unknown>, projectRoot: string, record: ProjectTelemetryRecord
): Record<string, unknown> {
  const bindings = projectConsentBindings(config).filter(binding => binding.projectRoot !== projectRoot);
  if (record.enabled) bindings.push({ projectRoot, projectId: record.projectId, disclosureVersion: projectTelemetryDisclosureVersion });
  if (bindings.length > 1024) throw new FileSystemError('Local project consent inventory is full.');
  const telemetry = config.telemetry === undefined ? {} : config.telemetry;
  if (!isRecord(telemetry)) throw new FileSystemError('Invalid telemetry configuration.');
  return { ...config, telemetry: { ...telemetry, projectConsents: bindings.sort((a, b) => a.projectRoot.localeCompare(b.projectRoot, 'en')) } };
}

export function telemetryReviewFingerprint(value: unknown): string {
  return createHash('sha256').update('liftoff-project-telemetry-review-v1\0').update(canonicalJson(value)).digest('hex');
}

import { readdir } from 'node:fs/promises';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import { isHistoricalActivationIdentity } from '../domain/governance/policy/identity.js';
import {
  validateEvidenceHeader, validateLiveReadbackProof, validateSavedTransitionPlan
} from '../domain/governance/activation/validators.js';
import type { PhaseEvidenceRecord } from '../domain/governance/activation/types.js';

async function readJsonDirectory(projectRoot: string, parts: string[]): Promise<Array<{ path: string; value: unknown }>> {
  let entries;
  try {
    entries = await readdir(await resolveProjectPath(projectRoot, parts), { withFileTypes: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const results = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile()) throw new Error(`Activation proof ${[...parts, entry.name].join('/')} must be a regular file.`);
    const bytes = await readProjectFile(projectRoot, [...parts, entry.name]);
    if (!bytes) throw new Error('Activation proof changed during inspection.');
    const source = [...parts, entry.name].join('/');
    try {
      results.push({ path: source, value: JSON.parse(bytes.toString('utf8')) as unknown });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`Unable to parse ${source}: invalid JSON.`);
    }
  }
  return results;
}

export async function readReviewedTransitionPlans(projectRoot: string) {
  return (await readJsonDirectory(projectRoot, ['governance', 'plans'])).map(({ path, value }) => {
    try { return validateSavedTransitionPlan(value); }
    catch (error) { throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

export async function readActivationEvidence(projectRoot: string): Promise<PhaseEvidenceRecord[]> {
  return (await readJsonDirectory(projectRoot, ['governance', 'evidence'])).map(({ path, value }) => {
    try {
      if (typeof value !== 'object' || value === null || !('header' in value) || !('evidenceId' in value) ||
        typeof value.evidenceId !== 'string' || !value.evidenceId) {
        throw new Error('Activation v2 requires a body-bound evidence record; historical headers are diagnostic-only.');
      }
      const record = value as Record<string, unknown>;
      const header = record.header;
      if (typeof header === 'object' && header !== null && 'schemaVersion' in header &&
        header.schemaVersion === 1 && 'identity' in header && isHistoricalActivationIdentity(header.identity)) {
        throw new Error('Historical activation v1 evidence is diagnostic-only; its original bytes are preserved and cannot authorize current execution or read scope.');
      }
      if (Object.keys(record).some((key) => !['evidenceId', 'header', 'payload', 'liveReadback'].includes(key))) {
        throw new Error('Unknown activation evidence fields.');
      }
      const rawReadback = record.liveReadback;
      if (rawReadback !== undefined && !Array.isArray(rawReadback)) {
        throw new Error('Evidence liveReadback must be an array.');
      }
      const liveReadback = rawReadback?.map(validateLiveReadbackProof) ?? [];
      return {
        evidenceId: value.evidenceId, header: validateEvidenceHeader(value.header),
        payload: record.payload, liveReadback
      };
    } catch (error) {
      throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

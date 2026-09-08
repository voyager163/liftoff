import { readdir } from 'node:fs/promises';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';
import type { CommandRunner } from '../process-runner.js';
import { loadActivationState } from './activation-state.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from './inputs.js';
import { canonicalPhaseGraph } from '../domain/governance/activation/graph.js';
import { selectLatestPhaseEvidence } from '../domain/governance/activation/evidence.js';
import { validateEvidenceHeader, validateLiveReadbackProof, validateSavedTransitionPlan, validateManifestActivationForExecution } from '../domain/governance/activation/validators.js';
import { phaseIds, type PhaseEvidenceRecord } from '../domain/governance/activation/types.js';
import { isHistoricalActivationIdentity } from '../domain/governance/policy/identity.js';

async function readJsonDirectory(projectRoot: string, parts: string[]): Promise<Array<{ path: string; value: unknown }>> {
  let entries;
  try { entries = await readdir(await resolveProjectPath(projectRoot, parts), { withFileTypes: true }); }
  catch (error) {
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
    try { results.push({ path: source, value: JSON.parse(bytes.toString('utf8')) as unknown }); }
    catch { throw new Error(`Unable to parse ${source}: invalid JSON.`); }
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
      typeof value.evidenceId !== 'string' || !value.evidenceId) throw new Error('Activation v2 requires a body-bound evidence record; historical headers are diagnostic-only.');
    const record = value as Record<string, unknown>;
    const header = record.header;
    if (typeof header === 'object' && header !== null && 'schemaVersion' in header &&
      header.schemaVersion === 1 && 'identity' in header && isHistoricalActivationIdentity(header.identity)) {
      throw new Error('Historical activation v1 evidence is diagnostic-only; its original bytes are preserved and cannot authorize current execution or read scope.');
    }
    if (Object.keys(record).some((key) => !['evidenceId', 'header', 'payload', 'liveReadback'].includes(key))) throw new Error('Unknown activation evidence fields.');
    if (record.liveReadback !== undefined && !Array.isArray(record.liveReadback)) throw new Error('Evidence liveReadback must be an array.');
    return { evidenceId: value.evidenceId, header: validateEvidenceHeader(value.header), payload: record.payload,
      liveReadback: (record.liveReadback as unknown[] | undefined)?.map(validateLiveReadbackProof) ?? [] };
    } catch (error) {
      throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Read-only proof boundary: returned values carry no executor, credential, or mutation port. */
export async function inspectCurrentActivationEvidence(projectRoot: string, manifest: LiftoffManifest, options: { runner?: CommandRunner; now?: Date } = {}) {
  validateManifestActivationForExecution(manifest);
  const loaded = await loadActivationState(projectRoot);
  if (!loaded) return { status: 'not-started' as const };
  const snapshot = await readActivationInputSnapshot(projectRoot, manifest, options.runner);
  const contexts = activationEvidenceContexts(canonicalPhaseGraph, loaded.state, snapshot, options.now);
  const plans = await readReviewedTransitionPlans(projectRoot);
  const records = await readActivationEvidence(projectRoot);
  for (const phaseId of phaseIds) contexts[phaseId].reviewedPlans = plans;
  const selections = Object.fromEntries(phaseIds.map((phaseId) => [phaseId,
    selectLatestPhaseEvidence(records.filter((record) => record.header.phaseId === phaseId), contexts[phaseId])]));
  return { status: 'inspected' as const, state: loaded.state, snapshot, contexts, records, selections };
}

export { evidenceBodyDigest, evidenceHeaderDigest, selectLatestPhaseEvidence, validateEvidenceFreshness } from '../domain/governance/activation/evidence.js';
export { activationEvidenceContexts, readActivationInputSnapshot } from './inputs.js';
export type { EvidenceFreshnessContext, EvidenceSelectionResult } from '../domain/governance/activation/evidence.js';
export { planDigestFor, type PlanDigestInput } from '../domain/governance/activation/operations.js';

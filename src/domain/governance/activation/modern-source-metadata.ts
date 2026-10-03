import type { ManifestContractContext } from '../../project/manifest/context.js';
import { denseArray, exactRecord } from '../../project/manifest/fields.js';
import { manifestPathAliasKey, validateManifestPathParts } from '../../project/manifest/layout.js';
import { modernActivationSourceContracts, modernGovernanceSourceMetadataSchemaVersion } from '../policy/identity.js';
import { canonicalJson, sha256Hex } from './canonical-json.js';
import { freezeModernValue } from './modern-graph.js';
import { createModernActivationIdentityReader } from './modern-identity.js';
import type { ModernActivationSourceInput, ModernPhaseId, ReadableModernActivationIdentity } from './modern-record-contracts.js';
import { releasedV3Values } from './record-contracts.js';
import {
  assertSafeControlRecord, assertTaskMarkers, projectTaskCheckboxValues,
  type PhaseProjectionInput, type TaskProjectionResult
} from './source-values.js';

export interface ModernGovernancePhaseTaskMapping {
  readonly phaseId: ModernPhaseId;
  readonly taskId: string;
  readonly marker: `<!-- liftoff-phase: ${ModernPhaseId} -->`;
  readonly policy: 'evidence-projection-v1';
}

export interface ModernGovernanceSourceMetadata {
  readonly schemaVersion: typeof modernGovernanceSourceMetadataSchemaVersion;
  readonly marker: 'liftoff-governance-source-of-truth';
  readonly changeId: string;
  readonly workflowKind: 'openspec' | 'spec-kit';
  readonly activationIdentity: ReadableModernActivationIdentity & { readonly workflow: 'openspec' | 'spec-kit' };
  readonly phaseGraphHash: string;
  readonly baselineSha: string;
  readonly phaseTaskMapping: readonly ModernGovernancePhaseTaskMapping[];
  readonly currentPolicy: {
    readonly phaseAuthority: 'managed-phase-graph';
    readonly taskCompletion: 'authoritative-evidence-projection';
    readonly approvalPolicy: 'approval-envelope-required-for-gated-phases';
  };
  readonly createdFrom: {
    readonly kind: 'approved-phase-0-facts';
    readonly approvedFactDigest: string;
    readonly evidenceIds: readonly string[];
  };
  readonly acknowledgedAt: string;
  readonly owner: string;
}

export type ModernGovernanceSourceInput = Pick<ModernGovernanceSourceMetadata,
  'changeId' | 'baselineSha' | 'createdFrom' | 'acknowledgedAt' | 'owner'>;

const sourceMarker = 'liftoff-governance-source-of-truth';
const sourcePolicy = Object.freeze({
  phaseAuthority: 'managed-phase-graph',
  taskCompletion: 'authoritative-evidence-projection',
  approvalPolicy: 'approval-envelope-required-for-gated-phases'
} as const);
const maximumSourceBytes = 262_144;

function rejectSensitiveSource(): never {
  throw new Error('Modern governance source contains prohibited sensitive control-record content.');
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be bounded non-empty single-line text.`);
  }
  assertSafeControlRecord(value, rejectSensitiveSource);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a complete lowercase SHA-256 digest.`);
  }
  return value;
}

function sourceChangeId(value: unknown): string {
  const id = text(value, 'modern source changeId', 160);
  validateManifestPathParts([id], 'modern source changeId');
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || id === 'archive' ||
    id.startsWith('bootstrap-') || id === '000-liftoff-bootstrap') {
    throw new Error('Modern governance metadata cannot name a seed, archive or noncanonical change.');
  }
  return id;
}

/** Private values only: metadata, task text and fact digests do not establish consent or execution readiness. */
export function createModernGovernanceSourceContract(
  catalog: ManifestContractContext['catalog'], context: ModernActivationSourceInput
) {
  const selected = createModernActivationIdentityReader(catalog).validateReadableModernActivationIdentity(context);
  if (selected.workflow === 'manual') throw new Error('Manual has no external governance source metadata or task projection.');
  const identity = Object.freeze({ ...selected, workflow: selected.workflow });
  const graph = modernActivationSourceContracts().find(source => source.identity.phaseGraphHash === identity.phaseGraphHash)!.graph;
  const phases = graph.phases.map(phase => phase.id);
  const phaseStates = [...releasedV3Values.phaseStates, 'identity-incompatible' as const];

  function read(value: unknown): ModernGovernanceSourceMetadata {
    const item = exactRecord(value, [
      'schemaVersion', 'marker', 'changeId', 'workflowKind', 'activationIdentity', 'phaseGraphHash',
      'baselineSha', 'phaseTaskMapping', 'currentPolicy', 'createdFrom', 'acknowledgedAt', 'owner'
    ], 'modern governance source');
    if (item.schemaVersion !== modernGovernanceSourceMetadataSchemaVersion || item.marker !== sourceMarker) {
      throw new Error('Modern governance source requires source-metadata schema 2 and its exact marker.');
    }
    const recorded = exactRecord(item.activationIdentity, Object.keys(identity), 'modern source activation identity');
    if (Object.entries(identity).some(([key, expected]) => recorded[key] !== expected) ||
      item.phaseGraphHash !== identity.phaseGraphHash || item.workflowKind !== identity.workflow) {
      throw new Error('Modern governance source contradicts its complete selected identity, graph or workflow.');
    }
    const policy = exactRecord(item.currentPolicy, Object.keys(sourcePolicy), 'modern source policy');
    if (Object.entries(sourcePolicy).some(([key, expected]) => policy[key] !== expected)) {
      throw new Error('Modern governance source cannot change phase, task or approval authority.');
    }
    const seenPhases = new Set<ModernPhaseId>(), seenTasks = new Set<string>();
    const mappings = denseArray(item.phaseTaskMapping, phases.length, 'modern source phase mapping')
      .map((entry): ModernGovernancePhaseTaskMapping => {
        const mapping = exactRecord(entry, ['phaseId', 'taskId', 'marker', 'policy'], 'modern source phase mapping');
        const phaseId = phases.find(id => id === mapping.phaseId);
        const taskId = text(mapping.taskId, 'modern source taskId', 128);
        if (!phaseId || seenPhases.has(phaseId) || seenTasks.has(taskId) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) {
          throw new Error('Modern governance source requires distinct known phases and unambiguous task IDs.');
        }
        const marker: ModernGovernancePhaseTaskMapping['marker'] = `<!-- liftoff-phase: ${phaseId} -->`;
        if (mapping.marker !== marker || mapping.policy !== 'evidence-projection-v1') {
          throw new Error('Modern governance source requires the exact phase marker and evidence projection policy.');
        }
        seenPhases.add(phaseId); seenTasks.add(taskId);
        return { phaseId, taskId, marker, policy: 'evidence-projection-v1' };
      });
    if (seenPhases.size !== phases.length) throw new Error('Modern governance source must map every selected graph phase.');
    const from = exactRecord(item.createdFrom, ['kind', 'approvedFactDigest', 'evidenceIds'], 'modern source creation');
    if (from.kind !== 'approved-phase-0-facts') throw new Error('Modern governance source requires explicit Phase 0 fact provenance.');
    const evidenceIds = denseArray(from.evidenceIds, 128, 'modern source evidence IDs').map(value => {
      const id = text(value, 'modern source evidence ID', 128);
      validateManifestPathParts([id], 'modern source evidence ID');
      return id;
    });
    if (!evidenceIds.length || new Set(evidenceIds.map(id => manifestPathAliasKey([id]))).size !== evidenceIds.length) {
      throw new Error('Modern governance source requires distinct non-empty evidence references.');
    }
    const acknowledgedAt = text(item.acknowledgedAt, 'modern source acknowledgedAt', 64);
    if (!/^\d{4}-\d{2}-\d{2}T/u.test(acknowledgedAt) || !Number.isFinite(Date.parse(acknowledgedAt))) {
      throw new Error('Modern governance source requires a valid ISO acknowledgment timestamp.');
    }
    const result: ModernGovernanceSourceMetadata = {
      schemaVersion: modernGovernanceSourceMetadataSchemaVersion, marker: sourceMarker,
      changeId: sourceChangeId(item.changeId), workflowKind: identity.workflow, activationIdentity: identity,
      phaseGraphHash: identity.phaseGraphHash, baselineSha: digest(item.baselineSha, 'modern source baseline'),
      phaseTaskMapping: mappings, currentPolicy: sourcePolicy,
      createdFrom: { kind: 'approved-phase-0-facts',
        approvedFactDigest: digest(from.approvedFactDigest, 'modern source fact digest'), evidenceIds },
      acknowledgedAt, owner: text(item.owner, 'modern source owner')
    };
    assertSafeControlRecord(result, rejectSensitiveSource);
    return freezeModernValue(result);
  }

  function create(input: ModernGovernanceSourceInput): ModernGovernanceSourceMetadata {
    const fields = exactRecord(input, ['changeId', 'baselineSha', 'createdFrom', 'acknowledgedAt', 'owner'], 'modern source construction');
    return read({
      ...fields, schemaVersion: modernGovernanceSourceMetadataSchemaVersion, marker: sourceMarker,
      workflowKind: identity.workflow, activationIdentity: identity, phaseGraphHash: identity.phaseGraphHash,
      currentPolicy: sourcePolicy,
      phaseTaskMapping: phases.map((phaseId, index): ModernGovernancePhaseTaskMapping => ({
        phaseId, taskId: `${index + 1}.1`, marker: `<!-- liftoff-phase: ${phaseId} -->`, policy: 'evidence-projection-v1'
      }))
    });
  }

  function encode(value: unknown): string {
    return `${canonicalJson(read(value))}\n`;
  }

  function projectTasks(markdown: string, value: unknown, calculatedStates: unknown): TaskProjectionResult<ModernPhaseId> {
    if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > maximumSourceBytes) {
      throw new Error('Modern governance task text exceeds its 256-KiB source bound.');
    }
    const metadata = read(value);
    const supplied = exactRecord(calculatedStates, phases, 'modern calculated phase states');
    const states: Partial<Record<ModernPhaseId, PhaseProjectionInput>> = {};
    for (const phase of phases) {
      const input = supplied[phase];
      const state = typeof input === 'string' ? input : exactRecord(input, ['state'], 'modern calculated phase state').state;
      const known = phaseStates.find(candidate => candidate === state);
      if (!known) throw new Error('Modern task projection requires an explicit calculated state for every current phase.');
      states[phase] = known;
    }
    assertTaskMarkers(markdown, metadata.phaseTaskMapping);
    return projectTaskCheckboxValues(markdown, metadata.phaseTaskMapping, states, phases, releasedV3Values.phaseStates);
  }

  function taskLayoutHash(markdown: string, value: unknown): string {
    return sha256Hex(projectTasks(markdown, value, Object.fromEntries(phases.map(phase => [phase, 'pending']))).markdown);
  }

  return Object.freeze({ identity, graph, read, create, encode, projectTasks, taskLayoutHash });
}

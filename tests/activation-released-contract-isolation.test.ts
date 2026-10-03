import { readFileSync } from 'node:fs';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  activationCompatibilityKey, historicalActivationIdentities, historicalV1ActivationIdentity,
  historicalV2ActivationIdentity, isHistoricalActivationIdentity, isHistoricalV1ActivationIdentity,
  isHistoricalV2ActivationIdentity, isReleasedV3ActivationIdentity, releasedV3ActivationIdentity,
  type HistoricalV1ActivationIdentity, type HistoricalV2ActivationIdentity, type ReleasedV3ActivationIdentity
} from '../src/domain/governance/policy/identity.js';
import {
  ActivationHistoryError, historyArray, historyRecord, parseHistoryJson, rawHistoryDigest,
  validateHistoricalV2SourceMigrationJournal, validateHistoricalV3SourceMigrationJournal,
  validateMigrationJournal, type HistoricalV2SourceMigrationJournal, type HistoricalV3SourceMigrationJournal
} from '../src/governance-activation/history-contracts.js';
import { activationCompatibility, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { resolveActivationCompatibility } from '../src/domain/governance/policy/identity.js';

const identityModule = '../src/domain/governance/policy/identity.js';
const graphModule = '../src/domain/governance/activation/graph.js';
const historyModule = '../src/governance-activation/history-contracts.js';
const frozenBytes = readFileSync(new URL('./fixtures/activation-v3/records.json', import.meta.url));
const captured = historyRecord(parseHistoryJson(frozenBytes, 'frozen v3 capture'), 'frozen v3 capture');
const localPhases = ['seed-valid', 'seed-verified', 'seed-archived'];

function v3Journal(family: 1 | 2 = 1): Record<string, unknown> {
  const entry = historyArray(captured.successors, 'captured successors')
    .map(value => historyRecord(value, 'captured successor')).find(value => value.family === family);
  if (!entry) throw new Error('Missing frozen source journal fixture.');
  return structuredClone(historyRecord(entry.journal, 'captured journal'));
}

function v2Journal(): Record<string, unknown> {
  return { ...v3Journal(1), laneId: 'activation-v1-to-v2', targetIdentity: { ...historicalV2ActivationIdentity } };
}

function progress(value: Record<string, unknown>) { return historyRecord(value.revalidation, 'revalidation'); }
function phases(value: Record<string, unknown>) {
  return historyArray(progress(value).phases, 'phases').map(phase => historyRecord(phase, 'phase'));
}

function expectHistoryError(action: () => unknown, code: string, location?: string) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ActivationHistoryError);
  expect(caught).toMatchObject({ code, ...(location ? { location } : {}) });
}

afterEach(() => {
  vi.doUnmock(identityModule);
  vi.doUnmock(graphModule);
  vi.resetModules();
});

describe('exact released identity selectors', () => {
  const families = [
    { identity: historicalV1ActivationIdentity, matches: isHistoricalV1ActivationIdentity, historical: true },
    { identity: historicalV2ActivationIdentity, matches: isHistoricalV2ActivationIdentity, historical: true },
    { identity: releasedV3ActivationIdentity, matches: isReleasedV3ActivationIdentity, historical: false }
  ];

  it.each(families)('preserves family $identity.activationContractVersion without widening eligibility', ({ identity, matches, historical }) => {
    expect(matches({ ...identity })).toBe(true);
    expect(isHistoricalActivationIdentity(identity)).toBe(historical);
    expect(families.filter(entry => entry.matches(identity))).toHaveLength(1);
    for (const value of [null, undefined, 3, 'released', [], [identity], {}]) expect(matches(value)).toBe(false);
    expect(matches({ ...identity, governanceProfile: 'single-maintainer-gitflow' })).toBe(false);
    expect(matches({ ...identity, phaseGraphHash: '0'.repeat(64) })).toBe(false);
    expect(matches(Object.create(identity))).toBe(false);
    for (const field of Object.keys(identity)) {
      const altered: Record<string, unknown> = { ...identity };
      delete altered[field];
      expect(matches(altered), `missing ${field}`).toBe(false);
      altered[field] = typeof identity[field as keyof typeof identity] === 'number' ? 99 : 'unknown-future';
      expect(matches(altered), `changed ${field}`).toBe(false);
    }
  });

  it('keeps current compatibility keys, tuple values and diagnostic classifications unchanged', () => {
    expect(historicalActivationIdentities).toEqual([historicalV1ActivationIdentity, historicalV2ActivationIdentity]);
    const fields = [
      'liftoffVersion', 'manifestArtifactVersion', 'policyVersion', 'activationContractVersion',
      'phaseGraphSchemaVersion', 'phaseGraphHash', 'activationStateSchemaVersion',
      'evidenceHeaderSchemaVersion', 'approvalEnvelopeSchemaVersion', 'supersessionSchemaVersion',
      'credentialPolicySchemaVersion'
    ];
    for (const identity of [historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity]) {
      const record = historyRecord(identity, 'identity');
      expect(activationCompatibilityKey(identity)).toBe(fields.map(field => `${field}=${record[field]}`).join('|'));
    }
    expect(resolveActivationCompatibility(currentActivationIdentity, activationCompatibility)).toEqual({
      compatible: true, identity: currentActivationIdentity
    });
    for (const identity of historicalActivationIdentities) {
      expect(resolveActivationCompatibility(identity, activationCompatibility)).toEqual({
        compatible: false,
        reason: `Historical activation v${identity.activationContractVersion} is diagnostic-only. Run liftoff update --check to inspect an explicitly supported history-preserving v3 successor; preserve original bytes without reset, retagging, or automatic conversion.`
      });
    }
  });
});

describe('published journal-1 contract', () => {
  const readers = [
    { name: 'v1-to-v2', fixture: v2Journal, read: validateHistoricalV2SourceMigrationJournal },
    { name: 'v1-to-v3', fixture: () => v3Journal(1), read: validateHistoricalV3SourceMigrationJournal },
    { name: 'v2-to-v3', fixture: () => v3Journal(2), read: validateHistoricalV3SourceMigrationJournal }
  ];

  it('retains independent closed TypeScript source/lane/schema/phase types', () => {
    expectTypeOf<HistoricalV2SourceMigrationJournal['sourceIdentity']>().toEqualTypeOf<HistoricalV1ActivationIdentity>();
    expectTypeOf<HistoricalV2SourceMigrationJournal['targetIdentity']>().toEqualTypeOf<HistoricalV2ActivationIdentity>();
    expectTypeOf<HistoricalV2SourceMigrationJournal['laneId']>().toEqualTypeOf<'activation-v1-to-v2'>();
    expectTypeOf<HistoricalV3SourceMigrationJournal['targetIdentity']>().toEqualTypeOf<ReleasedV3ActivationIdentity>();
    expectTypeOf<Extract<HistoricalV3SourceMigrationJournal, { laneId: 'activation-v1-to-v3' }>['sourceIdentity']>()
      .toEqualTypeOf<HistoricalV1ActivationIdentity>();
    expectTypeOf<Extract<HistoricalV3SourceMigrationJournal, { laneId: 'activation-v2-to-v3' }>['sourceIdentity']>()
      .toEqualTypeOf<HistoricalV2ActivationIdentity>();
    expectTypeOf<HistoricalV3SourceMigrationJournal['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<HistoricalV3SourceMigrationJournal['revalidation']['phases'][number]['phaseId']>()
      .toEqualTypeOf<'seed-valid' | 'seed-verified' | 'seed-archived'>();
    expectTypeOf<HistoricalV3SourceMigrationJournal['revalidation']['status']>()
      .toEqualTypeOf<'pending' | 'running' | 'blocked' | 'complete'>();
  });

  it.each(readers)('reads $name without rewriting fields or consulting approval expiry', ({ fixture, read }) => {
    const value = fixture();
    const before = JSON.stringify(value);
    expect(read(value)).toEqual(value);
    expect(read(value).revalidation.phases.map(phase => phase.phaseId)).toEqual(localPhases);
    expect(JSON.stringify(value)).toBe(before);
    expect(read(value)).not.toBe(value);
    expect(rawHistoryDigest(readFileSync(new URL('./fixtures/activation-v3/records.json', import.meta.url))))
      .toBe('cb9a4768b30e031d9d4b802528223679efa28259b50713221cdfc7a71d6eda46');
  });

  it.each(['pending', 'running', 'blocked', 'complete'] as const)('preserves original %s progress in every released lane', (status) => {
    for (const { fixture, read } of readers) {
      const value = fixture();
      progress(value).status = status;
      progress(value).nextAction = status === 'complete' ? null : 'Review the remaining local work.';
      for (const phase of phases(value)) {
        phase.status = status;
        phase.evidenceIds = status === 'complete' ? [`original-${phase.phaseId}`] : [];
        phase.blockers = status === 'blocked' ? ['Original local prerequisite unavailable.'] : [];
      }
      expect(read(value)).toEqual(value);
    }
  });

  const malformed: Array<{ name: string; edit: (value: Record<string, unknown>) => void; code?: string }> = [
    { name: 'future journal schema', edit: value => { value.schemaVersion = 2; } },
    { name: 'missing index digest', edit: value => { delete value.historyIndexDigest; } },
    { name: 'extra current-context field', edit: value => { value.workflow = 'manual'; } },
    { name: 'extra successor field', edit: value => { historyRecord(value.successor, 'successor').approved = true; } },
    { name: 'unknown status', edit: value => { progress(value).status = 'verified'; } },
    { name: 'duplicate local result', edit: value => { phases(value)[1].phaseId = 'seed-valid'; } },
    { name: 'missing local result', edit: value => { historyArray(progress(value).phases, 'phases').pop(); } },
    { name: 'future phase', edit: value => { phases(value)[0].phaseId = 'manual-local-complete'; } },
    { name: 'extra phase', edit: value => { historyArray(progress(value).phases, 'phases').push({ ...phases(value)[0] }); } },
    { name: 'pending evidence', edit: value => { phases(value)[0].evidenceIds = ['old-proof']; } },
    { name: 'pending blockers', edit: value => { phases(value)[0].blockers = ['old-blocker']; } },
    { name: 'complete without evidence', edit: value => { phases(value)[0].status = 'complete'; } },
    { name: 'blocked without diagnosis', edit: value => { phases(value)[0].status = 'blocked'; } },
    { name: 'complete with blockers', edit: value => { Object.assign(phases(value)[0], { status: 'complete', evidenceIds: ['proof'], blockers: ['blocked'] }); } },
    { name: 'duplicate evidence IDs', edit: value => { Object.assign(phases(value)[0], { status: 'complete', evidenceIds: ['proof', 'proof'] }); } },
    { name: 'inconsistent complete aggregate', edit: value => { progress(value).status = 'complete'; } },
    { name: 'inconsistent running aggregate', edit: value => { progress(value).status = 'running'; } },
    { name: 'inconsistent blocked aggregate', edit: value => { progress(value).status = 'blocked'; } },
    { name: 'inconsistent pending aggregate', edit: value => { phases(value)[0].status = 'running'; } },
    { name: 'missing incomplete action', edit: value => { progress(value).nextAction = null; } },
    { name: 'commit before creation', edit: value => { historyRecord(value.transaction, 'transaction').committedAt = '2000-01-01T00:00:00.000Z'; } },
    { name: 'revalidation before commit', edit: value => { progress(value).updatedAt = '2000-01-01T00:00:00.000Z'; } },
    { name: 'non-commit transaction', edit: value => { historyRecord(value.transaction, 'transaction').status = 'pending'; } },
    { name: 'invalid original anchor', edit: value => { historyRecord(value.successor, 'successor').repositoryId = 'R_REMOTE'; } },
    { name: 'invalid timestamp', edit: value => { progress(value).updatedAt = 'not-a-time'; } },
    { name: 'unsafe index path', edit: value => { value.historyIndexPathParts = ['governance', '..', 'outside']; }, code: 'unsafe-history-path' },
    { name: 'case-aliased index path', edit: value => { value.historyIndexPathParts = ['Governance', 'history', value.snapshotId, 'index.json']; }, code: 'unsafe-history-path' },
    { name: 'wrong snapshot path', edit: value => { value.snapshotId = '0'.repeat(64); }, code: 'unsafe-history-path' },
    { name: 'malformed index digest', edit: value => { value.historyIndexDigest = 'SHA256:not-a-digest'; } }
  ];

  it.each(malformed)('rejects $name with the existing sanitized classification', ({ edit, code }) => {
    for (const { fixture, read } of readers) {
      const value = fixture();
      edit(value);
      const before = JSON.stringify(value);
      expectHistoryError(() => read(value), code ?? 'invalid-history-record');
      expect(JSON.stringify(value)).toBe(before);
    }
  });

  it('rejects a next action after completed revalidation', () => {
    const value = v3Journal();
    progress(value).status = 'complete';
    for (const phase of phases(value)) Object.assign(phase, { status: 'complete', evidenceIds: [`proof-${phase.phaseId}`] });
    expectHistoryError(() => validateHistoricalV3SourceMigrationJournal(value), 'invalid-history-record', 'migrationJournal');
  });

  it.each(readers)('rejects wrong source, lane and target combinations for $name', ({ fixture, read }) => {
    const value = fixture();
    expectHistoryError(() => read({ ...value, laneId: 'activation-v3-to-v4' }), 'invalid-history-record');
    expectHistoryError(() => read({ ...value, sourceIdentity: releasedV3ActivationIdentity }), 'unsupported-historical-identity');
    expectHistoryError(() => read({ ...value, sourceIdentity: { ...historicalV1ActivationIdentity, activationContractVersion: 2 } }), 'unsupported-historical-identity');
    const wrongTarget = { ...historyRecord(value.targetIdentity, 'target'), phaseGraphHash: '0'.repeat(64) };
    expectHistoryError(() => read({ ...value, targetIdentity: wrongTarget }),
      value.laneId === 'activation-v1-to-v2' ? 'unsupported-historical-identity' : 'unsupported-migration-target');
    expectHistoryError(() => read({ ...value, sourceIdentity: { ...historyRecord(value.sourceIdentity, 'source'), workflow: 'openspec' } }),
      'unsupported-historical-identity');
  });

  it('keeps the current journal decoder behavior and output separate from published decoding', () => {
    for (const family of [1, 2] as const) expect(validateMigrationJournal(v3Journal(family))).toEqual(v3Journal(family));
    expectHistoryError(() => validateMigrationJournal(v2Journal()), 'invalid-history-record', 'migrationJournal.laneId');
    expectHistoryError(() => validateHistoricalV2SourceMigrationJournal(v3Journal()), 'invalid-history-record', 'historicalMigrationJournal.laneId');
    expectHistoryError(() => validateHistoricalV3SourceMigrationJournal({ ...v3Journal(2), laneId: 'activation-v1-to-v3' }),
      'invalid-history-record', 'historicalV3MigrationJournal.laneId');
  });
});

describe('future-context independence', () => {
  it('ignores a future current graph/identity and expanded historical aggregate when reading published journals', async () => {
    const actual = await vi.importActual<typeof import('../src/domain/governance/policy/identity.js')>(identityModule);
    const futureCurrent = { ...releasedV3ActivationIdentity, activationContractVersion: 99, workflow: 'manual' };
    const resolveCurrent = vi.fn(() => { throw new Error('Published reader consulted current compatibility.'); });
    vi.doMock(graphModule, () => ({ currentActivationIdentity: futureCurrent }));
    vi.doMock(identityModule, () => ({
      ...actual,
      historicalActivationIdentities: [...actual.historicalActivationIdentities, actual.releasedV3ActivationIdentity],
      isHistoricalActivationIdentity: (value: unknown) =>
        actual.isHistoricalActivationIdentity(value) || actual.isReleasedV3ActivationIdentity(value),
      resolveActivationCompatibility: resolveCurrent,
      liftoffActivationPackageVersion: 'unregistered-current-context',
      activationContractVersion: 99
    }));
    vi.resetModules();
    const future = await import('../src/governance-activation/history-contracts.js');
    expect(future.validateHistoricalV2SourceMigrationJournal(v2Journal())).toEqual(v2Journal());
    for (const family of [1, 2] as const) expect(future.validateHistoricalV3SourceMigrationJournal(v3Journal(family))).toEqual(v3Journal(family));
    expect(() => future.validateHistoricalV3SourceMigrationJournal({
      ...v3Journal(), sourceIdentity: releasedV3ActivationIdentity, laneId: 'activation-v2-to-v3'
    })).toThrow(/exact registered historical activation v1\/v2 identity/);
    expect(() => future.validateMigrationJournal(v3Journal())).toThrow('migrationJournal.targetIdentity.workflow: is required.');
    expect(resolveCurrent).not.toHaveBeenCalled();
  });
});

// Module mocks cannot replace same-module lexical constants. Inspect the bounded
// selectors/parser wiring as well as exercising their observable record behavior.
describe('closed release-selector dependencies', () => {
  function ast(file: string) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    return parseAst(source, { lang: 'ts' }, file);
  }
  function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function nodes(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!object(value)) return [];
    return [...(typeof value.type === 'string' ? [value] : []), ...Object.values(value).flatMap(nodes)];
  }
  function functionNode(tree: unknown, name: string) {
    const found = nodes(tree).find(node => node.type === 'FunctionDeclaration' && object(node.id) && node.id.name === name);
    if (!found) throw new Error(`Missing declared function ${name}.`);
    return found;
  }
  function identifiers(value: unknown) {
    return nodes(value).filter(node => node.type === 'Identifier').map(node => node.name);
  }
  function variable(tree: unknown, name: string) {
    const found = nodes(tree).find(node => node.type === 'VariableDeclarator' && object(node.id) && node.id.name === name);
    if (!found) throw new Error(`Missing declaration ${name}.`);
    return found;
  }
  function parserKind(tree: unknown, name: string) {
    const call = nodes(functionNode(tree, name).body).find(node =>
      node.type === 'CallExpression' && object(node.callee) && node.callee.name === 'readMigrationJournalFields');
    if (!call || !Array.isArray(call.arguments) || !object(call.arguments[1])) throw new Error('Missing closed parser selector.');
    return call.arguments[1].value;
  }

  it('derives released identity keys from their exact registered row, never current tupleFields', () => {
    const tree = ast('../src/domain/governance/policy/identity.ts');
    const helper = functionNode(tree, 'matchesReleasedIdentity');
    expect(identifiers(helper.body)).not.toContain('tupleFields');
    expect(identifiers(helper.body)).toContain('expected');
    expect(nodes(helper.body).some(node =>
      node.type === 'CallExpression' && object(node.callee) &&
      object(node.callee.object) && node.callee.object.name === 'Object' &&
      object(node.callee.property) && node.callee.property.name === 'entries' &&
      Array.isArray(node.arguments) && object(node.arguments[0]) && node.arguments[0].name === 'expected')).toBe(true);
    for (const [name, expected] of [
      ['isHistoricalV1ActivationIdentity', 'historicalV1ActivationIdentity'],
      ['isHistoricalV2ActivationIdentity', 'historicalV2ActivationIdentity'],
      ['isReleasedV3ActivationIdentity', 'releasedV3ActivationIdentity']
    ]) {
      const dependencies = identifiers(functionNode(tree, name).body);
      expect(dependencies).toContain('matchesReleasedIdentity');
      expect(dependencies).toContain(expected);
      for (const forbidden of ['tupleFields', 'isHistoricalActivationIdentity', 'historicalActivationIdentities', 'currentActivationIdentity']) {
        expect(dependencies).not.toContain(forbidden);
      }
    }
  });

  it('binds released journal wrappers only to the private frozen journal-1 definition', () => {
    const tree = ast('../src/governance-activation/history-contracts.ts');
    expect(parserKind(tree, 'validateHistoricalV2SourceMigrationJournal')).toBe('published-v1');
    expect(parserKind(tree, 'validateHistoricalV3SourceMigrationJournal')).toBe('published-v1');
    expect(parserKind(tree, 'validateMigrationJournal')).toBe('current');
    const frozen = variable(tree, 'publishedMigrationJournalV1');
    const dependencies = identifiers(frozen.init);
    for (const forbidden of ['migrationJournalSchemaVersion', 'migrationRevalidationPhaseIds', 'migrationRevalidationStatuses', 'activationHistoryRootPathParts']) {
      expect(dependencies).not.toContain(forbidden);
    }
    const contract = variable(functionNode(tree, 'readMigrationJournalFields'), 'contract');
    expect(contract.init).toMatchObject({
      type: 'ConditionalExpression',
      test: { type: 'BinaryExpression', operator: '===', left: { name: 'contractKind' }, right: { value: 'published-v1' } },
      consequent: { type: 'Identifier', name: 'publishedMigrationJournalV1' }
    });
    const parser = functionNode(tree, 'readMigrationJournalFields');
    const statements = object(parser.body) && Array.isArray(parser.body.body) ? parser.body.body : [];
    const remainder = statements.filter(statement => !nodes(statement).includes(contract));
    for (const forbidden of ['migrationJournalSchemaVersion', 'migrationRevalidationPhaseIds', 'migrationRevalidationStatuses',
      'activationHistoryRootPathParts', 'activationHistoryIndexPathParts', 'currentActivationIdentity']) {
      expect(identifiers(remainder)).not.toContain(forbidden);
    }
    const publishedTypes = nodes(tree).filter(node =>
      (node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration') && object(node.id) &&
      ['PublishedMigrationJournalFields', 'HistoricalV2SourceMigrationJournal', 'HistoricalV3SourceMigrationJournal'].includes(String(node.id.name)));
    expect(publishedTypes).toHaveLength(3);
    for (const forbidden of ['MigrationJournal', 'MigrationPhaseProgress', 'MigrationRevalidationStatus', 'ActivationSuccessorMigrationId', 'PhaseId']) {
      expect(identifiers(publishedTypes)).not.toContain(forbidden);
    }
    for (const name of ['validateHistoricalV2SourceMigrationJournal', 'validateHistoricalV3SourceMigrationJournal']) {
      for (const forbidden of ['historicalIdentity', 'isHistoricalActivationIdentity', 'migrationTargetIdentity']) {
        expect(identifiers(functionNode(tree, name).body)).not.toContain(forbidden);
      }
    }
    const exportedParser = nodes(tree).some(node => node.type === 'ExportNamedDeclaration' &&
      object(node.declaration) && node.declaration.type === 'FunctionDeclaration' &&
      object(node.declaration.id) && node.declaration.id.name === 'readMigrationJournalFields');
    expect(exportedParser).toBe(false);
  });
});

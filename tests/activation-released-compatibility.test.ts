import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  buildGovernanceCompatibilityMetadata, validateGovernanceCompatibilityMetadata,
  validateReleasedV3CompatibilityMetadata,
  type ManagedCompatibilityInventoryEntry, type ReleasedV3GovernanceCompatibilityMetadata
} from '../src/governance-activation/compatibility.js';
import {
  activationHistoryCopyPathParts, activationHistorySnapshotId, historyArray, historyRecord, historyPathParts,
  historicalMetadataPathParts, parseHistoryJson, rawHistoryDigest, validateActivationHistoryIndex
} from '../src/governance-activation/history-contracts.js';
import { managedCoreArtifactPaths, managedCoreLogicalNameInventories } from '../src/domain/project/artifact-lifecycle.js';
import {
  releasedManagedMetadata, releasedManagedLogicalInventories, releasedManagedActivationIdentities
} from '../src/governance-activation/released-managed-metadata.js';
import {
  historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity
} from '../src/domain/governance/policy/identity.js';
import { readHistoricalActivationInventory, readHistoricalSnapshotInventory } from '../src/governance-activation/historical-state.js';

const captureBytes = readFileSync(new URL('./fixtures/activation-v3/records.json', import.meta.url));
const capture = historyRecord(parseHistoryJson(captureBytes, 'frozen v3 records'), 'frozen v3 records');
function capturedCompatibility() {
  return structuredClone(historyRecord(capture.compatibility, 'captured compatibility'));
}
function activation(value: Record<string, unknown>) { return historyRecord(value.activation, 'activation'); }
function core(value: Record<string, unknown>) { return historyRecord(value.managedCore, 'managedCore'); }
const authority = 'liftoff.manifest.json managedArtifacts[].contentHash' as const;
function entries(names: readonly string[]): ManagedCompatibilityInventoryEntry[] {
  return names.map(logicalName => {
    const pathParts = managedCoreArtifactPaths.get(logicalName);
    if (!pathParts) throw new Error(`Missing original managed identity ${logicalName}`);
    return { logicalName, pathParts: [...pathParts], lifecycle: 'managed-core', contentHashAuthority: authority };
  });
}
function withInventory(names: readonly string[], selected = names) {
  const value = capturedCompatibility();
  core(value).logicalNameAllowlist = [...names];
  core(value).updateInventory = entries(selected);
  core(value).pathAllowlist = entries(selected).map(entry => entry.pathParts);
  return value;
}
function legacy(schemaVersion: 2 | 3) {
  const value = capturedCompatibility();
  value.schemaVersion = schemaVersion;
  const historical = historyRecord(activation(value).historicalReadability, 'historical');
  delete historical.readers;
  Object.assign(historical, {
    activationContractVersion: 'unvalidated legacy field',
    activationStateSchemaVersion: { original: true },
    evidenceHeaderSchemaVersion: null,
    migration: schemaVersion === 2 ? 'unsupported-preserve-bytes' : 'explicit-successor-preserve-bytes'
  });
  if (schemaVersion === 2) delete activation(value).successorMigrations;
  return value;
}

// These current-reader characterization cases run before R2 extraction and are
// retained unchanged afterward; they are not a stricter replacement contract.
describe('current compatibility characterization', () => {
  it('retains the exact frozen empty builder bytes and parser property order', () => {
    expect(createHash('sha256').update(captureBytes).digest('hex'))
      .toBe('cb9a4768b30e031d9d4b802528223679efa28259b50713221cdfc7a71d6eda46');
    const expected = capturedCompatibility();
    expect(JSON.stringify(buildGovernanceCompatibilityMetadata([], [], []))).toBe(JSON.stringify(expected));
    expect(JSON.stringify(validateGovernanceCompatibilityMetadata(expected))).toBe(JSON.stringify(expected));
  });

  it.each([0, 1, 2, 3])('keeps exact inventory variant %s, partial and empty membership', index => {
    const names = managedCoreLogicalNameInventories[index];
    for (const selected of [names, [], names.slice(0, 1), [...names].reverse()]) {
      const value = withInventory(names, selected);
      const before = JSON.stringify(value);
      expect(JSON.stringify(validateGovernanceCompatibilityMetadata(value))).toBe(before);
      expect(JSON.stringify(buildGovernanceCompatibilityMetadata(entries(selected), names, entries(selected).map(entry => entry.pathParts))))
        .toBe(before);
      expect(JSON.stringify(value)).toBe(before);
    }
  });

  it.each([2, 3] as const)('preserves schema %s legacy normalization without validating the ignored scalar values', schema => {
    const value = legacy(schema);
    const expected = structuredClone(value);
    const original = historyRecord(activation(value).historicalReadability, 'historical');
    activation(expected).historicalReadability = {
      tuples: original.tuples, activationContractVersion: 1, activationStateSchemaVersion: 1,
      evidenceHeaderSchemaVersion: 1, execution: original.execution, migration: original.migration
    };
    expect(JSON.stringify(validateGovernanceCompatibilityMetadata(value))).toBe(JSON.stringify(expected));
    expect(validateGovernanceCompatibilityMetadata(validateGovernanceCompatibilityMetadata(value)))
      .toEqual(validateGovernanceCompatibilityMetadata(value));
  });

  it('keeps original first-failure diagnostics and expected-agent narrowing', () => {
    const value = capturedCompatibility();
    expect(() => validateGovernanceCompatibilityMetadata({ ...value, schemaVersion: 5 }))
      .toThrow('compatibility.schemaVersion must be 2, 3, or 4; historical metadata requires its version-specific reader.');
    expect(() => validateGovernanceCompatibilityMetadata({ ...value, generatedBy: 'other', liftoffVersion: 'other' }))
      .toThrow('compatibility.generatedBy must be Mission Control Liftoff.');
    expect(() => validateGovernanceCompatibilityMetadata({ ...value, liftoffVersion: 'other' }))
      .toThrow('compatibility.liftoffVersion must be 0.12.0.');
    const names = managedCoreLogicalNameInventories[3];
    const claude = withInventory(names, ['liftoff-setup-claude']);
    expect(() => validateGovernanceCompatibilityMetadata(claude, { agents: ['github-copilot'] }))
      .toThrow('compatibility.managedCore.updateInventory contains inapplicable integration liftoff-setup-claude.');
    expect(() => validateGovernanceCompatibilityMetadata(claude, { logicalNameAllowlist: [] }))
      .toThrow('compatibility.managedCore.logicalNameAllowlist does not match the packaged managed-core allowlist.');
    expect(() => validateGovernanceCompatibilityMetadata(claude, { pathAllowlist: [] }))
      .toThrow('compatibility.managedCore.pathAllowlist does not match the packaged managed-core path allowlist.');
    expect(() => validateGovernanceCompatibilityMetadata(claude, { inventory: [] }))
      .toThrow('compatibility.managedCore.updateInventory does not match the expected managed update inventory.');
    const invalidMapping = capturedCompatibility();
    activation(invalidMapping).graphMappings = [{}];
    expect(() => validateGovernanceCompatibilityMetadata(invalidMapping))
      .toThrow('compatibility.activation.graphMappings[0].fromGraphHash is required.');
    const invalidLegacy = legacy(2);
    delete historyRecord(activation(invalidLegacy).historicalReadability, 'historical').activationContractVersion;
    expect(() => validateGovernanceCompatibilityMetadata(invalidLegacy))
      .toThrow('compatibility.activation.historicalReadability.activationContractVersion is required.');
    const invalidInventory = withInventory(names, names.slice(0, 1));
    historyRecord(historyArray(core(invalidInventory).updateInventory, 'inventory')[0], 'entry').pathParts = ['elsewhere'];
    expect(() => validateGovernanceCompatibilityMetadata(invalidInventory))
      .toThrow('compatibility.managedCore.updateInventory has invalid exact managed identity repository-governance-policy.');
  });
});


const originalPairs = [
  ['repository-governance-policy', '.liftoff/governance/policy.md'],
  ['repository-governance-context', '.liftoff/governance/context.json'],
  ['repository-governance-guide', '.liftoff/governance/README.md'],
  ['repository-governance-phase-graph', '.liftoff/governance/phase-graph.json'],
  ['repository-governance-compatibility', '.liftoff/governance/compatibility.json'],
  ['repository-governance-credential-policy-schema', '.liftoff/governance/credential-policy.schema.json'],
  ['liftoff-setup-copilot', '.github/prompts/liftoff-setup.prompt.md'],
  ['liftoff-setup-claude', '.claude/commands/liftoff-setup.md'],
  ['liftoff-governance-assess-copilot', '.github/prompts/liftoff-governance-assess.prompt.md'],
  ['liftoff-governance-assess-claude', '.claude/commands/liftoff-governance-assess.md'],
  ['liftoff-setup-codex', '.agents/skills/liftoff-setup/SKILL.md'],
  ['liftoff-governance-assess-codex', '.agents/skills/liftoff-governance-assess/SKILL.md'],
  ['liftoff-repair-copilot', '.github/prompts/liftoff-repair.prompt.md'],
  ['liftoff-repair-claude', '.claude/commands/liftoff-repair.md'],
  ['liftoff-repair-codex', '.agents/skills/liftoff-repair/SKILL.md']
] as const;
function frozenInventory(count = 15, selected: readonly string[] = originalPairs.slice(0, count).map(pair => pair[0])) {
  const value = capturedCompatibility();
  const inventory = selected.map(logicalName => {
    const pair = originalPairs.find(pair => pair[0] === logicalName);
    if (!pair) throw new Error('Unknown test inventory identity.');
    return { logicalName, pathParts: pair[1].split('/'), lifecycle: 'managed-core', contentHashAuthority: authority };
  });
  core(value).logicalNameAllowlist = originalPairs.slice(0, count).map(pair => pair[0]);
  core(value).updateInventory = inventory;
  core(value).pathAllowlist = inventory.map(entry => entry.pathParts);
  return value;
}
function nested(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return keys.reduce((item, key) => historyRecord(item[key], key), value);
}
function item(value: unknown, index = 0) { return historyRecord(historyArray(value, 'entries')[index], 'entry'); }
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/domain/governance/activation/graph.js');
  vi.doUnmock('../src/domain/governance/policy/identity.js');
  vi.doUnmock('../src/domain/project/artifact-lifecycle.js');
  vi.doUnmock('../src/domain/project/catalog.js');
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('released compatibility-4 declarations and closed decoding', () => {
  it('pins all fifteen paths, four ordered logical inventories and sixteen historical paths', () => {
    expect(releasedManagedMetadata.map(entry => [entry.logicalName, entry.pathParts.join('/')])).toEqual(originalPairs);
    expect(releasedManagedLogicalInventories).toEqual([8, 10, 12, 15].map(count => originalPairs.slice(0, count).map(pair => pair[0])));
    expect(historicalMetadataPathParts.map(parts => parts.join('/'))).toEqual([
      'liftoff.config.json', ...[3, 4, 1, 0, 2, 5, 6, 8, 7, 9, 10, 11, 12, 13, 14].map(index => originalPairs[index][1])
    ]);
    expect(releasedManagedActivationIdentities).toEqual([
      historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity
    ]);
    expect(Object.isFrozen(releasedManagedMetadata)).toBe(true);
    for (const entry of releasedManagedMetadata) expect(Object.isFrozen(entry.pathParts)).toBe(true);
    expectTypeOf<ReleasedV3GovernanceCompatibilityMetadata['schemaVersion']>().toEqualTypeOf<4>();
    expectTypeOf<ReleasedV3GovernanceCompatibilityMetadata['liftoffVersion']>().toEqualTypeOf<'0.12.0'>();
    expectTypeOf<ReleasedV3GovernanceCompatibilityMetadata['manifest']['writeVersion']>().toEqualTypeOf<7>();
  });

  it.each([8, 10, 12, 15])('reads released %s-name complete, partial, reordered and empty inventories', count => {
    const names = originalPairs.slice(0, count).map(pair => pair[0]);
    for (const selected of [names, names.slice(-1), [], [...names].reverse()]) {
      const raw = frozenInventory(count, selected);
      const before = JSON.stringify(raw);
      expect(JSON.stringify(validateReleasedV3CompatibilityMetadata(raw))).toBe(before);
      expect(JSON.stringify(raw)).toBe(before);
    }
    expect(validateReleasedV3CompatibilityMetadata(capturedCompatibility())).toEqual(capturedCompatibility());
  });

  it.each(['copilot', 'claude', 'codex'])('reads every released %s integration without inferring a new selection', agent => {
    const selected = originalPairs.filter(pair => pair[0].endsWith(`-${agent}`)).map(pair => pair[0]);
    const value = frozenInventory(15, selected);
    expect(validateReleasedV3CompatibilityMetadata(value).managedCore.updateInventory).toHaveLength(3);
  });

  const mutations: Array<{ name: string; edit: (value: Record<string, unknown>) => void }> = [
    { name: 'old or future schema', edit: value => { value.schemaVersion = 5; } },
    { name: 'wrong generator', edit: value => { value.generatedBy = 'other'; } },
    { name: 'writer label instead of activation release', edit: value => { value.liftoffVersion = '0.12.3'; } },
    { name: 'wrong minimum', edit: value => { nested(value, 'minimumLiftoffVersions').manifestWriteVersion7 = '0.11.0'; } },
    { name: 'empty remedy', edit: value => { nested(value, 'minimumLiftoffVersions').remedy = ''; } },
    { name: 'future read version', edit: value => { nested(value, 'manifest').readVersions = [2, 3, 4, 5, 6, 7, 8]; } },
    { name: 'reordered read versions', edit: value => { nested(value, 'manifest').readVersions = [7, 6, 5, 4, 3, 2]; } },
    { name: 'wrong write version', edit: value => { nested(value, 'manifest').writeVersion = 8; } },
    { name: 'wrong hash authority', edit: value => { nested(value, 'manifest').hashAuthority = 'source bytes'; } },
    { name: 'extra current tuple', edit: value => { historyArray(activation(value).currentCompatibleTuples, 'tuples').push(releasedV3ActivationIdentity); } },
    { name: 'mixed tuple', edit: value => { item(activation(value).currentCompatibleTuples).evidenceHeaderSchemaVersion = 2; } },
    { name: 'placeholder hash', edit: value => { item(activation(value).currentCompatibleTuples).phaseGraphHash = '0'.repeat(64); } },
    { name: 'future identity context', edit: value => { item(activation(value).currentCompatibleTuples).workflow = 'manual'; } },
    { name: 'reordered historical tuples', edit: value => { historyArray(nested(value, 'activation', 'historicalReadability').tuples, 'tuples').reverse(); } },
    { name: 'widened historical aggregate', edit: value => { historyArray(nested(value, 'activation', 'historicalReadability').tuples, 'tuples').push(releasedV3ActivationIdentity); } },
    { name: 'different reader names', edit: value => { nested(value, 'activation', 'historicalReadability').readers = ['activation-v2', 'activation-v1']; } },
    { name: 'executable history', edit: value => { nested(value, 'activation', 'historicalReadability').execution = 'current'; } },
    { name: 'different migration policy', edit: value => { nested(value, 'activation', 'historicalReadability').migration = 'automatic'; } },
    { name: 'unknown recognized graph', edit: value => { activation(value).recognizedGraphHashes = ['a'.repeat(64)]; } },
    { name: 'project graph mapping', edit: value => { activation(value).graphMappings = [{}]; } },
    { name: 'project in-place migration', edit: value => { activation(value).historicalStateMigrations = [{}]; } },
    { name: 'reordered lanes', edit: value => { historyArray(activation(value).successorMigrations, 'lanes').reverse(); } },
    { name: 'future lane', edit: value => { item(activation(value).successorMigrations).id = 'activation-v1-to-v4'; } },
    { name: 'mixed lane source', edit: value => { item(activation(value).successorMigrations).fromIdentity = historicalV2ActivationIdentity; } },
    { name: 'mixed lane target', edit: value => { item(activation(value).successorMigrations).toIdentity = historicalV2ActivationIdentity; } },
    { name: 'wrong strategy', edit: value => { item(activation(value).successorMigrations).strategy = 'convert'; } },
    { name: 'future history schema', edit: value => { item(activation(value).successorMigrations).historySchemaVersion = 2; } },
    { name: 'future journal schema', edit: value => { item(activation(value).successorMigrations).journalSchemaVersion = 2; } },
    { name: 'empty unsupported remedy', edit: value => { activation(value).unsupportedRemedy = ''; } },
    { name: 'unknown logical inventory', edit: value => { core(value).logicalNameAllowlist = ['future-integration']; } },
    { name: 'reordered logical inventory', edit: value => { historyArray(core(value).logicalNameAllowlist, 'names').reverse(); } },
    { name: 'wrong logical path pair', edit: value => { item(core(value).updateInventory).pathParts = ['.liftoff', 'governance', 'elsewhere']; } },
    { name: 'unregistered logical name', edit: value => { item(core(value).updateInventory).logicalName = 'whole-project-assessment'; } },
    { name: 'duplicate entry', edit: value => { historyArray(core(value).updateInventory, 'entries').push(item(core(value).updateInventory)); } },
    { name: 'duplicate path', edit: value => { historyArray(core(value).pathAllowlist, 'paths').push(historyArray(core(value).pathAllowlist, 'paths')[0]); } },
    { name: 'mismatched entry/path order', edit: value => { historyArray(core(value).pathAllowlist, 'paths').reverse(); } },
    { name: 'wrong lifecycle', edit: value => { item(core(value).updateInventory).lifecycle = 'project'; } },
    { name: 'wrong entry authority', edit: value => { item(core(value).updateInventory).contentHashAuthority = 'observed'; } },
    { name: 'nonzero writes', edit: value => { nested(value, 'managedCore', 'validation').checkModeWritesBytes = 1; } },
    { name: 'relaxed validation', edit: value => { nested(value, 'managedCore', 'validation').strictJson = false; } }
  ];
  it.each(mutations)('rejects $name without changing input', ({ edit }) => {
    const value = frozenInventory();
    edit(value);
    const before = JSON.stringify(value);
    expect(() => validateReleasedV3CompatibilityMetadata(value)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });

  it('requires every schema-4 field and refuses extra fields at every closed object', () => {
    const selectors = [
      (v: Record<string, unknown>) => v,
      (v: Record<string, unknown>) => nested(v, 'minimumLiftoffVersions'),
      (v: Record<string, unknown>) => nested(v, 'manifest'),
      activation,
      (v: Record<string, unknown>) => nested(v, 'activation', 'historicalReadability'),
      (v: Record<string, unknown>) => item(activation(v).currentCompatibleTuples),
      (v: Record<string, unknown>) => item(activation(v).successorMigrations),
      core,
      (v: Record<string, unknown>) => item(core(v).updateInventory),
      (v: Record<string, unknown>) => nested(v, 'managedCore', 'validation')
    ];
    for (const select of selectors) {
      for (const key of Object.keys(select(frozenInventory()))) {
        const value = frozenInventory();
        delete select(value)[key];
        expect(() => validateReleasedV3CompatibilityMetadata(value), key).toThrow();
      }
      const value = frozenInventory();
      select(value).extra = true;
      expect(() => validateReleasedV3CompatibilityMetadata(value)).toThrow();
    }
  });

  it.each([0, 2, 3, 4.5, 99, null, '4', undefined])('does not infer released schema-4 support from %s', schemaVersion => {
    const value = capturedCompatibility();
    value.schemaVersion = schemaVersion;
    expect(() => validateReleasedV3CompatibilityMetadata(value)).toThrow();
  });

  it('rejects every independently altered identity component even when other components are known', () => {
    for (const key of Object.keys(releasedV3ActivationIdentity)) {
      const value = capturedCompatibility();
      const identity = item(activation(value).currentCompatibleTuples);
      identity[key] = typeof identity[key] === 'number' ? Number(identity[key]) + 1 : `${identity[key]}-future`;
      expect(() => validateReleasedV3CompatibilityMetadata(value), key).toThrow(/exact released/);
    }
  });

  it.each([['..'], ['C:'], ['\\\\server'], ['part/child'], ['CON'], ['.Liftoff', 'governance', 'policy.md'], ['e\u0301']].map(parts => ({ parts })))
    ('rejects unsafe or aliased declared paths $parts', ({ parts }) => {
      const value = frozenInventory();
      item(core(value).updateInventory).pathParts = parts;
      historyArray(core(value).pathAllowlist, 'paths')[0] = parts;
      expect(() => validateReleasedV3CompatibilityMetadata(value)).toThrow();
    });

  it('preserves freeform remedy text and detaches parsed arrays from frozen declarations', () => {
    const value = frozenInventory();
    nested(value, 'minimumLiftoffVersions').remedy = 'Original operator guidance.';
    activation(value).unsupportedRemedy = 'Preserve these original records.';
    const parsed = validateReleasedV3CompatibilityMetadata(value);
    expect(parsed.minimumLiftoffVersions.remedy).toBe('Original operator guidance.');
    expect(parsed.activation.unsupportedRemedy).toBe('Preserve these original records.');
    const list = historyArray(parsed.activation.successorMigrations, 'lanes');
    item(list).id = 'modified caller result';
    expect(validateReleasedV3CompatibilityMetadata(value).activation.successorMigrations[0].id).toBe('activation-v1-to-v3');
  });
});

const metadataParts = {
  compatibility: ['.liftoff', 'governance', 'compatibility.json'],
  graph: ['.liftoff', 'governance', 'phase-graph.json'],
  credential: ['.liftoff', 'governance', 'credential-policy.schema.json']
};
function capturedFiles(family: 1 | 2) {
  const successor = historyArray(capture.successors, 'successors').map(value => historyRecord(value, 'successor'))
    .find(value => value.family === family);
  if (!successor) throw new Error('Missing original source files.');
  return historyArray(successor.sourceFiles, 'source files').map(value => {
    const file = historyRecord(value, 'source file');
    if (typeof file.content !== 'string' || typeof file.mode !== 'number') throw new Error('Invalid captured source file.');
    return { pathParts: historyPathParts(file.pathParts, 'captured path'), content: Buffer.from(file.content, 'base64'), mode: file.mode };
  });
}
async function write(root: string, parts: readonly string[], content: string | Buffer, mode = 0o600) {
  const file = path.join(root, ...parts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
}
async function sourceRoot(family: 1 | 2 = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-history-'));
  roots.push(root);
  for (const file of capturedFiles(family)) await write(root, file.pathParts, file.content, file.mode);
  return root;
}
function originalMetadata(family: 1 | 2) {
  const file = capturedFiles(family).find(file => file.pathParts.join('/') === metadataParts.compatibility.join('/'));
  if (!file) throw new Error('Missing captured compatibility.');
  return historyRecord(parseHistoryJson(file.content, 'original compatibility'), 'original compatibility');
}

describe('actual frozen managed source-metadata routing', () => {
  it.each([1, 2, 3, 4])('retains exact v1 proof with supported schema-%s managed metadata', async schema => {
    const root = await sourceRoot();
    const value = schema === 1 ? originalMetadata(1) : schema === 4 ? frozenInventory() : originalMetadata(2);
    if (schema === 2) {
      value.schemaVersion = 2;
      delete activation(value).successorMigrations;
      nested(value, 'activation', 'historicalReadability').migration = 'unsupported-preserve-bytes';
    }
    const bytes = Buffer.from(JSON.stringify(value, null, '\t').replace(/\n/g, '\r\n') + '\r\n');
    await write(root, metadataParts.compatibility, bytes, 0o640);
    const beforeState = await fs.readFile(path.join(root, 'governance', 'activation-state.json'));
    const inventory = await readHistoricalActivationInventory(root);
    expect(inventory.state.identity).toEqual(historicalV1ActivationIdentity);
    const retained = inventory.files.find(file => file.pathParts.join('/') === metadataParts.compatibility.join('/'))!;
    expect(retained.content).toEqual(bytes);
    expect(retained.mode).toBe(0o640);
    expect(await fs.readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(beforeState);
    expect(await fs.readFile(path.join(root, ...metadataParts.compatibility))).toEqual(bytes);
  });

  it('uses the same frozen schema-4 routing through exact stored snapshot copies', async () => {
    const root = await sourceRoot(2);
    const bytes = Buffer.from(JSON.stringify(frozenInventory(15, ['liftoff-repair-codex']), null, '\t') + '\r\n');
    await write(root, metadataParts.compatibility, bytes, 0o640);
    const inventory = await readHistoricalActivationInventory(root);
    const files = inventory.files.map(file => ({
      kind: file.kind, originalPathParts: file.pathParts, digest: file.digest, mode: file.mode
    }));
    const snapshotId = activationHistorySnapshotId(inventory.state.identity, files);
    const index = validateActivationHistoryIndex({
      schemaVersion: 1, snapshotId, sourceIdentity: inventory.state.identity,
      files: files.map(file => ({ ...file, copyPathParts: activationHistoryCopyPathParts(snapshotId, file.originalPathParts) }))
    });
    for (const file of index.files) {
      await write(root, file.copyPathParts, inventory.files.find(source => source.pathParts.join('/') === file.originalPathParts.join('/'))!.content);
    }
    await write(root, metadataParts.compatibility, 'malformed active file, not the snapshot');
    const read = await readHistoricalSnapshotInventory(root, index);
    expect(read.files.find(file => file.pathParts.join('/') === metadataParts.compatibility.join('/'))?.content).toEqual(bytes);
    expect(read.state.identity).toEqual(historicalV2ActivationIdentity);
  });

  it.each([5, 99, null, '4', undefined])('rejects unknown compatibility schema %s with no fallback', async schema => {
    const root = await sourceRoot();
    const value = capturedCompatibility();
    if (schema === undefined) delete value.schemaVersion;
    else value.schemaVersion = schema;
    const bytes = Buffer.from(JSON.stringify(value));
    await write(root, metadataParts.compatibility, bytes);
    await expect(readHistoricalActivationInventory(root)).rejects.toMatchObject({ code: 'invalid-managed-source-metadata' });
    expect(await fs.readFile(path.join(root, ...metadataParts.compatibility))).toEqual(bytes);
  });

  it('accepts only the three exact released graphs without rewriting formatting', async () => {
    const root = await sourceRoot();
    const v1 = capturedFiles(1).find(file => file.pathParts.join('/') === metadataParts.graph.join('/'))!.content;
    const graphs = [
      JSON.parse(v1.toString('utf8')),
      JSON.parse(readFileSync('assets/governance/single-maintainer-gitflow/activation-v2-graph.json', 'utf8')),
      JSON.parse(readFileSync('assets/governance/single-maintainer-gitflow/activation-v3-graph.json', 'utf8'))
    ];
    for (const graph of graphs) {
      const bytes = Buffer.from(JSON.stringify(graph, null, '\t').replace(/\n/g, '\r\n') + '\r\n');
      await write(root, metadataParts.graph, bytes);
      expect((await readHistoricalActivationInventory(root)).state.identity).toEqual(historicalV1ActivationIdentity);
      expect(await fs.readFile(path.join(root, ...metadataParts.graph))).toEqual(bytes);
    }
    await write(root, metadataParts.graph, JSON.stringify({ ...graphs[2], schemaVersion: 99 }));
    await expect(readHistoricalActivationInventory(root)).rejects.toMatchObject({ code: 'unsupported-historical-graph' });
  });

  it('accepts exact released credential-schema identities without widening its outer schema checks', async () => {
    const root = await sourceRoot();
    for (const identity of [historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity]) {
      const schema = {
        $schema: 'Original schema label', preservedOuterField: true,
        properties: { identity: { properties: Object.fromEntries(Object.entries(identity).map(([key, value]) => [key, { const: value }])) } }
      };
      await write(root, metadataParts.credential, JSON.stringify(schema));
      expect((await readHistoricalActivationInventory(root)).state.identity).toEqual(historicalV1ActivationIdentity);
      const property = historyRecord(nested(schema, 'properties', 'identity').properties, 'properties');
      property.workflow = { const: 'manual' };
      await write(root, metadataParts.credential, JSON.stringify(schema));
      await expect(readHistoricalActivationInventory(root)).rejects.toThrow(/not supported/);
      delete property.workflow;
      property.phaseGraphHash = { const: '0'.repeat(64) };
      await write(root, metadataParts.credential, JSON.stringify(schema));
      await expect(readHistoricalActivationInventory(root)).rejects.toMatchObject({ code: 'invalid-managed-source-metadata' });
    }
  });

  it('distinguishes optional absence, denied access and unsafe original bytes', async () => {
    const root = await sourceRoot();
    await fs.unlink(path.join(root, ...metadataParts.compatibility));
    expect((await readHistoricalActivationInventory(root)).files.some(file =>
      file.pathParts.join('/') === metadataParts.compatibility.join('/'))).toBe(false);
    const denied = Object.assign(new Error('Explicit read denial'), { code: 'EACCES' });
    vi.doMock('node:fs/promises', async () => ({
      ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),
      open: vi.fn().mockRejectedValue(denied)
    }));
    vi.resetModules();
    const deniedReader = await import('../src/governance-activation/historical-state.js');
    await expect(deniedReader.readHistoricalActivationInventory(root)).rejects.toBe(denied);
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
    await write(root, metadataParts.compatibility, '{"schemaVersion":4,"schemaVersion":4}');
    await expect(readHistoricalActivationInventory(root)).rejects.toMatchObject({ code: 'malformed-history-json' });
    await write(root, metadataParts.compatibility, '{"rawState":{"sensitive":true}}');
    await expect(readHistoricalActivationInventory(root)).rejects.toMatchObject({ code: 'unsafe-historical-payload' });
  });
});

describe('released compatibility is independent of imported current declarations', () => {
  it('survives current identity/graph/catalog replacement but rejects those replacement values', async () => {
    const identities = await vi.importActual<typeof import('../src/domain/governance/policy/identity.js')>('../src/domain/governance/policy/identity.js');
    const graphs = await vi.importActual<typeof import('../src/domain/governance/activation/graph.js')>('../src/domain/governance/activation/graph.js');
    const artifacts = await vi.importActual<typeof import('../src/domain/project/artifact-lifecycle.js')>('../src/domain/project/artifact-lifecycle.js');
    const catalog = await vi.importActual<typeof import('../src/domain/project/catalog.js')>('../src/domain/project/catalog.js');
    const future = { ...releasedV3ActivationIdentity, liftoffVersion: 'future-test-context', manifestArtifactVersion: 99, phaseGraphHash: 'f'.repeat(64) };
    vi.doMock('../src/domain/governance/policy/identity.js', () => ({
      ...identities, liftoffActivationPackageVersion: future.liftoffVersion, liftoffManifestArtifactVersion: 99,
      compatibilityMetadataSchemaVersion: 99, activationStateSchemaVersion: 99,
      historicalActivationIdentities: [...identities.historicalActivationIdentities, identities.releasedV3ActivationIdentity]
    }));
    vi.doMock('../src/domain/governance/activation/graph.js', () => ({
      ...graphs, currentActivationIdentity: future, canonicalPhaseGraphHash: future.phaseGraphHash
    }));
    vi.doMock('../src/domain/project/artifact-lifecycle.js', () => ({
      ...artifacts, managedCoreLogicalNameInventories: [['new-current-plugin']],
      managedCoreArtifactPaths: new Map([['new-current-plugin', ['.liftoff', 'new-current-path']]])
    }));
    vi.doMock('../src/domain/project/catalog.js', () => ({
      ...catalog, governanceAgentIntegrations: {
        'new-current-agent': { setup: { logicalName: 'new-current-plugin' }, assessment: { logicalName: 'new-assessment' }, repair: { logicalName: 'new-repair' } }
      }
    }));
    vi.resetModules();
    const changed = await import('../src/governance-activation/compatibility.js');
    expect(changed.validateReleasedV3CompatibilityMetadata(frozenInventory())).toEqual(frozenInventory());
    expect(() => changed.validateGovernanceCompatibilityMetadata(frozenInventory())).toThrow(/schemaVersion/);
    expect(changed.buildGovernanceCompatibilityMetadata([], [], []).manifest.writeVersion).toBe(99);
    const unknown = frozenInventory();
    activation(unknown).currentCompatibleTuples = [future];
    expect(() => changed.validateReleasedV3CompatibilityMetadata(unknown)).toThrow(/exact released/);
    const newPath = frozenInventory();
    item(core(newPath).updateInventory).logicalName = 'new-current-plugin';
    item(core(newPath).updateInventory).pathParts = ['.liftoff', 'new-current-path'];
    expect(() => changed.validateReleasedV3CompatibilityMetadata(newPath)).toThrow(/invalid exact managed identity/);
    const changedHistory = await import('../src/governance-activation/history-contracts.js');
    expect(changedHistory.historicalMetadataPathParts).toEqual(historicalMetadataPathParts);
  });
});

describe('bounded lexical contract selection', () => {
  function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
  function nodes(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!object(value)) return [];
    return [...(typeof value.type === 'string' ? [value] : []), ...Object.values(value).flatMap(nodes)];
  }
  function tree(file: string) { return parseAst(readFileSync(file, 'utf8'), { lang: 'ts' }, file); }
  function fn(ast: unknown, name: string) {
    const found = nodes(ast).find(node => node.type === 'FunctionDeclaration' && object(node.id) && node.id.name === name);
    if (!found) throw new Error(`Missing function ${name}`);
    return found;
  }
  function names(value: unknown) { return nodes(value).filter(node => node.type === 'Identifier').map(node => node.name); }
  it('uses frozen declarations rather than pretending export mocks replace lexical builders', () => {
    const declarations = tree('src/governance-activation/released-managed-metadata.ts');
    const imports = nodes(declarations).filter(node => node.type === 'ImportDeclaration').map(node => object(node.source) ? node.source.value : undefined);
    expect(imports).toEqual(['../domain/governance/policy/identity.js']);
    for (const forbidden of ['currentActivationIdentity', 'historicalActivationIdentities', 'managedCoreArtifactPaths', 'governanceArtifactPaths']) {
      expect(names(declarations)).not.toContain(forbidden);
    }
    const parser = tree('src/governance-activation/compatibility.ts');
    const selector = fn(parser, 'compatibilityContract');
    const branch = nodes(selector.body).find(node => node.type === 'IfStatement');
    expect(branch).toMatchObject({
      test: { type: 'BinaryExpression', operator: '===', left: { name: 'kind' }, right: { value: 'released-v3' } },
      consequent: { type: 'ReturnStatement', argument: { name: 'releasedV3CompatibilityContract' } }
    });
    expect(names(branch)).not.toContain('packagedActivationSuccessorMigrations');
    const releasedReader = fn(parser, 'validateReleasedV3CompatibilityMetadata');
    expect(names(releasedReader.body)).not.toContain('validateGovernanceCompatibilityMetadata');
    expect(names(releasedReader.body)).not.toContain('buildGovernanceCompatibilityMetadata');
    for (const forbidden of ['identityFields', 'stableIdentity', 'currentActivationIdentity', 'isHistoricalActivationIdentity']) {
      expect(names(fn(parser, 'releasedMetadataIdentity').body)).not.toContain(forbidden);
      expect(names(fn(parser, 'assertReleasedIdentity').body)).not.toContain(forbidden);
    }
    expect(nodes(parser).some(node => node.type === 'ExportNamedDeclaration' &&
      object(node.declaration) && node.declaration.type === 'FunctionDeclaration' &&
      object(node.declaration.id) && node.declaration.id.name === 'readCompatibilityMetadata')).toBe(false);
    const read = fn(parser, 'readCompatibilityMetadata');
    expect(nodes(read.body).some(node => node.type === 'ConditionalExpression' &&
      object(node.test) && object(node.test.right) && node.test.right.value === 'released-v3' &&
      object(node.consequent) && object(node.consequent.object) && node.consequent.object.name === 'releasedV3CompatibilityContract' &&
      object(node.alternate) && object(node.alternate.callee) && node.alternate.callee.name === 'packagedActivationSuccessorMigrations')).toBe(true);
    expect(nodes(read.body).filter(node => node.type === 'BinaryExpression' && ['>=', '>'].includes(String(node.operator)))
      .some(node => object(node.left) && node.left.name === 'schemaVersion')).toBe(false);
    const source = tree('src/governance-activation/historical-state.ts');
    const metadata = fn(source, 'validateHistoricalMetadata');
    for (const forbidden of ['currentActivationIdentity', 'validateGovernanceCompatibilityMetadata', 'historicalActivationIdentities']) {
      expect(names(metadata.body)).not.toContain(forbidden);
    }
    expect(names(metadata.body)).toContain('validateReleasedV3CompatibilityMetadata');
    const history = tree('src/governance-activation/history-contracts.ts');
    expect(names(history)).not.toContain('governanceArtifactPaths');
    expect(names(history)).toContain('releasedHistoricalMetadataPathParts');
  });
});

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { parseAst } from 'rolldown/parseAst';
import * as approvals from '../src/domain/governance/activation/approvals.js';
import {
  normalizeApprovalCostCeiling, normalizeApprovalResources, normalizeApprovalDestinations,
  normalizeApprovalPermissions, normalizeApprovalPolicyExceptions, normalizeApprovalDestructiveScope,
  canonicalApprovalEnvelopeScope, canonicalApprovalEnvelopeHash
} from '../src/domain/governance/activation/approvals.js';
import { validateApprovalEnvelope } from '../src/domain/governance/activation/validators.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import type {
  ApprovalCostCeiling, ApprovalResourceScope, ApprovalDestinationScope
} from '../src/domain/governance/activation/types.js';
import { historyArray, historyRecord, parseHistoryJson, rawHistoryDigest } from '../src/governance-activation/history-contracts.js';
import * as values from '../src/domain/governance/activation/approval-values.js';
import type {
  ApprovalResourceValueV1, ApprovalDestinationValueV1, ApprovalCostValueV1
} from '../src/domain/governance/activation/approval-values.js';

const normalizerNames = [
  'normalizeApprovalCostCeiling', 'normalizeApprovalResources', 'normalizeApprovalDestinations',
  'normalizeApprovalPermissions', 'normalizeApprovalPolicyExceptions', 'normalizeApprovalDestructiveScope'
] as const;
const captureBytes = readFileSync(new URL('./fixtures/activation-v3/records.json', import.meta.url));
const capture = historyRecord(parseHistoryJson(captureBytes, 'frozen v3 capture'), 'frozen v3 capture');
const capturedApproval = historyArray(capture.approvals, 'captured approvals')[0];

// Run and pin this exact block before extraction; keep it as the original
// behavior oracle rather than tightening the value boundary during the move.
describe('original approval value characterization', () => {
  it('keeps the six public functions and no new helper facade exports', () => {
    for (const name of normalizerNames) expect(approvals[name]).toBeTypeOf('function');
    for (const name of ['cleanString', 'sortedUnique', 'resourceKey', 'destinationKey']) expect(approvals).not.toHaveProperty(name);
    expect(rawHistoryDigest(captureBytes)).toBe('cb9a4768b30e031d9d4b802528223679efa28259b50713221cdfc7a71d6eda46');
  });

  it('normalizes resources by canonical keys without changing identity case or input objects', () => {
    const source = Object.freeze([
      Object.freeze({ type: ' Azure ', identity: ' Beta ' }),
      Object.freeze({ type: '\tGITHUB\n', identity: 'alpha' })
    ]);
    const result = normalizeApprovalResources(source);
    expect(result).toEqual([{ type: 'github', identity: 'alpha' }, { type: 'azure', identity: 'Beta' }]);
    expect(JSON.stringify(result)).toBe('[{"type":"github","identity":"alpha"},{"type":"azure","identity":"Beta"}]');
    expect(source[0]).toEqual({ type: ' Azure ', identity: ' Beta ' });
    expect(result).not.toBe(source);
    expect(result[1]).not.toBe(source[0]);
    const sameIdentity = [
      { type: 'Z', identity: 'shared' }, { type: 'a', identity: 'shared' }
    ];
    expect(normalizeApprovalResources(sameIdentity).map(value => value.type)).toEqual(['a', 'z']);
  });

  it.each(['repository', 'subscription', 'environment', 'tenant', 'local', 'external'] as const)(
    'preserves the original destination kind %s and nullable fields',
    type => {
      const input = Object.freeze({
        type, identity: ' Target ', repository: ' Owner/Repo ', subscriptionId: '\tSUB\n'
      });
      expect(normalizeApprovalDestinations([input])).toEqual([{
        type, identity: 'Target', repository: 'Owner/Repo', subscriptionId: 'SUB'
      }]);
      expect(normalizeApprovalDestinations([{ ...input, repository: null, subscriptionId: null }])).toEqual([{
        type, identity: 'Target', repository: null, subscriptionId: null
      }]);
      expect(input.identity).toBe(' Target ');
    }
  );

  it('sorts destinations by all normalized fields and detects normalized duplicates', () => {
    const source: ApprovalDestinationScope[] = [
      { type: 'repository', identity: 'same', repository: 'z/repo', subscriptionId: null },
      { type: 'repository', identity: 'same', repository: 'a/repo', subscriptionId: null }
    ];
    expect(normalizeApprovalDestinations(source).map(value => value.repository)).toEqual(['a/repo', 'z/repo']);
    const normalized = { type: 'repository', identity: 'same', repository: 'a/repo', subscriptionId: null };
    expect(() => normalizeApprovalDestinations([source[1], { ...source[1], identity: ' same ' }]))
      .toThrow(`approvalEnvelope.destinations must not contain duplicate ${canonicalJson(normalized)}.`);
    expect(() => normalizeApprovalResources([{ type: 'AZURE', identity: 'same' }, { type: ' azure ', identity: ' same ' }]))
      .toThrow(`approvalEnvelope.resources must not contain duplicate ${canonicalJson({ type: 'azure', identity: 'same' })}.`);
  });

  it('retains freeform permissions while trimming, lowercasing and sorting them', () => {
    const permissions = Object.freeze([' Unknown.Future/Write ', 'azure:read', ' GIT-COMMIT ']);
    expect(normalizeApprovalPermissions(permissions)).toEqual(['azure:read', 'git-commit', 'unknown.future/write']);
    expect(permissions[0]).toBe(' Unknown.Future/Write ');
    expect(() => normalizeApprovalPermissions(['Write', ' write ']))
      .toThrow('approvalEnvelope.permissions must not contain duplicate write.');
  });

  it.each([
    { name: 'policyExceptions', normalize: normalizeApprovalPolicyExceptions },
    { name: 'destructiveScope', normalize: normalizeApprovalDestructiveScope }
  ])('preserves case and lax freeform $name values', ({ name, normalize }) => {
    const input = Object.freeze([' Zed ', 'Beta', '\talpha\n', '../recorded-freeform-scope']);
    expect(normalize(input)).toEqual(['../recorded-freeform-scope', 'alpha', 'Beta', 'Zed']);
    expect(input[0]).toBe(' Zed ');
    expect(normalize(['A', 'a'])).toEqual(['a', 'A']);
    expect(() => normalize(['one', ' one '])).toThrow(`approvalEnvelope.${name} must not contain duplicate one.`);
  });

  it('preserves original cost semantics including negative zero and nonstandard uppercase currency', () => {
    const source = Object.freeze({ currency: ' XYZ ', fixedMonthlyCents: -0, usageMonthlyCents: Number.MAX_SAFE_INTEGER });
    const output = normalizeApprovalCostCeiling(source);
    expect(output).toEqual({ currency: 'XYZ', fixedMonthlyCents: -0, usageMonthlyCents: Number.MAX_SAFE_INTEGER });
    expect(Object.is(output.fixedMonthlyCents, -0)).toBe(true);
    expect(source.currency).toBe(' XYZ ');
    expect(output).not.toBe(source);
    expect(Object.keys(output)).toEqual(['currency', 'fixedMonthlyCents', 'usageMonthlyCents']);
  });

  it.each(['usd', 'US', 'USDD', 'U1D', 'U\u00c9D'])('rejects invalid original currency %s', currency => {
    expect(() => normalizeApprovalCostCeiling({ currency, fixedMonthlyCents: 0, usageMonthlyCents: 0 }))
      .toThrow('approvalEnvelope.costCeiling.currency must be a three-letter uppercase ISO currency code.');
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN])(
    'rejects nonnegative-safe-integer cost violation %s in either field',
    invalid => {
      for (const field of ['fixedMonthlyCents', 'usageMonthlyCents'] as const) {
        const cost: ApprovalCostCeiling = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 };
        cost[field] = invalid;
        expect(() => normalizeApprovalCostCeiling(cost))
          .toThrow(`approvalEnvelope.costCeiling.${field} must be a non-negative safe integer number of cents.`);
      }
    }
  );

  it('retains value-object projection rather than introducing extra-field rejection', () => {
    const resource = { type: 'AZURE', identity: 'value', extra: 'discarded' };
    const destination: ApprovalDestinationScope & { extra: string } = {
      type: 'local', identity: 'value', repository: null, subscriptionId: null, extra: 'discarded'
    };
    const cost = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 1, extra: 'discarded' };
    expect(normalizeApprovalResources([resource])).toEqual([{ type: 'azure', identity: 'value' }]);
    expect(normalizeApprovalDestinations([destination])).toEqual([{
      type: 'local', identity: 'value', repository: null, subscriptionId: null
    }]);
    expect(normalizeApprovalCostCeiling(cost)).toEqual({ currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 1 });
    expect(resource.extra).toBe('discarded');
  });

  it('keeps empty-list acceptance and does not alias empty input arrays', () => {
    for (const normalize of [
      normalizeApprovalResources, normalizeApprovalDestinations, normalizeApprovalPermissions,
      normalizeApprovalPolicyExceptions, normalizeApprovalDestructiveScope
    ]) {
      const input: never[] = [];
      const output = normalize(input);
      expect(output).toEqual([]);
      expect(output).not.toBe(input);
    }
  });

  it('keeps malformed value diagnostics and original failure precedence', () => {
    expect(() => Reflect.apply(normalizeApprovalResources, undefined, [[{ type: 1, identity: '' }]]))
      .toThrow('approvalEnvelope.resources[0].type must be a string.');
    expect(() => normalizeApprovalResources([{ type: ' ', identity: '' }]))
      .toThrow('approvalEnvelope.resources[0].type must be a non-empty string.');
    expect(() => normalizeApprovalResources([{ type: 'azure', identity: '\n' }]))
      .toThrow('approvalEnvelope.resources[0].identity must be a non-empty string.');
    expect(() => Reflect.apply(normalizeApprovalDestinations, undefined, [[{ type: ' repository ', identity: '', repository: null, subscriptionId: null }]]))
      .toThrow('approvalEnvelope.destinations[0].type contains unsupported value " repository ".');
    expect(() => Reflect.apply(normalizeApprovalDestinations, undefined, [[{ type: 'repository', identity: 'repo', subscriptionId: null }]]))
      .toThrow('approvalEnvelope.destinations[0].repository must be a string.');
    expect(() => normalizeApprovalDestinations([{ type: 'repository', identity: 'repo', repository: null, subscriptionId: ' ' }]))
      .toThrow('approvalEnvelope.destinations[0].subscriptionId must be a non-empty string.');
    for (const [normalize, name] of [
      [normalizeApprovalPermissions, 'permissions'],
      [normalizeApprovalPolicyExceptions, 'policyExceptions'],
      [normalizeApprovalDestructiveScope, 'destructiveScope']
    ] as const) {
      expect(() => normalize([' \t'])).toThrow(`approvalEnvelope.${name}[0] must be a non-empty string.`);
      expect(() => Reflect.apply(normalize, undefined, [[5]])).toThrow(`approvalEnvelope.${name}[0] must be a string.`);
    }
    expect(() => Reflect.apply(normalizeApprovalCostCeiling, undefined, [{ currency: 7, fixedMonthlyCents: -1 }]))
      .toThrow('approvalEnvelope.costCeiling.currency must be a string.');
    expect(() => Reflect.apply(normalizeApprovalCostCeiling, undefined, [{ currency: 'USD', fixedMonthlyCents: '0', usageMonthlyCents: 0 }]))
      .toThrow('approvalEnvelope.costCeiling.fixedMonthlyCents must be a non-negative safe integer number of cents.');
  });

  it('retains current canonical approval projection, interval and approver hashing', () => {
    const original = validateApprovalEnvelope(capturedApproval);
    const envelope = {
      ...original,
      resources: [{ type: ' Azure ', identity: ' ExactCase ' }],
      destinations: [{ type: 'local' as const, identity: ' Project ', repository: null, subscriptionId: null }],
      permissions: [' READ-WORKTREE ', 'git-commit'],
      costCeiling: { currency: ' USD ', fixedMonthlyCents: 0, usageMonthlyCents: 10 },
      policyExceptions: [' Zed ', 'alpha'],
      destructiveScope: [' Scope '],
      approver: ' fixture-maintainer '
    };
    const expected = {
      schemaVersion: envelope.schemaVersion, phaseId: envelope.phaseId, gateKind: envelope.gateKind,
      identity: envelope.identity, baselineSha: envelope.baselineSha, planDigest: envelope.planDigest,
      resources: [{ type: 'azure', identity: 'ExactCase' }],
      destinations: [{ type: 'local', identity: 'Project', repository: null, subscriptionId: null }],
      permissions: ['git-commit', 'read-worktree'],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 10 },
      policyExceptions: ['alpha', 'Zed'], destructiveScope: ['Scope'],
      scope: envelope.scope,
      coveredPhases: envelope.coveredPhases,
      operationDigests: envelope.operationDigests,
      phasePlanDigests: envelope.phasePlanDigests,
      expiresAt: envelope.expiresAt, approvedAt: envelope.approvedAt, approver: 'fixture-maintainer'
    };
    expect(canonicalApprovalEnvelopeScope(envelope)).toEqual(expected);
    expect(JSON.stringify(canonicalApprovalEnvelopeScope(envelope))).toBe(JSON.stringify(expected));
    expect(canonicalApprovalEnvelopeHash(envelope)).toBe(canonicalSha256(expected));
    expect(canonicalApprovalEnvelopeHash({ ...envelope, approvedAt: '2026-09-12T00:00:01.000Z' }))
      .not.toBe(canonicalApprovalEnvelopeHash(envelope));
    expect(canonicalApprovalEnvelopeHash({ ...envelope, approver: 'other' }))
      .not.toBe(canonicalApprovalEnvelopeHash(envelope));
    expect(validateApprovalEnvelope(capturedApproval)).toEqual(original);
  });
});

afterEach(() => {
  vi.doUnmock('../src/domain/governance/activation/approvals.js');
  vi.doUnmock('../src/domain/governance/activation/graph.js');
  vi.doUnmock('../src/domain/governance/activation/inputs.js');
  vi.doUnmock('../src/domain/governance/activation/types.js');
  vi.doUnmock('../src/domain/governance/policy/identity.js');
  vi.resetModules();
});

describe('stable approval value-v1 types and exports', () => {
  it('keeps exactly the original three field shapes without current identity/phase dependencies', () => {
    expectTypeOf<keyof ApprovalResourceValueV1>().toEqualTypeOf<'type' | 'identity'>();
    expectTypeOf<ApprovalResourceValueV1>().toEqualTypeOf<{ type: string; identity: string }>();
    expectTypeOf<keyof ApprovalDestinationValueV1>().toEqualTypeOf<'type' | 'identity' | 'repository' | 'subscriptionId'>();
    expectTypeOf<ApprovalDestinationValueV1['type']>()
      .toEqualTypeOf<'repository' | 'subscription' | 'environment' | 'tenant' | 'local' | 'external'>();
    expectTypeOf<ApprovalDestinationValueV1['repository']>().toEqualTypeOf<string | null>();
    expectTypeOf<ApprovalDestinationValueV1['subscriptionId']>().toEqualTypeOf<string | null>();
    expectTypeOf<keyof ApprovalCostValueV1>().toEqualTypeOf<'currency' | 'fixedMonthlyCents' | 'usageMonthlyCents'>();
    expectTypeOf<ApprovalCostValueV1>().toEqualTypeOf<{
      currency: string; fixedMonthlyCents: number; usageMonthlyCents: number;
    }>();
    expectTypeOf<ApprovalResourceScope>().toEqualTypeOf<ApprovalResourceValueV1>();
    expectTypeOf<ApprovalDestinationScope>().toEqualTypeOf<ApprovalDestinationValueV1>();
    expectTypeOf<ApprovalCostCeiling>().toEqualTypeOf<ApprovalCostValueV1>();

    const resource: ApprovalResourceValueV1 = { type: 'fixture', identity: 'first' };
    resource.type = 'updated';
    resource.identity = 'second';
    const destination: ApprovalDestinationValueV1 = { type: 'local', identity: 'first', repository: null, subscriptionId: null };
    destination.type = 'repository';
    destination.identity = 'second';
    destination.repository = 'owner/repo';
    destination.subscriptionId = 'subscription';
    const cost: ApprovalCostValueV1 = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 };
    cost.currency = 'XYZ';
    cost.fixedMonthlyCents = 1;
    cost.usageMonthlyCents = 2;
    const currentResource: ApprovalResourceScope = resource;
    const currentDestination: ApprovalDestinationScope = destination;
    const currentCost: ApprovalCostCeiling = cost;
    expect(currentResource).toBe(resource);
    expect(currentDestination).toBe(destination);
    expect(currentCost).toBe(cost);
  });

  it('retains readonly input arrays, mutable value results and source-compatible public functions', () => {
    expectTypeOf<typeof values.normalizeApprovalResources>().toEqualTypeOf<
      (resources: readonly ApprovalResourceValueV1[]) => ApprovalResourceValueV1[]
    >();
    expectTypeOf<typeof values.normalizeApprovalDestinations>().toEqualTypeOf<
      (destinations: readonly ApprovalDestinationValueV1[]) => ApprovalDestinationValueV1[]
    >();
    expectTypeOf<typeof values.normalizeApprovalCostCeiling>().toEqualTypeOf<
      (cost: ApprovalCostValueV1) => ApprovalCostValueV1
    >();
    expectTypeOf<typeof normalizeApprovalResources>().toEqualTypeOf<
      (resources: readonly ApprovalResourceScope[]) => ApprovalResourceScope[]
    >();
    expectTypeOf<typeof normalizeApprovalDestinations>().toEqualTypeOf<
      (destinations: readonly ApprovalDestinationScope[]) => ApprovalDestinationScope[]
    >();
    expectTypeOf<typeof normalizeApprovalCostCeiling>().toEqualTypeOf<
      (cost: ApprovalCostCeiling) => ApprovalCostCeiling
    >();
    for (const normalize of [
      values.normalizeApprovalPermissions, values.normalizeApprovalPolicyExceptions, values.normalizeApprovalDestructiveScope
    ]) expectTypeOf(normalize).toEqualTypeOf<(input: readonly string[]) => string[]>();
    const result = values.normalizeApprovalResources(Object.freeze([Object.freeze({ type: 'TEST', identity: 'a' })]));
    result[0].identity = 'b';
    result.push({ type: 'second', identity: 'c' });
    expect(result).toHaveLength(2);
  });

  it('re-exports the same six functions and keeps sibling helpers out of the existing facade', () => {
    for (const name of normalizerNames) expect(approvals[name]).toBe(values[name]);
    expect(Object.keys(values).sort()).toEqual([...normalizerNames, 'cleanString', 'sortedUnique', 'resourceKey', 'destinationKey'].sort());
    for (const name of ['cleanString', 'sortedUnique', 'resourceKey', 'destinationKey']) expect(approvals).not.toHaveProperty(name);
  });

  it('retains the generic shared helpers used by current hashing, sorting and scope comparison', () => {
    expect(values.cleanString('\tOriginal Label\n', 'fixture')).toBe('Original Label');
    expect(() => values.cleanString('  ', 'fixture')).toThrow('fixture must be a non-empty string.');
    const resource = { type: 'original', identity: 'ExactCase' };
    const destination: ApprovalDestinationValueV1 = { type: 'repository', identity: 'ExactCase', repository: null, subscriptionId: null };
    expect(values.resourceKey(resource)).toBe(canonicalJson(resource));
    expect(values.destinationKey(destination)).toBe(canonicalJson(destination));
    const source: readonly { name: string }[] = Object.freeze([Object.freeze({ name: ' Zed ' }), Object.freeze({ name: 'alpha' })]);
    const seenIndexes: number[] = [];
    const result = values.sortedUnique(source, 'fixture', (value, index) => {
      seenIndexes.push(index);
      return { name: value.name.trim() };
    }, value => value.name);
    expect(result).toEqual([{ name: 'alpha' }, { name: 'Zed' }]);
    expect(seenIndexes).toEqual([0, 1]);
    expect(source[0].name).toBe(' Zed ');
    expect(() => values.sortedUnique(['A', ' a '], 'fixture', value => value.trim().toLowerCase(), value => value))
      .toThrow('fixture must not contain duplicate a.');
  });
});

describe('approval value leaf dependency boundary', () => {
  it('runs all six normalizers without loading the current approval/graph/input/type/identity modules', async () => {
    const blocked = vi.fn(() => { throw new Error('Current activation module was imported.'); });
    vi.doMock('../src/domain/governance/activation/approvals.js', blocked);
    vi.doMock('../src/domain/governance/activation/graph.js', blocked);
    vi.doMock('../src/domain/governance/activation/inputs.js', blocked);
    vi.doMock('../src/domain/governance/activation/types.js', blocked);
    vi.doMock('../src/domain/governance/policy/identity.js', blocked);
    vi.resetModules();
    const leaf = await import('../src/domain/governance/activation/approval-values.js');
    expect(leaf.normalizeApprovalResources([{ type: ' TYPE ', identity: ' item ' }])).toEqual([{ type: 'type', identity: 'item' }]);
    expect(leaf.normalizeApprovalDestinations([{
      type: 'local', identity: ' project ', repository: null, subscriptionId: null
    }])).toEqual([{ type: 'local', identity: 'project', repository: null, subscriptionId: null }]);
    expect(leaf.normalizeApprovalCostCeiling({ currency: ' USD ', fixedMonthlyCents: 0, usageMonthlyCents: 1 }))
      .toEqual({ currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 1 });
    expect(leaf.normalizeApprovalPermissions([' B ', 'A'])).toEqual(['a', 'b']);
    expect(leaf.normalizeApprovalPolicyExceptions([' Zed ', 'alpha'])).toEqual(['alpha', 'Zed']);
    expect(leaf.normalizeApprovalDestructiveScope([' Zed ', 'alpha'])).toEqual(['alpha', 'Zed']);
    expect(blocked).not.toHaveBeenCalled();
    await expect(import('../src/domain/governance/activation/approvals.js')).rejects.toThrow(/error when mocking a module/);
    expect(blocked).toHaveBeenCalledOnce();
  });

  it('keeps frozen value interfaces and lexical imports independent of mutable current declarations', () => {
    function object(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
    function nodes(value: unknown): Record<string, unknown>[] {
      if (Array.isArray(value)) return value.flatMap(nodes);
      if (!object(value)) return [];
      return [...(typeof value.type === 'string' ? [value] : []), ...Object.values(value).flatMap(nodes)];
    }
    function tree(file: string) { return parseAst(readFileSync(file, 'utf8'), { lang: 'ts' }, file); }
    function imports(ast: unknown) {
      return nodes(ast).filter(node => node.type === 'ImportDeclaration');
    }
    function sourceOf(node: Record<string, unknown>) { return object(node.source) ? node.source.value : undefined; }
    const leaf = tree('src/domain/governance/activation/approval-values.ts');
    expect(imports(leaf).map(sourceOf)).toEqual(['./canonical-json.js']);
    expect(nodes(leaf).filter(node => node.type === 'ImportExpression')).toEqual([]);
    const interfaces = nodes(leaf).filter(node => node.type === 'TSInterfaceDeclaration');
    expect(interfaces.map(node => object(node.id) ? node.id.name : undefined).sort()).toEqual([
      'ApprovalCostValueV1', 'ApprovalDestinationValueV1', 'ApprovalResourceValueV1'
    ]);
    const identifiers = nodes(leaf).filter(node => node.type === 'Identifier').map(node => node.name);
    for (const forbidden of ['ActivationIdentity', 'CurrentActivationIdentity', 'PhaseId', 'ApprovalEnvelope', 'phaseIds', 'currentActivationIdentity']) {
      expect(identifiers).not.toContain(forbidden);
    }
    const currentTypes = tree('src/domain/governance/activation/types.ts');
    for (const [current, stable] of [
      ['ApprovalResourceScope', 'ApprovalResourceValueV1'],
      ['ApprovalDestinationScope', 'ApprovalDestinationValueV1'],
      ['ApprovalCostCeiling', 'ApprovalCostValueV1']
    ]) {
      const found = nodes(currentTypes).find(node =>
        node.type === 'TSInterfaceDeclaration' && object(node.id) && node.id.name === current);
      expect(found).toBeDefined();
      expect(nodes(found).filter(node => node.type === 'Identifier').map(node => node.name)).toContain(stable);
      expect(object(found?.body) ? found.body.body : undefined).toEqual([]);
    }
    const facade = tree('src/domain/governance/activation/approvals.ts');
    const leafExport = nodes(facade).find(node => node.type === 'ExportNamedDeclaration' && sourceOf(node) === './approval-values.js');
    expect(leafExport).toBeDefined();
    expect(nodes(leafExport).filter(node => node.type === 'ExportSpecifier').map(node =>
      object(node.exported) ? node.exported.name : undefined).sort()).toEqual([...normalizerNames].sort());
    for (const name of [...normalizerNames, 'cleanString', 'sortedUnique', 'resourceKey', 'destinationKey',
      'normalizeResource', 'normalizeDestination', 'normalizePermission', 'normalizePlainScope']) {
      expect(nodes(facade).some(node =>
        node.type === 'FunctionDeclaration' && object(node.id) && node.id.name === name)).toBe(false);
    }
    const records = tree('src/domain/governance/activation/record-validation.ts');
    expect(imports(records).map(sourceOf)).not.toContain('./approvals.js');
    const leafImport = imports(records).find(node => sourceOf(node) === './approval-values.js');
    expect(leafImport).toBeDefined();
    expect(nodes(leafImport).filter(node => node.type === 'ImportSpecifier').map(node =>
      object(node.imported) ? node.imported.name : undefined).sort()).toEqual([...normalizerNames].sort());
  });
});

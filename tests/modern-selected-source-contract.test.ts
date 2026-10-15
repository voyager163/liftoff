import { afterAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  modernActivationSourceContracts, preWorkflowModernActivationSourceContracts,
  preCustodyModernActivationSourceContracts, readableModernActivationSourceContracts,
  readableModernActivationSourceContract
} from '../src/domain/governance/policy/identity.js';
import {
  countSourceClones, selectedFactories, selectedInvalidIdentityControls, selectedSourceCases, sourceFactorySnapshot
} from './fixtures/modern-selected-source-contract.js';

const cases = selectedSourceCases();
const observed: {
  hash: string; source: (typeof cases)[number]['source']; rowDigest: string;
  recordedIdentity: (typeof cases)[number]['recordedIdentity'];
  factory: ReturnType<typeof sourceFactorySnapshot>;
}[] = [];
const measured: { hash: string; name: string; counts: ReturnType<typeof countSourceClones>['counts'] }[] = [];

afterAll(async () => {
  const output = process.env.LIFTOFF_SELECTED_SOURCE_OUTPUT;
  if (!output) return;
  const full = {
    current: modernActivationSourceContracts(), preWorkflow: preWorkflowModernActivationSourceContracts(),
    preCustody: preCustodyModernActivationSourceContracts(), readable: readableModernActivationSourceContracts()
  };
  await writeFile(output, JSON.stringify({
    observed, measured, full, failures: selectedInvalidIdentityControls(),
    fullDigests: Object.fromEntries(Object.entries(full).map(([name, value]) => [name, canonicalSha256(value)]))
  }, null, 2) + '\n', { flag: 'wx' });
});

describe.each(cases.map((value, index) => ({ ...value, index })))(
  'fresh selected readable source $index/$source.identity.profile/$source.identity.workflow',
  ({ source, input, recordedIdentity }) => {
    it('preserves the complete registered row and clones only that row once', () => {
      const { value, counts } = countSourceClones(() => readableModernActivationSourceContract(source.identity.phaseGraphHash));
      expect(value).toEqual(source);
      expect(canonicalSha256(value)).toBe(canonicalSha256(source));
      expect(counts).toMatchObject({ arrayCalls: 0, rowCalls: 1, graphRows: 1, bareGraphCalls: 0,
        hashes: { [source.identity.phaseGraphHash]: 1 } });
    });

    it('returns fresh deep-frozen graphs and leaves caller and full getters nonaliased', () => {
      const first = readableModernActivationSourceContract(source.identity.phaseGraphHash)!;
      const second = readableModernActivationSourceContract(source.identity.phaseGraphHash)!;
      function independent(left: unknown, right: unknown) {
        if (typeof left !== 'object' || left === null) return;
        expect(left).not.toBe(right);
        expect(Object.isFrozen(left)).toBe(true);
        for (const key of Object.keys(left)) independent(Reflect.get(left, key), Reflect.get(Object(right), key));
      }
      independent(first, second); independent(first, source);
      expect(Reflect.set(first.identity, 'policyVersion', 'changed')).toBe(false);
      expect(Reflect.set(first.graph.phases, '0', {})).toBe(false);
      expect(first).toEqual(source);
      expect(Object.isFrozen(input.selection.project)).toBe(false);
    });

    it('copies only the selected row in each guarded consumer, without sharing a graph', () => {
      const before = structuredClone(input);
      for (const [name, factory] of Object.entries(selectedFactories)) {
        if (name === 'metadata' && recordedIdentity.workflow === 'manual') {
          const { counts } = countSourceClones(() => expect(() => factory(input)).toThrow(/Manual/));
          expect(counts.graphRows).toBe(0);
          measured.push({ hash: source.identity.phaseGraphHash, name, counts });
          continue;
        }
        const { counts } = countSourceClones(() => factory(input));
        const expected = name === 'records' ? 2 : 1;
        expect(counts).toMatchObject({ arrayCalls: 0, rowCalls: expected, graphRows: expected,
          bareGraphCalls: 0, hashes: { [source.identity.phaseGraphHash]: expected } });
        measured.push({ hash: source.identity.phaseGraphHash, name, counts });
      }
      const first = selectedFactories.records(input), second = selectedFactories.records(input);
      expect(first.graph).not.toBe(second.graph);
      expect(first.graph).not.toBe(source.graph);
      expect(first.graph).toEqual(source.graph);
      expect(input).toEqual(before);
      expect(Object.isFrozen(input.selection.project)).toBe(false);
      const changed = structuredClone(input);
      Reflect.set(changed.selection.project, 'name', 'different source selection');
      expect(() => selectedFactories.records(changed)).toThrow(/complete source contract/);
    });

    it('roundtrips all record kinds and metadata with complete selected identity and graph', () => {
      const factory = sourceFactorySnapshot(input), api = selectedFactories.records(input);
      const validators = selectedFactories.validators(input).records;
      const { state, completed, plan, approval, evidence, credential, supersession } = factory.records;
      const related = { plans: [plan], evidence: [evidence] };
      expect(api.identity).toEqual(recordedIdentity);
      expect(api.graph).toEqual(source.graph);
      expect(validators.validateActivationIdentity(api.identity)).toEqual(recordedIdentity);
      expect(validators.validateUserActivationState(state)).toEqual(state);
      expect(api.readState(JSON.parse(factory.encoded.state))).toEqual(state);
      expect(api.readState(JSON.parse(factory.encoded.completed), related)).toEqual(completed);
      expect(api.readPlan(JSON.parse(factory.encoded.plan))).toEqual(plan);
      expect(api.readApproval(JSON.parse(factory.encoded.approval))).toEqual(approval);
      expect(api.readEvidence(JSON.parse(factory.encoded.evidence), related)).toEqual(evidence);
      expect(api.readCredentialPolicy(JSON.parse(factory.encoded.credential))).toEqual(credential);
      if (supersession && factory.encoded.supersession) {
        expect(api.readSupersession(JSON.parse(factory.encoded.supersession))).toEqual(supersession);
      } else expect(() => api.createSupersession({
        supersededChangeId: 'old-work', supersedingChangeId: 'reviewed-work', reason: 'format-only',
        approvedAt: '2026-09-01T00:00:00.000Z', approver: 'format-only'
      })).toThrow(/Manual/);
      if (factory.metadata) {
        const metadata = selectedFactories.metadata(input);
        expect(metadata.read(JSON.parse(factory.metadata.encoded))).toEqual(factory.metadata.created);
        expect(metadata.graph).toEqual(source.graph);
        const invalid = structuredClone(factory.metadata.created);
        Reflect.set(invalid.activationIdentity, 'pluginResolutionDigest', 'unknown');
        expect(() => metadata.read(invalid)).toThrow(/complete selected identity/);
      }
      for (const read of [
        () => api.readState({ ...state, identity: { ...state.identity, phaseGraphHash: 'unknown' } }),
        () => api.readPlan({ ...plan, identity: { ...plan.identity, phaseGraphHash: 'unknown' } }),
        () => api.readApproval({ ...approval, identity: { ...approval.identity, phaseGraphHash: 'unknown' } }),
        () => api.readEvidence({ ...evidence, header: { ...evidence.header, identity: { ...evidence.header.identity, phaseGraphHash: 'unknown' } } }, related),
        () => api.readCredentialPolicy({ ...credential, identity: { ...credential.identity, phaseGraphHash: 'unknown' } })
      ]) expect(read).toThrow(/exact modern source/);
      observed.push({ hash: source.identity.phaseGraphHash, source, rowDigest: canonicalSha256(source), recordedIdentity, factory });
    });
  }
);

it('preserves all four full getter digests and readable ordering', () => {
  expect(canonicalSha256(modernActivationSourceContracts())).toBe('dcf71aa7039fd27307b8fa7e47f3a9577af6bca1b42007b5c6d50ca6afe8c71d');
  expect(canonicalSha256(preWorkflowModernActivationSourceContracts())).toBe('343d62d5a939134e8799d93d544f1f2d5959c0d729c9c3f263862fa505c40289');
  expect(canonicalSha256(preCustodyModernActivationSourceContracts())).toBe('1063f49769a76f3ed56458a970f75bbd6aaa51ca63be9795a2805215f565cd29');
  expect(canonicalSha256(readableModernActivationSourceContracts())).toBe('ae79ca38bc3a17eb24fb207bd2a58e30aa6d95a178ab6cfdce12cc257b46b252');
});

it('retains identity rejection before selection for all18rows/17fields/3consumers', () => {
  const controls = selectedInvalidIdentityControls();
  expect(controls).toHaveLength(918);
  for (const { value, counts } of controls) {
    expect(value.message).toMatch(/Modern activation/);
    expect(counts.graphRows).toBe(0);
  }
});

it('preserves unmatched lookup without cloning any row', () => {
  const { value, counts } = countSourceClones(() => readableModernActivationSourceContract('unregistered-graph'));
  expect(value).toBeUndefined();
  expect(counts.graphRows).toBe(0);
});

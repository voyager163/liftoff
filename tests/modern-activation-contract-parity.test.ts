import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  canonicalPhaseGraph, canonicalPhaseGraphJson, canonicalPhaseGraphHash, canonicalPhaseContractDigests
} from '../src/domain/governance/activation/graph.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import * as identities from '../src/domain/governance/policy/identity.js';
import { historicalV3PhaseGraph } from '../src/governance-activation/historical-v3.js';
import type { ModernActivationState, ModernApprovalEnvelope, ModernCredentialPolicy, ModernEvidenceHeader,
  ModernPhaseId, ModernSavedTransitionPlan, ModernSupersessionRecord, NativeLocalCompletionPayload } from '../src/domain/governance/activation/modern-record-contracts.js';
import type { CurrentActivationIdentity } from '../src/domain/governance/policy/identity.js';
import { currentActivationRecordValidators } from '../src/domain/governance/activation/record-validation.js';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
describe('current/released contracts stay separate from modern source allocation', () => {
  it('preserves released graph bytes while limiting the reviewed current successor to runner-ready', () => {
    const bytes = readFileSync('assets/governance/single-maintainer-gitflow/activation-v3-graph.json');
    expect(hash(bytes)).toBe('2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703');
    const released = historicalV3PhaseGraph();
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(released);
    expect(canonicalPhaseGraphHash).toBe('f8122e15e69b9e7425096ea7d8e8624d2b4c3041074e534ce582486331deadba');
    expect(canonicalPhaseGraphJson).not.toBe(bytes.toString('utf8'));
    const releasedRunner = released.phases.find((phase) => phase.id === 'runner-ready')!;
    const currentRunner = canonicalPhaseGraph.phases.find((phase) => phase.id === 'runner-ready')!;
    expect(currentRunner).toMatchObject({
      allowedMutations: {
        local: ['write-evidence', 'write-activation-state'],
        remote: ['azure-network-provision', 'azure-read', 'github-read', 'github-write']
      },
      evidence: {
        schema: 'runner-ready.v1',
        required: true,
        liveReadbackProviders: ['azure', 'github']
      }
    });
    expect({
      ...canonicalPhaseGraph,
      phases: canonicalPhaseGraph.phases.map((phase) =>
        phase.id === 'runner-ready' ? releasedRunner : phase)
    }).toEqual(released);
    for (const { label: _label, ...behavior } of canonicalPhaseGraph.phases) {
      expect(canonicalPhaseContractDigests[behavior.id]).toBe(canonicalSha256(behavior));
    }
  });

  it('does not rewrite the released identity, advance schema versions, widen legacy selectors or change policy6', () => {
    expect(identities.createActivationIdentity(canonicalPhaseGraphHash))
      .not.toEqual(identities.releasedV3ActivationIdentity);
    expect(identities.releasedV3ActivationIdentity.phaseGraphHash)
      .toBe('2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703');
    expect(identities.liftoffActivationPackageVersion).toBe('0.12.0');
    expect(identities.liftoffManifestArtifactVersion).toBe(7);
    expect(identities.activationContractVersion).toBe(3);
    expect(identities.phaseGraphSchemaVersion).toBe(2);
    expect(identities.historicalActivationIdentities).toHaveLength(2);
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe('0.12.3');
    expect(hash(readFileSync('assets/governance/single-maintainer-gitflow/policy.md')))
      .toBe('9444e7339ea7747e49b8c11bada6ebc2f52e3e53cee7e1e8fd593353ce1ab149');
    const modern = identities.modernActivationSourceContracts()[0].identity;
    expect(identities.isHistoricalActivationIdentity(modern)).toBe(false);
    expect(identities.isReleasedV3ActivationIdentity(modern)).toBe(false);
    expect(() => currentActivationRecordValidators().validateActivationIdentity(modern)).toThrow();
    expectTypeOf<ReturnType<ReturnType<typeof currentActivationRecordValidators>['validateActivationIdentity']>>()
      .toEqualTypeOf<CurrentActivationIdentity>();
  });

  it('allocates real new record shapes without claiming their C2 runtime readers exist', () => {
    expectTypeOf<ModernActivationState['schemaVersion']>().toEqualTypeOf<4>();
    expectTypeOf<ModernEvidenceHeader['schemaVersion']>().toEqualTypeOf<4>();
    expectTypeOf<ModernApprovalEnvelope['schemaVersion']>().toEqualTypeOf<4>();
    expectTypeOf<ModernSavedTransitionPlan['schemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<ModernCredentialPolicy['schemaVersion']>().toEqualTypeOf<2>();
    expectTypeOf<ModernSupersessionRecord['schemaVersion']>().toEqualTypeOf<2>();
    expectTypeOf<'seed-archived'>().not.toExtend<ModernPhaseId>();
    expectTypeOf<'local-complete'>().toExtend<ModernPhaseId>();
    expectTypeOf<NativeLocalCompletionPayload['frameworkValidation']>().toEqualTypeOf<'not-required'>();
    expectTypeOf<NativeLocalCompletionPayload['frameworkFinalization']>().toEqualTypeOf<'not-required'>();
    const sources = identities.modernActivationSourceContracts();
    expect(sources.every(source => !Object.hasOwn(source.identity, 'pluginResolutionDigest') &&
      !Object.hasOwn(source.identity, 'activeLayoutDigest') && !Object.hasOwn(source.identity, 'sourceSelectionDigest'))).toBe(true);
  });
});

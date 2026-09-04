import type { ActivationIdentity, PhaseId, PhaseState } from './types.js';

function compileTimeTypeContract(): void {
  function acceptIdentity(_identity: ActivationIdentity): void {}

  // @ts-expect-error phase identifiers are closed over the canonical graph.
  const badPhaseId: PhaseId = 'remote-ready-before-import';
  // @ts-expect-error phase states are closed over activation-state schema v1.
  const badPhaseState: PhaseState = 'done';
  acceptIdentity({
    liftoffVersion: '0.10.0',
    manifestArtifactVersion: 7,
    policyVersion: '6',
    activationContractVersion: 1,
    phaseGraphSchemaVersion: 1,
    phaseGraphHash: '0000000000000000000000000000000000000000000000000000000000000000',
    activationStateSchemaVersion: 1,
    evidenceHeaderSchemaVersion: 1,
    approvalEnvelopeSchemaVersion: 1,
    supersessionSchemaVersion: 1,
    credentialPolicySchemaVersion: 1,
    // @ts-expect-error activation identity does not carry a setup-skill version.
    setupSkillVersion: '1'
  });
  void badPhaseId;
  void badPhaseState;
}

void compileTimeTypeContract;

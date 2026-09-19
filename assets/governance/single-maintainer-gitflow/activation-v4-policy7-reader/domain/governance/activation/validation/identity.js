import { activationCompatibility, currentActivationIdentity } from '../graph.js';
import { activationContractVersion, activationStateSchemaVersion, approvalEnvelopeSchemaVersion, credentialPolicySchemaVersion, evidenceHeaderSchemaVersion, governanceActivationPolicyVersion, liftoffActivationPackageVersion, liftoffManifestArtifactVersion, phaseGraphSchemaVersion, resolveActivationCompatibility, supersessionSchemaVersion, isHistoricalActivationIdentity,                                                                 } from '../../policy/identity.js';
                                                      
                                                                     
import { hex64Pattern, exact, stringField, requireVersion } from './common.js';

export function validateActivationIdentityShape(value         , path        )                     {
  const identity = exact(value, [
    'liftoffVersion',
    'manifestArtifactVersion',
    'policyVersion',
    'activationContractVersion',
    'phaseGraphSchemaVersion',
    'phaseGraphHash',
    'activationStateSchemaVersion',
    'evidenceHeaderSchemaVersion',
    'approvalEnvelopeSchemaVersion',
    'supersessionSchemaVersion',
    'credentialPolicySchemaVersion'
  ], path);
  requireVersion(identity.liftoffVersion, liftoffActivationPackageVersion, `${path}.liftoffVersion`);
  requireVersion(identity.manifestArtifactVersion, liftoffManifestArtifactVersion, `${path}.manifestArtifactVersion`);
  requireVersion(identity.policyVersion, governanceActivationPolicyVersion, `${path}.policyVersion`);
  requireVersion(identity.activationContractVersion, activationContractVersion, `${path}.activationContractVersion`);
  requireVersion(identity.phaseGraphSchemaVersion, phaseGraphSchemaVersion, `${path}.phaseGraphSchemaVersion`);
  requireVersion(identity.activationStateSchemaVersion, activationStateSchemaVersion, `${path}.activationStateSchemaVersion`);
  requireVersion(identity.evidenceHeaderSchemaVersion, evidenceHeaderSchemaVersion, `${path}.evidenceHeaderSchemaVersion`);
  requireVersion(identity.approvalEnvelopeSchemaVersion, approvalEnvelopeSchemaVersion, `${path}.approvalEnvelopeSchemaVersion`);
  requireVersion(identity.supersessionSchemaVersion, supersessionSchemaVersion, `${path}.supersessionSchemaVersion`);
  requireVersion(identity.credentialPolicySchemaVersion, credentialPolicySchemaVersion, `${path}.credentialPolicySchemaVersion`);
  const phaseGraphHash = stringField(identity, 'phaseGraphHash', path);
  if (!hex64Pattern.test(phaseGraphHash)) {
    throw new Error(`${path}.phaseGraphHash must be a SHA-256 hex digest.`);
  }
  return {
    liftoffVersion: identity.liftoffVersion                                        ,
    manifestArtifactVersion: identity.manifestArtifactVersion                                                 ,
    policyVersion: identity.policyVersion                                       ,
    activationContractVersion: identity.activationContractVersion                                                   ,
    phaseGraphSchemaVersion: identity.phaseGraphSchemaVersion                                                 ,
    phaseGraphHash,
    activationStateSchemaVersion: identity.activationStateSchemaVersion                                                      ,
    evidenceHeaderSchemaVersion: identity.evidenceHeaderSchemaVersion                                                     ,
    approvalEnvelopeSchemaVersion: identity.approvalEnvelopeSchemaVersion                                                       ,
    supersessionSchemaVersion: identity.supersessionSchemaVersion                                                   ,
    credentialPolicySchemaVersion: identity.credentialPolicySchemaVersion                                                       
  };
}

export function validateActivationIdentity(value         )                            {
  if (isHistoricalActivationIdentity(value)) {
    const historical = resolveActivationCompatibility(value, activationCompatibility);
    if (!historical.compatible) throw new Error(historical.reason);
  }
  const typed = validateActivationIdentityShape(value, 'identity');
  const compatibility = resolveActivationCompatibility(typed, activationCompatibility);
  if (!compatibility.compatible) {
    throw new Error(compatibility.reason);
  }
  return typed                             ;
}

/** Manifest readability is not execution compatibility; historical vectors are never retagged. */

export function validateReadableActivationIdentity(value         )                             {
  if (isHistoricalActivationIdentity(value)) return { ...value };
  return validateActivationIdentity(value);
}

export function validateManifestActivationForExecution(manifest                                     )       {
  const governance = manifest.governance;
  if (governance.profile === 'none' || governance.profile === 'unspecified') return;
  if (governance.activationIdentity === undefined) {
    throw new Error(
      'This governance handoff has no recorded activation identity. It is readable for assessment and reviewed update, not current activation execution; review liftoff update --check without inventing or retagging identity.'
    );
  }
  const identity = validateActivationIdentity(governance.activationIdentity);
  if (governance.policyVersion !== identity.policyVersion) {
    throw new Error('Manifest governance policyVersion does not match its exact current activation identity.');
  }
}

export function validFixtureIdentity()                     {
  return currentActivationIdentity;
}

                                                                 

export const liftoffActivationPackageVersion = '0.12.0'         ;
export const liftoffManifestArtifactVersion = 7         ;
export const governanceActivationPolicyVersion = '6'         ;
export const activationContractVersion = 3         ;
export const phaseGraphSchemaVersion = 2         ;
export const activationStateSchemaVersion = 3         ;
export const evidenceHeaderSchemaVersion = 3         ;
export const approvalEnvelopeSchemaVersion = 3         ;
export const compatibilityMetadataSchemaVersion = 4         ;
export const supersessionSchemaVersion = 1         ;
export const credentialPolicySchemaVersion = 1         ;

export const knownActivationVersions = {
  liftoffVersion: [liftoffActivationPackageVersion],
  manifestArtifactVersion: [liftoffManifestArtifactVersion],
  policyVersion: ['5', governanceActivationPolicyVersion],
  activationContractVersion: [activationContractVersion],
  phaseGraphSchemaVersion: [phaseGraphSchemaVersion],
  activationStateSchemaVersion: [activationStateSchemaVersion],
  evidenceHeaderSchemaVersion: [evidenceHeaderSchemaVersion],
  approvalEnvelopeSchemaVersion: [approvalEnvelopeSchemaVersion],
  supersessionSchemaVersion: [supersessionSchemaVersion],
  credentialPolicySchemaVersion: [credentialPolicySchemaVersion]
}         ;

const tupleFields = [
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
]         ;

                                                                                 

                                                              
                                                         
                                                                 
                                                          
                                                              
                                                          
                                                                    
                                                                  
                                                                      
                                                              
                                                                      
  

export const historicalActivationIdentities = [{
  liftoffVersion: '0.10.0',
  manifestArtifactVersion: 7,
  policyVersion: '6',
  activationContractVersion: 1,
  phaseGraphSchemaVersion: 1,
  phaseGraphHash: 'b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7',
  activationStateSchemaVersion: 1,
  evidenceHeaderSchemaVersion: 1,
  approvalEnvelopeSchemaVersion: 1,
  supersessionSchemaVersion: 1,
  credentialPolicySchemaVersion: 1
}, {
  liftoffVersion: '0.11.0',
  manifestArtifactVersion: 7,
  policyVersion: '6',
  activationContractVersion: 2,
  phaseGraphSchemaVersion: 1,
  phaseGraphHash: 'ac160e3fc86f3e438141d985658e09f419508b3adbe176ddd13100d5dfdee47c',
  activationStateSchemaVersion: 2,
  evidenceHeaderSchemaVersion: 2,
  approvalEnvelopeSchemaVersion: 2,
  supersessionSchemaVersion: 1,
  credentialPolicySchemaVersion: 1
}]                                                 ;

export const historicalV1ActivationIdentity = historicalActivationIdentities[0];
export const historicalV2ActivationIdentity = historicalActivationIdentities[1];
                                                                                   
                                                                                   

                                                                                         
                                                                                                  

export function isHistoricalActivationIdentity(value         )                                        {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value                           ;
  return Object.keys(identity).length === tupleFields.length &&
    historicalActivationIdentities.some((historical) => tupleFields.every((field) =>
      Object.hasOwn(identity, field) && identity[field] === historical[field]));
}

export function isHistoricalV1ActivationIdentity(value         )                                          {
  return isHistoricalActivationIdentity(value) && value.activationContractVersion === 1;
}

export function isHistoricalV2ActivationIdentity(value         )                                          {
  return isHistoricalActivationIdentity(value) && value.activationContractVersion === 2;
}

export function createActivationIdentity(phaseGraphHash        )                            {
  return {
    liftoffVersion: liftoffActivationPackageVersion,
    manifestArtifactVersion: liftoffManifestArtifactVersion,
    policyVersion: governanceActivationPolicyVersion,
    activationContractVersion,
    phaseGraphSchemaVersion,
    phaseGraphHash,
    activationStateSchemaVersion,
    evidenceHeaderSchemaVersion,
    approvalEnvelopeSchemaVersion,
    supersessionSchemaVersion,
    credentialPolicySchemaVersion
  };
}

export function activationCompatibilityKey(identity                    )         {
  return tupleFields.map((field) => `${field}=${identity[field]}`).join('|');
}

export function buildActivationCompatibilityMap(
  identities                               
)                             {
  return new Map(identities.map((identity) => [activationCompatibilityKey(identity), identity]));
}

function knownVersion(field                                      , value                 )          {
  return (knownActivationVersions[field]                                ).includes(value);
}

                                           
                                                      
                                          

export function resolveActivationCompatibility(
  identity                    ,
  compatibility                            
)                                {
  if (isHistoricalActivationIdentity(identity)) {
    return { compatible: false, reason: `Historical activation v${identity.activationContractVersion} is diagnostic-only. Run liftoff update --check to inspect an explicitly supported history-preserving v3 successor; preserve original bytes without reset, retagging, or automatic conversion.` };
  }
  for (const field of Object.keys(knownActivationVersions)                                            ) {
    if (!knownVersion(field, identity[field])) {
      const supported = (knownActivationVersions[field]                                )
        .map((value) => JSON.stringify(value))
        .join(', ');
      return {
        compatible: false,
        reason:
          `Unsupported activation identity field ${field}: found ${JSON.stringify(identity[field])}; ` +
          `supported values are ${supported}. Minimum Liftoff ${liftoffActivationPackageVersion} is required; ` +
          'upgrade through the configured Liftoff package delivery workflow.'
      };
    }
  }
  const found = compatibility.get(activationCompatibilityKey(identity));
  if (!found) {
    const supportedTuples = [...compatibility.keys()].join('; ');
    const graphHashes = [...new Set([...compatibility.values()].map((entry) => entry.phaseGraphHash))].join(', ');
    return {
      compatible: false,
      reason:
        `Activation identity tuple is not present in the explicit compatibility map: found ${activationCompatibilityKey(identity)}; ` +
        `supported tuples are ${supportedTuples}; recognized graph hashes are ${graphHashes}. ` +
        `Minimum Liftoff ${liftoffActivationPackageVersion} is required; upgrade/remediate with ` +
        'the configured Liftoff package delivery workflow.'
    };
  }
  return { compatible: true, identity: found };
}

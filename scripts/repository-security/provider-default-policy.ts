import { readFileSync } from 'node:fs';
import { canonicalDigest } from './admission.ts';
import { assertIssuedCheckovObservation } from './checkov.ts';
import { record, SecurityEvidenceError } from './evidence.ts';
import { qualifyGeneratedRegistryRole } from './generated-role-policy.ts';

export const providerDefaultControls = [
  {
    rule: 'CKV_AZURE_44', resource: 'azurerm_storage_account.main', attribute: 'min_tls_version', value: 'TLS1_2',
    schemaBlob: 'd276a04b64c3888a716c97317034ec43ca67a562', schemaLines: [306, 313],
    createLines: [1243, 1243], updateLines: [1608, 1610], constantsBlob: 'a87d6b1430526934e15a75ef75eb9b96547f3ba1'
  },
  {
    rule: 'CKV_AZURE_148', resource: 'azurerm_redis_cache.main', attribute: 'minimum_tls_version', value: '1.2',
    schemaBlob: 'dea2ea01bc7e36f4194613c7b8dbf038ae885006', schemaLines: [108, 115],
    createLines: [474, 474], updateLines: [579, 588], constantsBlob: 'a0d1416f52202c74fc228f87617303413d7999bc'
  },
  {
    rule: 'CKV_AZURE_190', resource: 'azurerm_storage_account.main', attribute: 'allow_nested_items_to_be_public', value: false,
    schemaBlob: 'd276a04b64c3888a716c97317034ec43ca67a562', schemaLines: [329, 333],
    createLines: [1233, 1233], updateLines: [1543, 1545], constantsBlob: null
  },
  {
    rule: 'CKV_AZURE_205', resource: 'azurerm_servicebus_namespace.main', attribute: 'minimum_tls_version', value: '1.2',
    schemaBlob: 'a3c1b6b05df9023909143210fe998e7eee248e24', schemaLines: [147, 154],
    createLines: [322, 325], updateLines: [423, 425], constantsBlob: 'a2af4619cfc49fd93ae1083f5754e0de6bee9164'
  }
] as const;
for (const control of providerDefaultControls) {
  Object.freeze(control.schemaLines);
  Object.freeze(control.createLines);
  Object.freeze(control.updateLines);
  Object.freeze(control);
}
Object.freeze(providerDefaultControls);

const provider = Object.freeze({
  source: 'hashicorp/azurerm', version: '5.3.0', repository: 'hashicorp/terraform-provider-azurerm',
  commit: '9215c429172fbccf3c7c6197a246d23f7c3287af', sdkVersion: '2.40.1',
  sdkCommit: 'e6c7dc42a51abcaf5b709a98720ba13ba0082021', sdkResourceDataBlob: 'f2089e0277267672932c7b096a680d76497ce115'
} as const);

function fail(): never { throw new SecurityEvidenceError('provider-default-policy-registration'); }
const decisionDigest = (() => {
  let value: unknown;
  try {
    const bytes = readFileSync(new URL('../../security/provider-default-control-decision.json', import.meta.url));
    if (bytes.length > 16_384) fail();
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch { return fail(); }
  const decision = record(value, [
    'schemaVersion', 'recordedOn', 'decision', 'coordinatorSession', 'scope', 'provider', 'controls',
    'independentNativeBindingRequired', 'nativeFailuresPreserved', 'vulnerabilityException',
    'deployedStateQualified', 'strongerContractsMayBeDowngraded', 'adoptedPolicyAuthority'
  ], 'provider-default-policy-registration');
  if (decision.schemaVersion !== 1 || decision.recordedOn !== '2026-09-21' ||
      decision.decision !== 'coordinator-approved-exact-provider-default-control-equivalence' ||
      decision.coordinatorSession !== 'f1debac3-fd7e-44a5-a4f8-078a5cbf2a3a' ||
      decision.scope !== 'independently-issued-exact-generated-baseline-observations-only' ||
      canonicalDigest(decision.provider) !== canonicalDigest(provider) ||
      canonicalDigest(decision.controls) !== canonicalDigest(providerDefaultControls) ||
      decision.independentNativeBindingRequired !== true || decision.nativeFailuresPreserved !== true ||
      decision.vulnerabilityException !== false || decision.deployedStateQualified !== false ||
      decision.strongerContractsMayBeDowngraded !== false || decision.adoptedPolicyAuthority !== false) fail();
  return canonicalDigest(decision);
})();

export function qualifyProviderDefaultControls(value: unknown) {
  assertIssuedCheckovObservation(value);
  const registration = qualifyGeneratedRegistryRole(value);
  return {
    kind: 'exact-provider-default-control-equivalence-preview',
    decisionDigest,
    controls: providerDefaultControls.flatMap((control, index) => {
      const indexes = value.generatedProviderDefaultResultIndexes[index];
      if (!registration.qualified || value.generatedProviderDefaultFacts[index] !== true || indexes?.length !== 1) return [];
      const resultIndex = indexes[0]!, result = value.results[resultIndex];
      if (result?.rule !== control.rule || result.status !== 'failed') return [];
      return [{
        ...control, resultIndex, nativeStatus: 'failed' as const,
        classification: 'satisfied-by-pinned-provider-default' as const,
        owner: 'voyager163', caseId: registration.caseId, environment: registration.environment,
        scopeDigest: registration.scopeDigest, provider, decisionDigest,
        rationale: `The exact omitted ${control.attribute} uses the verified pinned schema default and request serialization; this source-control equivalence is not a native pass or deployed-state proof.`
      }];
    }),
    nativeFailuresUnchanged: true, strongerContractsMayBeDowngraded: false,
    vulnerabilityException: false, deployedStateQualified: false,
    adoptedPolicyAuthority: false, admissionQualified: false, publicationQualified: false
  };
}

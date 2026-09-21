import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalDigest } from './admission.ts';
import { digest, SecurityEvidenceError } from './evidence.ts';
import { assertIssuedCheckovObservation, verifiedCheckovScope, type CheckovInputScope } from './checkov.ts';
import { generatedSecurityCases } from './inventory.ts';
import { verifiedGeneratedImageHealth } from './trivy.ts';
import { requireGeneratedArtifactBaseline } from './generated-artifact-binding.ts';

function fail(): never { throw new SecurityEvidenceError('generated-role-policy-registration'); }
const decision = (() => {
  try {
    const source = readFileSync(new URL('../../security/generated-role-diagnostic-decision.json', import.meta.url), 'utf8');
    if (Buffer.byteLength(source) > 32_768) fail();
    return JSON.parse(source);
  } catch { return fail(); }
})();
const environments = ['dev', 'staging', 'prod'];
if (decision.schemaVersion !== 1 || decision.provider?.version !== '5.3.0' ||
    decision.provider?.commit !== '9215c429172fbccf3c7c6197a246d23f7c3287af' ||
    decision.provider?.resourceBlob !== 'a1fb10a8913ab0a443294bd528da26775c29e089' ||
    decision.provider?.sdkCommit !== 'e6c7dc42a51abcaf5b709a98720ba13ba0082021' ||
    decision.provider?.sdkVersion !== '2.40.1' ||
    decision.provider?.sdkResourceDataBlob !== 'f2089e0277267672932c7b096a680d76497ce115' ||
    decision.provider?.publicNetworkDefault !== true || decision.provider?.anonymousPullDefault !== false ||
    decision.provider?.legacyNotaryPropertiesPresent !== false ||
    decision.strongerHaContractsMayBeDowngraded !== false || decision.nativeFailuresPreserved !== true ||
    decision.featuresClaimedPresent !== false || decision.separateHealthEvidenceRequired !== true ||
    !decision.baselineScopes || typeof decision.baselineScopes !== 'object' ||
    Object.keys(decision.baselineScopes).sort().join() !== generatedSecurityCases.map(entry => entry.id).sort().join()) fail();
const registrations = Object.entries(decision.baselineScopes).flatMap(([caseId, values]) => {
  if (!Array.isArray(values) || values.length !== 3) return fail();
  return values.map((value, index) => ({ caseId, environment: environments[index]!, scopeDigest: digest(value) }));
});
if (new Set(registrations.map(item => item.scopeDigest)).size !== registrations.length) fail();
if (decision.optionalCapabilities?.ownerDecision !== 'Approve bounded diagnostics; keep security and exposure checks strict.' ||
    decision.optionalCapabilities?.independentNativeResourceBindingRequired !== true ||
    decision.optionalCapabilities?.strongerExistingRequirementsMayBeDowngraded !== false ||
    decision.optionalCapabilities?.nativeFailuresRemainVisible !== true ||
    JSON.stringify(decision.optionalCapabilities?.availabilityRules) !==
      JSON.stringify(['CKV_AZURE_136', 'CKV_AZURE_230', 'CKV_AZURE_206', 'CKV_AZURE_212', 'CKV_AZURE_225'])) fail();

export function generatedRoleScopeDigest(scope: CheckovInputScope) {
  const sha = (content: string) => createHash('sha256').update(content).digest('hex');
  const files = scope.files.map(item => ({ pathParts: item.pathParts, digest: sha(item.content) }))
    .sort((a, b) => a.pathParts.join('/').localeCompare(b.pathParts.join('/'), 'en'));
  const variables = (scope.terraformContext?.variableFiles ?? []).map(item => ({ pathParts: item.pathParts, digest: sha(item.content) }))
    .sort((a, b) => a.pathParts.join('/').localeCompare(b.pathParts.join('/'), 'en'));
  return canonicalDigest({ files, variables });
}

export function qualifyGeneratedRegistryRole(value: unknown) {
  assertIssuedCheckovObservation(value);
  const scope = verifiedCheckovScope(value), scopeDigest = generatedRoleScopeDigest(scope);
  const registration = registrations.find(item => item.scopeDigest === scopeDigest);
  if (!registration) return {
    qualified: false as const, reason: 'not-exact-approved-generated-baseline', scopeDigest
  };
  if (scope.terraformContext?.rootDirectory.at(-1) !== registration.environment ||
      value.generatedRoleFacts.length !== 12 || !value.generatedRoleFacts.every(Boolean) ||
      value.generatedRegistryResultIndexes.length === 0) return {
    qualified: false as const, reason: 'native-provider-auth-or-role-binding-unqualified', scopeDigest
  };
  return {
    qualified: true as const, ...registration,
    provider: 'hashicorp/azurerm@5.3.0',
    providerSchemaCommit: decision.provider.commit as string,
    providerSchemaBlob: decision.provider.resourceBlob as string,
    providerSdkCommit: decision.provider.sdkCommit as string,
    strongerAcrHaContractPresent: false, nativeFailuresPreserved: true,
    healthQualified: false, productionFactsAsserted: false
  };
}

export const generatedRegistryDiagnostics = Object.freeze({
  CKV_AZURE_139: 'The independently qualified baseline registry is authenticated-public under the exact provider defaults and managed-identity AcrPull/pull bindings; this is a network-hardening diagnostic, not anonymous access.',
  CKV_AZURE_163: 'The native rule tests Standard/Premium SKU, not actual image scanning. The qualified generated baseline uses Basic; actual image vulnerability assessment remains mandatory.',
  CKV_AZURE_164: 'The pinned provider 5.3.0 registry schema does not expose the legacy Notary trust-policy properties checked by this rule. This is a schema compatibility diagnostic, not a signing or provenance claim.',
  CKV_AZURE_165: 'The exact qualified Basic baseline has no stronger ACR geo-replication contract. This availability diagnostic is not production HA or Storage ZRS qualification.',
  CKV_AZURE_233: 'The exact qualified Basic baseline has no stronger ACR zone-topology contract. This availability diagnostic does not change any other resource redundancy requirement.',
  CKV_AZURE_237: 'Dedicated data endpoints are not enabled in the qualified Basic baseline. The optional feature gap remains visible; no network topology is changed or claimed.',
  CKV_AZURE_166: 'Quarantine is not enabled in the qualified Basic baseline. The optional feature gap remains visible; no quarantine or verify workflow is claimed.',
  CKV_AZURE_167: 'Untagged-manifest retention is not enabled in the qualified Basic baseline. The optional feature gap remains visible; no data-retention or image-revision policy is substituted.'
});

const optionalRoles = [
  { role: 0, rule: 'CKV_AZURE_136', rationale: 'The exact B_Standard_B1ms PostgreSQL baseline has no stronger geo-backup or HA contract. The native geo-backup failure remains an availability diagnostic, not backup or recovery proof.' },
  { role: 1, rule: 'CKV_AZURE_230', rationale: 'The exact Basic/C Redis baseline has no stronger replication contract. The absent Standard/Premium replication feature remains visible; authentication, TLS and exposure are not waived.' },
  { role: 2, rule: 'CKV_AZURE_206', rationale: 'The exact Standard/LRS Storage baseline has no stronger replication contract. Native GRS-family requirements remain an availability diagnostic; LRS is neither ZRS nor GRS and no ACR approval is inherited.' },
  { role: 3, rule: 'CKV_AZURE_212', rationale: 'The exact Linux/Y1 worker plan and function binding have no existing multi-instance requirement. The native worker-count failure remains visible; runtime security and readiness are separate.' },
  { role: 3, rule: 'CKV_AZURE_225', rationale: 'The exact Linux/Y1 worker plan and function binding have no existing zone-balancing requirement. No zones or production availability capability is claimed.' }
] as const;

export function generatedOptionalDiagnostic(value: unknown, resultIndex: number) {
  assertIssuedCheckovObservation(value);
  const registration = qualifyGeneratedRegistryRole(value);
  if (!registration.qualified) return undefined;
  const result = value.results[resultIndex];
  if (!result || result.status !== 'failed') return undefined;
  const match = optionalRoles.find(item => item.rule === result.rule);
  if (!match || value.generatedOptionalRoleFacts[match.role] !== true ||
      !value.generatedOptionalRoleResultIndexes[match.role]?.includes(resultIndex)) return undefined;
  return match.rationale;
}

export function qualifyGeneratedDockerHealthDiagnostic(
  observation: unknown, health: unknown, expected: { caseId: string; artifactInventoryDigest: string }, now = new Date()
) {
  assertIssuedCheckovObservation(observation);
  const scope = verifiedCheckovScope(observation), proof = verifiedGeneratedImageHealth(health);
  requireGeneratedArtifactBaseline(expected.caseId, expected.artifactInventoryDigest);
  const parts = proof.target === 'frontend' ? ['frontend', 'Dockerfile'] : ['Dockerfile'];
  if (!generatedSecurityCases.some(entry => entry.id === expected.caseId) ||
      proof.generatedCase !== expected.caseId || proof.artifactInventoryDigest !== digest(expected.artifactInventoryDigest) ||
      scope.framework !== 'dockerfile' || scope.files.length !== 1 ||
      scope.files[0]!.pathParts.join('/') !== parts.join('/') ||
      `sha256:${createHash('sha256').update(scope.files[0]!.content).digest('hex')}` !== proof.dockerfileDigest ||
      !Number.isFinite(now.getTime()) || Date.parse(proof.completedAt) > now.getTime() ||
      now.getTime() - Date.parse(proof.completedAt) > 86_400_000) {
    throw new SecurityEvidenceError('generated-health-subject-or-freshness-mismatch');
  }
  const expectedChecks = proof.target === 'frontend'
    ? ['frontend-index', 'local-frontend-module'] : ['health-ok', 'ready-ready', 'openapi-v3'];
  if (JSON.stringify(proof.checks) !== JSON.stringify(expectedChecks) ||
      proof.externalServicesQualified || proof.orchestratorProbesClaimed) throw new SecurityEvidenceError('generated-health-contract');
  return {
    kind: 'native-generated-health-diagnostic', generatedCase: proof.generatedCase, target: proof.target,
    inputDigest: expected.artifactInventoryDigest, dockerfileDigest: proof.dockerfileDigest,
    imageDigest: proof.imageDigest, healthEvidenceDigest: canonicalDigest(proof),
    diagnostics: observation.results.flatMap((result, index) =>
      result.rule === 'CKV_DOCKER_2' && result.status === 'failed' ? [{
        resultIndex: index, rule: result.rule, nativeStatus: 'failed', classification: 'tracked-runtime-diagnostic',
        owner: 'voyager163',
        rationale: 'Exact generated inputs and built image independently passed their required local health/readiness or frontend contract; no Dockerfile instruction or orchestrator probe is invented.'
      }] : []),
    nativeFailuresUnchanged: true, externalServicesQualified: false,
    orchestratorProbesClaimed: false, publicationQualified: false
  };
}

import { assertIssuedCheckovObservation, verifiedCheckovScope } from './checkov.ts';
import { SecurityEvidenceError } from './evidence.ts';
import { createHash } from 'node:crypto';
import { generatedOptionalDiagnostic, generatedRegistryDiagnostics, qualifyGeneratedRegistryRole } from './generated-role-policy.ts';
import { qualifyProviderDefaultControls } from './provider-default-policy.ts';

export const telemetryFeatureDiagnosticScope = Object.freeze({
  path: 'infrastructure/opentofu/telemetry/container-app.tf',
  sha256: '2619aca90ece080565e28ab146498ca60cbe62b75813092a78e30f9c8b80fc86',
  rationales: Object.freeze({
    CKV_AZURE_163: 'This native rule checks Standard/Premium SKU only, not actual vulnerability scanning. The exact approved telemetry registry is Basic; independent image vulnerability assessment remains mandatory.',
    CKV_AZURE_237: 'Dedicated data endpoints are not configured for the exact authenticated-public Basic telemetry role. This is a visible network-feature gap, not anonymous access or proof of a private endpoint.',
    CKV_AZURE_164: 'Legacy Notary content trust is not configured for the exact Basic telemetry role. Digest pinning is not signing; neither signing nor trusted-image enforcement is claimed.',
    CKV_AZURE_166: 'Registry quarantine is not configured for the exact Basic telemetry role. No quarantine, scan-and-verify workflow or equivalent capability is claimed.',
    CKV_AZURE_167: 'Untagged-manifest retention is not configured for the exact Basic telemetry role. Retained source revisions and telemetry-data retention do not establish this feature.'
  })
});

/**
 * Preview only. The original native failures remain intact; these diagnostics
 * cannot stand in for adopted policy, security admission or release evidence.
 */
export function previewCheckovRoleDiagnostics(inputs: readonly unknown[]) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 256) throw new SecurityEvidenceError('checkov-role-observation-set');
  const observations = inputs.map(value => { assertIssuedCheckovObservation(value); return value; });
  const scopes = observations.map(verifiedCheckovScope);
  const telemetry = observations.flatMap((report, index) =>
    scopes[index]!.framework === 'terraform' && scopes[index]!.files.some(file =>
      file.pathParts.join('/') === 'infrastructure/opentofu/telemetry/container-app.tf') ? [{ report, index }] : []);
  if (telemetry.length > 1) throw new SecurityEvidenceError('checkov-role-ambiguous-source');
  const source = telemetry[0];
  const authenticatedBasicRegistry = source?.report.roleFacts.slice(0, 11).every(Boolean) === true;
  const tcpProbes = authenticatedBasicRegistry && source!.report.roleFacts.slice(11).every(Boolean);
  // The approved omission/default facts belong to these exact source bytes.
  // Changed feature bindings require requalification, not a rule-ID exemption.
  const featureInput = source && scopes[source.index]!.files.find(file => file.pathParts.join('/') === telemetryFeatureDiagnosticScope.path);
  const approvedFeatureFacts = authenticatedBasicRegistry && featureInput !== undefined &&
    createHash('sha256').update(featureInput.content).digest('hex') === telemetryFeatureDiagnosticScope.sha256;
  const diagnostics: {
    reportIndex: number; resultIndex: number; rule: string; nativeStatus: 'failed';
    classification: 'tracked-design-diagnostic'; owner: 'voyager163'; rationale: string;
    evidenceReportIndex: number;
  }[] = [];
  const generatedRoleQualifications = observations.flatMap((report, reportIndex) =>
    scopes[reportIndex]!.terraformContext?.rootDirectory.slice(0, 4).join('/') === 'infrastructure/opentofu/azure/environments'
      ? [{ reportIndex, ...qualifyGeneratedRegistryRole(report) }] : []);
  observations.forEach((report, reportIndex) => {
    report.results.forEach((result, resultIndex) => {
      if (result.status !== 'failed') return;
      let rationale: string | undefined;
      let evidenceReportIndex = source?.index;
      if (source?.index === reportIndex && authenticatedBasicRegistry &&
          report.telemetryRegistryResultIndexes.includes(resultIndex)) {
        if (result.rule === 'CKV_AZURE_165' || result.rule === 'CKV_AZURE_233') {
          rationale = 'The exact authenticated telemetry ACR has the approved Basic/cost-bounded role; this change adds no geo-replication or zone-topology requirement.';
        } else if (result.rule === 'CKV_AZURE_139') {
          rationale = 'The exact telemetry ACR is authenticated-public, with admin and anonymous access disabled and matching managed-identity AcrPull/image-pull relationships; this is not anonymous access or public telemetry ingress.';
        } else if (approvedFeatureFacts) {
          rationale = Object.entries(telemetryFeatureDiagnosticScope.rationales).find(([rule]) => rule === result.rule)?.[1];
        }
      }
      if (result.rule === 'CKV_DOCKER_2' && tcpProbes && scopes[reportIndex]!.framework === 'dockerfile' &&
          scopes[reportIndex]!.files[result.fileIndex]?.pathParts.join('/') === 'services/telemetry-ingest/Dockerfile') {
        rationale = 'The deployed-source telemetry role declares matching TCP startup/readiness/liveness probes; the missing Dockerfile instruction remains visible and no HTTP health route is invented.';
      }
      const generated = generatedRoleQualifications.find(item => item.reportIndex === reportIndex && item.qualified);
      if (generated && report.generatedRegistryResultIndexes.includes(resultIndex)) {
        const registered = Object.entries(generatedRegistryDiagnostics).find(([rule]) => rule === result.rule);
        if (registered) { rationale = registered[1]; evidenceReportIndex = reportIndex; }
      }
      if (generated && !rationale) {
        rationale = generatedOptionalDiagnostic(report, resultIndex);
        if (rationale) evidenceReportIndex = reportIndex;
      }
      if (rationale && evidenceReportIndex !== undefined) diagnostics.push({
        reportIndex, resultIndex, rule: result.rule, nativeStatus: 'failed',
        classification: 'tracked-design-diagnostic', owner: 'voyager163', rationale, evidenceReportIndex
      });
    });
  });
  return {
    kind: 'role-bound-checkov-classification-preview', diagnostics,
    controlEquivalences: observations.flatMap((report, reportIndex) =>
      qualifyProviderDefaultControls(report).controls.map(control => ({ ...control, reportIndex }))),
    nativeFailuresUnchanged: true, unknownRolesRemainUnqualified: true,
    generatedRoleQualifications,
    generatedAvailabilityRoleQualified: generatedRoleQualifications.length > 0 && generatedRoleQualifications.every(item => item.qualified),
    generatedHealthRoleQualified: false, adoptedPolicyAuthority: false,
    admissionQualified: false, publicationQualified: false
  };
}

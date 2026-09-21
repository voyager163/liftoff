import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArtifacts } from '../src/templates.js';
import { buildProjectPlan } from '../src/planner.js';
import { generatedSecurityCases } from '../scripts/repository-security/inventory.ts';
import { composeImageInventory, generatedCheckovPlan } from '../scripts/repository-security/checkov-driver.ts';
import { assessCheckovScope } from '../scripts/repository-security/checkov.ts';
import { generatedRoleScopeDigest, qualifyGeneratedRegistryRole } from '../scripts/repository-security/generated-role-policy.ts';
import { previewCheckovRoleDiagnostics } from '../scripts/repository-security/checkov-role-policy.ts';
import { requireGeneratedArtifactBaseline, verifyGeneratedArtifactBinding } from '../scripts/repository-security/generated-artifact-binding.ts';
import { createHash } from 'node:crypto';
import { canonicalDigest } from '../scripts/repository-security/admission.ts';

const baseline = JSON.parse(await readFile(path.join(process.cwd(), 'assets', 'supported-stack.json'), 'utf8'));
const decision = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'generated-role-diagnostic-decision.json'), 'utf8'));
const images = composeImageInventory(baseline);
function scopes(caseId: string) {
  const entry = generatedSecurityCases.find(item => item.id === caseId)!;
  return generatedCheckovPlan(caseId,
    buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true })), images)
    .cases.filter(item => item.scope.framework === 'terraform');
}

describe('independently registered generated baseline role scope', () => {
  it('binds health labels to complete independently registered generated artifacts and actual file digests', async () => {
    const entry = generatedSecurityCases.find(item => item.id === 'standard-node')!;
    const files = buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true })).map(item => ({
      logicalName: item.logicalName, pathParts: item.pathParts,
      digest: `sha256:${createHash('sha256').update(item.content).digest('hex')}`
    }));
    const artifactInventoryDigest = canonicalDigest(files), context = path.resolve('nonexecuted-private-context');
    const binding = { caseId: entry.id, target: 'backend' as const, artifactInventoryDigest, files };
    const resolve = async (filename: string) => files.find(item => path.join(context, ...item.pathParts) === filename)!.digest;
    expect(() => requireGeneratedArtifactBaseline(entry.id, artifactInventoryDigest)).not.toThrow();
    await expect(verifyGeneratedArtifactBinding(binding, context, resolve)).resolves.toBeUndefined();
    expect(() => requireGeneratedArtifactBaseline('genai-rag', artifactInventoryDigest)).toThrow('baseline-mismatch');
    await expect(verifyGeneratedArtifactBinding({ ...binding, files: files.slice(1) }, context, resolve)).rejects.toThrow('inventory-mismatch');
    await expect(verifyGeneratedArtifactBinding(binding, context, async () => `sha256:${'0'.repeat(64)}`))
      .rejects.toThrow('content-mismatch');
  });
  it('matches all thirteen real generator cases and three environments without trusting a candidate role label', () => {
    for (const entry of generatedSecurityCases) {
      expect(scopes(entry.id).map(item => generatedRoleScopeDigest(item.scope))).toEqual(decision.baselineScopes[entry.id]);
    }
    expect(Object.values(decision.baselineScopes).flat()).toHaveLength(39);
    expect(new Set(Object.values(decision.baselineScopes).flat()).size).toBe(39);
    expect(decision).toMatchObject({
      ownerDecision: 'Approve only for independently qualified generated baseline roles',
      nativeRoleEvidenceRequired: true, separateHealthEvidenceRequired: true,
      nativeFailuresPreserved: true, strongerHaContractsMayBeDowngraded: false, signingOrProvenanceClaim: false
    });
  });
  it('refuses synthetic/serialized approval and changes scope identity for any altered binding input', () => {
    expect(() => qualifyGeneratedRegistryRole({ role: 'generated', approved: true, generatedRoleFacts: Array(12).fill(true) })).toThrow();
    const original = scopes('standard-node')[0]!.scope, changed = structuredClone(original);
    changed.files[0]!.content += '\n# Not the reviewed baseline.\n';
    expect(generatedRoleScopeDigest(changed)).not.toBe(generatedRoleScopeDigest(original));
    changed.files = original.files;
    changed.terraformContext!.variableFiles[0]!.content += '\n# Changed binding.\n';
    expect(generatedRoleScopeDigest(changed)).not.toBe(generatedRoleScopeDigest(original));
  });
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_GENERATED_ROLES === '1')(
  'qualifies native generated provider/auth/identity facts independently and rejects changed facts',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external parent required.');
    const selected = scopes('standard-node')[0]!.scope;
    const original = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', selected, parent);
    expect(original.generatedRoleFacts).toEqual(Array(12).fill(true));
    expect(qualifyGeneratedRegistryRole(original)).toMatchObject({
      qualified: true, caseId: 'standard-node', environment: 'dev',
      provider: 'hashicorp/azurerm@5.3.0', healthQualified: false, productionFactsAsserted: false
    });
    const preview = previewCheckovRoleDiagnostics([original]);
    expect(preview.diagnostics.map(item => item.rule).sort()).toEqual([
      ...decision.registryRules, 'CKV_AZURE_136', 'CKV_AZURE_230', 'CKV_AZURE_206'
    ].sort());
    expect(original.generatedOptionalRoleFacts).toEqual([true, true, true, false]);
    expect(preview.generatedHealthRoleQualified).toBe(false);
    for (const item of preview.diagnostics) expect(original.results[item.resultIndex]!.status).toBe('failed');
    expect(() => qualifyGeneratedRegistryRole(structuredClone(original))).toThrow();
    for (const [before, after] of [
      ['admin_enabled       = false', 'admin_enabled       = true'],
      ['sku                 = "Basic"', 'sku                 = "Premium"'],
      ['role_definition_name = "AcrPull"', 'role_definition_name = "Owner"'],
      ['account_replication_type = "LRS"', 'account_replication_type = "ZRS"']
    ]) {
      const changed = structuredClone(selected);
      const main = changed.files.find(item => item.pathParts.join('/') === 'infrastructure/opentofu/azure/modules/application/main.tf')!;
      expect(main.content).toContain(before);
      main.content = main.content.replace(before!, after!);
      const report = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', changed, parent);
      expect(qualifyGeneratedRegistryRole(report).qualified).toBe(false);
      expect(previewCheckovRoleDiagnostics([report]).diagnostics).toEqual([]);
    }
    const provider = structuredClone(selected);
    const versions = provider.files.find(item => item.pathParts.at(-1) === 'versions.tf')!;
    expect(versions.content).toContain('"5.3.0"');
    versions.content = versions.content.replace('"5.3.0"', '"5.2.0"');
    const changed = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', provider, parent);
    expect(changed.generatedRoleFacts[0]).toBe(false);
    expect(previewCheckovRoleDiagnostics([changed]).diagnostics).toEqual([]);
    const worker = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', scopes('genai-rag')[0]!.scope, parent);
    expect(worker.generatedOptionalRoleFacts).toEqual([true, true, true, true]);
    const workerPreview = previewCheckovRoleDiagnostics([worker]);
    expect(workerPreview.diagnostics.map(item => item.rule)).toEqual(expect.arrayContaining(['CKV_AZURE_212', 'CKV_AZURE_225']));
    expect(workerPreview.diagnostics.some(item => [
      ...decision.optionalCapabilities.strictSecurityRules,
      ...decision.optionalCapabilities.unapprovedExposureRules,
      ...decision.optionalCapabilities.serviceBusRulesHeldUntilIndependentEncryptionAuthenticationAndApplicationIdentityProof,
      decision.optionalCapabilities.queueLoggingHeldUntilActualServiceUseProof
    ].includes(item.rule))).toBe(false);
  }, 240_000
);

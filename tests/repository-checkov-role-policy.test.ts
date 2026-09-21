import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessCheckovScope, type CheckovInputScope } from '../scripts/repository-security/checkov.ts';
import { previewCheckovRoleDiagnostics, telemetryFeatureDiagnosticScope } from '../scripts/repository-security/checkov-role-policy.ts';

describe('role-bound Checkov diagnostics', () => {
  it('rejects candidate claims, forged facts and serialized observations as authority', () => {
    expect(() => previewCheckovRoleDiagnostics([])).toThrow('observation-set');
    for (const value of [null, {}, { role: 'telemetry', approved: true, roleFacts: Array(14).fill(true) }]) {
      expect(() => previewCheckovRoleDiagnostics([value])).toThrow('identity-mismatch');
    }
  });
  it('records exact owner scope rather than a generic native-rule downgrade', async () => {
    const decision = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'telemetry-feature-diagnostic-decision.json'), 'utf8'));
    expect(decision.sourceSha256).toBe(telemetryFeatureDiagnosticScope.sha256);
    expect(decision.pathParts.join('/')).toBe(telemetryFeatureDiagnosticScope.path);
    expect(decision.rules.sort()).toEqual(Object.keys(telemetryFeatureDiagnosticScope.rationales).sort());
    expect(decision).toMatchObject({
      nativeFailuresPreserved: true, featuresClaimedPresent: false, digestPinningIsSigning: false,
      generatedRegistriesInherit: false, mandatoryAuthenticationAndImageScanningUnchanged: true
    });
  });
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_ROLES === '1')(
  'derives telemetry advice from real source bindings and does not transfer it to changed facts or resources',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    const directory = ['infrastructure', 'opentofu', 'telemetry'];
    const files = await Promise.all(['container-app.tf', 'main.tf', 'outputs.tf', 'variables.tf', 'versions.tf'].map(async name => ({
      pathParts: [...directory, name], content: await readFile(path.join(process.cwd(), ...directory, name), 'utf8')
    })));
    const source: CheckovInputScope = { framework: 'terraform', files };
    const dockerParts = ['services', 'telemetry-ingest', 'Dockerfile'];
    const docker: CheckovInputScope = { framework: 'dockerfile', files: [{
      pathParts: dockerParts, content: await readFile(path.join(process.cwd(), ...dockerParts), 'utf8')
    }] };
    const original = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', source, parent);
    const image = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', docker, parent);
    expect(original.roleFacts).toEqual(Array(14).fill(true));
    expect(original.results).toContainEqual(expect.objectContaining({ rule: 'CKV2_LIFTOFF_10', status: 'passed' }));
    expect(original.resourceApplicabilityBasis).toBe('exact-telemetry-role-graph-and-registered-controls');
    const preview = previewCheckovRoleDiagnostics([original, image]);
    expect(preview.diagnostics.map(item => item.rule).sort()).toEqual([
      'CKV_AZURE_139', 'CKV_AZURE_163', 'CKV_AZURE_164', 'CKV_AZURE_165', 'CKV_AZURE_166',
      'CKV_AZURE_167', 'CKV_AZURE_233', 'CKV_AZURE_237', 'CKV_DOCKER_2'
    ]);
    expect(preview).toMatchObject({ nativeFailuresUnchanged: true, adoptedPolicyAuthority: false, publicationQualified: false });
    for (const diagnostic of preview.diagnostics) {
      expect([original, image][diagnostic.reportIndex]!.results[diagnostic.resultIndex]!.status).toBe('failed');
    }
    expect(() => previewCheckovRoleDiagnostics([JSON.parse(JSON.stringify(original))])).toThrow('identity-mismatch');
    for (const [from, to] of [
      ['anonymous_pull_enabled        = false', 'anonymous_pull_enabled        = true'],
      ['admin_enabled                 = false', 'admin_enabled                 = true'],
      ['sku                           = "Basic"', 'sku                           = "Premium"'],
      ['role_definition_name = "AcrPull"', 'role_definition_name = "Contributor"'],
      ['transport               = "TCP"', 'transport               = "HTTP"']
    ]) {
      const changed = structuredClone(source);
      const input = changed.files.find(file => file.pathParts.at(-1) === 'container-app.tf')!;
      expect(input.content).toContain(from);
      input.content = input.content.replaceAll(from!, to!);
      const observed = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', changed, parent);
      const result = previewCheckovRoleDiagnostics([observed, image]);
      if (from!.includes('transport')) expect(result.diagnostics.some(item => item.rule === 'CKV_DOCKER_2')).toBe(false);
      else expect(result.diagnostics).toEqual([]);
    }
    const additional = structuredClone(source);
    additional.files[0]!.content += '\nresource "azurerm_container_registry" "unregistered_role" {\n sku = "Basic"\n public_network_access_enabled = true\n}\n';
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', additional, parent))
      .rejects.toThrow('unresolved-policy-binding');
    const uncertain = structuredClone(source);
    uncertain.files[0]!.content = uncertain.files[0]!.content.replace('sku                           = "Basic"',
      'sku                           = "Basic"\n  data_endpoint_enabled = var.unresolved_endpoint');
    const unknown = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', uncertain, parent);
    expect(previewCheckovRoleDiagnostics([unknown]).diagnostics.some(item =>
      Object.hasOwn(telemetryFeatureDiagnosticScope.rationales, item.rule))).toBe(false);
    for (const [before, after] of [
      ['local_authentication_enabled   = false', 'local_authentication_enabled   = true'],
      ['TimeGenerated, EventName, SchemaVersion, Command, CliVersion, Outcome', 'TimeGenerated, EventName, SchemaVersion, Command, CliVersion, SourceIp'],
      ['retention_in_days       = 180', 'retention_in_days       = 365'],
      ['role_definition_name = "Monitoring Metrics Publisher"', 'role_definition_name = "Owner"']
    ]) {
      const changed = structuredClone(source), main = changed.files.find(file => file.pathParts.at(-1) === 'main.tf')!;
      expect(main.content).toContain(before);
      main.content = main.content.replace(before!, after!);
      const observed = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', changed, parent);
      expect(observed.results).toContainEqual(expect.objectContaining({ rule: 'CKV2_LIFTOFF_10', status: 'failed' }));
    }
    const alteredValidation = structuredClone(source);
    alteredValidation.files.find(file => file.pathParts.at(-1) === 'variables.tf')!.content += '\n# Changed declaration contract.\n';
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', alteredValidation, parent))
      .rejects.toThrow('unresolved-policy-binding');
    const branchBuild = structuredClone(source);
    branchBuild.files[0]!.content = branchBuild.files[0]!.content.replace(
      'setunion(var.retained_image_revisions, toset([var.source_revision]))', 'toset(["main"])');
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', branchBuild, parent))
      .rejects.toThrow('unresolved-policy-binding');
    const credential = structuredClone(source);
    credential.files[0]!.content = credential.files[0]!.content.replace(
      'loginMode = "Default"', 'loginMode = "Default"\n username = "nonfunctional-user"');
    const credentialResult = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', credential, parent);
    expect(credentialResult.results).toContainEqual(expect.objectContaining({ rule: 'CKV2_LIFTOFF_10', status: 'failed' }));
  }, 240_000
);

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessCheckovScope, checkovCustomPolicyFiles, parseCheckovScopeOutput, type CheckovInputScope } from '../scripts/repository-security/checkov.ts';
import { bootstrapRepresentativeVariables } from '../scripts/repository-security/checkov-driver.ts';

async function policies() {
  return Promise.all(checkovCustomPolicyFiles.map(async item => ({
    id: item.id, filename: item.filename,
    content: await readFile(path.join(process.cwd(), 'security', 'checkov', item.filename), 'utf8')
  })));
}

async function scope(secure: boolean): Promise<CheckovInputScope> {
  return {
    framework: 'terraform', customPolicies: await policies(),
    files: [{ pathParts: ['infrastructure', 'opentofu', 'bootstrap', 'main.tf'], content: [
      'resource "azapi_resource" "state_storage" {',
      '  type = "Microsoft.Storage/storageAccounts@2023-05-01"',
      '  name = "nonfunctional-state-fixture"',
      '  body = { properties = {',
      `    supportsHttpsTrafficOnly = ${secure}`,
      `    minimumTlsVersion = "${secure ? 'TLS1_2' : 'TLS1_0'}"`,
      `    allowSharedKeyAccess = ${!secure}`,
      `    defaultToOAuthAuthentication = ${secure}`,
      `    publicNetworkAccess = "${secure ? 'SecuredByPerimeter' : 'Enabled'}"`,
      `    allowBlobPublicAccess = ${!secure}`,
      '  } }',
      '}',
      'resource "azapi_resource" "state_container" {',
      '  type = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"',
      '  name = "nonfunctional-state-container"',
      `  body = { properties = { publicAccess = "${secure ? 'None' : 'Blob'}" } }`,
      '}',
      'resource "azurerm_network_security_perimeter_association" "state_storage" {',
      '  name = "nonfunctional-association"',
      `  access_mode = "${secure ? 'Enforced' : 'Learning'}"`,
      '}',
      'resource "azurerm_network_security_perimeter_access_rule" "operators" {',
      '  direction = "Inbound"',
      `  address_prefixes = ["${secure ? '192.0.2.1/32' : '192.0.2.0/24'}"]`,
      '}'
    ].join('\n') }]
  };
}

describe('registered existing bootstrap contracts', () => {
  it('does not apply state-storage authentication/perimeter requirements to telemetry or other roles', async () => {
    const input = await scope(true);
    input.files[0]!.pathParts = ['infrastructure', 'opentofu', 'telemetry', 'main.tf'];
    expect(() => parseCheckovScopeOutput(Buffer.from('[]'), 0, input)).toThrow('invalid-input');
    expect(checkovCustomPolicyFiles.filter(item => item.bootstrapOnly).map(item => item.id)).toEqual([2, 3, 4, 5, 7]);
  });

  it('keeps every exact policy file registered as a protected control, never maintenance data', async () => {
    const control = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'control-plane.json'), 'utf8'));
    for (const policy of await policies()) {
      expect(control.controlInputs).toContainEqual(['security', 'checkov', policy.filename]);
      expect(control.policyData.some((entry: { pathParts: string[] }) => entry.pathParts.includes(policy.filename))).toBe(false);
      expect(policy.content).toContain(`CKV2_LIFTOFF_${policy.id}`);
    }
  });
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_BOOTSTRAP === '1')(
  'qualifies secure/insecure actual-shaped bootstrap policies and refuses malformed value types',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    for (const secure of [true, false]) {
      const result = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', await scope(secure), parent);
      const applicable = result.results.filter(item => item.applicability === 'applicable');
      expect(applicable.map(item => item.rule).sort()).toEqual([1, 2, 3, 4, 5, 7, 8].map(id => `CKV2_LIFTOFF_${id}`));
      expect(applicable.every(item => item.status === (secure ? 'passed' : 'failed'))).toBe(true);
      expect(result.checkedResources).toBe(4);
      expect(result.publicationQualified).toBe(false);
    }
    const cased = await scope(true);
    cased.files[0]!.content = cased.files[0]!.content.replaceAll('Microsoft.Storage/storageAccounts', 'microsoft.storage/storageaccounts');
    const result = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', cased, parent);
    expect(result.results.filter(item => item.applicability === 'applicable')).toHaveLength(7);
    expect(result.failed).toBe(0);
    const malformed = await scope(true);
    malformed.files[0]!.content = malformed.files[0]!.content.replace('allowSharedKeyAccess = false', 'allowSharedKeyAccess = 0');
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', malformed, parent))
      .rejects.toThrow('unresolved-policy-binding');
    for (const value of ['[]', '["2001:db8::1/128"]', '["192.0.2.1/32", "192.0.2.0/24"]']) {
      const invalid = await scope(true);
      invalid.files[0]!.content = invalid.files[0]!.content.replace('["192.0.2.1/32"]', value);
      const observed = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', invalid, parent);
      expect(observed.results).toContainEqual(expect.objectContaining({ rule: 'CKV2_LIFTOFF_8', status: 'failed' }));
    }
    const unresolved = await scope(true);
    unresolved.files[0]!.content = unresolved.files[0]!.content.replace('["192.0.2.1/32"]', 'var.unresolved_cidrs');
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', unresolved, parent))
      .rejects.toThrow('unresolved-policy-binding');
  }, 240_000
);

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_BOOTSTRAP === '1')(
  'qualifies the exact bootstrap role graph rather than extending check counts to unknown resources',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    const rootDirectory = ['infrastructure', 'opentofu', 'bootstrap'];
    const source: CheckovInputScope = {
      framework: 'terraform', customPolicies: await policies(),
      files: await Promise.all(['main.tf', 'outputs.tf', 'variables.tf', 'versions.tf'].map(async name => ({
        pathParts: [...rootDirectory, name], content: await readFile(path.join(process.cwd(), ...rootDirectory, name), 'utf8')
      }))),
      terraformContext: {
        rootDirectory, moduleDirectories: [],
        variableFiles: [{ pathParts: [...rootDirectory, 'fixture.tfvars'], content: bootstrapRepresentativeVariables }]
      }
    };
    const actual = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', source, parent);
    expect(actual).toMatchObject({
      resourceApplicabilityQualified: true, resourceApplicabilityBasis: 'exact-bootstrap-role-graph-and-registered-controls',
      failed: 0, terraformContext: { requiredRootVariables: 4, productionValues: false }
    });
    expect(actual.results).toContainEqual(expect.objectContaining({ rule: 'CKV2_LIFTOFF_9', status: 'passed' }));
    for (const [before, after] of [
      ['role_definition_name = "Storage Blob Data Contributor"', 'role_definition_name = "Owner"'],
      ['prevent_destroy = true', 'prevent_destroy = false'],
      ['resource_id                           = azapi_resource.state_storage.id', 'resource_id                           = azurerm_resource_group.state.id']
    ]) {
      const changed = structuredClone(source);
      expect(changed.files[0]!.content).toContain(before);
      changed.files[0]!.content = changed.files[0]!.content.replace(before!, after!);
      const result = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', changed, parent);
      expect(result.results).toContainEqual(expect.objectContaining({ rule: 'CKV2_LIFTOFF_9', status: 'failed' }));
    }
    const unknown = structuredClone(source);
    unknown.files[0]!.content += '\nresource "azurerm_resource_group" "unknown_role" { name = "inert" }\n';
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', unknown, parent)).rejects.toThrow('unresolved-policy-binding');
    const unresolved = structuredClone(source);
    unresolved.files[0]!.content = unresolved.files[0]!.content.replace(
      'role_definition_name = "Storage Blob Data Contributor"', 'role_definition_name = var.unresolved_role');
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', unresolved, parent)).rejects.toThrow('unresolved-policy-binding');
  }, 240_000
);

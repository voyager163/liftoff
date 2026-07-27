import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const bootstrapRoot = path.join(
  process.cwd(),
  'infrastructure',
  'opentofu',
  'bootstrap'
);

async function bootstrapSource(): Promise<string> {
  const files = (await readdir(bootstrapRoot))
    .filter((name) => name.endsWith('.tf'))
    .sort();
  return (await Promise.all(files.map((name) => readFile(path.join(bootstrapRoot, name), 'utf8'))))
    .join('\n');
}

describe('telemetry OpenTofu backend bootstrap', () => {
  it('creates protected state resources without shared keys', async () => {
    const source = await bootstrapSource();
    expect(source).toContain('resource_group_name  = "rg-liftoff-tfstate"');
    expect(source).toContain('storage_account_name = "stliftofftfstate${var.resource_suffix}"');
    expect(source).toMatch(/resource "azurerm_resource_group" "state"[\s\S]*?prevent_destroy = true/);
    expect(source).toMatch(/resource "azapi_resource" "state_storage"[\s\S]*?prevent_destroy = true/);
    expect(source).toContain('allowSharedKeyAccess         = false');
    expect(source).toContain('requireInfrastructureEncryption = true');
    expect(source).toContain('isVersioningEnabled = true');
  });

  it('enforces one state-storage perimeter with only operator rules', async () => {
    const [source, variables, outputs] = await Promise.all([
      bootstrapSource(),
      readFile(path.join(bootstrapRoot, 'variables.tf'), 'utf8'),
      readFile(path.join(bootstrapRoot, 'outputs.tf'), 'utf8')
    ]);
    expect(source).toContain('resource "azurerm_network_security_perimeter" "telemetry"');
    expect(source).toContain('resource "azurerm_network_security_perimeter_profile" "telemetry_storage"');
    expect(source).toContain('address_prefixes                      = var.operator_cidrs');
    expect(source).not.toMatch(/approved-subscription|onedeploy|AppService|network_service_tags/i);
    expect(source).toContain('publicNetworkAccess          = "SecuredByPerimeter"');
    expect(source).toMatch(
      /resource "azurerm_network_security_perimeter_association" "state_storage"[\s\S]*?access_mode\s*=\s*"Enforced"/
    );
    expect(variables).toContain('variable "operator_cidrs"');
    expect(variables).toContain('sensitive   = true');
    expect(variables).toContain('/32 CIDR');
    expect(variables).toContain('^[a-z0-9]{6,8}$');
    expect(outputs).not.toMatch(/operator|cidr|address_prefix/i);
  });

  it('creates the private container through ARM and grants scoped data access', async () => {
    const source = await bootstrapSource();
    expect(source).toContain('Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01');
    expect(source).toContain('resource "azapi_update_resource" "blob_service"');
    expect(source).toContain('/blobServices/default"');
    expect(source).toContain('publicAccess = "None"');
    expect(source).toMatch(
      /resource "azapi_resource" "state_container"[\s\S]*?prevent_destroy = true/
    );
    expect(source).toContain('role_definition_name = "Storage Blob Data Contributor"');
    expect(source).toContain('scope                = azapi_resource.state_storage.id');
    expect(source).toContain('create_duration = "10m"');
  });

  it('uses local bootstrap state without static credentials', async () => {
    const source = await bootstrapSource();
    expect(source).toContain('backend "local"');
    expect(source).toContain('path = ".bootstrap/bootstrap.tfstate"');
    expect(source).not.toMatch(/(?:access_key|sas_token|client_secret|password)\s*=/i);
  });

  it('uses repository-correct input paths and requires a secure state backup', async () => {
    const readme = await readFile(path.join(bootstrapRoot, 'README.md'), 'utf8');
    expect(readme).toContain('../../../.azure/telemetry-bootstrap.tfvars');
    expect(readme).toContain('../../../.azure/telemetry-bootstrap.tfplan');
    expect(readme).toContain('/secure/encrypted/liftoff-bootstrap.tfstate');
    expect(readme).toContain('Network Security Perimeter');
    expect(readme).toContain('operator');
  });
});

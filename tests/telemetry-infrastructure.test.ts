import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const infrastructureRoot = path.join(
  process.cwd(),
  'infrastructure',
  'opentofu',
  'telemetry'
);

async function tofuSource(): Promise<string> {
  const files = (await readdir(infrastructureRoot))
    .filter((name) => name.endsWith('.tf'))
    .sort();
  return (await Promise.all(files.map((name) => readFile(path.join(infrastructureRoot, name), 'utf8'))))
    .join('\n');
}

async function tofuFile(name: string): Promise<string> {
  return readFile(path.join(infrastructureRoot, name), 'utf8');
}

describe('telemetry OpenTofu privacy contract', () => {
  it('owns the exact protected production resource group', async () => {
    const source = await tofuSource();
    expect(source).toContain('resource_group_name       = "rg-liftoff-prod"');
    expect(source).toMatch(/resource "azurerm_resource_group" "telemetry"[\s\S]*?prevent_destroy = true/);
    for (const resource of [
      'azurerm_user_assigned_identity',
      'azurerm_log_analytics_workspace',
      'azurerm_monitor_data_collection_endpoint',
      'azurerm_monitor_data_collection_rule',
      'azurerm_container_registry',
      'azurerm_container_app_environment',
      'azurerm_container_app'
    ]) {
      expect(source).toMatch(
        new RegExp(`resource "${resource}"[\\s\\S]*?resource_group_name\\s*=\\s*azurerm_resource_group\\.telemetry\\.name`)
      );
    }
    expect(source).toMatch(
      /resource "azapi_resource" "telemetry_image_build_task"[\s\S]*?parent_id\s*=\s*azurerm_container_registry\.telemetry\.id/
    );
  });

  it('uses managed identity for ACR pull and ingestion without target-architecture secrets', async () => {
    const [source, target, outputs] = await Promise.all([
      tofuSource(),
      tofuFile('container-app.tf'),
      tofuFile('outputs.tf')
    ]);
    expect(target).toContain('admin_enabled                 = false');
    expect(target).toContain('anonymous_pull_enabled        = false');
    expect(target).toContain('role_definition_name = "AcrPull"');
    expect(target).toContain('principal_id         = azurerm_user_assigned_identity.telemetry.principal_id');
    expect(target).toContain('identity = azurerm_user_assigned_identity.telemetry.id');
    expect(source).toContain('role_definition_name = "Monitoring Metrics Publisher"');
    expect(source).not.toMatch(/application_insights|APPINSIGHTS|INSTRUMENTATIONKEY/i);
    expect(target).not.toMatch(/password_secret_name|username\s*=|secret_name|sas_token|storage_access_key|connection_string/i);
    expect(outputs).not.toMatch(/key|secret|token|connection/i);
  });

  it('stores only six projected columns for exactly 180 days', async () => {
    const source = await tofuSource();
    expect(source).toContain('name                    = "LiftoffCommandEvents_CL"');
    expect(source).toContain('retention_in_days       = 180');
    expect(source).toContain('total_retention_in_days = 180');
    expect(source).toContain('local_authentication_enabled = false');
    expect(source).toContain(
      'transform_kql = "source | project TimeGenerated, EventName, SchemaVersion, Command, CliVersion, Outcome"'
    );
    for (const column of [
      'TimeGenerated',
      'EventName',
      'SchemaVersion',
      'Command',
      'CliVersion',
      'Outcome'
    ]) {
      expect(source).toContain(`name = "${column}"`);
    }
  });

  it('builds one immutable image from a full public commit SHA', async () => {
    const [target, variables] = await Promise.all([
      tofuFile('container-app.tf'),
      tofuFile('variables.tf')
    ]);
    expect(variables).toContain('variable "source_revision"');
    expect(variables).toContain('^[0-9a-f]{40}$');
    expect(target).toContain('image_tag               = var.source_revision');
    expect(target).toContain('https://github.com/voyager163/liftoff.git#${var.source_revision}');
    expect(target).toContain('Microsoft.ContainerRegistry/registries/tasks@2019-04-01');
    expect(target).toContain('dockerFilePath = "services/telemetry-ingest/Dockerfile"');
    expect(target).toContain('imageNames     = [local.image_name]');
    expect(target).toContain('resource "azurerm_container_registry_task_schedule_run_now" "telemetry_image"');
    expect(target).toContain('create = "45m"');
    expect(target).not.toMatch(/:latest|image_tag\s*=\s*"(?:main|master|latest)"/i);
  });

  it('keeps one smallest warm replica with strict scale and probe bounds', async () => {
    const target = await tofuFile('container-app.tf');
    expect(target).toContain('logs_destination    = ""');
    expect(target).not.toContain('log_analytics_workspace_id');
    expect(target).toContain('allow_insecure_connections = false');
    expect(target).toContain('external_enabled           = var.ingestion_enabled');
    expect(target).toContain('target_port                = local.container_port');
    expect(target).toContain('revision_mode                = "Single"');
    expect(target).toContain('min_replicas                     = 1');
    expect(target).toContain('max_replicas                     = 5');
    expect(target).toContain('cpu    = 0.25');
    expect(target).toContain('memory = "0.5Gi"');
    expect(target).toContain('termination_grace_period_seconds = 30');
    expect(target.match(/transport\s*=\s*"TCP"/g)).toHaveLength(3);
    expect(target).toContain('concurrent_requests = "20"');
  });

  it('passes only approved non-secret settings to the Container App', async () => {
    const target = await tofuFile('container-app.tf');
    for (const setting of [
      'AZURE_CLIENT_ID',
      'TELEMETRY_DCE_ENDPOINT',
      'TELEMETRY_DCR_IMMUTABLE_ID',
      'TELEMETRY_STREAM_NAME'
    ]) {
      expect(target).toContain(`name  = "${setting}"`);
    }
    expect(target.match(/\n\s+env \{/g)).toHaveLength(4);
    expect(target).not.toMatch(/AzureWebJobsStorage|FUNCTIONS_|WEBSITE_|secret_name/);
    expect(target).toMatch(
      /depends_on = \[[\s\S]*?azurerm_container_registry_task_schedule_run_now\.telemetry_image[\s\S]*?time_sleep\.container_registry_pull_propagation/
    );
  });

  it('isolates and freezes the superseded Function path during migration', async () => {
    const [target, legacy, variables] = await Promise.all([
      tofuFile('container-app.tf'),
      tofuFile('main.tf'),
      tofuFile('variables.tf')
    ]);
    expect(target).not.toMatch(/Microsoft\.Web|Function|OneDeploy|AzureWebJobsStorage|storage_account/i);
    expect(legacy).toMatch(
      /resource "azurerm_storage_blob" "function_package"[\s\S]*?ignore_changes = \[[\s\S]*?name,[\s\S]*?source/
    );
    expect(legacy).toContain('count = var.legacy_onedeploy_enabled ? 1 : 0');
    expect(variables).toMatch(
      /variable "legacy_onedeploy_enabled"[\s\S]*?default\s*=\s*false[\s\S]*?condition\s*=\s*!var\.legacy_onedeploy_enabled/
    );
  });

  it('pins providers and exposes no sensitive outputs', async () => {
    const [source, outputs, variables] = await Promise.all([
      tofuSource(),
      tofuFile('outputs.tf'),
      tofuFile('variables.tf')
    ]);
    expect(source).toContain('version = "4.81.0"');
    expect(source).toContain('version = "2.8.0"');
    expect(source).toContain('version = "2.11.0"');
    expect(source).toContain('version = "0.14.0"');
    expect(source).toMatch(/daily_quota_gb\s*=\s*var\.daily_quota_gb/);
    expect(outputs).not.toMatch(/key|secret|token|connection/i);
    expect(outputs).toContain('azurerm_container_app.telemetry.ingress[0].fqdn');
    expect(outputs).not.toMatch(/function_app_id|azurewebsites/i);
    expect(variables).toContain('^[a-z0-9]{6,8}$');
    expect(variables).not.toMatch(/variable "subscription_id"[\s\S]*?default\s*=\s*null/);
  });

  it('contains only OpenTofu infrastructure files and no alternate deployment path', async () => {
    const entries = await readdir(infrastructureRoot);
    expect(entries.some((name) => name.endsWith('.bicep'))).toBe(false);
    const source = await tofuSource();
    expect(source).not.toMatch(/\bazd\b|\bterraform (?:apply|destroy|plan)\b|\baz deployment\b/i);
  });

  it('keeps standard GitHub-hosted CI static-only', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('init -backend=false');
    expect(workflow).not.toMatch(/\btofu(?:\s+-[^\s]+)*\s+(?:plan|apply|destroy)\b/);
    expect(workflow).not.toMatch(/\bazd\s+(?:up|deploy|provision)\b/);
  });

  it('uses one production variable file for plan and emergency disablement', async () => {
    const [readme, example] = await Promise.all([
      readFile(path.join(infrastructureRoot, 'README.md'), 'utf8'),
      readFile(path.join(infrastructureRoot, 'production.tfvars.example'), 'utf8')
    ]);
    expect(readme.match(/-var-file=\/secure\/path\/telemetry-production\.tfvars/g)).toHaveLength(2);
    for (const input of [
      'subscription_id',
      'location',
      'resource_suffix',
      'source_revision',
      'maximum_instance_count',
      'daily_quota_gb'
    ]) {
      expect(example).toContain(input);
    }
  });
});

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import { patterns } from '../src/application/project/catalog.js';
import { object, parseHcl, singleBlock } from '../src/adapters/hcl/semantic.js';
import { AZURE_NAME_LIMITS, buildArtifacts, buildAzureResourceNames } from '../src/templates.js';

const environmentIds = ['dev', 'staging', 'prod'];
const rootIds = ['versions', 'provider-lock', 'providers', 'variables', 'main', 'outputs', 'local-state', 'remote-state-example', 'tfvars'];
const artifactsFor = (environments: string[], extra = {}) => buildArtifacts(buildProjectPlan({
  projectName: 'Customer Portal API',
  pattern: 'rag',
  cloud: 'azure',
  environments,
  ...extra
}, { requireProjectName: true }));

describe('independent generated infrastructure roots', () => {
  it('inventories every nonempty environment combination without a shared default state', () => {
    for (let selection = 1; selection < 8; selection++) {
      const environments = environmentIds.filter((_, index) => selection & (1 << index));
      const artifacts = artifactsFor(environments);
      expect(artifactsFor(environments)).toEqual(artifacts);
      for (const id of ['versions', 'variables', 'main', 'outputs']) {
        const artifact = artifacts.find(({ logicalName }) => logicalName === `opentofu-application-${id}`)!;
        expect(artifact.pathParts).toEqual(['infrastructure', 'opentofu', 'azure', 'modules', 'application', `${id}.tf`]);
        expect(artifact).toMatchObject({ lifecycle: 'project', provisioningGroup: 'base' });
      }
      const keys: string[] = [];
      const states: string[] = [];
      for (const environment of environments) {
        for (const id of rootIds) {
          const artifact = artifacts.find(({ logicalName }) => logicalName === `opentofu-${environment}-${id}`)!;
          expect(artifact, `${environment} ${id}`).toBeDefined();
          expect(artifact.pathParts.slice(0, 5)).toEqual(['infrastructure', 'opentofu', 'azure', 'environments', environment]);
          expect(artifact).toMatchObject({ lifecycle: 'project', provisioningGroup: `environment:${environment}` });
          if (id === 'tfvars') expect(artifact.pathParts.at(-1)).toBe(`${environment}.tfvars`);
          if (id === 'main') expect(artifact.content).toContain('"../../modules/application"');
          if (id === 'variables') expect(artifact.content).toContain(`var.environment == "${environment}"`);
          if (id === 'local-state') {
            expect(artifact.content).toContain(`path = "state/${environment}.tfstate"`);
            states.push(artifact.pathParts.slice(0, -1).join('/') + `/state/${environment}.tfstate`);
          }
          if (id === 'remote-state-example') {
            expect(artifact.content).toContain(`/${environment}/terraform.tfstate`);
            expect(artifact.content).toContain('private, encrypted ZRS');
            keys.push(artifact.content.match(/key\s+= "([^"]+)"/)![1]);
          }
        }
      }
      expect(new Set(keys).size).toBe(environments.length);
      expect(new Set(states).size).toBe(environments.length);
      expect(artifacts.filter(({ pathParts }) =>
        pathParts.slice(0, 3).join('/') === 'infrastructure/opentofu/azure' &&
        pathParts.length === 4
      ).map(({ logicalName }) => logicalName)).toEqual(['opentofu-readme']);
      for (const legacy of ['versions', 'provider-lock', 'providers', 'variables', 'main', 'outputs', 'local-state', 'remote-state-example']) {
        expect(artifacts.some(({ logicalName }) => logicalName === `opentofu-${legacy}`)).toBe(false);
      }
    }
  });

  it('keeps long full-project identities distinct even with the same caller-supplied suffix', () => {
    const plans = ['customer-portal-api', 'customer-portal-web'].map((projectName) =>
      buildProjectPlan({ projectName, pattern: 'rag', cloud: 'azure' }, { requireProjectName: true }));
    for (const environment of environmentIds) {
      const names = plans.map((plan) => buildAzureResourceNames(plan, environment, 'abcdefghijkl'));
      for (const key of Object.keys(AZURE_NAME_LIMITS) as Array<keyof typeof AZURE_NAME_LIMITS>) {
        expect(names[0][key], key).not.toBe(names[1][key]);
        for (const name of names.map((item) => item[key])) {
          expect(name.length, key).toBeLessThanOrEqual(AZURE_NAME_LIMITS[key]);
          expect(name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
          expect(name).not.toContain('--');
        }
      }
      expect(names[0].storage).toMatch(/^[a-z0-9]{3,24}$/);
      expect(names[0].containerRegistry).toMatch(/^[a-z0-9]{5,50}$/);
    }
  });

  it('binds RAG publication and reception to distinct identities at queue scope', () => {
    const artifacts = artifactsFor(['prod']);
    const main = artifacts.find(({ logicalName }) => logicalName === 'opentofu-application-main')!.content;
    const sender = main.match(/resource "azurerm_role_assignment" "backend_servicebus_sender" \{[^}]+\}/)![0];
    const receiver = main.match(/resource "azurerm_role_assignment" "function_servicebus_receiver" \{[^}]+\}/)![0];
    expect(sender).toContain('scope                = azurerm_servicebus_queue.events.id');
    expect(sender).toContain('"Azure Service Bus Data Sender"');
    expect(sender).toContain('azurerm_user_assigned_identity.app.principal_id');
    expect(receiver).toContain('scope                = azurerm_servicebus_queue.events.id');
    expect(receiver).toContain('"Azure Service Bus Data Receiver"');
    expect(receiver).toContain('azurerm_user_assigned_identity.worker.principal_id');
    for (const key of ['SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE', 'SERVICE_BUS_QUEUE_NAME', 'SERVICE_BUS_AUTH_MODE', 'AZURE_CLIENT_ID']) {
      expect(main).toContain(`name  = "${key}"`);
    }
    expect(main).toContain('ServiceBusConnection__clientId                = azurerm_user_assigned_identity.worker.client_id');
    const readme = artifacts.find(({ logicalName }) => logicalName === 'opentofu-readme')!.content;
    expect(readme).toContain('cd infrastructure/opentofu/azure/environments/prod');
    expect(readme).toContain('tofu plan -var-file=prod.tfvars');
    expect(readme).not.toContain('environments/dev');
  });

  it('emits the four explicit Azure TLS and private-blob defaults for issue #80 across profiles while preserving unrelated settings', async () => {
    const supportedProjects = [
      ...['node-fastify', 'python-fastapi', 'go-huma'].map((apiStack) => ({
        projectType: 'standard' as const, apiStack
      })),
      ...patterns.map((pattern) => ({ projectType: 'genai' as const, pattern: pattern.id }))
    ];
    expect(supportedProjects).toHaveLength(12);
    for (const [index, project] of supportedProjects.entries()) {
      const artifacts = buildArtifacts(buildProjectPlan({
        projectName: `baseline-profile-${index}`, ...project,
        cloud: 'azure', environments: ['dev', 'prod']
      }, { requireProjectName: true }));
      const main = artifacts.find(({ logicalName }) => logicalName === 'opentofu-application-main')!.content;
      const resources = object((await parseHcl(main, 'generated main.tf')).resource, 'resources');
      const resource = (type: string, name = 'main') => singleBlock(object(resources[type], type)[name], `${type}.${name}`);
      expect(resource('azurerm_redis_cache')).toMatchObject({
        minimum_tls_version: '1.2', capacity: 0, family: 'C', sku_name: 'Basic'
      });
      expect(resource('azurerm_servicebus_namespace')).toMatchObject({
        minimum_tls_version: '1.2', sku: 'Standard'
      });
      expect(resource('azurerm_storage_account')).toMatchObject({
        min_tls_version: 'TLS1_2', allow_nested_items_to_be_public: false,
        account_tier: 'Standard', account_replication_type: 'LRS'
      });
      expect(resource('azurerm_storage_container', 'documents')).toMatchObject({ container_access_type: 'private' });
    }
  });

  it('passes all five cited Checkov Azure controls on actual generated output', async () => {
    const root = path.resolve('tests', '.checkov-generated', randomUUID());
    try {
      const artifacts = artifactsFor(['dev'], { includeFrontend: true });
      for (const artifact of artifacts.filter((entry) => entry.category === 'infrastructure')) {
        const file = path.join(root, ...artifact.pathParts);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, artifact.content);
      }
      const controls = ['CKV_AZURE_148', 'CKV_AZURE_44', 'CKV_AZURE_190', 'CKV2_AZURE_47', 'CKV_AZURE_205'];
      const result = spawnSync(process.env.CHECKOV_PATH ?? 'checkov', [
        '-d', root,
        '--framework', 'terraform', '--check', controls.join(','),
        '--skip-download', '--download-external-modules', 'false', '--output', 'json'
      ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.summary.parsing_errors).toBe(0);
      expect(report.results.failed_checks).toEqual([]);
      expect(report.results.skipped_checks).toEqual([]);
      const applicablePassed = controls.filter((control) =>
        report.results.passed_checks.some((check: { check_id: string }) => check.check_id === control)
      );
      expect(new Set(applicablePassed), 'The qualification tool must execute every cited control, including the graph control.')
        .toEqual(new Set(controls));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('formats every emitted HCL root and module without provider access', async () => {
    const root = path.resolve('tests', '.generated-infrastructure', randomUUID());
    try {
      for (const artifact of artifactsFor(environmentIds, { includeFrontend: true })) {
        if (artifact.category !== 'infrastructure') continue;
        const file = path.join(root, ...artifact.pathParts);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, artifact.content);
      }
      const result = spawnSync('tofu', ['fmt', '-check', '-diff', '-recursive'], {
        cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024
      });
      expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

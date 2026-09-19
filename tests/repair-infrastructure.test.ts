import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@cdktf/hcl2json';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectInfrastructureRepair } from '../src/application/repair/infrastructure.js';
import { assessInfrastructureLayout, currentInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
import { liftoffVersion } from '../src/version.js';
import { equivalentHcl } from '../src/adapters/hcl/semantic.js';
import { createLegacyInfrastructureFixture, legacyInfrastructureSources, repairRoot } from './fixtures/repair-infrastructure.js';

const roots: string[] = [];
const hasOpenTofuFormatter = spawnSync('tofu', ['--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
async function fixture(environments: ('dev' | 'staging' | 'prod')[] = ['dev', 'prod']) {
  const root = path.resolve(`.repair infrastructure ${randomUUID()}`);
  roots.push(root);
  const manifest = await createLegacyInfrastructureFixture(root, environments);
  return { root, manifest };
}
async function put(root: string, parts: string[], content: string) {
  const target = path.join(root, ...repairRoot, ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
async function privateProviderRuntime(): Promise<string> {
  // Go provider plugins use Unix sockets with a short pathname limit.
  for (let attempt = 0; attempt < 16; attempt++) {
    const directory = path.resolve(randomUUID().slice(0, 2));
    try {
      await mkdir(directory, { mode: 0o700 });
      roots.push(directory);
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not create a private provider runtime directory.');
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bounded source-preserving infrastructure recipe', () => {
  it.skipIf(!hasOpenTofuFormatter || process.env.LIFTOFF_REPAIR_REAL_TOFU !== '1')('initializes and validates the complete fixture with real providers and no Azure access', async () => {
    const { root, manifest } = await fixture(['dev']);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    const target = path.resolve(`.repair infrastructure validation ${randomUUID()}`);
    roots.push(target);
    for (const file of candidate.files) {
      const destination = path.join(target, ...file.pathParts);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { mode: 0o600 });
    }
    const home = await privateProviderRuntime();
    const config = path.join(home, 'tofu.rc');
    await writeFile(config, '', { mode: 0o600 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(TF_|TOFU_|OTF_|ARM_|AZURE_|AWS_|GOOGLE_)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home,
      TMPDIR: home, TEMP: home, TMP: home, TF_CLI_CONFIG_FILE: config,
      TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1'
    });
    const cwd = path.join(target, ...repairRoot, 'environments', 'dev');
    execFileSync('tofu', ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'], {
      cwd, env, encoding: 'utf8', timeout: 120_000
    });
    const validation = spawnSync('tofu', ['validate', '-json', '-no-color'], {
      cwd, env, encoding: 'utf8', timeout: 120_000
    });
    expect(validation.status, validation.stdout).toBe(0);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true, error_count: 0 });
  }, 180_000);

  it.skipIf(!hasOpenTofuFormatter).each(['full', 'minimal'])('preserves formatted source bytes and generates fmt-clean module consumers (%s)', async (scope) => {
    const { root, manifest } = await fixture();
    if (scope === 'minimal') {
      await put(root, ['main.tf'], `resource "azurerm_resource_group" "main" {
  name     = "rg-native-repair-\${var.environment}"
  location = var.location
}
`);
      await put(root, ['outputs.tf'], `output "resource_group_name" {
  value = azurerm_resource_group.main.name
}
`);
    } else {
      await put(root, ['outputs.tf'], `${legacyInfrastructureSources['outputs.tf']}
output "secret" {
  value = var.postgres_admin_password
  sensitive = true
}
`);
    }
    execFileSync('tofu', ['fmt', '-recursive'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    const formattedMain = await readFile(path.join(root, ...repairRoot, 'main.tf'), 'utf8');
    const formattedVariables = await readFile(path.join(root, ...repairRoot, 'variables.tf'), 'utf8');
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    const target = path.resolve(`.repair infrastructure fmt ${randomUUID()}`);
    roots.push(target);
    for (const file of candidate.files) {
      const destination = path.join(target, ...file.pathParts);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
    expect(await readFile(path.join(target, ...repairRoot, 'modules', 'application', 'main.tf'), 'utf8')).toBe(formattedMain);
    expect(await readFile(path.join(target, ...repairRoot, 'modules', 'application', 'variables.tf'), 'utf8')).toBe(formattedVariables);
    expect(execFileSync('tofu', ['fmt', '-check', '-recursive'], {
      cwd: target, encoding: 'utf8', timeout: 10_000
    })).toBe('');
  });

  it('reorganizes the actual flat-root shape without regenerating resources or values', async () => {
    const { root, manifest } = await fixture();
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf'].replace('memory = "1Gi"', 'memory = "2Gi"'));
    await put(root, ['environments', 'prod.tfvars'], 'environment = "prod"\nresource_suffix = "abcdef123456"\nbackend_target_port = 9999\n# Preserve the project-selected values.\n');
    await put(root, ['notes.txt'], 'Unrelated project bytes');
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.layout).toBe('legacy-shared');
    expect(candidate.resourceGroups).toEqual([
      { environment: 'dev', name: 'rg-repair-dev' }, { environment: 'prod', name: 'rg-repair-prod' }
    ]);
    const get = (parts: string[]) => candidate.files.find((item) => path.join(...item.pathParts) === path.join(...repairRoot, ...parts))!.content;
    expect(get(['modules', 'application', 'main.tf'])).toBe(await readFile(path.join(root, ...repairRoot, 'main.tf'), 'utf8'));
    expect(get(['README.md'])).toContain('# Repaired infrastructure layout');
    expect(get(['README.md']).endsWith(legacyInfrastructureSources['README.md'])).toBe(true);
    for (const file of ['variables.tf', 'outputs.tf', 'versions.tf']) {
      expect(get(['modules', 'application', file])).toBe(legacyInfrastructureSources[file]);
    }
    for (const env of ['dev', 'prod']) {
      expect(get(['environments', env, '.terraform.lock.hcl'])).toBe(legacyInfrastructureSources['.terraform.lock.hcl']);
      expect(get(['environments', env, 'versions.tf'])).toBe(legacyInfrastructureSources['versions.tf']);
      expect(get(['environments', env, `${env}.tfvars`])).toBe(await readFile(path.join(root, ...repairRoot, 'environments', `${env}.tfvars`), 'utf8'));
      const consumer = await parse('main.tf', get(['environments', env, 'main.tf']));
      expect(consumer.module.application[0]).toMatchObject({
        source: '../../modules/application', environment: env, backend_target_port: '${var.backend_target_port}'
      });
      expect(await parse('backend.local.tf', get(['environments', env, 'backend.local.tf']))).toMatchObject({
        terraform: [{ backend: { local: [{ path: 'terraform.tfstate' }] } }]
      });
    }
    expect(candidate.files).toHaveLength(currentInfrastructureIdentities(['dev', 'prod']).length);
    expect(candidate.mutations.some((item) => item.pathParts.includes('notes.txt'))).toBe(false);
    expect(candidate.mutations.some((item) => item.pathParts.includes('manifest.json'))).toBe(false);
    for (const artifact of candidate.artifacts) {
      const file = candidate.files.find((item) => path.join(...item.pathParts) === path.join(...artifact.pathParts))!;
      expect(artifact.generationHash).toBe(`sha256:${createHash('sha256').update(file.content).digest('hex')}`);
      expect(artifact.generatedBy).toBe(liftoffVersion);
    }
    expect(assessInfrastructureLayout({ ...manifest, projectArtifacts: candidate.artifacts }).kind).toBe('independent');
    expect(candidate.snapshots.some((item) => item.content === undefined && item.pathParts.includes('modules'))).toBe(true);
    expect(candidate.snapshots.some((item) => item.pathParts.at(-1) === 'dev.tfvars' && item.content !== undefined)).toBe(true);
    expect(candidate.statePaths).toContainEqual([...repairRoot, '.terraform', 'terraform.tfstate']);
    expect(candidate.statePaths).toContainEqual([...repairRoot, '.terraform', 'environment']);
    expect(candidate.statePaths).toContainEqual([...repairRoot, 'terraform.tfstate.d']);
    expect(candidate.statePaths).toContainEqual([...repairRoot, 'environments', 'prod', 'terraform.tfstate']);
    expect(candidate).not.toHaveProperty('eligible');
    expect(candidate.directoryInventory.some((entry) => entry.entries.some((item) => item.name === 'notes.txt'))).toBe(true);
    expect(await readFile(path.join(root, ...repairRoot, 'notes.txt'), 'utf8')).toBe('Unrelated project bytes');
  });

  it('preserves locals, arbitrary supported resources, literal/default bindings, and sensitive outputs', async () => {
    const { root, manifest } = await fixture(['staging']);
    const main = `locals {\n prefix = "custom"\n group_name = "\${local.prefix}-\${var.environment}"\n}\n` +
      legacyInfrastructureSources['main.tf'].replace('"rg-repair-${var.environment}"', 'local.group_name') +
      '\nresource "azurerm_service_plan" "custom" {\n name = "worker"\n resource_group_name = azurerm_resource_group.main.name\n location = var.location\n os_type = "Linux"\n sku_name = "Y1"\n}\n';
    const outputs = `${legacyInfrastructureSources['outputs.tf']}\noutput "secret" {\n value = var.postgres_admin_password\n sensitive = true\n}\n`;
    await put(root, ['main.tf'], main);
    await put(root, ['outputs.tf'], outputs);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.resourceGroups).toEqual([{ environment: 'staging', name: 'custom-staging' }]);
    expect(candidate.files.find((item) => item.pathParts.includes('application') && item.pathParts.at(-1) === 'outputs.tf')!.content).toBe(outputs);
    const rootOutputs = candidate.files.find((item) => item.pathParts.includes('staging') && item.pathParts.at(-1) === 'outputs.tf')!;
    expect(await parse('outputs.tf', rootOutputs.content)).toMatchObject({
      output: { secret: [{ value: '${module.application.secret}', sensitive: true }] }
    });
  });

  it('supports the legacy worker resource and role chains without reinterpreting literal runtime paths', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf'] + `
resource "azurerm_service_plan" "functions" {
  name = "plan"
  resource_group_name = azurerm_resource_group.main.name
  location = var.location
  os_type = "Linux"
  sku_name = "Y1"
}
resource "azurerm_linux_function_app" "worker" {
  name = "worker"
  resource_group_name = azurerm_resource_group.main.name
  location = var.location
  service_plan_id = azurerm_service_plan.functions.id
  storage_account_name = azurerm_storage_account.main.name
  storage_account_access_key = azurerm_storage_account.main.primary_access_key
  app_settings = {
    SHARED_ORCHESTRATION_ROOT = "../../backend"
    ServiceBusConnection__fullyQualifiedNamespace = "\${azurerm_servicebus_namespace.main.name}.servicebus.windows.net"
  }
}
resource "azurerm_role_assignment" "function_receiver" {
  scope = azurerm_servicebus_namespace.main.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id = azurerm_user_assigned_identity.app.principal_id
}
`);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.resourceGroups).toEqual([{ environment: 'dev', name: 'rg-repair-dev' }]);
    expect(candidate.files.find((item) => item.pathParts.includes('application') && item.pathParts.at(-1) === 'main.tf')!.content)
      .toContain('SHARED_ORCHESTRATION_ROOT = "../../backend"');
  });

  it('derives every explicit group through selected tfvars, defaults and local reference chains', async () => {
    const { root, manifest } = await fixture(['prod']);
    await put(root, ['variables.tf'], legacyInfrastructureSources['variables.tf'] +
      '\nvariable "prefix" {\n type = string\n default = "existing-project"\n}\n');
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf'] + `
locals {
  base = var.prefix
  extra_name = "\${local.base}-\${var.environment}-extra"
}
resource "azurerm_resource_group" "extra" {
  name = local.extra_name
  location = var.location
}
resource "azurerm_storage_account" "extra" {
  name = "customstore"
  resource_group_name = azurerm_resource_group.extra.name
}
resource "azurerm_storage_container" "extra" {
  name = "container"
  storage_account_id = azurerm_storage_account.extra.id
}
`);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.resourceGroups.map((item) => item.name).sort()).toEqual(['existing-project-prod-extra', 'rg-repair-prod']);
  });

  it('does not equate different relative traversals or argument expansion in duplicate files', async () => {
    expect(await equivalentHcl(
      'output "x" { value = (var.obj).first }',
      'output "x" { value = (var.obj).second }', 'outputs.tf'
    )).toBe(false);
    expect(await equivalentHcl(
      'output "x" { value = concat(var.items) }',
      'output "x" { value = concat(var.items...) }', 'outputs.tf'
    )).toBe(false);
    expect(await equivalentHcl(
      'output "x" { value = var.obj.first }',
      '# whitespace-only change\noutput "x" { value = var.obj . first }', 'outputs.tf'
    )).toBe(true);
  });

  it('supports equivalent moved source and duplicate syntax while retaining destination bytes', async () => {
    const { root, manifest } = await fixture(['prod']);
    const target = path.join(root, ...repairRoot, 'modules', 'application');
    await mkdir(target, { recursive: true });
    await rename(path.join(root, ...repairRoot, 'main.tf'), path.join(target, 'main.tf'));
    const customizedSpacing = '# Moved by the owner\n' + legacyInfrastructureSources['variables.tf'].replace('type = string', 'type    =    string');
    await put(root, ['modules', 'application', 'variables.tf'], customizedSpacing);
    await mkdir(path.join(root, ...repairRoot, 'environments', 'prod'), { recursive: true });
    await rename(path.join(root, ...repairRoot, 'environments', 'prod.tfvars'), path.join(root, ...repairRoot, 'environments', 'prod', 'prod.tfvars'));
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.files.find((item) => item.pathParts.includes('application') && item.pathParts.at(-1) === 'variables.tf')!.content).toBe(customizedSpacing);
    expect(candidate.mutations.some((item) => item.type === 'write' && item.pathParts.includes('application') && item.pathParts.at(-1) === 'main.tf')).toBe(false);
    expect(candidate.mutations.some((item) => item.type === 'delete' && item.pathParts.length === 4 && item.pathParts.at(-1) === 'main.tf')).toBe(false);
  });

  it('keeps unchanged provenance and becomes a no-write independent validation candidate', async () => {
    const { root, manifest } = await fixture(['dev']);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    for (const mutation of candidate.mutations) {
      const target = path.join(root, ...mutation.pathParts);
      if (mutation.type === 'delete') await rm(target);
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, mutation.content);
      }
    }
    const repairedManifest = { ...manifest, projectArtifacts: candidate.artifacts };
    const repeated = await inspectInfrastructureRepair(root, repairedManifest);
    expect(repeated.blockers).toEqual([]);
    expect(repeated.layout).toBe('independent');
    expect(repeated.mutations).toEqual([]);
    expect(repeated.files).toEqual(candidate.files);
    expect(repeated.artifacts).toEqual(candidate.artifacts);
    const application = candidate.artifacts.find((artifact) => artifact.logicalName === 'opentofu-application-main')!;
    const file = path.join(root, ...application.pathParts);
    const customized = `${await readFile(file, 'utf8')}\n# Developer-owned setting documentation.\n`;
    await writeFile(file, customized);
    const observed = await inspectInfrastructureRepair(root, repairedManifest);
    expect(observed.blockers).toEqual([]);
    expect(observed.mutations).toEqual([]);
    expect(observed.artifacts).toEqual(candidate.artifacts);
    expect(observed.files.find((entry) => entry.pathParts.join('/') === application.pathParts.join('/'))?.content).toBe(customized);
    expect(application.generationHash).not.toBe(`sha256:${createHash('sha256').update(customized).digest('hex')}`);
  });

  it('prefixes selected-root guidance while preserving custom README prose, mode and original snapshot', async () => {
    const { root, manifest } = await fixture(['staging', 'prod']);
    const original = '# Our custom operations guide\r\n\r\nRun from the old root.\r\nKeep these owner-authored notes unchanged.';
    await put(root, ['README.md'], original);
    await chmod(path.join(root, ...repairRoot, 'README.md'), 0o640);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    const readme = candidate.files.find((file) => file.pathParts.at(-1) === 'README.md')!;
    expect(readme.content.endsWith(original)).toBe(true);
    expect(readme.content).toContain('liftoff infra plan --env staging');
    expect(readme.content).toContain('liftoff infra plan --env prod');
    expect(readme.content).not.toContain('liftoff infra plan --env dev');
    expect(readme.content).toContain([...repairRoot, 'environments', 'staging'].join('/'));
    expect(candidate.snapshots.find((snapshot) => snapshot.pathParts.at(-1) === 'README.md')!.content?.toString('utf8')).toBe(original);
    const mutation = candidate.mutations.find((item) => item.pathParts.at(-1) === 'README.md')!;
    expect(mutation).toMatchObject({ type: 'write', content: readme.content });
    if (process.platform !== 'win32') expect(mutation).toHaveProperty('mode', 0o640);
    const provenance = candidate.artifacts.find((artifact) => artifact.logicalName === 'opentofu-readme')!;
    expect(provenance.generatedBy).toBe(liftoffVersion);
    expect(provenance.generationHash).toBe(`sha256:${createHash('sha256').update(readme.content).digest('hex')}`);
    await put(root, ['README.md'], readme.content);
    const partial = await inspectInfrastructureRepair(root, manifest);
    expect(partial.blockers).toEqual([]);
    expect(partial.files.find((file) => file.pathParts.at(-1) === 'README.md')!.content).toBe(readme.content);
    expect(partial.mutations.some((item) => item.pathParts.at(-1) === 'README.md')).toBe(false);
    await put(root, ['README.md'], 'x'.repeat(256 * 1024));
    const oversized = await inspectInfrastructureRepair(root, manifest);
    expect(oversized.blockers.join()).toContain('repaired target exceeds');
    expect(oversized.mutations).toEqual([]);
  });

  it('preserves bounded explicit local backend paths and inventories both old/new state locations', async () => {
    const { root, manifest } = await fixture(['dev']);
    const backend = 'terraform {\n backend "local" {\n path = "state/custom.tfstate"\n workspace_dir = "workspaces"\n }\n}\n';
    await put(root, ['backend.local.tf'], backend);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.files.find((item) => item.pathParts.includes('dev') && item.pathParts.at(-1) === 'backend.local.tf')!.content).toBe(backend);
    for (const prefix of [repairRoot, [...repairRoot, 'environments', 'dev']]) {
      expect(candidate.statePaths).toContainEqual([...prefix, 'state', 'custom.tfstate']);
      expect(candidate.statePaths).toContainEqual([...prefix, 'state', 'custom.tfstate.backup']);
      expect(candidate.statePaths).toContainEqual([...prefix, 'workspaces']);
    }
  });

  it('makes block-comment-only default backends explicit and does not discover the remote example group', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['backend.local.tf'], '/* Keep these comments: the old root used the local default. */\n');
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.resourceGroups).toEqual([{ environment: 'dev', name: 'rg-repair-dev' }]);
    expect(candidate.files.find((item) => item.pathParts.includes('dev') && item.pathParts.at(-1) === 'backend.local.tf')!.content).toContain('backend "local"');
    await put(root, ['backend.remote.example.tf'], 'terraform {\n backend "azurerm" {}\n}\n');
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('read-only example contains active');
  });

  it('does not read any state or backend metadata contents, even invalid/huge state', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['terraform.tfstate'], '\0'.repeat(1024 * 1024));
    await put(root, ['.terraform', 'terraform.tfstate'], 'not JSON and MUST NOT be read');
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.snapshots.some((item) => item.pathParts.some((part) => part === '.terraform' || part.endsWith('.tfstate')))).toBe(false);
    expect(candidate.statePaths).toContainEqual([...repairRoot, 'terraform.tfstate']);
    expect(candidate.statePaths).toContainEqual([...repairRoot, '.terraform', 'terraform.tfstate']);
  });

  it('allows benign provider/module caches while recording exact unknown backend metadata', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['.terraform', 'providers', 'cached-provider'], 'opaque provider bytes');
    await put(root, ['.terraform', 'modules', 'modules.json'], 'opaque module cache');
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.statePaths).not.toContainEqual([...repairRoot, '.terraform']);
    expect(candidate.statePaths.some((parts) => parts.includes('providers') || parts.includes('modules.json'))).toBe(false);
    expect(candidate.snapshots.some((item) => item.pathParts.includes('.terraform'))).toBe(false);
    expect(candidate.directoryInventory.find((item) => item.pathParts.join('/') === [...repairRoot, '.terraform'].join('/'))?.entries)
      .toEqual([{ name: 'modules', kind: 'directory' }, { name: 'providers', kind: 'directory' }]);
    await put(root, ['.terraform', 'unknown-backend.json'], 'sensitive-backend-content');
    const unknown = await inspectInfrastructureRepair(root, manifest);
    expect(unknown.blockers).toEqual([]);
    expect(unknown.statePaths).toContainEqual([...repairRoot, '.terraform', 'unknown-backend.json']);
    expect(unknown.snapshots.some((item) => item.pathParts.at(-1) === 'unknown-backend.json')).toBe(false);
    expect(JSON.stringify(unknown.directoryInventory)).not.toContain('sensitive-backend-content');
  });

  it('rejects symlinked metadata parents and custom state-path parents without reading contents', async () => {
    const { root, manifest } = await fixture(['dev']);
    const destination = path.join(root, 'unrelated-metadata');
    await mkdir(destination);
    await symlink(destination, path.join(root, ...repairRoot, '.terraform'), process.platform === 'win32' ? 'junction' : 'dir');
    const metadata = await inspectInfrastructureRepair(root, manifest);
    expect(metadata.blockers.join()).toContain('symlink');
    expect(metadata.mutations).toEqual([]);
    await rm(path.join(root, ...repairRoot, '.terraform'));
    await put(root, ['backend.local.tf'], 'terraform {\n backend "local" {\n path = "state/project.tfstate"\n }\n}\n');
    await symlink(destination, path.join(root, ...repairRoot, 'state'), process.platform === 'win32' ? 'junction' : 'dir');
    const state = await inspectInfrastructureRepair(root, manifest);
    expect(state.blockers.join()).toContain('symlink');
    expect(state.mutations).toEqual([]);
  });

  it('preserves private tfvars file modes for newly created environment values', async () => {
    const { root, manifest } = await fixture(['dev']);
    await chmod(path.join(root, ...repairRoot, 'environments', 'dev.tfvars'), 0o600);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers).toEqual([]);
    if (process.platform !== 'win32') {
      expect(candidate.mutations.find((item) => item.type === 'write' && item.pathParts.at(-1) === 'dev.tfvars')).toMatchObject({ mode: 0o600 });
    }
  });

  it.each([
    ['external module', 'main.tf', '\nmodule "foreign" {\n source = "example/foreign/azure"\n}\n', 'module'],
    ['provisioner', 'main.tf', '\nresource "azurerm_storage_account" "other" {\n resource_group_name = azurerm_resource_group.main.name\n provisioner "local-exec" {\n command = "echo forbidden"\n }\n}\n', 'provisioner'],
    ['nonlocal data', 'main.tf', '\ndata "azurerm_resource_group" "foreign" {\n name = "outside"\n}\n', 'nonlocal'],
    ['path expression', 'main.tf', '\nlocals { forbidden = path.module }\n', 'path'],
    ['file function', 'main.tf', '\nlocals { forbidden = file("secret") }\n', 'function file'],
    ['timestamp function', 'main.tf', '\nlocals { forbidden = timestamp() }\n', 'function timestamp'],
    ['workspace', 'main.tf', '\nlocals { forbidden = terraform.workspace }\n', 'workspace'],
    ['unknown resource', 'main.tf', '\nresource "azurerm_subscription" "outside" {\n subscription_name = "outside"\n}\n', 'containment'],
    ['unbound role', 'main.tf', '\nresource "azurerm_role_assignment" "outside" {\n scope = "/subscriptions/unknown"\n}\n', 'containment'],
    ['dynamic ownership', 'main.tf', '\nresource "azurerm_storage_account" "dynamic" {\n for_each = {}\n resource_group_name = azurerm_resource_group.main.name\n}\n', 'for_each'],
    ['provider alias', 'providers.tf', '\nprovider "azurerm" {\n alias = "outside"\n features {}\n}\n', 'duplicate'],
    ['import', 'main.tf', '\nimport {\n to = azurerm_resource_group.main\n id = "outside"\n}\n', 'import'],
    ['moved', 'main.tf', '\nmoved {\n from = azurerm_resource_group.old\n to = azurerm_resource_group.main\n}\n', 'moved']
  ])('rejects %s without returning any writes', async (_name, file, extra, blocker) => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, [file], legacyInfrastructureSources[file] + extra);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers.join(' ')).toContain(blocker);
    expect(candidate.mutations).toEqual([]);
    expect(candidate.artifacts).toEqual([]);
  });

  it.each([
    ['terraform {\n backend "azurerm" {}\n}\n', 'remote'],
    ['terraform {\n backend "local" { path = "../outside.tfstate" }\n}\n', 'bounded'],
    ['terraform {\n backend "local" { path = "/absolute.tfstate" }\n}\n', 'bounded'],
    ['terraform {\n backend "local" { path = "C:\\\\outside.tfstate" }\n}\n', 'bounded'],
    ['terraform {\n backend "local" { path = "CON.tfstate" }\n}\n', 'bounded'],
    ['terraform {\n backend "local" { path = "ordinary.txt" }\n}\n', 'bounded'],
    ['terraform {\n backend "local" { path = var.backend }\n}\n', 'literal']
  ])('rejects unsupported backend configuration %#', async (backend, reason) => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['backend.local.tf'], backend);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers.join(' ')).toContain(reason);
    expect(candidate.mutations).toEqual([]);
  });

  it.each(['extra.tf', 'override.tf', 'other.tf.json', 'secret.auto.tfvars', 'terraform.tfvars', 'override.tofu'])('rejects uninventoried active %s without reading its bytes', async (name) => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, [name], 'invalid SECRET = "no-disclosure"');
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers.join(' ')).toContain('additional active');
    expect(candidate.blockers.join(' ')).not.toContain('no-disclosure');
    expect(candidate.snapshots.some((item) => item.pathParts.at(-1) === name)).toBe(false);
  });

  it('rejects unknown active module/selected-root files and unselected roots', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['modules', 'application', 'extra.tf'], '');
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('additional active');
    await rm(path.join(root, ...repairRoot, 'modules', 'application', 'extra.tf'));
    await put(root, ['environments', 'prod', 'main.tf'], '');
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('unselected');
  });

  it('rejects missing provenance, missing source and conflicting partial migrations', async () => {
    const { root, manifest } = await fixture(['dev']);
    const missing = structuredClone(manifest);
    missing.projectArtifacts = missing.projectArtifacts.filter((item) => item.logicalName !== 'opentofu-main');
    expect((await inspectInfrastructureRepair(root, missing)).blockers.join()).toContain('provenance is missing');
    await put(root, ['modules', 'application', 'main.tf'], legacyInfrastructureSources['main.tf'].replace('sku = "Basic"', 'sku = "Standard"'));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('conflicting target');
    await rm(path.join(root, ...repairRoot, 'main.tf'));
    await rm(path.join(root, ...repairRoot, 'modules', 'application', 'main.tf'));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('source is missing');
  });

  it('does not grant ownership from files when manifest provenance is unknown', async () => {
    const { root, manifest } = await fixture(['dev']);
    manifest.projectArtifacts = [];
    const result = await inspectInfrastructureRepair(root, manifest);
    expect(result.layout).toBe('unknown');
    expect(result.blockers.join()).toContain('provenance');
    expect(result.mutations).toEqual([]);
  });

  it.each([
    ['"rg-repair-${var.environment}"', '"shared-group"', 'share'],
    ['"rg-repair-${var.environment}"', 'data.azurerm_client_config.current.tenant_id', 'discovery'],
    ['"rg-repair-${var.environment}"', '"${upper(var.environment)}-group"', 'discovery'],
    ['azurerm_resource_group.main.name', '"unrelated-group"', 'containment'],
    ['azurerm_storage_account.main.id', 'azurerm_storage_account.missing.id', 'unsupported reference'],
    ['name = "rg-repair-${var.environment}"', 'count = 1\n name = "rg-repair-${var.environment}"', 'dynamic']
  ])('rejects unproven or shared resource-group bindings %#', async (before, after, reason) => {
    const { root, manifest } = await fixture();
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf'].replace(before, after));
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers.join(' ')).toContain(reason);
    expect(candidate.resourceGroups).toEqual([]);
    expect(candidate.mutations).toEqual([]);
  });

  it('redacts parse failures and unknown tfvars values', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['environments', 'dev.tfvars'], 'environment = "dev"\nbackend_image = invalid("private-value")\n');
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers.join(' ')).toContain('literal');
    expect(candidate.blockers.join(' ')).not.toContain('private-value');
    await put(root, ['environments', 'dev.tfvars'], 'environment = "dev"\npostgres_admin_password = "private-value');
    const invalid = await inspectInfrastructureRepair(root, manifest);
    expect(invalid.blockers.join(' ')).toContain('HCL syntax');
    expect(invalid.blockers.join(' ')).not.toContain('private-value');
  });

  it('blocks declared-sensitive tfvars/default literals rather than journaling plaintext', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['environments', 'dev.tfvars'], 'environment = "dev"\npostgres_admin_password = "never-journal-this-secret"\n');
    const tfvars = await inspectInfrastructureRepair(root, manifest);
    expect(tfvars.blockers.join()).toContain('plaintext value for sensitive input');
    expect(tfvars.blockers.join()).not.toContain('never-journal-this-secret');
    expect(tfvars.mutations).toEqual([]);
    expect(tfvars.files).toEqual([]);
    expect(tfvars.artifacts).toEqual([]);
    await put(root, ['environments', 'dev.tfvars'], 'environment = "dev"\n');
    await put(root, ['variables.tf'], legacyInfrastructureSources['variables.tf'].replace(
      'variable "postgres_admin_password" {',
      'variable "postgres_admin_password" {\n default = "never-journal-this-secret"'
    ));
    const defaults = await inspectInfrastructureRepair(root, manifest);
    expect(defaults.blockers.join()).toContain('sensitive literal default');
    expect(defaults.blockers.join()).not.toContain('never-journal-this-secret');
    expect(defaults.mutations).toEqual([]);
    expect(defaults.files).toEqual([]);
    expect(defaults.artifacts).toEqual([]);
  });

  it('rejects scope overrides, unresolved and cyclic bindings, and mismatched environment values', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['providers.tf'], 'provider "azurerm" {\n features {}\n subscription_id = "elsewhere"\n}\n');
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('subscription');
    await put(root, ['providers.tf'], legacyInfrastructureSources['providers.tf']);
    await put(root, ['main.tf'], 'locals {\n a = local.b\n b = local.a\n}\n' +
      legacyInfrastructureSources['main.tf'].replace('"rg-repair-${var.environment}"', 'local.a'));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('cyclic');
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf'].replace('"rg-repair-${var.environment}"', 'var.postgres_admin_password'));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('unresolved');
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf']);
    await put(root, ['environments', 'dev.tfvars'], 'environment = "prod"\n');
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('selected environment');
  });

  it.each([
    ['subscription_id', '"11111111-1111-1111-1111-111111111111"'],
    ['subscription_id', 'var.subscription_id'],
    ['tenant_id', '"22222222-2222-2222-2222-222222222222"'],
    ['environment', '"usgovernment"'],
    ['alias', '"other"'],
    ['use_cli', 'false'],
    ['client_secret', '"do-not-disclose-provider-secret"'],
    ['client_id', 'var.client_id'],
    ['oidc_token_file_path', '"token"']
  ])('rejects source provider scope %s = %s rather than treating a selected subscription as equivalent', async (key, value) => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['providers.tf'], `provider "azurerm" {\n features {}\n ${key} = ${value}\n}\n`);
    const candidate = await inspectInfrastructureRepair(root, manifest);
    expect(candidate.blockers.join()).toContain(`unsupported ${key} scope`);
    expect(candidate.resourceGroups).toEqual([]);
    expect(candidate.mutations).toEqual([]);
  });

  it('rejects resource-specific and data-specific provider scopes', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf'].replace(
      'resource "azurerm_resource_group" "main" {',
      'resource "azurerm_resource_group" "main" {\n provider = azurerm.other'
    ));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('provider');
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf'].replace(
      'data "azurerm_client_config" "current" {}',
      'data "azurerm_client_config" "current" { provider = azurerm.other }'
    ));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('provider');
  });

  it('bounds source size and directory enumeration', async () => {
    const { root, manifest } = await fixture(['dev']);
    await put(root, ['main.tf'], '#'.repeat(256 * 1024 + 1));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('256 KiB');
    await put(root, ['main.tf'], legacyInfrastructureSources['main.tf']);
    await Promise.all(Array.from({ length: 257 }, (_, index) => put(root, [`unrelated-${index}.txt`], '')));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('256-entry');
  });

  it('rejects symlink destinations and wrong-case expected paths', async () => {
    const { root, manifest } = await fixture(['dev']);
    await mkdir(path.join(root, 'unrelated-target'));
    await mkdir(path.join(root, ...repairRoot, 'modules'));
    await symlink(path.join(root, 'unrelated-target'), path.join(root, ...repairRoot, 'modules', 'application'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('symlink');
    await rm(path.join(root, ...repairRoot, 'modules', 'application'));
    await rename(path.join(root, ...repairRoot, 'main.tf'), path.join(root, ...repairRoot, 'MAIN.tf'));
    expect((await inspectInfrastructureRepair(root, manifest)).blockers.join()).toContain('case-colliding');
  });
});

import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { inspectProviderSources } from '../src/application/azure-activation/provider-inventory.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('actual generated infrastructure provider inventory', () => {
  it.each(['standard', 'genai'] as const)('derives %s namespaces from all selected roots and shared modules', async (projectType) => {
    const projectRoot = await createFixtureProject({
      projectName: 'Provider inventory', projectType, apiStack: projectType === 'genai' ? 'python' : 'go',
      ...(projectType === 'genai' ? { pattern: 'rag' } : {}), environments: ['dev', 'staging'],
      cloud: 'azure', includeFrontend: false
    });
    roots.push(path.dirname(projectRoot));
    const manifest = await loadManifest(projectRoot);
    const inventory = await inspectProviderSources({ projectRoot, manifest }, ['infrastructure', 'opentofu', 'azure', 'environments', 'dev']);
    expect(inventory.roots).toEqual([
      ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'],
      ['infrastructure', 'opentofu', 'azure', 'environments', 'staging']
    ]);
    expect(inventory.namespaces).toEqual([
      'Microsoft.App', 'Microsoft.Authorization', 'Microsoft.Cache', 'Microsoft.Communication',
      'Microsoft.ContainerRegistry', 'Microsoft.DBforPostgreSQL', 'Microsoft.KeyVault',
      'Microsoft.ManagedIdentity', 'Microsoft.Resources', 'Microsoft.ServiceBus', 'Microsoft.Storage',
      ...(projectType === 'genai' ? ['Microsoft.Web'] : [])
    ]);
    expect(inventory.namespaces).not.toContain('Microsoft.CognitiveServices');
    expect(inventory.files.some((file) => file.path.includes('/environments/staging/'))).toBe(true);
    expect(inventory.files.filter((file) => file.path.endsWith('/modules/application/main.tf'))).toHaveLength(1);
    const moduleFile = path.join(projectRoot, 'infrastructure', 'opentofu', 'azure', 'modules', 'application', 'main.tf');
    const original = await readFile(moduleFile, 'utf8');
    const fingerprint = canonicalSha256(inventory);
    await writeFile(moduleFile, `${original}\nresource "azurerm_log_analytics_workspace" "new_scope" {}\n`);
    const changed = await inspectProviderSources({ projectRoot, manifest }, inventory.rootPathParts);
    expect(changed.namespaces).toContain('Microsoft.OperationalInsights');
    expect(canonicalSha256(changed)).not.toBe(fingerprint);
  });
});

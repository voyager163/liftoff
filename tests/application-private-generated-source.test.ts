import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { object, parseHcl, singleBlock } from '../src/adapters/hcl/semantic.js';
import { inspectApplicationPrivateSource } from '../src/application/azure-activation/application-private-source.js';
import { applicationPrivateVersionMatches } from '../src/application/azure-activation/application-private-version.js';
import { applicationPrivateAddress } from '../src/application/azure-activation/application-private-address.js';
import type { ApplicationPrivateIntent } from '../src/application/azure-activation/application-private-contracts.js';
import { custody, fixtureBinding, fixtureTime, privateTarget } from './helpers/private-activation-fixture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sourceRoot = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];

async function fixture(kind: 'standard' | 'genai') {
  const root = await createFixtureProject({
    projectName: 'Actual private source', projectType: kind, apiStack: kind === 'genai' ? 'python-fastapi' : 'node-fastify',
    ...(kind === 'genai' ? { pattern: 'rag' } : {}), cloud: 'azure', environments: ['dev'], includeFrontend: false
  });
  roots.push(path.dirname(root));
  const manifest = await loadManifest(root);
  const versionFile = await readFile(path.join(root, ...sourceRoot, 'versions.tf'), 'utf8');
  const terraform = singleBlock((await parseHcl(versionFile, 'Current generated versions')).terraform, 'Terraform');
  const providers = singleBlock(terraform.required_providers, 'Providers');
  const provider = object(providers.azurerm, 'Azure provider');
  if (typeof provider.version !== 'string') throw new Error('Current generated Azure provider pin is missing.');
  await writeFile(path.join(root, ...sourceRoot, '.terraform.lock.hcl'),
    `provider "registry.opentofu.org/hashicorp/azurerm" {\n version = "${provider.version}"\n hashes = ["zh:${'a'.repeat(64)}"]\n}\n`);
  const held = custody(path.dirname(root));
  const intent: ApplicationPrivateIntent = {
    schemaVersion: 1, scope: 'prerequisites-core', binding: fixtureBinding, backend: privateTarget(), custody: held,
    writer: { ...fixtureBinding, clientId: randomUUID(), keychainPath: path.join(path.dirname(root), 'writer.keychain'),
      service: 'org.liftoff.azure-application-writer.fixture', account: '42' },
    source: {
      rootPathParts: sourceRoot, backendPathParts: [...sourceRoot, 'backend.local.tf'],
      variablesRef: `state-workspace:${held.workspaceId}/${randomUUID()}`,
      provider: { source: 'registry.opentofu.org/hashicorp/azurerm', version: provider.version,
        mirrorDirectory: path.join(path.dirname(root), 'mirror'), binary: { path: path.join(path.dirname(root), 'mirror', 'provider'), sha256: 'b'.repeat(64) } }
    },
    targets: [], artifact: null, notBefore: fixtureTime.toISOString(), expiresAt: '2026-09-15T00:15:00.000Z',
    releaseUntil: '2026-09-15T00:17:00.000Z', maxCommandMs: 5000
  };
  return { root, manifest, intent, versionFile };
}

describe('private executor consumes actual generated Azure sources', () => {
  it.each(['standard', 'genai'] as const)('admits exact %s source declarations, pinned provider and unexecuted local backend without rewriting project files', async (kind) => {
    const f = await fixture(kind);
    const inventory = await inspectApplicationPrivateSource(f.root, f.manifest, f.intent);
    expect(inventory.resources.some((resource) => resource.type === 'azurerm_postgresql_flexible_server')).toBe(true);
    expect(inventory.resources.some((resource) => resource.type === 'azurerm_storage_container')).toBe(true);
    expect(inventory.resources.find((resource) => resource.type === 'azurerm_postgresql_flexible_server_firewall_rule')?.counted).toBe(true);
    if (kind === 'genai') expect(inventory.resources.some((resource) => resource.type === 'azurerm_linux_function_app')).toBe(true);
    expect(await readFile(path.join(f.root, ...sourceRoot, 'versions.tf'), 'utf8')).toBe(f.versionFile);
    expect(inventory.files.some((file) => file.kind === 'backend')).toBe(true);
  });

  it('refuses to ignore actual source-local state in favor of another backend', async () => {
    const f = await fixture('standard');
    const local = path.join(f.root, ...sourceRoot, 'state');
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'dev.tfstate'), 'SOURCE_STATE_MUST_NOT_BE_READ_OR_IMPORTED');
    await expect(inspectApplicationPrivateSource(f.root, f.manifest, f.intent)).rejects.toThrow(/local-state-migration-required/);
  });

  it('matches only supported explicit version constraints against the actual selected tool/provider', () => {
    expect(applicationPrivateVersionMatches('1.12.6', '>= 1.12.6, < 2.0.0')).toBe(true);
    expect(applicationPrivateVersionMatches('5.3.0', '5.3.0')).toBe(true);
    expect(applicationPrivateVersionMatches('4.30.0', '~> 4.0')).toBe(true);
    expect(applicationPrivateVersionMatches('4.30.0', '~> 4.29.0')).toBe(false);
    expect(applicationPrivateVersionMatches('5.3.0', '4.30.0')).toBe(false);
    expect(applicationPrivateVersionMatches('invalid', '>= 0.0.0')).toBe(false);
    expect(applicationPrivateVersionMatches('1.12.6', '')).toBe(false);
  });

  it('keeps concrete numeric instance identity distinct from the source declaration', () => {
    expect(applicationPrivateAddress('module.application.azurerm_postgresql_flexible_server_firewall_rule.azure_services[0]'))
      .toMatchObject({
        declaration: 'module.application.azurerm_postgresql_flexible_server_firewall_rule.azure_services',
        type: 'azurerm_postgresql_flexible_server_firewall_rule', index: 0
      });
    expect(() => applicationPrivateAddress('module.application.azurerm_storage_account.main[*]')).toThrow();
    expect(() => applicationPrivateAddress('module.application.azurerm_storage_account.main[-1]')).toThrow();
  });
});

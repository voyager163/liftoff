import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArtifacts } from '../src/templates.js';
import { buildProjectPlan } from '../src/planner.js';
import { generatedSecurityCases } from '../scripts/repository-security/inventory.ts';
import { composeImageInventory, generatedCheckovPlan } from '../scripts/repository-security/checkov-driver.ts';
import { assessCheckovScope } from '../scripts/repository-security/checkov.ts';
import { providerDefaultControls, qualifyProviderDefaultControls } from '../scripts/repository-security/provider-default-policy.ts';
import { previewCheckovRoleDiagnostics } from '../scripts/repository-security/checkov-role-policy.ts';
import { summarizeCheckovGate } from '../scripts/repository-security/artifact-gates.ts';

describe('strict provider-default control equivalence', () => {
  it('registers only the four approved security controls, distinct from optional-role diagnostics', async () => {
    const decision = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'provider-default-control-decision.json'), 'utf8'));
    expect(decision.controls).toEqual(providerDefaultControls);
    expect(providerDefaultControls.map(control => control.rule)).toEqual([
      'CKV_AZURE_44', 'CKV_AZURE_148', 'CKV_AZURE_190', 'CKV_AZURE_205'
    ]);
    expect(Object.isFrozen(providerDefaultControls)).toBe(true);
    for (const control of providerDefaultControls) {
      expect(Object.isFrozen(control)).toBe(true);
      expect(Object.isFrozen(control.schemaLines)).toBe(true);
    }
    expect(decision).toMatchObject({
      independentNativeBindingRequired: true, nativeFailuresPreserved: true,
      vulnerabilityException: false, deployedStateQualified: false,
      strongerContractsMayBeDowngraded: false, adoptedPolicyAuthority: false
    });
  });
  it.each([null, {}, { generatedProviderDefaultFacts: [true, true, true, true], approved: true }])(
    'refuses candidate labels or fabricated evidence', input => {
      expect(() => qualifyProviderDefaultControls(input)).toThrow('identity-mismatch');
    }
  );
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_PROVIDER_DEFAULTS === '1')(
  'binds secure omissions to exact native results and rejects changed provider, role, input and override facts',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external parent required.');
    const baseline = JSON.parse(await readFile(path.join(process.cwd(), 'assets', 'supported-stack.json'), 'utf8'));
    const entry = generatedSecurityCases.find(item => item.id === 'standard-node')!;
    const plan = generatedCheckovPlan(entry.id,
      buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true })), composeImageInventory(baseline));
    const scope = plan.cases.find(item => item.scope.terraformContext?.rootDirectory.at(-1) === 'dev')!.scope;
    const native = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', scope, parent);
    const before = JSON.stringify(native);
    expect(native.generatedProviderDefaultFacts).toEqual([true, true, true, true]);
    expect(native.generatedProviderDefaultResultIndexes.every(indexes => indexes.length === 1)).toBe(true);
    const qualified = qualifyProviderDefaultControls(native);
    expect(qualified.controls.map(control => control.rule)).toEqual(providerDefaultControls.map(control => control.rule));
    for (const control of qualified.controls) {
      expect(control).toMatchObject({
        nativeStatus: 'failed', classification: 'satisfied-by-pinned-provider-default',
        caseId: 'standard-node', environment: 'dev'
      });
      expect(native.results[control.resultIndex]!.status).toBe('failed');
    }
    const preview = previewCheckovRoleDiagnostics([native]);
    expect(preview.diagnostics.some(item => providerDefaultControls.some(control => control.rule === item.rule))).toBe(false);
    expect(preview.controlEquivalences).toHaveLength(4);
    const policy = await readFile(path.join(process.cwd(), 'security', 'finding-policy.json'), 'utf8');
    const gate = summarizeCheckovGate([{ id: 'standard-node-dev', scope }],
      [{ id: 'standard-node-dev', status: 'complete', result: native }], policy);
    expect(gate.cases[0]!.controlEquivalences).toEqual(expect.arrayContaining(providerDefaultControls.map(control => control.rule)));
    expect([...gate.cases[0]!.blocking, ...gate.cases[0]!.unmapped]).toContain('CKV_AZURE_203');
    expect(gate.gate).not.toBe('passed');
    expect(JSON.stringify(native)).toBe(before);
    expect(() => qualifyProviderDefaultControls(structuredClone(native))).toThrow('identity-mismatch');

    const substitutions = [
      ['explicit-weak', 'resource "azurerm_storage_account" "main" {', 'resource "azurerm_storage_account" "main" {\n min_tls_version = "TLS1_0"'],
      ['explicit-null', 'resource "azurerm_storage_account" "main" {', 'resource "azurerm_storage_account" "main" {\n min_tls_version = null'],
      ['explicit-public', 'resource "azurerm_storage_account" "main" {', 'resource "azurerm_storage_account" "main" {\n allow_nested_items_to_be_public = true'],
      ['lifecycle', 'resource "azurerm_storage_account" "main" {', 'resource "azurerm_storage_account" "main" {\n lifecycle { ignore_changes = [min_tls_version] }'],
      ['provider-override', 'resource "azurerm_storage_account" "main" {', 'resource "azurerm_storage_account" "main" {\n provider = azurerm.other'],
      ['changed-auth', 'admin_enabled       = false', 'admin_enabled       = true'],
      ['unresolved', 'resource "azurerm_storage_account" "main" {', 'resource "azurerm_storage_account" "main" {\n min_tls_version = var.location']
    ];
    for (const [label, original, replacement] of substitutions) {
      const changed = structuredClone(scope);
      const source = changed.files.find(file => file.pathParts.join('/') === 'infrastructure/opentofu/azure/modules/application/main.tf')!;
      expect(source.content, label).toContain(original);
      source.content = source.content.replace(original!, replacement!);
      const report = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', changed, parent);
      expect(qualifyProviderDefaultControls(report).controls, label).toEqual([]);
      if (label !== 'changed-auth' && label !== 'explicit-public') expect(report.generatedProviderDefaultFacts[0], label).toBe(false);
      if (label === 'explicit-public') expect(report.generatedProviderDefaultFacts[2]).toBe(false);
    }
    const changed = structuredClone(scope), versions = changed.files.find(file => file.pathParts.at(-1) === 'versions.tf')!;
    expect(versions.content).toContain('"5.3.0"');
    versions.content = versions.content.replace('"5.3.0"', '"5.2.0"');
    const report = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', changed, parent);
    expect(report.generatedProviderDefaultFacts).toEqual([false, false, false, false]);
    expect(qualifyProviderDefaultControls(report).controls).toEqual([]);
  }, 240_000
);
